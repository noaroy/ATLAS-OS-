import { canonicalDomainOf } from '@atlas/core';
import type { EntityKind, SourceTrust } from '@atlas/data';
import { isTechnicalDomain } from '@atlas/departments';
import type { EntityRef } from './types.ts';

/**
 * Normaliser, dédoublonner, se méfier.
 *
 * Une entreprise a une clé : son domaine canonique. Trouvée par quatre
 * chemins, elle est une seule entité avec quatre preuves. Sans domaine, la
 * clé est son nom normalisé — et deux entreprises de même nom sur deux
 * domaines différents restent deux entités : on ne fusionne jamais sur le
 * seul nom. Un annuaire, un réseau social, un article de blog ne sont pas
 * des entreprises : ils sont écartés avant d'entrer dans l'univers.
 */

// ─── Les noms ────────────────────────────────────────────────────────────────

const LEGAL_SUFFIXES = /\b(s\.?a\.?s\.?u?|s\.?a\.?r\.?l\.?|s\.?a\.?|s\.?n\.?c\.?|e\.?u\.?r\.?l\.?|s\.?c\.?o\.?p\.?|gmbh|ag|ab|as|asa|oy|oyj|aps|a\/s|bv|nv|b\.?v\.?|ltd\.?|limited|inc\.?|llc|plc|s\.?r\.?l\.?|s\.?p\.?a\.?|s\.?l\.?|kft|sp\.? z\.? ?o\.? ?o\.?|co\.?|corp\.?|company|group|groupe)\b/gi;

export function flatten(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Le nom, sans forme juridique ni ponctuation : la matière d'un alias et d'une clé. */
export function normaliseCompanyName(name: string): string {
  return flatten(name)
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Un nom lisible : le titre d'une page ramené à sa raison sociale probable. */
export function cleanCompanyName(raw: string): string {
  let name = raw.replace(/\s+/g, ' ').trim();
  // « Acme – Fabricant de … » / « Acme | Accueil » : la première partie nomme, la suite décrit.
  name = name.split(/\s+[|–—:·»]\s+|\s+-\s+/)[0] ?? name;
  name = name.replace(/^(accueil|home|bienvenue|welcome)\s*[-|:]?\s*/i, '').trim();
  return name.slice(0, 80);
}

/**
 * Un mot de métier est-il présent dans un texte ?
 *
 * Un mot de métier est souvent une expression (« usinage de précision ») ;
 * une page l'écrit rarement telle quelle. La présence de la moitié au moins
 * de ses mots significatifs (cinq lettres et plus) suffit — « usinage » dit
 * assez. Les deux textes sont aplatis (accents, casse) avant comparaison.
 */
export function keywordHit(text: string, keyword: string): boolean {
  const hay = flatten(text);
  const kw = flatten(keyword).trim();
  if (!kw) return false;
  if (hay.includes(kw)) return true;
  const tokens = kw.split(/[^a-z0-9]+/).filter((t) => t.length >= 5);
  if (tokens.length === 0) return false;
  const present = tokens.filter((t) => hay.includes(t)).length;
  return present * 2 >= tokens.length;
}

// ─── Les domaines ────────────────────────────────────────────────────────────

export function domainOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    const host = canonicalDomainOf(u.hostname);
    return host || null;
  } catch {
    return null;
  }
}

/**
 * Les hôtes qui ne désignent jamais une entreprise cible : réseaux sociaux,
 * annuaires, encyclopédies, places de marché, plateformes de blog, avis,
 * emplois, administrations. Une page de ces hôtes peut être une *piste*
 * (un annuaire nomme des entreprises) ; elle n'est jamais un candidat, ni
 * une preuve forte.
 */
const JUNK_HOSTS = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'pinterest.com', 'vimeo.com',
  'wikipedia.org', 'wikidata.org', 'wikimedia.org',
  'societe.com', 'pappers.fr', 'infogreffe.fr', 'verif.com', 'manageo.fr', 'kompass.com', 'europages.com', 'europages.fr',
  'pagesjaunes.fr', 'yelp.com', 'yelp.fr', 'trustpilot.com', 'capterra.com', 'capterra.fr', 'g2.com', 'crunchbase.com', 'zoominfo.com',
  'dnb.com', 'bloomberg.com', 'opencorporates.com', 'allabolag.se', 'hitta.se', 'eniro.se', 'ratsit.se', 'proff.se', 'proff.no', 'firmenwissen.de', 'northdata.com',
  'amazon.com', 'amazon.fr', 'amazon.de', 'amazon.se', 'alibaba.com', 'aliexpress.com', 'ebay.com', 'ebay.fr', 'leboncoin.fr', 'cdiscount.com', 'manomano.fr',
  'indeed.com', 'indeed.fr', 'glassdoor.com', 'glassdoor.fr', 'welcometothejungle.com', 'hellowork.com', 'apec.fr', 'monster.fr',
  'medium.com', 'wordpress.com', 'blogspot.com', 'wix.com', 'wixsite.com', 'weebly.com', 'jimdo.com', 'jimdosite.com', 'linktr.ee', 'canva.site',
  'google.com', 'google.fr', 'bing.com', 'yahoo.com', 'duckduckgo.com', 'qwant.com',
  'reddit.com', 'quora.com', 'stackoverflow.com', 'slideshare.net', 'scribd.com', 'issuu.com', 'calameo.com',
  'lefigaro.fr', 'lemonde.fr', 'lesechos.fr', 'usinenouvelle.com', 'latribune.fr', 'bfmtv.com', 'ouest-france.fr', 'francebleu.fr', 'francetvinfo.fr',
  'archiexpo.fr', 'archiexpo.com', 'directindustry.com', 'directindustry.fr', 'medicalexpo.com', 'agriexpo.online', 'nauticexpo.com',
  'hellopro.fr', 'usine-digitale.fr', 'industrie-online.com', 'techni-contact.com', 'ecosia.org',
  // Messageries, raccourcisseurs, cartes, magasins d'applications : des liens, pas des entreprises.
  'whatsapp.com', 'wa.me', 't.me', 'telegram.org', 'messenger.com', 'skype.com', 'goo.gl', 'bit.ly', 'youtu.be', 'maps.app.goo.gl',
  'apple.com', 'play.google.com', 'microsoft.com', 'outlook.com', 'gmail.com', 'zoom.us', 'teams.microsoft.com', 'calendly.com', 'hubspot.com', 'mailchimp.com',
  // Plateformes d'événements et d'exposants : l'outil du salon, pas un exposant.
  'mapyourshow.com', 'comexposium.com', 'a2zinc.net', 'expofp.com', 'eventscribe.net', 'swapcard.com', 'b2match.io', 'eventbrite.com', 'eventbrite.fr',
  'weezevent.com', 'hopin.com', 'cvent.com', 'reedexpo.com', 'rxglobal.com', 'gl-events.com', 'viparis.com', 'messefrankfurt.com',
  // Annuaires et fiches d'entreprises : une page *sur* une entreprise, jamais la sienne.
  '118712.fr', '118000.fr', 'hoodspot.fr', 'annuaire-entreprises.data.gouv.fr', 'entreprises.lefigaro.fr', 'societe.ninja', 'bilansgratuits.fr',
  'ellisphere.com', 'scores-et-decisions.com', 'similarweb.com', 'rocketreach.co', 'apollo.io', 'lusha.com', 'datanyze.com', 'owler.com',
  'cybo.com', 'cylex.fr', 'cylex-france.fr', 'pagesjaunes.com', 'yellowpages.com', 'yelp.co.uk', 'foursquare.com', 'mappy.com', 'waze.com',
  'trouver-une-entreprise.fr', 'entreprises.gouv.fr', 'infonet.fr', 'b-reputation.com', 'fr.kompass.com', 'wer-liefert-was.de', 'wlw.de',
  'catalogueformpro.com', 'formpro.fr', 'mon-compte-formation.gouv.fr',
];

/** Les sous-domaines qui désignent un outil, jamais une entreprise cible. */
const JUNK_SUBDOMAIN = /^(api|apis|careers?|jobs?|emplois?|recrutement|login|auth|sso|account|accounts|mail|webmail|cdn|static|assets|img|images|docs|support|help|status|app|apps|my|portal|events?|tickets?|billetterie|shop-?admin|admin|dev|staging|test|beta|calendar|agenda|exh|reg|register|inscription)\./i;

const JUNK_TLDS = ['gouv.fr', 'gov', 'edu', 'ac.uk', 'mil', 'cci.fr', 'asso.fr'];

/**
 * Les institutions qu'une fédération ou un salon liste parmi ses membres :
 * chambres de commerce, banques publiques, centres techniques, écoles,
 * collectivités. Des acteurs de l'écosystème, jamais des entreprises à
 * démarcher pour une étude de prospection.
 */
const INSTITUTION = /\b(cci|chambre|bpifrance|cetim|campus|lyc[ée]e|universit|ecole|école|formation|r[ée]gion|d[ée]partement|mairie|ville-de|communaut[ée]|agglo|m[ée]tropole|pole-emploi|p[ôo]le-emploi|apec|urssaf|inpi|afnor|cnrs|inserm|inria|minist[èe]re|pr[ée]fecture|conseil-general|conseil-regional|cluster|p[ôo]le-de-comp|federation|f[ée]d[ée]ration|syndicat|association|fondation|foundation|institut|academy|acad[ée]mie)\b/i;

export function looksLikeInstitution(domain: string | null, name: string | null): boolean {
  const hay = `${(domain ?? '').replace(/\./g, ' ').replace(/-/g, ' ')} ${(name ?? '').replace(/-/g, ' ')}`;
  return INSTITUTION.test(hay);
}

export function isJunkDomain(domain: string | null, options: { allowInstitutions?: boolean } = {}): boolean {
  if (!domain) return true;
  const d = domain.toLowerCase();
  if (isTechnicalDomain(d)) return true;
  if (JUNK_SUBDOMAIN.test(d)) return true;
  // Une fédération est une *source* légitime (elle liste ses membres) et
  // une cible illégitime (on ne la démarche pas) : l'appelant dit lequel.
  if (!options.allowInstitutions && looksLikeInstitution(d, null)) return true;
  if (JUNK_HOSTS.some((h) => d === h || d.endsWith(`.${h}`))) return true;
  if (JUNK_TLDS.some((t) => d === t || d.endsWith(`.${t}`))) return true;
  return false;
}

/**
 * Une page qui n'est pas la présentation d'une entreprise : article, liste,
 * fiche d'annuaire, PDF. Une fiche d'annuaire se reconnaît aussi à son
 * chemin : un numéro SIREN/SIRET (9 à 14 chiffres) dans l'adresse, ou un
 * segment « professionnels », « company », « entreprise-… ».
 */
const LISTICLE_PATH = /\/(?:blog|actualites|actualite|news|article|articles|magazine|guide|guides|top-?\d+|meilleur|meilleurs|best|classement|comparatif|comparateur|annuaire|directory|liste|list|tag|tags|category|categorie|forum|wiki|professionnels?|pro|company|companies|entreprise|entreprises|societe|societes|fiche|fiches|listing|listings)\b|\.pdf(\?|$)|\/\d{4}\/\d{2}\/|[-/](?:\d[\d ]{8,15}\d)(?:[/?#]|$)/i;
const LISTICLE_TITLE = /\b(top ?\d+|les \d+ meilleurs|meilleurs? \w+ de|classement|comparatif|comparateur|annuaire|liste des|list of|best \d+|alternatives? (?:à|to)|vs\.?|versus)\b/i;

export function looksLikeListicle(url: string, title: string | null): boolean {
  return LISTICLE_PATH.test(url) || (title !== null && LISTICLE_TITLE.test(title));
}

// ─── Les pays ────────────────────────────────────────────────────────────────

const TLD_COUNTRY: Record<string, string> = {
  fr: 'France', be: 'Belgique', ch: 'Suisse', lu: 'Luxembourg', de: 'Allemagne', at: 'Autriche', it: 'Italie', es: 'Espagne', pt: 'Portugal',
  nl: 'Pays-Bas', se: 'Suède', no: 'Norvège', dk: 'Danemark', fi: 'Finlande', pl: 'Pologne', cz: 'Tchéquie', sk: 'Slovaquie', hu: 'Hongrie', ro: 'Roumanie',
  bg: 'Bulgarie', gr: 'Grèce', hr: 'Croatie', si: 'Slovénie', lt: 'Lituanie', lv: 'Lettonie', ee: 'Estonie', ua: 'Ukraine', ru: 'Russie', tr: 'Turquie',
  ie: 'Irlande', uk: 'Royaume-Uni', il: 'Israël', in: 'Inde', br: 'Brésil', mx: 'Mexique', ar: 'Argentine', cl: 'Chili', za: 'Afrique du Sud',
  ca: 'Canada', us: 'États-Unis', jp: 'Japon', cn: 'Chine', kr: 'Corée du Sud', tw: 'Taïwan', hk: 'Hong Kong', sg: 'Singapour', my: 'Malaisie',
  th: 'Thaïlande', vn: 'Viêt Nam', id: 'Indonésie', au: 'Australie', nz: 'Nouvelle-Zélande', ma: 'Maroc', tn: 'Tunisie', dz: 'Algérie', eg: 'Égypte', ae: 'Émirats arabes unis',
};

/** Le pays que le suffixe suggère — une indication faible, jamais une preuve. */
export function countryHintOf(domain: string | null): string | null {
  if (!domain) return null;
  const parts = domain.split('.');
  const tld = parts.pop() ?? '';
  // « .com.ua », « .co.uk » : le pays est l'avant-dernier suffixe.
  if ((tld === 'com' || tld === 'co' || tld === 'org' || tld === 'net') && parts.length >= 2) {
    const second = parts[parts.length - 1]!;
    if (TLD_COUNTRY[second] && second.length === 2) return TLD_COUNTRY[second]!;
  }
  return TLD_COUNTRY[tld] ?? null;
}

/**
 * Un lien de crédit : « réalisation : Agence X », « powered by », « site par ».
 *
 * Le pied de page d'un site nomme souvent l'agence qui l'a fait. Sur la page
 * distributeurs, ce lien serait lu comme un distributeur. On le reconnaît à
 * son contexte, pas à son domaine.
 */
export function looksLikeCreditLink(context: string, text: string): boolean {
  return /\b(r[ée]alisation|r[ée]alis[ée] par|cr[ée]ation|cr[ée][ée] par|con[çc]u par|design(?:ed)? by|powered by|propuls[ée] par|made by|site (?:par|by)|agence web|webdesign|web design|cr[ée]dits?|mentions l[ée]gales|h[ée]berg)\b/i.test(`${context} ${text}`.slice(0, 200));
}

/** Un libellé de navigation, pas un nom d'entreprise : « Our jobs », « 2026 Full agenda », « EXHIBITOR AREA ». */
export function looksLikeNavigationLabel(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^\d{2,4}\b/.test(t)) return true;
  if (/^(our|nos|notre|votre|vos|your|the|les?|la|des|du|un|une|my|mon|ma|mes|all|tous|toutes|see|voir|read|lire|more|plus|en savoir)\b/i.test(t)) return true;
  if (/\b(agenda|programme?|jobs?|careers?|emplois?|login|log in|sign (?:in|up)|register|inscription|tickets?|billets?|area|espace|contact|newsletter|faq|cookies?|privacy|confidentialit|about|[àa] propos|home|accueil|menu|search|recherche|download|t[ée]l[ée]charger|subscribe|abonn)\b/i.test(t)) return true;
  if (t === t.toUpperCase() && t.split(/\s+/).length >= 2 && !/[0-9]/.test(t) && t.length > 12) return true;
  return false;
}

const COUNTRY_WORDS: Array<[RegExp, string]> = [
  [/\b(france|français|francaise|française)\b/i, 'France'], [/\b(belgique|belgi[eë]|belgium)\b/i, 'Belgique'], [/\b(suisse|schweiz|switzerland|svizzera)\b/i, 'Suisse'],
  [/\b(sverige|sweden|suède|svensk)\b/i, 'Suède'], [/\b(deutschland|germany|allemagne)\b/i, 'Allemagne'], [/\b(norge|norway|norvège)\b/i, 'Norvège'],
  [/\b(danmark|denmark|danemark)\b/i, 'Danemark'], [/\b(suomi|finland|finlande)\b/i, 'Finlande'], [/\b(nederland|netherlands|pays-bas)\b/i, 'Pays-Bas'],
  [/\b(italia|italy|italie)\b/i, 'Italie'], [/\b(españa|spain|espagne)\b/i, 'Espagne'], [/\b(luxembourg)\b/i, 'Luxembourg'], [/\b(canada|québec|quebec)\b/i, 'Canada'],
];

/** Un pays cité dans un texte court (extrait, pied de page) — indication, pas preuve. */
export function countryMentionedIn(text: string | null): string | null {
  if (!text) return null;
  for (const [re, country] of COUNTRY_WORDS) if (re.test(text)) return country;
  return null;
}

export function normaliseCountry(country: string | null | undefined): string | null {
  if (!country) return null;
  const c = country.trim();
  if (!c) return null;
  const known = COUNTRY_WORDS.find(([re]) => re.test(c));
  return known ? known[1] : c;
}

// ─── Les clés d'entité ───────────────────────────────────────────────────────

/**
 * La clé canonique : le domaine, sinon le nom normalisé préfixé.
 *
 * Deux entités de même nom sur deux domaines → deux clés. Une entité sans
 * domaine n'est jamais rattachée d'office à un domaine trouvé plus tard :
 * c'est la fusion « Nordpack AB » / « Nordpack Ltd » qu'on interdit.
 */
export function entityKeyOf(ref: { domain: string | null; name: string }): string {
  const domain = ref.domain ? canonicalDomainOf(ref.domain) : '';
  if (domain) return domain;
  return `name:${normaliseCompanyName(ref.name) || flatten(ref.name).trim()}`;
}

export function refFrom(input: { name: string; url?: string | null; domain?: string | null; country?: string | null; kind?: EntityKind }): EntityRef & { kind: EntityKind } {
  const domain = input.domain ? canonicalDomainOf(input.domain) : domainOfUrl(input.url ?? null);
  return {
    name: cleanCompanyName(input.name) || domain || input.name,
    domain: domain || null,
    website: domain ? `https://${domain}` : null,
    country: normaliseCountry(input.country),
    kind: input.kind ?? 'COMPANY',
  };
}

export function sameEntity(a: EntityRef, b: EntityRef): boolean {
  return entityKeyOf(a) === entityKeyOf(b);
}

// ─── La confiance des sources ────────────────────────────────────────────────

/**
 * Ce que vaut une preuve, d'après qui la publie.
 *
 * Une page du site de la source (ses distributeurs, ses partenaires) ou du
 * site de la cible : OFFICIAL. La page d'un salon ou d'une fédération qui
 * liste ses exposants / membres : ASSOCIATION_EVENT. Tout le reste — un
 * extrait de moteur, un article, un annuaire — SECONDARY : une piste, jamais
 * une preuve forte à elle seule.
 */
export function trustOf(evidenceUrl: string, source: EntityRef & { kind?: EntityKind }, target: EntityRef): SourceTrust {
  const host = domainOfUrl(evidenceUrl);
  if (!host) return 'SECONDARY';
  const under = (d: string | null) => Boolean(d) && (host === d || host.endsWith(`.${d}`));
  if (source.kind === 'EVENT' || source.kind === 'ASSOCIATION') {
    return under(source.domain) ? 'ASSOCIATION_EVENT' : 'SECONDARY';
  }
  if (under(source.domain) || under(target.domain)) return 'OFFICIAL';
  return 'SECONDARY';
}

// ─── HTML ────────────────────────────────────────────────────────────────────

export function htmlToText(html: string, maxChars = 6_000): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
    .slice(0, maxChars);
}

export function titleOf(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const t = htmlToText(m[1]!, 200).replace(/\n/g, ' ').trim();
  return t || null;
}

export function metaDescriptionOf(html: string): string | null {
  const m = /<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']{10,400})["']/i.exec(html)
    ?? /<meta[^>]+content\s*=\s*["']([^"']{10,400})["'][^>]*name\s*=\s*["']description["']/i.exec(html);
  return m ? htmlToText(m[1]!, 400).replace(/\n/g, ' ').trim() : null;
}

export interface ExternalLink {
  url: string;
  domain: string;
  text: string;
  /** Le texte autour du lien — la ligne qui le porte, souvent la description du partenaire. */
  context: string;
}

/**
 * Les liens sortants d'une page : ce qu'un site dit d'*autres* entreprises.
 *
 * Un site qui liste ses distributeurs les nomme et les lie. On garde les
 * liens vers d'autres domaines, hors bruit (réseaux sociaux, annuaires),
 * avec le texte du lien et sa ligne : c'est la preuve, et la matière du nom.
 */
export function externalLinks(html: string, pageUrl: string, ownDomain: string | null, max = 120): ExternalLink[] {
  const out: ExternalLink[] = [];
  const seen = new Set<string>();
  const anchor = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) !== null && out.length < max) {
    const href = m[1]!.trim();
    if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
    let abs: URL;
    try { abs = new URL(href, pageUrl); } catch { continue; }
    if (abs.protocol !== 'https:' && abs.protocol !== 'http:') continue;
    const domain = canonicalDomainOf(abs.hostname);
    if (!domain || domain.indexOf('.') < 0) continue;
    if (ownDomain && (domain === ownDomain || domain.endsWith(`.${ownDomain}`))) continue;
    if (isJunkDomain(domain)) continue;
    if (seen.has(domain)) continue;
    seen.add(domain);
    const text = htmlToText(m[2]!, 120).replace(/\n/g, ' ').trim();
    const before = html.slice(Math.max(0, m.index - 220), m.index);
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 220);
    const context = htmlToText(`${before} ${m[0]} ${after}`, 300).replace(/\n/g, ' ').trim();
    out.push({ url: `https://${abs.hostname}${abs.pathname === '/' ? '' : abs.pathname}`, domain, text, context });
  }
  return out;
}

/** Le nom d'entreprise le plus plausible pour un lien : son texte, sinon le domaine mis en forme. */
export function nameFromLink(link: ExternalLink): string {
  const text = link.text.replace(/\s+/g, ' ').trim();
  if (text && text.length <= 60 && !/^(site|www|voir|visiter|en savoir|lien|link|website|here|ici|cliquez|click)/i.test(text) && !/https?:|\.(com|fr|se|de|net|org)\b/i.test(text)) return text;
  const label = link.domain.split('.')[0] ?? link.domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}
