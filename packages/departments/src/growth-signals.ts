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
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
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
        const foldedQuote = fold(quote);
        if (NOT_A_SIGNAL.some((bad) => foldedQuote.includes(bad))) continue;

        found.push({ kind: pattern.kind, quote, marker, sourceUrl: page.url });
        counts.set(pattern.kind, (counts.get(pattern.kind) ?? 0) + 1);
        break;
      }
    }
  }
  return found;
}

/** Le libellé lisible d'un signal, pour un rapport de revue. */
export const SIGNAL_LABELS: Record<GrowthSignalKind, string> = {
  DISTRIBUTION: 'cherche des distributeurs ou partenaires',
  EXPORT: 'vend ou vise l’étranger',
  SALES_HIRING: 'renforce sa force commerciale',
  NEW_CAPACITY: 'a une nouveauté à faire connaître',
  NAMED_MARKETS: 'nomme les secteurs qu’elle sert',
};
