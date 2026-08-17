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
