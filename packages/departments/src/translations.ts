/**
 * Les traductions françaises des preuves, par identifiant.
 *
 * Écrites à la main, relues, et versionnées avec le code. Ce n'est pas un
 * cache : c'est une décision éditoriale par affirmation, sur des entreprises
 * réelles dont on dit quelque chose à un client qui paie.
 *
 * Trois règles ont guidé chaque ligne :
 *
 *   1. **On traduit, on ne reformule pas.** « described as Germany's oldest
 *      specialist » devient « présentée comme le plus ancien spécialiste
 *      allemand » — la distance de l'énonciateur est dans le texte source,
 *      elle reste dans la traduction. La perdre transformerait une revendication
 *      de l'entreprise en constat d'ATLAS.
 *   2. **Le vocabulaire technique est traduit, pas anglicisé.** « carton
 *      erectors » sont des formeuses de caisses, « strapping machines » des
 *      cercleuses. Un client qui lit « strapping machines » dans un document
 *      français comprend qu'on n'a pas lu ce qu'on lui vend.
 *   3. **Ce qui est cité entre guillemets dans la source le reste.**
 *      « jahrzehntelange Erfahrung » est conservé avec sa glose : c'est ce que
 *      le site dit, et le client peut aller le vérifier mot pour mot.
 *
 * L'original n'est jamais remplacé. Le rendu affiche les deux, parce que
 * l'original est la seule chose que le client peut confronter à la source.
 */

export interface EvidenceTranslation {
  /** L'identifiant de la preuve traduite — le lien avec sa source et sa nature. */
  evidenceId: string;
  french: string;
  /** Qui a traduit. Une traduction est un acte éditorial, elle a un auteur. */
  translatedBy: string;
}

export const EVIDENCE_TRANSLATIONS: readonly EvidenceTranslation[] = [
  // ── Burghardt Verpackungsmaschinen ──────────────────────────────────────
  {
    evidenceId: 'evd_01M06ZZZ07FA93E5F50AFKE5Z9',
    french: 'Contact public : téléphone +49 (0)711 60 18 74 10.',
    translatedBy: 'atlas-editorial',
  },
  {
    evidenceId: 'evd_01M06ZZZ06BATNFRVVVYF3RDMK',
    french:
      'Burghardt Verpackungsmaschinen exploite un site de vente en ligne actif, proposant ' +
      'des machines et des systèmes d’emballage à une clientèle industrielle.',
    translatedBy: 'atlas-editorial',
  },
  {
    evidenceId: 'evd_01M06ZZZ06GW18SW0JFN5B16E4',
    french:
      'Intégrateur proposant des lignes d’emballage complètes — du composant à l’intégration ' +
      'système — avec des prestations de conseil en conception, d’assemblage sur mesure et ' +
      'd’accompagnement applicatif multi-secteurs (chimie, pharmacie, agroalimentaire, ' +
      'électronique, automobile, aéronautique, logistique, etc.).',
    translatedBy: 'atlas-editorial',
  },
  {
    evidenceId: 'evd_01M06ZZZ075XXAKTADSG6037TW',
    french:
      'Propose des prestations d’intégration en mode conseil, avec une expertise en conception ' +
      'de lignes d’emballage, en sélection de composants et en assemblage de lignes complètes, ' +
      'appuyée sur « jahrzehntelange Erfahrung » (des décennies d’expérience).',
    translatedBy: 'atlas-editorial',
  },

  // ── Hagenauer+Denk KG ───────────────────────────────────────────────────
  {
    evidenceId: 'evd_01M06ZZZ05H7ZAKBP0X79PZ2W2',
    french: 'Contact public : téléphone +49 8323 96600, courriel info@hagenauer-denk.de.',
    translatedBy: 'atlas-editorial',
  },
  {
    evidenceId: 'evd_01M06ZZZ052REBEWFZPDMCYH39',
    french:
      'Hagenauer+Denk KG est une société allemande immatriculée, dont les coordonnées complètes, ' +
      'le site actif et l’adresse d’établissement sont documentés : Albert-Denk-Str. 2, ' +
      'D-87509 Immenstadt.',
    translatedBy: 'atlas-editorial',
  },
  {
    evidenceId: 'evd_01M06ZZZ05FGRWCTBM8WBP1664',
    french:
      'Fondée en 1803 (« Seit 1803 »), présentée comme le plus ancien spécialiste allemand des ' +
      'installations d’emballage, avec une activité de conseil, des retours d’expérience clients ' +
      'et une offre de service complète.',
    translatedBy: 'atlas-editorial',
  },
  {
    evidenceId: 'evd_01M06ZZZ05NG3YZ4QA7MCM4PP6',
    french:
      'Distributeur et intégrateur de solutions d’emballage complètes : formeuses de caisses, ' +
      'fermeuses de caisses, cercleuses, banderoleuses de palettes, robots collaboratifs, ' +
      'palettiseurs, convoyeurs et lignes d’emballage modulaires — du composant à l’intégration ' +
      'système.',
    translatedBy: 'atlas-editorial',
  },
];

/** Les traductions sous la forme attendue par le rapport : identifiant → texte. */
export function translationMap(
  translations: readonly EvidenceTranslation[] = EVIDENCE_TRANSLATIONS,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const t of translations) map[t.evidenceId] = t.french;
  return map;
}

/**
 * Les contrôles de qualification, traduits — et ramenés à leurs preuves.
 *
 * Deux corrections distinctes, faites au même endroit parce qu'elles portent
 * sur le même texte :
 *
 *   **La langue.** Les contrôles de Burghardt étaient rédigés en allemand, ceux
 *   de Hagenauer en français émaillé d'anglais. Le livrable client est
 *   français ; seules les citations de la source restent dans leur langue.
 *
 *   **La portée.** Le contrôle « Capacité à représenter auprès d'industriels »
 *   concluait « positionner pour servir des clients industriels *français* »
 *   sur une preuve qui ne parle que de l'ancienneté de l'entreprise. Aucune
 *   présence, équipe, référence ou partenaire français n'est attesté nulle
 *   part. La formulation retenue dit ce que la preuve porte, et rien de plus —
 *   ce qui manque est déclaré dans `UNVERIFIED_POINTS`.
 *
 * Le libellé d'origine n'est jamais supprimé : le rapport affiche les deux,
 * comme pour les preuves.
 */
export interface CheckTranslation {
  /** Le libellé d'origine, tel qu'il sert de clé. */
  criterion: string;
  criterionFr: string;
  detailFr: string;
  translatedBy: string;
}

export const CHECK_TRANSLATIONS: readonly CheckTranslation[] = [
  {
    criterion: 'Sitz in Deutschland',
    criterionFr: 'Siège en Allemagne',
    detailFr:
      'L’entreprise a son siège à Stuttgart, en Allemagne, et exploite un site actif.',
    translatedBy: 'atlas-editorial',
  },
  {
    criterion: 'Distributor oder Integrator von Verpackungsmaschinen',
    criterionFr: 'Distributeur ou intégrateur de machines d’emballage',
    detailFr:
      'Propose des lignes d’emballage complètes, du composant à l’intégration système, ' +
      'avec des prestations d’intégration étendues.',
    translatedBy: 'atlas-editorial',
  },
  {
    criterion: 'B2B-Industriekompetenz',
    criterionFr: 'Compétence industrielle B2B',
    detailFr:
      'Des décennies d’expérience en conception de lignes d’emballage, en sélection de ' +
      'composants et en montage, avec un accompagnement multi-secteurs (chimie, pharmacie, ' +
      'agroalimentaire, électronique, automobile, aéronautique et spatial, logistique).',
    translatedBy: 'atlas-editorial',
  },
  {
    criterion: 'Kontaktierbarkeit und aktive Geschäftstätigkeit',
    criterionFr: 'Joignabilité et activité effective',
    detailFr:
      'Coordonnées publiques disponibles (+49 (0)711 60 18 74 10) et site de vente en ligne ' +
      'actif à destination de clients industriels.',
    translatedBy: 'atlas-editorial',
  },
  {
    criterion: 'Localisation en Allemagne',
    criterionFr: 'Localisation en Allemagne',
    detailFr:
      'Hagenauer+Denk KG est enregistrée et basée en Allemagne, à Immenstadt (Bavière), ' +
      'avec une adresse complète et un site actif.',
    translatedBy: 'atlas-editorial',
  },
  {
    criterion: 'Rôle de distributeur',
    criterionFr: 'Rôle de distributeur',
    detailFr:
      'L’entreprise est explicitement identifiée comme distributeur de solutions d’emballage ' +
      'complètes, avec une gamme documentée.',
    translatedBy: 'atlas-editorial',
  },
  {
    criterion: 'Rôle d’intégrateur',
    criterionFr: 'Rôle d’intégrateur',
    detailFr:
      'L’entreprise est confirmée comme intégrateur, capable d’assembler des solutions ' +
      'modulaires et complètes d’emballage, du composant à l’intégration système.',
    translatedBy: 'atlas-editorial',
  },
  {
    criterion: 'Expertise en emballage industriel B2B',
    criterionFr: 'Expertise en emballage industriel B2B',
    detailFr:
      'Spécialiste reconnue des systèmes d’emballage, active depuis 1803, avec une gamme ' +
      'complète de machines et d’automatismes pour applications industrielles.',
    translatedBy: 'atlas-editorial',
  },
  {
    // Le contrôle qui dépassait sa preuve. La mention « clients industriels
    // français » est retirée : elle ne repose sur rien, et elle figure
    // désormais parmi les points non établis.
    criterion: 'Capacité à représenter auprès d’industriels',
    criterionFr: 'Capacité à représenter une offre auprès d’industriels',
    detailFr:
      'Historique établi de spécialiste allemand, avec une activité de conseil, des retours ' +
      'd’expérience clients documentés et une offre de services complète. Aucun de ces ' +
      'éléments ne porte sur le marché français.',
    translatedBy: 'atlas-editorial',
  },
];

/**
 * Ce que la mission demandait et qu'aucune preuve n'établit.
 *
 * Déclaré à la main, jamais déduit. Une absence de preuve ne se calcule pas :
 * elle se constate en confrontant ce qu'on cherchait à ce qu'on a trouvé, et
 * c'est un travail de relecture.
 *
 * Ces points ne sont pas des défauts des entreprises. Ce sont les questions
 * qu'un premier appel tranchera en cinq minutes, et les écrire évite au client
 * de croire qu'elles sont déjà réglées.
 */
export const UNVERIFIED_POINTS: readonly string[] = [
  'Présence commerciale en France : aucun bureau, filiale, agent ou showroom français n’est attesté par les sources consultées.',
  'Clients français : aucune référence, étude de cas ou mention de client français n’a été trouvée.',
  'Partenaires français : aucun accord de distribution ou partenariat avec une entreprise française n’est documenté.',
  'Équipe francophone : rien n’indique la présence d’interlocuteurs de langue française.',
  'Interlocuteur nommé : les coordonnées publiées sont celles d’un standard, aucune personne n’est identifiée.',
];

/** Les traductions de contrôles, par libellé d'origine. */
export function checkTranslationMap(
  translations: readonly CheckTranslation[] = CHECK_TRANSLATIONS,
): Record<string, { criterion: string; detail: string }> {
  const map: Record<string, { criterion: string; detail: string }> = {};
  for (const t of translations) {
    map[normaliseCriterion(t.criterion)] = { criterion: t.criterionFr, detail: t.detailFr };
  }
  return map;
}

/**
 * Rapproche deux écritures d'un même libellé.
 *
 * Les apostrophes typographiques et droites coexistent dans les données selon
 * qui a écrit la ligne ; sans normalisation, « Rôle d'intégrateur » et
 * « Rôle d’intégrateur » seraient deux critères différents et l'un des deux
 * resterait sans traduction.
 */
export const normaliseCriterion = (text: string): string =>
  text.replace(/[’']/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
