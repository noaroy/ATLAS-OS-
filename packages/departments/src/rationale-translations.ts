/**
 * Les justifications de notation, en français.
 *
 * Elles étaient rédigées en français émaillé d'anglais — « carton erectors »,
 * « consultancy », « packaging machinery ». Un client qui lit ces termes dans
 * un document français en conclut qu'on n'a pas relu ce qu'on lui vend.
 *
 * Le fond n'est pas retouché, et il est solide : les justifications
 * géographiques disent d'elles-mêmes qu'aucune présence française n'est
 * attestée — c'est le résumé libre qui les contredisait, pas elles.
 *
 * Une seule formulation a été resserrée. « correspondant aux industriels
 * français typiques du marché » devient « les mêmes familles d'industriels que
 * celles visées en France » : la parenté sectorielle est réelle, une clientèle
 * française existante ne l'est pas, et la première tournure laissait entendre
 * la seconde.
 *
 * La clé associe l'entreprise et la dimension. Un identifiant technique serait
 * plus court, mais illisible pour qui relit — et c'est justement une table que
 * l'on relit.
 */

export interface RationaleTranslation {
  company: string;
  dimension: string;
  french: string;
  /** Une traduction est un acte éditorial : elle a un auteur. */
  translatedBy: string;
}

export const RATIONALE_TRANSLATIONS: readonly RationaleTranslation[] = [
  {
    company: 'Burghardt Verpackungsmaschinen',
    dimension: 'sector-fit',
    french:
      'Burghardt propose des solutions d’intégration complètes pour le secteur de l’emballage ' +
      'industriel : machines d’emballage et intégration de systèmes. Son portefeuille atteste ' +
      'une présence établie auprès de secteurs diversifiés — chimie, pharmacie, agroalimentaire, ' +
      'électronique, automobile, aéronautique, logistique — soit les mêmes familles ' +
      'd’industriels que celles visées en France. La spécialisation en machines et en conception ' +
      'de lignes d’emballage confirme une connaissance approfondie du secteur cible.',
    translatedBy: 'atlas-editorial',
  },
  {
    company: 'Burghardt Verpackungsmaschinen',
    dimension: 'geographic-fit',
    french:
      'Burghardt est basée à Stuttgart, en Allemagne, avec une activité effective : site de ' +
      'vente en ligne opérationnel, coordonnées téléphoniques vérifiées. Pour couvrir le ' +
      'territoire français visé, aucune présence réelle en France n’est attestée. La proximité ' +
      'allemande offre une accessibilité géographique acceptable, mais non optimale pour des ' +
      'ventes régulières en B2B français. Aucune trace de bureau, d’équipe commerciale ni de ' +
      'partenaire français.',
    translatedBy: 'atlas-editorial',
  },
  {
    company: 'Burghardt Verpackungsmaschinen',
    dimension: 'commercial-reach',
    french:
      'Burghardt dispose d’une infrastructure commerciale active : site de vente en ligne ' +
      'fonctionnel, téléphone publié, prestations de conseil intégrées qui laissent supposer une ' +
      'équipe technique et commerciale. L’expérience de plusieurs décennies et la diversité ' +
      'sectorielle indiquent un parc installé. En revanche, aucune trace de présence sur des ' +
      'salons français majeurs, de références commerciales documentées, ni de la taille exacte ' +
      'de l’équipe de vente.',
    translatedBy: 'atlas-editorial',
  },
  {
    company: 'Hagenauer+Denk KG',
    dimension: 'sector-fit',
    french:
      'Hagenauer+Denk possède une expertise établie en solutions d’emballage complètes : ' +
      'formeuses de caisses, fermeuses de caisses, cercleuses, banderoleuses de palettes, ' +
      'palettiseurs, convoyeurs. Ces équipements servent directement les secteurs industriels ' +
      'français — production, logistique, biens de grande consommation — qui achètent de ' +
      'l’emballage B2B. Le portefeuille couvre les machines et les intégrations qu’utilisent ' +
      'les clients cibles, sans ambiguïté sectorielle.',
    translatedBy: 'atlas-editorial',
  },
  {
    company: 'Hagenauer+Denk KG',
    dimension: 'portfolio-fit',
    french:
      'Hagenauer+Denk commercialise des machines et des systèmes d’emballage complets : mise en ' +
      'caisse, cerclage, palettisation, convoyage. Une offre française d’emballage B2B ' +
      'industriel s’y intégrerait potentiellement en complémentarité — composants et machines, ' +
      'ou alternatives de gamme. Faute de détail sur les segments couverts (carton ondulé ou ' +
      'moulé, étiquettes, films), le positionnement exact reste à valider pour éviter une ' +
      'redondance ou un décalage.',
    translatedBy: 'atlas-editorial',
  },
  {
    company: 'Hagenauer+Denk KG',
    dimension: 'strategic-relevance',
    french:
      'Hagenauer+Denk, acteur allemand établi des machines d’emballage depuis 1803, ne présente ' +
      'aucune incitation stratégique documentée à se diversifier cette année vers une nouvelle ' +
      'offre française. Aucune déclaration d’expansion en France, aucun contexte de croissance ' +
      'affiché, aucun partenariat récent. Le candidat est performant sur son marché ; ' +
      'l’ouverture d’un nouveau segment français relèverait d’une opportunité commerciale, non ' +
      'd’un besoin stratégique visible.',
    translatedBy: 'atlas-editorial',
  },
  {
    company: 'Hagenauer+Denk KG',
    dimension: 'size-fit',
    french:
      'Entreprise fondée en 1803, active, avec un site complet, une activité de conseil et un ' +
      'portefeuille de solutions système — profil de PME ou d’ETI allemande solide. Assez grande ' +
      'pour assurer crédibilité et service technique, conseil et historique documentés. La ' +
      'taille n’étant pas précisée — ni chiffre d’affaires, ni effectifs — il est impossible ' +
      'd’affirmer qu’elle est assez petite pour que la France compte réellement pour elle. ' +
      'Risque : être trop absorbée par son marché allemand historique pour investir dans une ' +
      'nouvelle région.',
    translatedBy: 'atlas-editorial',
  },
];

/** Les justifications traduites, par « entreprise|dimension ». */
export function rationaleTranslationMap(
  translations: readonly RationaleTranslation[] = RATIONALE_TRANSLATIONS,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const t of translations) map[`${t.company}|${t.dimension}`] = t.french;
  return map;
}
