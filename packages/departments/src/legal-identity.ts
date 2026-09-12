import { whyNotACompanyName } from './sales-icp.ts';
import { isOfficialPage } from './contact-resolver.ts';

/**
 * Lire la raison sociale là où la loi oblige à l'écrire.
 *
 * Deux prospects du lot du 26/08/2026 avaient leurs deux faits sourcés, un
 * canal de contact public relevé, un score au-dessus du seuil — et n'ont produit
 * aucun brouillon. La garde qui les a arrêtés dit « nom et domaine sans rapport,
 * et identité peu confirmée ». Elle a raison : leur nom venait du titre du
 * résultat de recherche, et rien ne le confirmait. Écrire à
 * `contact@groupe-ledoux.com` en appelant l'entreprise « Cyberméca » sans avoir
 * vérifié le lien est exactement ce que la garde empêche.
 *
 * Ce module ne touche pas à la garde. Il lui apporte ce qu'elle réclame.
 *
 * Toute société française exerçant en ligne publie ses mentions légales :
 * dénomination, forme juridique, immatriculation. C'est une source de première
 * main, sur le domaine de l'entreprise, opposable — la meilleure preuve
 * d'identité disponible sans appeler personne.
 *
 * Aucun modèle n'intervient. Une raison sociale devinée par un modèle serait
 * plausible, et une entreprise mal nommée dans la première ligne d'un courriel
 * se remarque immédiatement.
 */

/** Ce qu'une page de mentions légales a livré. */
export interface LegalIdentity {
  /** La dénomination telle qu'elle est écrite, sans la forme juridique. */
  legalName: string;
  /** SARL, SAS, SASU… quand elle figure. */
  legalForm: string | null;
  /** Le numéro d'immatriculation relevé, preuve que la page en est bien une. */
  registration: string | null;
  /** Le motif qui a permis de l'extraire, pour qu'un humain puisse contester. */
  basis: string;
  sourceUrl: string;
}

/** Les chemins où une entreprise publie ses mentions légales. */
export const LEGAL_PATHS: readonly string[] = [
  '/mentions-legales', '/mentions-legales/', '/mentions-legales.html',
  '/mentions-legales.php', '/mentions_legales', '/mentionslegales',
  '/informations-legales', '/mentions', '/legal', '/legals', '/legal-notice',
  '/conditions-generales', '/cgv', '/cgu', '/impressum',
];

export function legalPagesFor(officialWebsite: string | null, domain: string | null): string[] {
  const base = officialWebsite?.trim() || (domain ? `https://${domain}` : null);
  if (!base) return [];
  let origin: string;
  try {
    origin = new URL(base.startsWith('http') ? base : `https://${base}`).origin;
  } catch {
    return [];
  }
  return LEGAL_PATHS.map((path) => `${origin}${path}`);
}

/** Les liens d'une page qui mènent aux mentions légales. */
const LEGAL_LINK = /(mentions?[-_ ]?l[ée]gales?|informations?[-_ ]?l[ée]gales?|legal[-_ ]?notice|impressum|\bcgv\b|\bcgu\b)/i;

export function legalLinksIn(html: string, pageUrl: string, officialDomain: string, max = 3): string[] {
  const found = new Set<string>();
  const anchor = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null) {
    const href = match[1]!;
    const text = match[2]!.replace(/<[^>]+>/g, ' ');
    if (!LEGAL_LINK.test(href) && !LEGAL_LINK.test(text)) continue;
    let absolute: string;
    try {
      absolute = new URL(href, pageUrl).href;
    } catch {
      continue;
    }
    if (!absolute.startsWith('https://')) continue;
    if (!isOfficialPage(absolute, officialDomain)) continue;
    found.add(absolute.split('#')[0]!);
    if (found.size >= max) break;
  }
  return [...found];
}

const strip = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' . ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, ' . ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&(?:e|E)acute;/g, 'é')
    .replace(/&(?:e|E)grave;/g, 'è')
    .replace(/&agrave;/g, 'à')
    .replace(/&ccedil;/g, 'ç')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    // « S.A.R.L. », « S.A.S. » : la forme pointee est courante et ne
    // correspondait a aucun motif. Relevee telle quelle sur groupe-ledoux.com.
    .replace(/S\.?A\.?R\.?L\.?(?=\s|,|$)/g, 'SARL')
    .replace(/S\.?A\.?S\.?U\.?(?=\s|,|$)/g, 'SASU')
    .replace(/S\.A\.S\.?(?=\s|,|$)/g, 'SAS')
    .replace(/E\.?U\.?R\.?L\.?(?=\s|,|$)/g, 'EURL')
    .trim();

const fold = (t: string): string =>
  t.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Cette page est-elle réellement une page de mentions légales ?
 *
 * La question n'est pas rhétorique : sans elle, la première page contenant
 * « SAS » quelque part fournirait une raison sociale. Une mention légale porte
 * un vocabulaire obligatoire, et c'est lui qu'on exige — pas le chemin de
 * l'URL, qu'un site peut nommer comme il veut.
 */
const LEGAL_MARKERS = [
  'mentions legales', 'mention legale', 'raison sociale', 'denomination sociale',
  'denomination', 'siret', 'siren', 'rcs', 'immatricul', 'numero de tva',
  'tva intracommunautaire', 'directeur de la publication', 'impressum',
  'informations legales',
];

export function looksLikeLegalNotice(html: string): boolean {
  const folded = fold(strip(html));
  return LEGAL_MARKERS.some((m) => folded.includes(m));
}

/** Les formes juridiques reconnues, écrites telles qu'on les rencontre. */
const FORMS = ['SASU', 'SARLU', 'SARL', 'SAS', 'EURL', 'EIRL', 'SNC', 'SCOP', 'SCIC', 'SCI', 'SA', 'SEM', 'GIE'];

/** Un numéro d'immatriculation : neuf ou quatorze chiffres, espacés ou non. */
const REGISTRATION = /\b(\d{3}[\s.]?\d{3}[\s.]?\d{3}(?:[\s.]?\d{5})?)\b/g;

/**
 * Le numero le plus precis que la page publie.
 *
 * Une page de mentions legales en porte souvent deux : le SIREN a neuf
 * chiffres dans la ligne RCS, puis le SIRET a quatorze. Prendre le premier
 * rencontre retenait le SIREN, qui identifie la societe ; le SIRET identifie
 * l'etablissement, et c'est celui qu'on peut rapprocher d'une adresse.
 */
function bestRegistration(text: string): string | null {
  const found = [...text.matchAll(REGISTRATION)].map((m) => m[1]!.replace(/[\s.]/g, ''));
  if (found.length === 0) return null;
  return found.find((n) => n.length === 14) ?? found[0]!;
}

/** Ce qui ne peut pas être une dénomination, même bien formé. */
const NOT_A_NAME = [
  'capital', 'siege social', 'adresse', 'telephone', 'courriel', 'email',
  'hebergeur', 'directeur', 'responsable', 'editeur', 'rcs', 'siret', 'siren',
  'tva', 'code postal', 'france', 'tous droits',
  // Relevees sur de vrais sites : « Rue Thomas Edison SARL » a ete extrait de
  // europe-industrie.fr, ou l'adresse precede la forme juridique. Une voie
  // n'est pas une denomination, meme suivie d'un sigle.
  'rue ', 'avenue', 'boulevard', 'allee', 'chemin', 'impasse', 'place ',
  'route ', 'quai ', 'cours ', 'zone ', ' za ', ' zi ', 'parc d', 'lieu-dit',
];

/**
 * Les sections d'une page de mentions legales, et celle qui nous interesse.
 *
 * Une page en decrit plusieurs entites : l'editeur du site, son hebergeur, son
 * agence de realisation. Sur le-sur-mesure-industriel.fr, la seule societe
 * immatriculee citee est Digidream — l'agence qui a fait le site. Extraire sans
 * distinguer les sections nommait donc l'entreprise d'apres son prestataire, ce
 * qui aurait produit un courriel adresse a la mauvaise societe.
 */
const EDITOR_MARKERS = [
  'editeur du site', 'edite par', 'editeur', 'proprietaire du site',
  'proprietaire', 'raison sociale', 'denomination sociale', 'denomination',
  'la societe', 'ce site est edite',
];
const OTHER_SECTION_MARKERS = [
  'hebergement', 'hebergeur', 'realisation', 'conception du site', 'credits',
  'credit photo', 'responsabilite', 'confidentialite', 'cookies', 'donnees',
  'propriete intellectuelle', 'litiges', 'droit applicable', 'developpement du site',
];

/**
 * Le passage qui parle de l'editeur, et lui seul.
 *
 * Rend `null` plutot qu'un texte approximatif quand aucune section ne se
 * detache : mieux vaut ne rien confirmer que confirmer la mauvaise societe.
 */
function editorSection(text: string): string | null {
  const folded = fold(text);
  let start = -1;
  for (const marker of EDITOR_MARKERS) {
    const at = folded.indexOf(marker);
    if (at !== -1 && (start === -1 || at < start)) start = at;
  }
  if (start === -1) return null;

  let end = text.length;
  for (const marker of OTHER_SECTION_MARKERS) {
    const at = folded.indexOf(marker, start + 1);
    if (at !== -1 && at < end) end = at;
  }
  // Une section utile tient en quelques lignes ; au-dela on ratisse la page.
  return text.slice(start, Math.min(end, start + 400));
}

const clean = (raw: string): string =>
  raw
    .replace(/^[\s:«"'\-–—]+|[\s»"'\-–—.,;]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Extraire la dénomination d'une page de mentions légales.
 *
 * Trois voies, de la plus explicite à la plus indirecte. La première qui rend
 * un nom valide gagne : un site qui écrit « Raison sociale : X » n'a pas besoin
 * qu'on devine à partir d'un sigle.
 *
 * Le nom rendu repasse par `whyNotACompanyName`, la même garde que la
 * découverte : une extraction ne doit pas pouvoir faire entrer un intitulé de
 * métier que le tri initial aurait refusé.
 */
export function extractLegalIdentity(
  pages: ReadonlyArray<{ url: string; html: string }>,
  officialDomain: string,
): LegalIdentity | null {
  for (const page of pages) {
    if (!isOfficialPage(page.url, officialDomain)) continue;
    if (!looksLikeLegalNotice(page.html)) continue;

    const complet = strip(page.html);
    const text = editorSection(complet);
    // Sans section editeur identifiable, on ne devine pas : la page cite
    // souvent trois societes, et une seule est la bonne.
    if (!text) continue;
    const registration = bestRegistration(text);

    // ── 1. La dénomination annoncée ─────────────────────────────────────
    //
    // Le `(?:\.\s*)*` saute le séparateur de bloc que `strip` insère entre
    // deux balises. Sur groupe-ledoux.com le texte devient « Editeur du
    // site: . LEDOUX FINANCE » : sans ce saut, la capture bute sur le point et
    // la seule identité lisible de la page était perdue.
    const labelled = new RegExp(
      String.raw`(?:raison sociale|d[ée]nomination(?:\s+sociale)?|soci[ée]t[ée]|nom de l['’]entreprise|[ée]diteur du site|[ée]dit[ée] par|propri[ée]taire du site)\s*[:\-–]\s*(?:\.\s*)*([^.;|]{2,70})`,
      'i',
    ).exec(text);
    if (labelled?.[1]) {
      const candidate = withoutForm(clean(labelled[1]));
      if (candidate) {
        return {
          legalName: candidate.name,
          legalForm: candidate.form,
          registration,
          basis: `dénomination annoncée sur la page de mentions légales`,
          sourceUrl: page.url,
        };
      }
    }

    // ── 2. Une forme juridique accolée à un nom ─────────────────────────
    for (const form of FORMS) {
      const after = new RegExp(String.raw`\b${form}\b[\s,]+([A-ZÀ-Ü][\w'’&.\- ]{2,60})`, '').exec(text);
      const before = new RegExp(String.raw`([A-ZÀ-Ü][\w'’&.\- ]{2,60}?)[\s,]+\b${form}\b`, '').exec(text);
      for (const hit of [after?.[1], before?.[1]]) {
        if (!hit) continue;
        const name = clean(hit);
        if (!acceptable(name)) continue;
        return {
          legalName: name,
          legalForm: form,
          registration,
          basis: `forme juridique « ${form} » accolée à la dénomination`,
          sourceUrl: page.url,
        };
      }
    }
  }
  return null;
}

/** Sépare une éventuelle forme juridique du nom, et valide le reste. */
function withoutForm(raw: string): { name: string; form: string | null } | null {
  let form: string | null = null;
  let name = raw;
  for (const f of FORMS) {
    const re = new RegExp(String.raw`(^|\s)${f}(\s|$)`, '');
    if (re.test(name)) {
      form = f;
      name = clean(name.replace(re, ' '));
      break;
    }
  }
  return acceptable(name) ? { name, form } : null;
}

function acceptable(name: string): boolean {
  if (name.length < 2 || name.length > 60) return false;
  const folded = fold(name);
  if (NOT_A_NAME.some((bad) => folded.includes(bad))) return false;
  if (/\d{4,}/.test(name)) return false;
  // La même garde que le tri initial : un intitulé de métier n'est pas un nom.
  return whyNotACompanyName(name) === null;
}

/**
 * Ce que la confirmation vaut, et pourquoi.
 *
 * La confiance ne monte pas parce qu'on a trouvé une page : elle monte parce
 * qu'on a trouvé une page **obligatoire**, sur le **domaine de l'entreprise**,
 * portant une **dénomination** et, le plus souvent, une **immatriculation**.
 * Chaque élément est une preuve distincte, et le niveau atteint le dit.
 *
 * Le plafond de 0,95 est délibéré : rien de lu automatiquement ne vaut une
 * vérification humaine, et laisser un chemin automatique atteindre 1 effacerait
 * la distinction.
 */
export function confidenceFromLegal(identity: LegalIdentity): number {
  let confidence = 0.8;
  if (identity.registration) confidence += 0.1;
  if (identity.legalForm) confidence += 0.05;
  return Math.min(0.95, Math.round(confidence * 100) / 100);
}
