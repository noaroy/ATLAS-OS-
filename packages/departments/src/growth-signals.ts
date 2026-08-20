/**
 * Relever, sur le site d'une entreprise, ce qui trahit un besoin commercial.
 *
 * Le score de conversion s'est heurté à un vide : les faits stockés décrivaient
 * ce que les entreprises *font*, parce que la qualification cherchait
 * l'adéquation au profil. Aucun ne disait si elles cherchent des clients. Le
 * score notait donc une absence de preuve, pas une absence de besoin — et les
 * deux se ressemblent dangereusement.
 *
 * Ce module lit les pages déjà récupérées et y cherche des formulations
 * précises. Il ne résume pas, ne paraphrase pas, n'interprète pas : il rend la
 * phrase telle qu'elle est écrite, avec l'adresse de la page. Un « ils
 * cherchent sans doute à se développer » n'a aucune place ici ; « devenir
 * distributeur » écrit noir sur blanc en a une.
 *
 * Aucun modèle n'intervient. Une expression régulière qui se trompe se corrige
 * et se teste ; une intuition de modèle sur le besoin d'un inconnu ne se
 * vérifie qu'après l'envoi.
 */

export type GrowthSignalKind =
  /** Cherche des revendeurs, des partenaires, des agents. */
  | 'DISTRIBUTION'
  /** Vend ou veut vendre hors de France. */
  | 'EXPORT'
  /** Recrute une fonction commerciale. */
  | 'SALES_HIRING'
  /** Annonce une nouveauté à faire connaître : produit, atelier, gamme. */
  | 'NEW_CAPACITY'
  /** Nomme les secteurs qu'elle sert — donc on sait qui lui présenter. */
  | 'NAMED_MARKETS';

export interface GrowthSignal {
  kind: GrowthSignalKind;
  /** La phrase telle qu'elle figure sur la page, resserrée autour du motif. */
  quote: string;
  /** Le motif qui l'a fait remarquer, pour qu'un humain puisse contester. */
  marker: string;
  sourceUrl: string;
}

/**
 * Les formulations cherchées, par nature de signal.
 *
 * Volontairement littérales et peu nombreuses. Élargir la liste augmenterait
 * le nombre de signaux et diminuerait ce que chacun vaut : c'est le compromis
 * qu'on refuse ici, parce qu'un signal faible sert ensuite de justification à
 * un message.
 */
const PATTERNS: ReadonlyArray<{ kind: GrowthSignalKind; markers: readonly string[] }> = [
  {
    kind: 'DISTRIBUTION',
    markers: [
      'devenir distributeur', 'devenir revendeur', 'devenir partenaire',
      'nos distributeurs', 'reseau de distributeurs', 'reseau de revendeurs',
      'nous recherchons des distributeurs', 'nous recherchons des partenaires',
      'rejoindre notre reseau', 'espace revendeur', 'espace distributeur',
    ],
  },
  {
    kind: 'EXPORT',
    // « export » seul est trop large : il capte « exporter vos donnees » dans
    // une politique de cookies. Un signal faux devient une phrase fausse dans
    // un vrai courriel, ce qui coute plus cher qu'un signal manquant.
    markers: [
      'a l export', 'a l international', 'nos clients a l etranger',
      'marches a l export', 'developpement export', 'service export',
      'exportons', 'exportateur', 'presents dans plusieurs pays',
      'implantes dans plusieurs pays', 'filiales a l etranger',
    ],
  },
  {
    kind: 'SALES_HIRING',
    markers: [
      'technico-commercial', 'attache commercial', 'ingenieur commercial',
      'charge d affaires', 'responsable commercial', 'developpement commercial',
      'nous recrutons', 'offre d emploi commercial',
    ],
  },
  {
    kind: 'NEW_CAPACITY',
    markers: [
      'nouvelle gamme', 'nouveau produit', 'nouvel atelier', 'nouvelle machine',
      'nous investissons', 'agrandissement', 'nouvelle unite', 'certification',
    ],
  },
  {
    kind: 'NAMED_MARKETS',
    markers: [
      'nos secteurs', 'secteurs d activite', 'domaines d intervention',
      'nos marches', 'nos clients', 'nos references', 'applications',
      'agroalimentaire', 'aeronautique', 'automobile', 'pharmaceutique',
      'cosmetique', 'ferroviaire', 'medical', 'nucleaire', 'defense',
    ],
  },
];

const strip = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // Les entités doivent partir : une phrase citée dans un courriel avec
    // « r&eacute;guli&egrave;rement » dedans annonce la machine qui l'a écrite.
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&(?:e|E)acute;/g, 'é')
    .replace(/&(?:e|E)grave;/g, 'è')
    .replace(/&ecirc;/g, 'ê')
    .replace(/&agrave;/g, 'à')
    .replace(/&acirc;/g, 'â')
    .replace(/&ccedil;/g, 'ç')
    .replace(/&ugrave;/g, 'ù')
    .replace(/&ucirc;/g, 'û')
    .replace(/&ocirc;/g, 'ô')
    .replace(/&icirc;/g, 'î')
    .replace(/&iuml;/g, 'ï')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Le vocabulaire qui disqualifie une phrase, quel que soit le motif trouvé.
 *
 * Les mentions légales, la politique de cookies et le RGPD contiennent
 * « exporter », « pays », « secteurs » — et n'ont jamais rien dit d'un besoin
 * commercial. Une phrase qui vient de là ne se cite pas.
 */
const NOT_A_SIGNAL = [
  'cookie', 'rgpd', 'donnees personnelles', 'donnee personnelle',
  'politique de confidentialite', 'mentions legales', 'hebergeur',
  'droit d acces', 'traitement des donnees', 'consentement',
  'conditions generales', 'propriete intellectuelle', 'navigateur',
  // Un formulaire n'est pas une phrase : « Type of request * Required field
  // please select » a été retenu comme personnalisation pour Stabilus.
  'required field', 'champ obligatoire', 'please select', 'veuillez selectionner',
  'type of request', 'votre message', 'nom prenom', 'saisissez',
  // Relevé sur efa-controls : une phrase de conformité citée comme signal
  // commercial. « Europe » y figure, et rien d'autre.
  'privacy framework', 'commission europeenne', 'decision d adequation',
  'sous-traitant au sens', 'responsable de traitement', 'finalite du traitement',
];

/**
 * Ce qui disqualifie une page entière, et non une phrase.
 *
 * « Usine de France » nomme quinze secteurs industriels et donnait donc un
 * signal « marchés nommés » parfait — pour un annuaire. Le défaut n'était pas
 * dans la phrase mais dans la page : sur un site qui recense des entreprises,
 * aucune phrase ne parle de l'entreprise qui le publie.
 */
const NOT_A_COMPANY_PAGE = [
  'annuaire', 'referencer votre entreprise', 'inscrivez votre entreprise',
  'trouvez l usine', 'trouvez le fournisseur', 'comparateur',
  'moteur de recherche d entreprises', 'liste des entreprises',
];

const fold = (text: string): string =>
  text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, ' ');

/**
 * Découpe autour du motif une phrase lisible par un humain.
 *
 * Le point compte : c'est cette phrase qui deviendra la personnalisation du
 * message. Un fragment tronqué au milieu d'un mot produirait un « j'ai vu que
 * vous… » embarrassant, ce qui est pire que pas de personnalisation du tout.
 */
function sentenceAround(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf('.', index) + 1);
  const dot = text.indexOf('.', index);
  const end = dot === -1 ? Math.min(text.length, index + 180) : Math.min(dot + 1, index + 220);
  return text.slice(start, end).trim().replace(/\s+/g, ' ');
}

export function findGrowthSignals(
  pages: ReadonlyArray<{ url: string; html: string }>,
  options: { maxPerKind?: number } = {},
): GrowthSignal[] {
  const maxPerKind = options.maxPerKind ?? 1;
  const found: GrowthSignal[] = [];
  const counts = new Map<GrowthSignalKind, number>();

  for (const page of pages) {
    const text = strip(page.html);
    const folded = fold(text);
    if (NOT_A_COMPANY_PAGE.some((bad) => folded.includes(bad))) continue;

    for (const pattern of PATTERNS) {
      if ((counts.get(pattern.kind) ?? 0) >= maxPerKind) continue;
      for (const marker of pattern.markers) {
        const index = folded.indexOf(fold(marker));
        if (index === -1) continue;

        const quote = sentenceAround(text, index);
        // Une phrase trop courte ne prouve rien et ne se cite pas ; une phrase
        // trop longue est un paragraphe entier collé dans un message.
        if (quote.length < 25 || quote.length > 260) continue;
        // Une accumulation de mots sans verbe est une liste de menu ou de
        // champs, pas une phrase qu'on peut citer.
        if ((quote.match(/\*/g) ?? []).length >= 2) continue;
        if (/&[a-z]+;|&#\d+;/i.test(quote)) continue;
        const foldedQuote = fold(quote);
        if (NOT_A_SIGNAL.some((bad) => foldedQuote.includes(bad))) continue;
        // La même exigence que pour une citation d'ouverture : ce qui n'est
        // pas une phrase n'est pas un signal. La garde vivait à côté du chemin
        // qu'elle devait protéger.
        if (!readsAsSentence(cleanQuote(quote))) continue;

        found.push({ kind: pattern.kind, quote: cleanQuote(quote), marker, sourceUrl: page.url });
        counts.set(pattern.kind, (counts.get(pattern.kind) ?? 0) + 1);
        break;
      }
    }
  }
  return found;
}

/**
 * Nettoie une citation avant qu'elle serve d'ouverture à un message.
 *
 * Les sites décorent leurs titres — émojis, puces, chevrons. Repris tels quels
 * dans un courriel, ils font de la phrase un copier-coller visible : « 🍽️
 * Agroalimentaire & Embouteillage… » annonce la machine avant la deuxième
 * ligne. Le texte lui-même n'est pas retouché : on retire l'ornement, on ne
 * reformule pas.
 */
export function cleanQuote(quote: string): string {
  return quote
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, ' ')
    .replace(/[\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu, ' ')
    .replace(/^[\s•·▪▶>«»–—-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Les fragments de navigation qui ne sont jamais une phrase du site. */
const NAVIGATION = [
  'contactez-nous', 'en savoir plus', 'lire la suite', 'accueil', 'menu',
  'nos services', 'voir tous', 'demander un devis', 'newsletter',
  'suivez-nous', 'plan du site', 'retour', 'cliquez',
  'qui suis-je', 'nos realisations', 'nos produits', 'notre equipe',
  // Le squelette d'une page : relevé pour de vrai comme « fait observé » —
  // « Passer au contenu Rechercher: Qui sommes nous ? »
  'passer au contenu', 'aller au contenu', 'rechercher', 'qui sommes nous',
  'mon compte', 'panier', 'connexion', 'inscription', 'partager',
];

/**
 * Cette citation se lit-elle comme une phrase ?
 *
 * Un titre de rubrique — « Agroalimentaire & Embouteillage Tests
 * d'étanchéité » — passe tous les autres filtres et fait pourtant un mauvais
 * début de message : personne n'écrit ainsi. La proportion de mots capitalisés
 * les sépare, sans avoir à analyser la grammaire : une phrase a une majuscule
 * au début et peu ailleurs, un titre en a partout.
 */
export function readsAsSentence(quote: string): boolean {
  const words = quote.split(/\s+/).filter((w) => w.length > 1);
  if (words.length < 8) return false;
  if (NAVIGATION.some((nav) => quote.toLowerCase().includes(nav))) return false;

  const capitalised = words.filter((w) => /^[A-ZÀ-Ü]/.test(w)).length;
  if (capitalised / words.length > 0.4) return false;

  // Un menu recopié en ligne : « En savoir plus Nos clients Accueil
  // Développement industriel … Qui suis-je ? Contact ». Aucun de ces mots
  // n'est disqualifiant seul ; trois ensemble le sont.
  const MENU_WORDS = ['accueil', 'contact', 'nos clients', 'en savoir plus', 'projets',
    'le bureau', 'qui suis', 'mentions', 'blog', 'actualites', 'services'];
  const hits = MENU_WORDS.filter((w) => quote.toLowerCase().includes(w)).length;
  if (hits >= 3) return false;
  // Une phrase contient au moins un mot de liaison : sans cela, c'est une
  // énumération.
  return /\b(de|des|du|le|la|les|et|en|pour|dans|avec|nos|notre|qui|que)\b/i.test(quote);
}

/** Le libellé lisible d'un signal, pour un rapport de revue. */
export const SIGNAL_LABELS: Record<GrowthSignalKind, string> = {
  DISTRIBUTION: 'cherche des distributeurs ou partenaires',
  EXPORT: 'vend ou vise l’étranger',
  SALES_HIRING: 'renforce sa force commerciale',
  NEW_CAPACITY: 'a une nouveauté à faire connaître',
  NAMED_MARKETS: 'nomme les secteurs qu’elle sert',
};
