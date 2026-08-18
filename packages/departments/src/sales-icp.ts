/**
 * Le profil des entreprises qui peuvent acheter notre étude de prospection.
 *
 * ATLAS travaille ici pour ATLAS. La différence avec une mission client n'est
 * pas technique — c'est que personne ne nous a briefés. Le profil est donc
 * déclaré ici, explicitement, plutôt que déduit d'une demande.
 *
 * Rien n'est codé en dur pour un secteur : `SalesIcp` est une configuration, et
 * le premier lot en est une instance. Le jour où l'offre change de cible, on
 * change la constante, pas le moteur.
 *
 * Le tri est **déterministe et gratuit**. Un candidat écarté par ces règles ne
 * coûte pas un appel au modèle, et c'est tout l'intérêt : sur vingt candidats,
 * n'en analyser que la moitié divise la facture par deux sans rien perdre de ce
 * qui compte.
 */

export interface SalesIcp {
  /** Les pays acceptés, du plus prioritaire au moins. */
  countries: string[];
  /** Ce que fait l'entreprise. Vide = aucune contrainte sectorielle. */
  industries: string[];
  /** Les tailles visées, en effectif approximatif. */
  companySize: { minEmployees: number | null; maxEmployees: number | null };
  /** Vend-elle à des entreprises, à des particuliers, ou aux deux ? */
  businessModel: 'b2b' | 'b2c' | 'both';
  /** À qui l'on s'adresse, par ordre de préférence. */
  targetBuyerRoles: string[];
  /** Ce qui indique qu'elle cherche à s'étendre. */
  expansionSignals: string[];
  /** Ce qui indique qu'elle a du mal à prospecter seule. */
  prospectingNeedSignals: string[];
  /** Ce qui la disqualifie, quoi qu'elle porte par ailleurs. */
  exclusions: {
    /** Au-delà, l'entreprise a une équipe commerciale et n'a que faire de nous. */
    maxEmployees: number;
    /** Des domaines qui ne désignent jamais une entreprise cliente. */
    domains: string[];
    /** Des mots qui, dans un nom ou une description, écartent d'emblée. */
    keywords: string[];
  };
}

/**
 * Le profil du premier lot.
 *
 * Choisi pour ce que nous savons faire aujourd'hui, pas pour ce qui serait
 * flatteur. Une PME B2B qui vend cher, sur un marché de niche, avec un site
 * sérieux mais sans équipe de prospection : c'est exactement le cas où
 * quarante-neuf euros ne se discutent pas et où la recherche manuelle coûte
 * des heures.
 *
 * Les très grands groupes sont exclus : ils ont des équipes dont c'est le
 * métier. Les micro-entreprises sans activité B2B identifiable aussi : notre
 * livrable ne leur servirait à rien, et le leur vendre serait malhonnête.
 */
export const ATLAS_SALES_ICP: SalesIcp = {
  countries: ['France', 'Belgique', 'Suisse'],
  industries: [],
  companySize: { minEmployees: 3, maxEmployees: 250 },
  businessModel: 'b2b',
  targetBuyerRoles: [
    'dirigeant',
    'fondateur',
    'directeur commercial',
    'business development',
    'responsable export',
    'responsable des ventes',
  ],
  expansionSignals: [
    'export',
    'international',
    'nouveaux marchés',
    'distributeur',
    'revendeur',
    'partenaire',
    'implantation',
    'recrutement commercial',
  ],
  prospectingNeedSignals: [
    'nous recherchons des distributeurs',
    'devenir partenaire',
    'devenir revendeur',
    'réseau de distribution',
    'demander un devis',
    'nous contacter pour un projet',
    'sur mesure',
  ],
  exclusions: {
    maxEmployees: 250,
    domains: [
      'linkedin.com',
      'facebook.com',
      'societe.com',
      'pappers.fr',
      'infogreffe.fr',
      'verif.com',
      'wikipedia.org',
      'youtube.com',
      'indeed.com',
      'pagesjaunes.fr',
    ],
    keywords: [
      'annuaire',
      'comparateur',
      'wikipedia',
      'forum',
      'blog',
      'actualités',
      'recrutement',
      'offres d’emploi',
      'mairie',
      'université',
      'association',
      'particuliers',
    ],
  },
};

/** Ce qu'on sait d'un candidat au moment du tri gratuit. */
export interface RawCandidate {
  companyName: string;
  domain: string | null;
  country: string | null;
  industry: string | null;
  sourceUrl: string;
  searchProvider: string;
  query: string;
  discoveredAt: string;
  /** Le texte rapporté par le moteur, seul contenu disponible à ce stade. */
  snippet?: string | null;
}

export type FilterOutcome = 'kept' | 'rejected';

export interface FilterDecision {
  outcome: FilterOutcome;
  /** Pourquoi, en clair — un rejet muet ne s'audite pas. */
  reason: string;
  /** Les signaux repérés dans le texte, pour la suite du pipeline. */
  signals: { expansion: string[]; prospectingNeed: string[] };
}

const normalise = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Le domaine réduit à son enregistrable, sans protocole ni sous-domaine. */
export function domainOf(url: string | null): string | null {
  if (!url) return null;
  const host = url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    ?.replace(/^www\./, '');
  if (!host || !host.includes('.')) return null;
  const labels = host.split('.');
  return labels.length > 2 && labels.at(-2)!.length <= 3 && labels.at(-1)!.length === 2
    ? labels.slice(-3).join('.')
    : labels.slice(-2).join('.');
}

/**
 * Ce candidat mérite-t-il qu'on dépense pour l'analyser ?
 *
 * Purement syntaxique, et volontairement sévère du côté des annuaires : un
 * résultat qui pointe vers `societe.com` ou `pagesjaunes.fr` ne désigne pas une
 * entreprise cliente mais une fiche à son sujet. L'analyser reviendrait à payer
 * pour découvrir qu'on a trouvé un annuaire.
 *
 * En revanche, ce qui *manque* ne disqualifie pas. Un pays inconnu ou un
 * secteur non renseigné sont des informations absentes, pas contraires — et
 * c'est la qualification, plus loin, qui aura de quoi trancher.
 */
export function filterCandidate(candidate: RawCandidate, icp: SalesIcp): FilterDecision {
  const haystack = normalise(
    [candidate.companyName, candidate.industry, candidate.snippet, candidate.sourceUrl]
      .filter(Boolean)
      .join(' '),
  );

  const signals = {
    expansion: icp.expansionSignals.filter((s) => haystack.includes(normalise(s))),
    prospectingNeed: icp.prospectingNeedSignals.filter((s) => haystack.includes(normalise(s))),
  };

  const domain = candidate.domain ?? domainOf(candidate.sourceUrl);
  if (!domain) {
    return {
      outcome: 'rejected',
      reason: 'aucun domaine exploitable : impossible d’identifier une entreprise.',
      signals,
    };
  }
  if (icp.exclusions.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return {
      outcome: 'rejected',
      reason: `« ${domain} » est un annuaire ou une plateforme : il désigne une fiche, pas une entreprise cliente.`,
      signals,
    };
  }

  const matchedKeyword = icp.exclusions.keywords.find((k) => haystack.includes(normalise(k)));
  if (matchedKeyword) {
    return {
      outcome: 'rejected',
      reason: `mot écarté par le profil : « ${matchedKeyword} ».`,
      signals,
    };
  }

  const nameProblem = whyNotACompanyName(candidate.companyName);
  if (nameProblem) {
    return { outcome: 'rejected', reason: nameProblem, signals };
  }

  return {
    outcome: 'kept',
    reason:
      signals.expansion.length + signals.prospectingNeed.length > 0
        ? `signaux repérés : ${[...signals.expansion, ...signals.prospectingNeed].join(', ')}.`
        : 'aucun signal repéré dans le résumé, mais rien ne l’écarte.',
    signals,
  };
}

/**
 * Pourquoi ce libellé n'est pas un nom d'entreprise.
 *
 * Le premier batch réel l'a montré : le titre de page « Nous recherchons des
 * distributeurs » a été retenu comme raison sociale, qualifié, et noté 68 sur
 * 100. Le pipeline a fonctionné parfaitement sur une entrée qui n'était pas une
 * entreprise — et un message d'approche adressé à « Nous recherchons des
 * distributeurs » serait parti sous notre nom.
 *
 * Le titre d'une page décrit ce qu'elle contient ; la raison sociale n'y figure
 * qu'accessoirement. Trois signaux le distinguent, tous syntaxiques :
 *
 *   — une phrase commence par un mot outil (« nous », « le », « comment »)
 *   — une phrase est longue ; une raison sociale tient en quelques mots
 *   — une raison sociale porte au moins un mot en capitale initiale
 *
 * Volontairement permissif : dans le doute on garde, parce qu'un rejet à tort
 * fait perdre un prospect réel alors qu'un faux positif sera écarté plus loin,
 * à la qualification, pour quelques millièmes de dollar.
 */
export function whyNotACompanyName(name: string): string | null {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) return 'aucun nom d’entreprise.';

  const words = clean.split(' ');
  if (words.length > 8) {
    return `« ${clean.slice(0, 50)}… » : trop long pour une raison sociale, c’est un titre de page.`;
  }

  const OPENERS = new Set([
    'nous', 'vous', 'je', 'notre', 'nos', 'votre', 'vos', 'le', 'la', 'les',
    'un', 'une', 'des', 'comment', 'pourquoi', 'devenir', 'trouver', 'accueil',
    'contact', 'bienvenue', 'decouvrez', 'tout', 'top', 'meilleur', 'meilleurs',
    // Sans accents : la comparaison ci-dessous normalise, et « découvrez »
    // écrit ici avec son accent ne correspondrait jamais.
  ]);
  const first = normalise(words[0] ?? '').replace(/[^a-z]/g, '');
  if (OPENERS.has(first)) {
    return `« ${clean.slice(0, 50)} » commence par « ${words[0]} » : c’est une phrase, pas une raison sociale.`;
  }

  // Une raison sociale porte une majuscule quelque part. Un titre tout en
  // minuscules est presque toujours un fragment de phrase.
  if (!/[A-ZÀ-Þ]/.test(clean)) {
    return `« ${clean.slice(0, 50)} » : aucune majuscule, improbable pour une raison sociale.`;
  }

  return null;
}

/**
 * Réduit une liste de candidats à des entreprises distinctes.
 *
 * Le domaine fait foi. Deux pages d'un même site sont un seul prospect, et
 * l'oublier gonflerait le compte de découverte sans rien ajouter — le premier
 * chiffre qu'on regarde deviendrait le moins fiable.
 */
export function dedupeCandidates(candidates: readonly RawCandidate[]): RawCandidate[] {
  const seen = new Map<string, RawCandidate>();
  for (const candidate of candidates) {
    const domain = candidate.domain ?? domainOf(candidate.sourceUrl);
    if (!domain) continue;
    if (!seen.has(domain)) seen.set(domain, { ...candidate, domain });
  }
  return [...seen.values()];
}
