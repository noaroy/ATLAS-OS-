/**
 * Transformer un résultat de recherche en entreprise identifiée — ou refuser.
 *
 * Le lot 002 a fonctionné techniquement et échoué commercialement. Deux
 * prospects sont ressortis PRIORITY :
 *
 *   « Entreprises du secteur Automatisation Industrielle… » → mordorintelligence.com
 *   « Industriailes, l'agence marketing & communication B2B » → industri-ailes.fr
 *
 * Le premier est une page d'étude de marché *listant* des entreprises ; ATLAS a
 * qualifié l'éditeur du rapport. Le second est une vraie société, mais une
 * agence de communication — hors du profil « fabricant » de ce lot.
 *
 * La cause commune est une confusion que rien n'empêchait : **le titre d'un
 * résultat de recherche était pris pour une raison sociale**. Un titre décrit ce
 * que contient une page. Il ne nomme l'entreprise que lorsque la page lui
 * appartient — ce qui est précisément la question à trancher avant, et non
 * après, la qualification.
 *
 * Trois questions, dans cet ordre, toutes gratuites :
 *
 *   1. À qui appartient cette page ?        → `classifyPageType`
 *   2. Quelle entreprise désigne-t-elle ?   → `resolveCompanyIdentity`
 *   3. Entre-t-elle dans le profil ?        → `icpStatus`
 *
 * Aucun appel au modèle avant que les trois aient répondu.
 */

export type PageType =
  /** Le site d'une entreprise, qui parle d'elle-même. */
  | 'OFFICIAL_COMPANY_SITE'
  /** Un annuaire : des fiches *sur* des entreprises. */
  | 'DIRECTORY'
  /** Une étude de marché, qui liste des acteurs sans en être un. */
  | 'MARKET_REPORT'
  | 'ARTICLE'
  | 'BLOG'
  | 'JOB'
  | 'MARKETPLACE'
  | 'SOCIAL'
  /** Une page de catégorie ou de listing sur un site marchand. */
  | 'CATEGORY_PAGE'
  | 'UNKNOWN';

export interface PageClassification {
  type: PageType;
  /** Pourquoi — un classement muet ne s'audite pas. */
  reason: string;
  /**
   * Le propriétaire du domaine peut-il être le candidat ?
   *
   * Faux pour tout ce qui n'est pas un site officiel : l'éditeur d'un annuaire
   * ou d'une étude n'est pas un prospect industriel parce que sa page cite des
   * industriels.
   */
  ownerIsCandidate: boolean;
}

/** Des domaines dont on sait ce qu'ils sont, sans avoir à lire la page. */
const KNOWN_DOMAINS: ReadonlyArray<{ domain: string; type: PageType }> = [
  { domain: 'mordorintelligence.com', type: 'MARKET_REPORT' },
  { domain: 'marketsandmarkets.com', type: 'MARKET_REPORT' },
  { domain: 'grandviewresearch.com', type: 'MARKET_REPORT' },
  { domain: 'statista.com', type: 'MARKET_REPORT' },
  { domain: 'xerfi.com', type: 'MARKET_REPORT' },
  { domain: 'businesscoot.com', type: 'MARKET_REPORT' },
  { domain: 'societe.com', type: 'DIRECTORY' },
  { domain: 'pappers.fr', type: 'DIRECTORY' },
  { domain: 'infogreffe.fr', type: 'DIRECTORY' },
  { domain: 'verif.com', type: 'DIRECTORY' },
  { domain: 'pagesjaunes.fr', type: 'DIRECTORY' },
  { domain: 'kompass.com', type: 'DIRECTORY' },
  { domain: 'europages.fr', type: 'DIRECTORY' },
  { domain: 'europages.com', type: 'DIRECTORY' },
  { domain: 'directindustry.fr', type: 'MARKETPLACE' },
  { domain: 'directindustry.com', type: 'MARKETPLACE' },
  { domain: 'amazon.fr', type: 'MARKETPLACE' },
  { domain: 'alibaba.com', type: 'MARKETPLACE' },
  { domain: 'linkedin.com', type: 'SOCIAL' },
  { domain: 'facebook.com', type: 'SOCIAL' },
  { domain: 'x.com', type: 'SOCIAL' },
  { domain: 'twitter.com', type: 'SOCIAL' },
  { domain: 'youtube.com', type: 'SOCIAL' },
  { domain: 'wikipedia.org', type: 'ARTICLE' },
  { domain: 'indeed.com', type: 'JOB' },
  { domain: 'welcometothejungle.com', type: 'JOB' },
  { domain: 'apec.fr', type: 'JOB' },
  { domain: 'usinenouvelle.com', type: 'ARTICLE' },
  { domain: 'lesechos.fr', type: 'ARTICLE' },
];

/**
 * Domaines publics et institutionnels.
 *
 * Le lot 002 a résolu « ULTRO » sur `gouv.fr` et l'a présenté comme une
 * entreprise. Une administration, une chambre de commerce ou une université
 * n'est pas un prospect industriel, et son domaine héberge des pages *sur*
 * des entreprises exactement comme un annuaire. Le classement reste UNKNOWN
 * — le vocabulaire des types de page décrit ce que la page est, pas qui la
 * publie — mais le propriétaire cesse d'être un candidat.
 */
const INSTITUTIONAL_SUFFIXES = [
  '.gouv.fr', 'gouv.fr', 'service-public.fr', 'legifrance.gouv.fr',
  'insee.fr', 'bpifrance.fr', 'cci.fr', 'europa.eu', '.gov', '.gov.uk',
  '.edu', '.ac.uk', 'univ-', 'cnrs.fr', 'ademe.fr', 'urssaf.fr',
];

const norm = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * À qui appartient cette page ?
 *
 * Le domaine d'abord, quand il est connu — `mordorintelligence.com` publie des
 * études, quelle que soit la page. Puis le chemin, puis le titre. L'ordre va du
 * plus fiable au plus faible : un chemin peut mentir, un domaine connu non.
 */
export function classifyPageType(input: {
  url: string;
  domain: string | null;
  title?: string | null;
  snippet?: string | null;
}): PageClassification {
  const domain = input.domain ?? '';
  const known = KNOWN_DOMAINS.find((k) => domain === k.domain || domain.endsWith(`.${k.domain}`));
  if (known) {
    return {
      type: known.type,
      reason: `« ${domain} » est un éditeur connu de type ${known.type}.`,
      ownerIsCandidate: false,
    };
  }

  const institutional = INSTITUTIONAL_SUFFIXES.find(
    (suffix) => domain === suffix.replace(/^\./, '') || domain.endsWith(suffix) || domain.startsWith(suffix),
  );
  if (institutional) {
    return {
      type: 'UNKNOWN',
      reason: `« ${domain} » est un domaine public ou institutionnel : ni entreprise, ni prospect.`,
      ownerIsCandidate: false,
    };
  }

  let path = '';
  try {
    path = new URL(input.url).pathname.toLowerCase();
  } catch {
    return { type: 'UNKNOWN', reason: 'adresse illisible.', ownerIsCandidate: false };
  }

  const PATH_RULES: ReadonlyArray<{ fragments: string[]; type: PageType; label: string }> = [
    { fragments: ['/industry-report', '/market-report', '/etude-de-marche', '/rapport-'], type: 'MARKET_REPORT', label: 'étude de marché' },
    { fragments: ['/annuaire', '/entreprises/', '/societe/', '/fiche'], type: 'DIRECTORY', label: 'annuaire' },
    { fragments: ['/emploi', '/jobs', '/recrutement', '/carriere', '/offre-emploi'], type: 'JOB', label: 'offre d’emploi' },
    { fragments: ['/blog', '/actualite', '/news', '/presse'], type: 'BLOG', label: 'blog ou actualités' },
    { fragments: ['/article', '/dossier'], type: 'ARTICLE', label: 'article' },
    { fragments: ['/categorie', '/category', '/rubrique', '/tag/', '/recherche', '/search'], type: 'CATEGORY_PAGE', label: 'page de catégorie' },
  ];
  for (const rule of PATH_RULES) {
    const hit = rule.fragments.find((f) => path.includes(f));
    if (hit) {
      return {
        type: rule.type,
        reason: `chemin « ${hit} » : ${rule.label}, pas le site d'une entreprise.`,
        ownerIsCandidate: false,
      };
    }
  }

  // Le titre, en dernier recours : « Entreprises du secteur… », « Top 10 des… »
  // annoncent une liste, donc une page *sur* des entreprises.
  const title = norm(input.title ?? '');
  const LISTING_TITLES = [
    'entreprises du secteur', 'liste des entreprises', 'top 10', 'top 20',
    'classement des', 'les meilleurs', 'annuaire des', 'acteurs du marche',
    'part de marche', 'analyse du marche', 'taille du marche',
  ];
  const listing = LISTING_TITLES.find((t) => title.includes(t));
  if (listing) {
    return {
      type: 'DIRECTORY',
      reason: `titre « ${listing}… » : la page liste des entreprises, elle n'en est pas une.`,
      ownerIsCandidate: false,
    };
  }

  const depth = path.split('/').filter(Boolean).length;
  if (depth > 4) {
    return {
      type: 'UNKNOWN',
      reason: `chemin à ${depth} niveaux : trop profond pour une page d'entreprise.`,
      ownerIsCandidate: false,
    };
  }

  return {
    type: 'OFFICIAL_COMPANY_SITE',
    reason: 'domaine propre et chemin compatible avec un site d’entreprise.',
    ownerIsCandidate: true,
  };
}

// ─── Identité ───────────────────────────────────────────────────────────────

export interface CompanyIdentity {
  companyName: string;
  canonicalDomain: string;
  officialWebsite: string;
  country: string | null;
  /** 0..1 — ce que valent les signaux qui l'établissent. */
  identityConfidence: number;
  /** Ce qui a servi à l'établir, nommé. */
  identitySources: string[];
}

export interface IdentityOutcome {
  identity: CompanyIdentity | null;
  reason: string;
  /** Ce qu'il faudrait pour trancher, quand rien ne suffit. */
  missing: string[];
}

/**
 * Les marqueurs qui font d'une chaîne une raison sociale.
 *
 * Jamais obligatoires : « Michelin » et « BHS Corrugated » n'affichent aucune
 * forme juridique et sont pourtant des marques parfaitement établies. Ils
 * ajoutent de la confiance, ils ne conditionnent pas.
 */
const LEGAL_MARKERS = [
  'sas', 'sarl', 'sasu', 'sa', 'eurl', 'snc', 'scop', 'sci',
  'gmbh', 'ag', 'kg', 'ohg', 'ug', 'mbh',
  'ltd', 'limited', 'inc', 'llc', 'plc', 'bv', 'nv', 'spa', 'srl',
];

/**
 * Une chaîne trop générique pour nommer une entreprise.
 *
 * « Automatisation Industrielle » décrit un métier, pas une société. Le lot 002
 * en a retenu plusieurs — « Concepteur Fabricant d'Equipement »,
 * « Constructeur d'équipements… » — chacune parfaitement plausible comme titre
 * de page et impossible comme raison sociale.
 *
 * La règle : une chaîne faite *uniquement* de mots de métier n'identifie
 * personne. Dès qu'un mot propre s'y ajoute — « Durand », « Sermeca » — elle
 * devient un nom.
 */
const TRADE_WORDS = new Set([
  'automatisation', 'industrielle', 'industrielles', 'industriel', 'industriels',
  'industrie', 'industries',
  'concepteur', 'fabricant', 'fabrication', 'constructeur', 'construction',
  'equipement', 'equipements', 'machine', 'machines', 'machinerie',
  'solution', 'solutions', 'technique', 'techniques', 'technologie',
  'systeme', 'systemes', 'materiel', 'materiels', 'produit', 'produits',
  'service', 'services', 'entreprise', 'entreprises', 'societe', 'societes',
  'specialiste', 'expert', 'specialisee', 'professionnel', 'professionnels',
  'secteur', 'secteurs', 'marche', 'marches', 'domaine', 'activite', 'activites',
  'de', 'du', 'des', 'la', 'le', 'les', 'et', 'en', 'pour', 'aux', 'au',
  'sur', 'dans', 'avec', 'par', 'france', 'francais', 'francaise',
]);

export function isGenericDescriptor(name: string): boolean {
  const words = norm(name)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (words.length === 0) return true;
  return words.every((w) => TRADE_WORDS.has(w));
}

/**
 * Résout l'identité d'une entreprise, ou refuse de la deviner.
 *
 * Le titre du résultat n'est qu'un **indice** : il ne devient une raison
 * sociale que si la page appartient à l'entreprise *et* que le libellé ressemble
 * à un nom. Sans les deux, on ne sait pas qui c'est — et ne pas savoir se dit,
 * plutôt que de se combler avec ce qu'on a sous la main.
 *
 * Les signaux facultatifs — `og:site_name`, JSON-LD `Organization`, mentions
 * légales — sont acceptés quand l'appelant a pu les récupérer, et augmentent la
 * confiance. Aucun n'est requis : la plupart des cas se tranchent sans eux, et
 * exiger une récupération de page rendrait la résolution coûteuse pour rien.
 */
/**
 * Ramène un titre à la marque qu'il annonce, quand il en annonce une.
 *
 * « ASM Indus: Concepteurs et fabricants de machines spéciales » nomme
 * « ASM Indus » et décrit le reste. Le lot 003 a stocké la phrase entière
 * comme raison sociale : exact au sens où rien n'était inventé, faux au sens
 * où aucune entreprise ne s'appelle ainsi.
 *
 * Seul le deux-points sépare ici. La virgule est écartée volontairement :
 * « Industriailes, l'agence marketing & communication B2B » perdrait, en
 * étant coupé, le mot qui le disqualifie — et un nettoyage qui efface un
 * motif de refus est pire que pas de nettoyage du tout.
 */
function brandOf(title: string): string {
  const head = title.split(':')[0]!.trim();
  if (head.length < 2 || head === title.trim()) return title.trim();
  if (isGenericDescriptor(head)) return title.trim();
  return head;
}

export function resolveCompanyIdentity(input: {
  searchTitle: string;
  url: string;
  domain: string | null;
  country?: string | null;
  page: PageClassification;
  /** Ce qu'une récupération de page a livré, quand elle a eu lieu. */
  siteName?: string | null;
  organizationName?: string | null;
  legalMention?: string | null;
}): IdentityOutcome {
  const missing: string[] = [];

  if (!input.domain) {
    return { identity: null, reason: 'aucun domaine exploitable.', missing: ['domaine'] };
  }

  if (!input.page.ownerIsCandidate) {
    return {
      identity: null,
      reason:
        `page de type ${input.page.type} : ${input.page.reason} ` +
        `Le propriétaire du domaine n'est pas le candidat. Pour retenir une entreprise citée ` +
        `sur cette page, il faudrait d'abord résoudre son propre domaine officiel.`,
      missing: ['domaine officiel de l’entreprise citée'],
    };
  }

  // Le nom, par ordre de fiabilité décroissante.
  const sources: string[] = [];
  let name: string | null = null;
  let confidence = 0;

  if (input.organizationName?.trim()) {
    name = input.organizationName.trim();
    sources.push('JSON-LD Organization');
    confidence = 0.95;
  } else if (input.legalMention?.trim()) {
    name = input.legalMention.trim();
    sources.push('mentions légales');
    confidence = 0.9;
  } else if (input.siteName?.trim()) {
    name = input.siteName.trim();
    sources.push('og:site_name');
    confidence = 0.8;
  } else {
    // Le titre de recherche, et seulement s'il ressemble à un nom.
    const candidate = cleanTitle(input.searchTitle);
    if (candidate && !isGenericDescriptor(candidate)) {
      name = brandOf(candidate);
      sources.push('titre du résultat');
      confidence = 0.55;
    } else {
      missing.push('raison sociale : le titre est un descriptif de métier');
    }
  }

  if (!name) {
    // Dernier recours : le domaine lui-même. « sermeca.fr » nomme Sermeca.
    const root = input.domain.split('.')[0] ?? '';
    if (root.length >= 4 && !isGenericDescriptor(root)) {
      name = root.charAt(0).toUpperCase() + root.slice(1);
      sources.push('domaine');
      confidence = 0.5;
      missing.length = 0;
    }
  }

  if (!name) {
    return {
      identity: null,
      reason:
        'aucune raison sociale identifiable : le titre décrit un métier et le domaine ne nomme personne.',
      missing: missing.length > 0 ? missing : ['raison sociale'],
    };
  }

  // Les marqueurs de forme juridique confirment sans être exigés.
  const hasMarker = norm(name)
    .split(/[\s,.-]+/)
    .some((w) => LEGAL_MARKERS.includes(w));
  if (hasMarker) {
    confidence = Math.min(1, confidence + 0.15);
    sources.push('forme juridique');
  }

  // Le nom et le domaine se recoupent-ils ? Un chevauchement rend l'identité
  // beaucoup plus sûre — et son absence n'est pas rédhibitoire, beaucoup de
  // sociétés ayant un domaine sans rapport avec leur raison sociale.
  if (nameMatchesDomain(name, input.domain)) {
    confidence = Math.min(1, confidence + 0.2);
    sources.push('nom cohérent avec le domaine');
  }

  return {
    identity: {
      companyName: name,
      canonicalDomain: input.domain,
      officialWebsite: `https://${input.domain}`,
      country: input.country ?? null,
      identityConfidence: Math.round(confidence * 100) / 100,
      identitySources: sources,
    },
    reason: `identité établie par : ${sources.join(', ')}.`,
    missing: [],
  };
}

/** Le nom et le domaine partagent-ils une racine ? */
export function nameMatchesDomain(name: string, domain: string): boolean {
  const root = norm(domain.split('.')[0] ?? '').replace(/[^a-z0-9]/g, '');
  if (root.length < 3) return false;
  const flat = norm(name).replace(/[^a-z0-9]/g, '');
  if (flat.includes(root) || root.includes(flat)) return true;
  return norm(name)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
    .some((w) => root.includes(w));
}

/** Retire d'un titre ce qui suit un séparateur — presque toujours le slogan. */
function cleanTitle(title: string): string {
  return (title.split(/\s+[|–—»·]\s+|\s+-\s+/)[0] ?? title)
    .replace(/\.\.\.$/, '')
    .replace(/[,;:]$/, '')
    .trim();
}

// ─── Profil ─────────────────────────────────────────────────────────────────

export type IcpStatus = 'MATCH' | 'OUT_OF_ICP' | 'UNKNOWN';

export interface IcpDecision {
  status: IcpStatus;
  reason: string;
}

/**
 * Des métiers qui ne sont pas le nôtre, pour ce lot.
 *
 * Une agence de communication B2B pourrait très bien acheter une étude de
 * prospection — Industriailes en est un bon exemple. Elle reste hors profil,
 * parce que le profil de ce lot dit « fabricant ou équipementier industriel ».
 *
 * Élargir le profil après coup pour sauver un prospect reviendrait à ne plus
 * en avoir : un profil qui s'ajuste à ce qu'on trouve ne filtre rien. Un profil
 * « agences B2B » se créera séparément, avec son propre score et ses propres
 * messages.
 */
const OUT_OF_SCOPE_TRADES: ReadonlyArray<{ words: string[]; label: string }> = [
  { words: ['agence marketing', 'agence de communication', 'agence web', 'agence digitale', 'communication b2b'], label: 'agence de communication ou de marketing' },
  { words: ['cabinet de conseil', 'cabinet conseil', 'consulting', 'conseil en strategie'], label: 'cabinet de conseil' },
  { words: ['cabinet de recrutement', 'interim', 'travail temporaire'], label: 'recrutement ou intérim' },
  { words: ['avocat', 'expert-comptable', 'notaire', 'assurance', 'courtier'], label: 'profession réglementée ou service financier' },
  { words: ['formation', 'organisme de formation', 'ecole', 'universite'], label: 'formation ou enseignement' },
  { words: ['agence immobiliere', 'immobilier'], label: 'immobilier' },
  { words: ['salon', 'evenementiel', 'organisateur de salons'], label: 'événementiel' },
];

/** Ce qui, au contraire, dit qu'on est bien chez un industriel. */
const IN_SCOPE_TRADES = [
  'fabricant', 'fabrication', 'constructeur', 'equipementier', 'usinage',
  'machine', 'machines', 'equipement', 'equipements', 'industriel',
  'production', 'atelier', 'chaudronnerie', 'mecanique', 'automatisme',
  'convoyeur', 'robotique', 'assemblage', 'sous-traitance industrielle',
];

/**
 * Cette entreprise entre-t-elle dans le profil du lot ?
 *
 * Trois issues, et `UNKNOWN` en est une vraie : quand ni les signaux d'entrée
 * ni ceux de sortie n'apparaissent, on ne sait pas. Trancher au hasard
 * coûterait soit un prospect réel, soit un appel inutile — et le dire permet à
 * la qualification de faire son travail avec le budget prévu pour ça.
 */
export function icpStatus(input: {
  companyName: string;
  snippet?: string | null;
  industry?: string | null;
  country?: string | null;
}): IcpDecision {
  const haystack = norm([input.companyName, input.industry, input.snippet].filter(Boolean).join(' '));

  const outOfScope = OUT_OF_SCOPE_TRADES.find((t) => t.words.some((w) => haystack.includes(norm(w))));
  if (outOfScope) {
    return {
      status: 'OUT_OF_ICP',
      reason:
        `${outOfScope.label} : hors du profil « fabricant ou équipementier industriel » de ce lot. ` +
        `Elle pourrait acheter une étude, mais le profil ne s'élargit pas après coup pour ` +
        `retenir un candidat.`,
    };
  }

  const inScope = IN_SCOPE_TRADES.filter((t) => haystack.includes(norm(t)));
  if (inScope.length > 0) {
    return {
      status: 'MATCH',
      reason: `signaux industriels repérés : ${inScope.slice(0, 4).join(', ')}.`,
    };
  }

  return {
    status: 'UNKNOWN',
    reason: 'aucun signal, ni d’appartenance au profil ni d’exclusion.',
  };
}

// ─── Éligibilité au rang PRIORITY ───────────────────────────────────────────

export interface PriorityCheck {
  eligible: boolean;
  /** Ce qui manque, énuméré — un refus muet ne se corrige pas. */
  blockers: string[];
}

/**
 * Ce prospect peut-il porter le rang PRIORITY ?
 *
 * Le score seul ne suffit plus. Les deux faux positifs du lot 002 avaient 73 et
 * 72 sur 100 : la note était bonne, ce qu'elle notait ne l'était pas.
 *
 * Sept conditions, toutes nécessaires. Un PRIORITY est un prospect qu'on
 * s'apprête à contacter nommément — l'exigence doit être celle du geste, pas
 * celle du calcul.
 */
export function checkPriorityEligibility(input: {
  identity: CompanyIdentity | null;
  pageType: PageType;
  icp: IcpStatus;
  observedFacts: number;
  score: number;
  scoreThreshold: number;
  hasSourcedPersonalization: boolean;
}): PriorityCheck {
  const blockers: string[] = [];

  if (!input.identity) blockers.push('aucune identité d’entreprise établie');
  else {
    if (input.identity.identityConfidence < 0.5) {
      blockers.push(`identité trop incertaine (${input.identity.identityConfidence})`);
    }
    if (!nameMatchesDomain(input.identity.companyName, input.identity.canonicalDomain)) {
      // Non bloquant seul, mais compté : beaucoup de sociétés ont un domaine
      // sans rapport avec leur nom. On l'exige seulement en dessous d'une
      // confiance élevée.
      if (input.identity.identityConfidence < 0.75) {
        blockers.push('nom et domaine sans rapport, et identité peu confirmée');
      }
    }
  }

  if (input.pageType !== 'OFFICIAL_COMPANY_SITE') {
    blockers.push(`page de type ${input.pageType} : ce n’est pas le site de l’entreprise`);
  }
  if (input.icp !== 'MATCH') {
    blockers.push(`profil ${input.icp} : seul MATCH peut être prioritaire`);
  }
  if (input.observedFacts < 2) {
    blockers.push(`${input.observedFacts} fait(s) observé(s) — deux au minimum`);
  }
  if (input.score < input.scoreThreshold) {
    blockers.push(`score ${input.score} sous le seuil ${input.scoreThreshold}`);
  }
  if (!input.hasSourcedPersonalization) {
    blockers.push('aucune personnalisation appuyée sur une source');
  }

  return { eligible: blockers.length === 0, blockers };
}
