/**
 * Relever ce qu'un site publie réellement — et rien d'autre.
 *
 * Le lot 003 a rendu `PUBLIC CONTACT CHANNEL = NONE` pour SERAAP et CIRMECA,
 * alors que leurs deux sites publient une adresse. La cause n'était pas
 * l'absence de coordonnées mais une règle de trop : l'extraction exigeait que
 * l'adresse porte le domaine du site. `contact@seraap.fr` relevé sur
 * `seraap.com` était donc jeté, au même titre qu'une adresse d'hébergeur.
 *
 * La règle correcte ne porte pas sur le domaine de l'adresse mais sur celui de
 * la **page** : ce qui compte est que l'entreprise l'ait publiée chez elle. Une
 * société peut parfaitement communiquer sur un `.fr` et héberger son site en
 * `.com` ; ce n'est pas une anomalie, c'est un usage courant.
 *
 * Ce module ne fabrique rien. Il ne connaît aucun motif du type `contact@` ou
 * `prenom.nom@` qu'il pourrait appliquer à un domaine : il ne rend que des
 * chaînes littéralement présentes dans le HTML qu'on lui donne. Une adresse
 * plausible et fausse coûte plus cher qu'une absence d'adresse — elle se
 * découvre après l'envoi.
 */

import {
  classifyContactIntent,
  outreachSuitability,
  selectOutreachContact,
  type ContactIntent,
  type OutreachSuitability,
  type SelectionOutcome,
} from './contact-intent.ts';

export type ContactKind = 'EMAIL' | 'PHONE' | 'FORM';

/**
 * Ce que vaut la coordonnée relevée.
 *
 * HIGH  une page dont l'objet est de publier les coordonnées (contact,
 *       mentions légales, impressum), ou une adresse dont la marque recoupe
 *       celle du domaine officiel.
 * MEDIUM relevée sur une autre page du site officiel, ou hébergée chez un
 *       fournisseur de messagerie grand public.
 * LOW   présente mais faiblement corroborée.
 */
export type ContactConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ResolvedContact {
  type: ContactKind;
  value: string;
  /** La page exacte où la coordonnée a été lue. Jamais nulle. */
  sourceUrl: string;
  /**
   * Toujours `true`. Le champ existe pour que la distinction reste visible à
   * la lecture : rien dans ce module ne produit de coordonnée déduite, et une
   * déduction ne doit jamais pouvoir emprunter cette forme.
   */
  observed: true;
  confidence: ContactConfidence;
  label: string | null;
  /** L'adresse porte-t-elle la marque de l'entreprise ? */
  sameBrand?: boolean;
  /** À quoi la boîte est destinée. Indépendant du fait qu'elle existe. */
  intent: ContactIntent;
  /**
   * Peut-on lui écrire pour prospecter ?
   *
   * Distinct de `observed` à dessein : le lot 005 a retenu
   * `support@groupe-reval.com` parce qu'il était publié. Il l'est ; c'est le
   * service après-vente.
   */
  suitability: OutreachSuitability;
}

/** L'ordre d'usage pour une prise de contact. */
export type ContactMethod = 'EMAIL' | 'FORM' | 'PHONE' | 'NONE';

export interface ContactResolution {
  publicEmails: ResolvedContact[];
  publicPhones: ResolvedContact[];
  contactFormUrl: ResolvedContact | null;
  contactPersonName: string | null;
  contactPersonRole: string | null;
  /** Toutes les pages officielles qui ont fourni quelque chose. */
  contactSources: string[];
  method: ContactMethod;
  /**
   * Le canal à utiliser, selon la priorité d'intention. `null` quand aucune
   * coordonnée n'est destinée à un contact commercial — ce qui n'est pas la
   * même chose que « aucune coordonnée ».
   */
  primary: ResolvedContact | null;
  /** Pourquoi ce canal, et ce qui a été écarté. */
  selection: SelectionOutcome;
  /** Les pages écartées, et pourquoi — un silence ne s'audite pas. */
  skipped: Array<{ url: string; reason: string }>;
}

export interface ContactPage {
  url: string;
  /** Le HTML tel que reçu. Le texte nettoyé perdrait les `mailto:`. */
  html: string;
}

/** Les chemins où une entreprise publie habituellement ses coordonnées. */
export const CONTACT_PATHS = [
  '/contact',
  '/contact/',
  '/contacts',
  '/nous-contacter',
  '/contactez-nous',
  '/contact-us',
  '/en/contact',
  '/mentions-legales',
  '/mentions-legales/',
  '/mentions-legales.html',
  '/legal',
  '/legals',
  '/impressum',
  '/kontakt',
] as const;

/**
 * Les pages dont l'objet *est* de publier des coordonnées.
 *
 * Une adresse trouvée là vaut mieux qu'une adresse croisée au détour d'un
 * article : la première est celle que l'entreprise donne, la seconde peut être
 * celle de n'importe qui.
 */
const AUTHORITATIVE_PATH = /(contact|mention|legal|impressum|kontakt)/i;

/** Fournisseurs de messagerie grand public : acceptés, mais moins probants. */
const FREEMAIL = [
  'gmail.com', 'googlemail.com', 'yahoo.fr', 'yahoo.com', 'hotmail.fr',
  'hotmail.com', 'outlook.fr', 'outlook.com', 'orange.fr', 'wanadoo.fr',
  'free.fr', 'sfr.fr', 'laposte.net', 'live.fr', 'aol.com',
];

/**
 * Adresses qui ne sont pas celles de l'entreprise.
 *
 * Une page de mentions légales cite l'hébergeur, l'agence web et parfois le
 * registre du commerce. Remonter tout cela noierait la seule adresse utile.
 */
const NOT_THE_COMPANY = [
  'example.com', 'sentry.io', 'wordpress', 'wixpress', 'wix.com', 'godaddy',
  'ovh.net', 'ovh.com', 'ionos.fr', 'o2switch.fr', 'gandi.net', 'hostinger',
  'cloudflare', 'shopify', 'squarespace', 'domain.com', 'sitemap',
  'w3.org', 'schema.org', 'jquery', 'bootstrapcdn', 'googleapis',
];

/** Fragments qui trahissent un fichier plutôt qu'une adresse. */
const NOT_AN_EMAIL = ['@2x', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.css', '.js'];

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const MAILTO_RE = /mailto:([^"'?>\s]+)/gi;
const TEL_RE = /tel:([+0-9().\s-]{7,})/gi;
/**
 * Un numéro écrit comme un numéro.
 *
 * La première version acceptait toute suite de chiffres assez longue et a
 * relevé « 00000033 100 » sur une page d'accueil — un identifiant, pas un
 * téléphone. Un vrai numéro publié porte ses séparateurs ou son indicatif ;
 * exiger l'un des deux coûte quelques faux négatifs et évite d'écrire un
 * numéro faux dans une fiche de contact.
 */
const PHONE_TEXT_RE =
  /(?:\+\d{1,3}[\s.-]?(?:\(0\)[\s.-]?)?)?0?\d(?:[\s.-]\d{2}){4}|\+\d{1,3}[\s.-]?\d{6,12}/g;

/**
 * Deux domaines désignent-ils la même maison ?
 *
 * `groupe-reval.com` et `france-reval.com` ne sont pas la même chaîne, et
 * pourtant `contact@france-reval.com` publié sur `groupe-reval.com` est bien
 * l'adresse de l'entreprise. Une comparaison stricte l'a fait descendre sous
 * le numéro de téléphone.
 *
 * Les préfixes qui ne distinguent rien — `groupe`, `france`, une forme
 * juridique — sont donc retirés avant de comparer. Ce qui reste doit se
 * recouper : `mecapole` et `forgeavia` n'ont rien en commun, et c'est bien le
 * résultat cherché.
 */
const GENERIC_BRAND_TOKENS = [
  'groupe', 'group', 'france', 'french', 'holding', 'company', 'societe',
  'sa', 'sas', 'sarl', 'sasu', 'eurl', 'international', 'intl', 'the',
];

export function brandsRelated(a: string, b: string): boolean {
  const significant = (host: string): string[] =>
    brandRoot(host)
      .split(/[-_]/)
      .filter((token) => token.length >= 4 && !GENERIC_BRAND_TOKENS.includes(token));

  const left = significant(a);
  const right = significant(b);
  if (left.length === 0 || right.length === 0) return brandRoot(a) === brandRoot(b);
  return left.some((token) => right.includes(token));
}

/** Le nom de marque d'un domaine : `seraap.com` et `seraap.fr` → `seraap`. */
export function brandRoot(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.');
  // Gère les suffixes composés courants (`co.uk`, `com.br`).
  if (parts.length >= 3 && ['co', 'com', 'org', 'net', 'gov', 'ac'].includes(parts[parts.length - 2]!)) {
    return parts[parts.length - 3] ?? '';
  }
  return parts.length >= 2 ? parts[parts.length - 2]! : (parts[0] ?? '');
}

/**
 * La page appartient-elle à l'entreprise ?
 *
 * C'est la seule question qui filtre. Une adresse relevée sur un annuaire tiers
 * est rejetée parce que la *page* n'est pas officielle — pas parce que
 * l'adresse aurait le mauvais domaine.
 */
export function isOfficialPage(pageUrl: string, officialDomain: string): boolean {
  let host: string;
  try {
    host = new URL(pageUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  const official = officialDomain.toLowerCase().replace(/^www\./, '');
  return host === official || host.endsWith(`.${official}`);
}

/** Les URL à essayer pour une entreprise, dans l'ordre de probabilité. */
export function contactPagesFor(officialWebsite: string | null, domain: string | null): string[] {
  const base = officialWebsite?.trim() || (domain ? `https://${domain}` : null);
  if (!base) return [];
  let origin: string;
  try {
    origin = new URL(base.startsWith('http') ? base : `https://${base}`).origin;
  } catch {
    return [];
  }
  return [origin + '/', ...CONTACT_PATHS.map((path) => `${origin}${path}`)];
}

/**
 * Les liens d'une page qui mènent à des coordonnées.
 *
 * Beaucoup de sites ne suivent aucune convention de chemin : leur page de
 * contact est en `/fr/nous-joindre` ou `/a-propos/contact-2`. Suivre les liens
 * coûte une requête et évite de conclure « aucun contact » alors que le lien
 * était en pied de page.
 */
export function contactLinksIn(html: string, pageUrl: string, officialDomain: string): string[] {
  const found = new Set<string>();
  const anchor = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null) {
    const href = match[1]!;
    const text = match[2]!.replace(/<[^>]+>/g, ' ');
    if (!AUTHORITATIVE_PATH.test(href) && !AUTHORITATIVE_PATH.test(text)) continue;
    let absolute: string;
    try {
      absolute = new URL(href, pageUrl).href;
    } catch {
      continue;
    }
    if (!absolute.startsWith('https://')) continue;
    if (!isOfficialPage(absolute, officialDomain)) continue;
    found.add(absolute.split('#')[0]!);
    if (found.size >= 6) break;
  }
  return [...found];
}

function cleanEmail(raw: string): string | null {
  const email = decodeURIComponent(raw).toLowerCase().trim().replace(/[.,;:)"'<>]+$/, '');
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return null;
  if (NOT_AN_EMAIL.some((bad) => email.includes(bad))) return null;
  if (NOT_THE_COMPANY.some((bad) => email.includes(bad))) return null;
  return email;
}

function emailConfidence(email: string, pageUrl: string, officialDomain: string): ContactConfidence {
  const host = email.split('@')[1] ?? '';
  const sameBrand = brandsRelated(host, officialDomain);
  const authoritative = AUTHORITATIVE_PATH.test(new URL(pageUrl).pathname) || new URL(pageUrl).pathname === '/';

  // La marque qui recoupe le domaine officiel est le signal le plus fort, et
  // il traverse les extensions : `contact@seraap.fr` sur `seraap.com` désigne
  // la même maison.
  if (sameBrand && authoritative) return 'HIGH';
  if (sameBrand) return 'MEDIUM';
  if (FREEMAIL.includes(host)) return 'MEDIUM';
  return authoritative ? 'MEDIUM' : 'LOW';
}

function normalisePhone(raw: string): string | null {
  const phone = raw.trim().replace(/\s+/g, ' ').replace(/[.\s-]+$/, '');
  const digits = phone.replace(/\D/g, '');
  // En dessous de neuf chiffres on ramasse des dates, des codes postaux et des
  // numéros de TVA ; au-dessus de quinze, des identifiants.
  if (digits.length < 9 || digits.length > 15) return null;
  // Trois zéros consécutifs ou un seul chiffre répété : un compteur, un
  // capital social, un numéro de sirène — pas un téléphone.
  if (/000/.test(digits)) return null;
  if (/^(\d)+$/.test(digits)) return null;
  // « 01 02 03 04 05 » est le numéro que les intégrateurs laissent dans les
  // gabarits. Une suite strictement croissante ou décroissante n'appelle
  // personne.
  const pairs = digits.match(/\d{2}/g) ?? [];
  if (pairs.length >= 4) {
    const ascending = pairs.every((pair, i) => i === 0 || Number(pair) === Number(pairs[i - 1]) + 1);
    const descending = pairs.every((pair, i) => i === 0 || Number(pair) === Number(pairs[i - 1]) - 1);
    if (ascending || descending) return null;
  }
  if (/^(?:0123456789|1234567890)/.test(digits)) return null;
  return phone;
}

/** Un formulaire de contact réel : des champs, pas une barre de recherche. */
function findForm(html: string): boolean {
  const forms = html.match(/<form\b[\s\S]{0,4000}?<\/form>/gi) ?? [];
  return forms.some((form) => {
    if (/type\s*=\s*["']?search/i.test(form)) return false;
    if (/name\s*=\s*["']?s["']?/i.test(form) && !/textarea/i.test(form)) return false;
    return /<textarea/i.test(form) || /type\s*=\s*["']?email/i.test(form);
  });
}

/**
 * Un nom et une fonction, seulement s'ils sont explicitement publiés.
 *
 * Deux sources acceptées : un `Person` en JSON-LD portant un `jobTitle`, ou un
 * libellé de type « Directeur commercial : Jean Dupont ». Tout le reste est
 * abandonné — deviner qui dirige une PME à partir d'une page d'accueil produit
 * exactement le genre d'erreur qui se lit dans le premier message.
 */
function findPerson(html: string): { name: string | null; role: string | null } {
  for (const block of html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? []) {
    const json = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    try {
      const walk = (node: unknown): { name: string; role: string } | null => {
        if (Array.isArray(node)) {
          for (const item of node) {
            const hit = walk(item);
            if (hit) return hit;
          }
          return null;
        }
        if (!node || typeof node !== 'object') return null;
        const record = node as Record<string, unknown>;
        if (record['@type'] === 'Person' && typeof record.name === 'string' && typeof record.jobTitle === 'string') {
          return { name: record.name.trim(), role: record.jobTitle.trim() };
        }
        for (const value of Object.values(record)) {
          const hit = walk(value);
          if (hit) return hit;
        }
        return null;
      };
      const hit = walk(JSON.parse(json));
      if (hit) return hit;
    } catch {
      // Un JSON-LD malformé n'est pas une raison d'échouer : on passe.
    }
  }

  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const labelled = text.match(
    /\b(directeur|directrice|président|présidente|gérant|gérante|responsable commercial[e]?|dirigeant[e]?)\b[^:]{0,30}:\s*([A-ZÉÈÀÂÎÔÛ][\p{L}'’-]+(?:\s+[A-ZÉÈÀÂÎÔÛ][\p{L}'’-]+){1,2})/u,
  );
  if (labelled) return { name: labelled[2]!.trim(), role: labelled[1]!.trim() };
  return { name: null, role: null };
}

/**
 * Résout les coordonnées publiques d'une entreprise à partir de pages déjà
 * récupérées.
 *
 * Aucun réseau ici : la fonction reçoit du HTML et rend ce qu'il contient. Le
 * découpage est délibéré — c'est ce qui permet de la tester sur des pages
 * figées, donc de vérifier qu'elle n'invente rien, ce qu'un test qui appelle
 * l'internet ne pourrait jamais prouver.
 */
export function resolveContacts(input: {
  officialDomain: string;
  pages: readonly ContactPage[];
}): ContactResolution {
  const emails = new Map<string, ResolvedContact>();
  const phones = new Map<string, ResolvedContact>();
  const sources = new Set<string>();
  const skipped: Array<{ url: string; reason: string }> = [];
  let form: ResolvedContact | null = null;
  let person: { name: string | null; role: string | null } = { name: null, role: null };

  for (const page of input.pages) {
    // La seule barrière : la page doit appartenir à l'entreprise. Un annuaire
    // tiers peut publier une adresse exacte — elle reste invérifiable, parce
    // que personne chez l'entreprise ne l'a mise là.
    if (!isOfficialPage(page.url, input.officialDomain)) {
      skipped.push({
        url: page.url,
        reason: `page hors du domaine officiel « ${input.officialDomain} » : une coordonnée publiée par un tiers n'engage pas l'entreprise.`,
      });
      continue;
    }

    let contributed = false;

    // La personne d'abord : une fonction commerciale publiée change la nature
    // des adresses de la même page. La chercher après les aurait classées sans
    // l'information qui les rachète.
    if (!person.name) {
      const found = findPerson(page.html);
      if (found.name) person = found;
    }

    // Les `mailto:` d'abord : c'est l'adresse que l'entreprise a elle-même
    // rendue cliquable, et elle survit aux obfuscations d'affichage.
    const raw: string[] = [];
    for (const m of page.html.matchAll(MAILTO_RE)) raw.push(m[1]!);
    for (const m of page.html.replace(/<[^>]+>/g, ' ').matchAll(EMAIL_RE)) raw.push(m[0]);

    for (const candidate of raw) {
      const email = cleanEmail(candidate);
      if (!email || emails.has(email)) continue;
      const intent = classifyContactIntent({
        value: email, kind: 'EMAIL', role: person.role, sourceUrl: page.url,
      });
      emails.set(email, {
        type: 'EMAIL',
        value: email,
        sourceUrl: page.url,
        observed: true,
        confidence: emailConfidence(email, page.url, input.officialDomain),
        label: null,
        intent,
        suitability: outreachSuitability(intent, Boolean(person.role)),
        sameBrand: brandsRelated(email.split('@')[1] ?? '', input.officialDomain),
      });
      contributed = true;
      if (emails.size >= 6) break;
    }

    for (const m of page.html.matchAll(TEL_RE)) {
      const phone = normalisePhone(m[1]!);
      if (!phone || phones.has(phone.replace(/\D/g, ''))) continue;
      phones.set(phone.replace(/\D/g, ''), {
        type: 'PHONE', value: phone, sourceUrl: page.url, observed: true,
        confidence: 'HIGH', label: null,
        intent: 'GENERAL', suitability: 'MEDIUM',
      });
      contributed = true;
    }
    if (phones.size === 0) {
      for (const m of page.html.replace(/<[^>]+>/g, ' ').matchAll(PHONE_TEXT_RE)) {
        const phone = normalisePhone(m[0]);
        if (!phone || phones.has(phone.replace(/\D/g, ''))) continue;
        phones.set(phone.replace(/\D/g, ''), {
          type: 'PHONE', value: phone, sourceUrl: page.url, observed: true,
          confidence: 'MEDIUM', label: null,
          intent: 'GENERAL', suitability: 'MEDIUM',
        });
        contributed = true;
        if (phones.size >= 2) break;
      }
    }

    if (!form && findForm(page.html)) {
      const formIntent = classifyContactIntent({ value: page.url, kind: 'FORM', sourceUrl: page.url });
      form = {
        type: 'FORM', value: page.url, sourceUrl: page.url, observed: true,
        confidence: AUTHORITATIVE_PATH.test(page.url) ? 'HIGH' : 'MEDIUM',
        label: 'formulaire publié sur le site officiel',
        intent: formIntent,
        suitability: outreachSuitability(formIntent),
      };
      contributed = true;
    }

    if (contributed) sources.add(page.url);
  }

  const publicEmails = [...emails.values()].sort(
    (a, b) => rank(b.confidence) - rank(a.confidence),
  );
  const publicPhones = [...phones.values()].sort(
    (a, b) => rank(b.confidence) - rank(a.confidence),
  );

  // La priorité ne porte plus sur le type de canal mais sur ce à quoi la boîte
  // est destinée. Le lot 005 choisissait la première adresse trouvée : pour
  // France Reval c'était le service après-vente, pour Mecapole les initiales
  // de la personne chargée des mentions légales. Les deux sont réelles ; ni
  // l'une ni l'autre n'est un interlocuteur commercial.
  const selection = selectOutreachContact([...publicEmails, ...(form ? [form] : []), ...publicPhones]);
  const primary = selection.selected
    ? ([...publicEmails, ...(form ? [form] : []), ...publicPhones].find(
        (c) => c.value === selection.selected!.value && c.type === selection.selected!.type,
      ) ?? null)
    : null;
  const method: ContactMethod = primary ? primary.type : 'NONE';

  return {
    publicEmails,
    publicPhones,
    contactFormUrl: form,
    contactPersonName: person.name,
    contactPersonRole: person.role,
    contactSources: [...sources],
    method,
    primary,
    selection,
    skipped,
  };
}

function rank(confidence: ContactConfidence): number {
  return confidence === 'HIGH' ? 3 : confidence === 'MEDIUM' ? 2 : 1;
}
