/**
 * Une phrase annoncée comme publiée sur un site doit s'y trouver.
 *
 * Le message d'approche écrit : « j'ai relevé ceci, publié sur votre site : … ».
 * C'est l'argument central de l'offre — chaque affirmation est vérifiable d'un
 * clic. Il suffit qu'une seule ne le soit pas pour que tout le reste devienne
 * douteux, et le destinataire qui ouvre la source le voit en dix secondes.
 *
 * Or deux natures de texte coexistent dans les preuves d'ATLAS :
 *
 *   · Ce qu'un extracteur a relevé mot pour mot sur une page. Vérifiable.
 *   · Ce qu'un modèle a écrit en résumant ce qu'il avait lu — « Intégrateur
 *     d'automatisme industriel avec solutions IOT et maintenance prédictive ».
 *     Juste, peut-être. Introuvable sur la page, sûrement.
 *
 * Les deux étaient enregistrées comme `observed`, avec une adresse source, et
 * rien ne les distinguait au moment de composer le message. Ce module les
 * sépare : il vérifie que la proposition citée se retrouve réellement dans le
 * texte de sa source.
 *
 * La comparaison est volontairement tolérante sur la forme — accents, entités
 * HTML, ponctuation, espaces — et stricte sur le fond : les mots porteurs de la
 * phrase doivent être là, dans la source, groupés. Un résumé qui reformule tout
 * échoue ; une citation dont on a nettoyé les guillemets passe.
 */

/** Ce que la vérification a conclu, et pourquoi. */
export interface ClaimCheck {
  verifiable: boolean;
  /** Part des mots porteurs retrouvés dans la source, entre 0 et 1. */
  overlap: number;
  reason: string;
}

/**
 * Décode les entités HTML avant toute comparaison.
 *
 * Sans cela, une page qui écrit `Fabricant&#x20;de&#x20;machines` ne contient
 * jamais « Fabricant de machines », et une citation parfaitement exacte serait
 * rejetée. Relevé tel quel sur europe-industrie.fr.
 */
export function decodeEntities(raw: string): string {
  return raw
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&laquo;|&raquo;/gi, '"')
    // Les entites typographiques courantes. Sans elles, « Harmony Beton
    // &mdash; Fabricant » se citerait avec son `&mdash;` en toutes lettres, et
    // un tiret cadratin non decode suffit a faire echouer une comparaison
    // parfaitement exacte.
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&bull;/gi, '•')
    .replace(/&middot;/gi, '·')
    .replace(/&deg;/gi, '°')
    .replace(/&euro;/gi, '€')
    .replace(/&times;/gi, '×')
    .replace(/&reg;/gi, '®')
    .replace(/&copy;/gi, '©')
    .replace(/&trade;/gi, '™')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&(?:e|E)acute;/g, 'é')
    .replace(/&(?:e|E)grave;/g, 'è')
    .replace(/&ecirc;/gi, 'ê')
    .replace(/&agrave;/gi, 'à')
    .replace(/&acirc;/gi, 'â')
    .replace(/&ccedil;/gi, 'ç')
    .replace(/&ugrave;/gi, 'ù')
    .replace(/&ucirc;/gi, 'û')
    .replace(/&ocirc;/gi, 'ô')
    .replace(/&icirc;/gi, 'î')
    .replace(/&iuml;/gi, 'ï')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(Number(dec)));
}

/** Réduit un texte à ce qui compte pour la comparaison. */
const aplatir = (raw: string): string =>
  decodeEntities(raw)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Les mots vides du français et de l'anglais.
 *
 * Les compter dans le recouvrement gonflerait tous les scores : deux textes
 * français partagent toujours « de », « la », « et ». Ce sont les mots porteurs
 * qui disent si la phrase vient de la page.
 */
const VIDES = new Set([
  'de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'et', 'ou', 'en', 'a', 'au',
  'aux', 'dans', 'sur', 'pour', 'par', 'avec', 'sans', 'nos', 'notre', 'votre',
  'vos', 'ses', 'son', 'sa', 'ce', 'cet', 'cette', 'qui', 'que', 'est', 'sont',
  'plus', 'tout', 'tous', 'toute', 'ainsi', 'aussi', 'the', 'and', 'of', 'to',
  'in', 'for', 'with', 'our', 'we', 'is', 'are', 'from', 'their', 'its', 'on',
  'by', 'at', 'as', 'an',
]);

const porteurs = (texte: string): string[] =>
  aplatir(texte)
    .split(' ')
    .filter((mot) => mot.length >= 4 && !VIDES.has(mot));

/**
 * La proposition citée se retrouve-t-elle dans le texte de la source ?
 *
 * Le seuil vaut 0,8 : quatre mots porteurs sur cinq doivent être présents. En
 * dessous, on ne cite plus — on résume, et le message ne peut plus annoncer que
 * la phrase est publiée sur le site.
 */
export function verifyClaimAgainstSource(
  claim: string,
  sourceText: string,
  seuil = 0.8,
): ClaimCheck {
  const mots = porteurs(claim);
  if (mots.length === 0) {
    return { verifiable: false, overlap: 0, reason: 'la citation ne porte aucun mot significatif' };
  }
  const source = ` ${aplatir(sourceText)} `;
  if (source.trim().length === 0) {
    return { verifiable: false, overlap: 0, reason: 'source vide : rien à vérifier' };
  }

  const trouves = mots.filter((mot) => source.includes(` ${mot} `));
  const overlap = Math.round((trouves.length / mots.length) * 100) / 100;

  if (overlap < seuil) {
    const manquants = mots.filter((m) => !source.includes(` ${m} `)).slice(0, 4);
    return {
      verifiable: false,
      overlap,
      reason:
        `${Math.round(overlap * 100)} % des mots porteurs retrouvés — reformulation, pas citation` +
        (manquants.length > 0 ? ` (absents : ${manquants.join(', ')})` : ''),
    };
  }
  return {
    verifiable: true,
    overlap,
    reason: `${Math.round(overlap * 100)} % des mots porteurs retrouvés dans la source`,
  };
}

/** Le texte lisible d'une page, pour la comparaison. */
export function readableText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}
