/**
 * Extraction de coordonnées professionnelles publiques.
 *
 * Version volontairement prudente. ATLAS ne relève que ce qu'une page publie
 * réellement, et ne fabrique jamais une adresse à partir d'un nom : construire
 * `prenom.nom@societe.de` produit une adresse plausible et fausse, ce qui est
 * pire qu'une absence d'adresse. Une coordonnée non constatée n'existe pas.
 *
 * Rien ici ne contourne quoi que ce soit : le contenu est celui qu'un
 * navigateur reçoit, sur des pages destinées à être lues (contact, mentions
 * légales, Impressum).
 */

/** Chemins où une organisation publie habituellement ses coordonnées. */
export const CONTACT_PATHS = [
  '/contact',
  '/kontakt',
  '/impressum',
  '/mentions-legales',
  '/about/contact',
  '/en/contact',
  '/contact-us',
] as const;

export interface ExtractedContact {
  kind: 'email' | 'phone' | 'form';
  value: string;
  /** Ce que la page dit autour de la coordonnée, quand c'est exploitable. */
  label: string | null;
  /**
   * Vrai lorsque l'adresse est générique (info@, vertrieb@…). Une adresse
   * générique est le bon point d'entrée B2B et ne vise personne en particulier.
   */
  generic: boolean;
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE = /(?:\+\d{1,3}[\s./-]?)?(?:\(?\d{2,5}\)?[\s./-]?){2,5}\d{2,6}/g;

/** Boîtes génériques : le contact d'entrée d'une organisation. */
const GENERIC_MAILBOXES = [
  'info',
  'contact',
  'kontakt',
  'sales',
  'vertrieb',
  'office',
  'hello',
  'bonjour',
  'commercial',
  'export',
  'service',
  'mail',
  'anfrage',
  'enquiries',
];

/** Adresses qui n'appartiennent pas à l'organisation ou ne servent à rien. */
const IGNORED = [
  'example.com',
  'sentry.io',
  'wordpress',
  'wixpress',
  'godaddy',
  'domain.com',
  '@2x',
  '.png',
  '.jpg',
  '.svg',
  '.webp',
];

/**
 * Relève les coordonnées présentes dans le texte d'une page.
 *
 * Retourne au plus quelques entrées : une page de mentions légales contient
 * souvent l'adresse de l'hébergeur, de l'agence web et du registre du commerce,
 * et remonter tout cela noierait la seule information utile.
 */
export function extractContacts(pageText: string, options: { domain?: string | null } = {}): ExtractedContact[] {
  const found: ExtractedContact[] = [];
  const seen = new Set<string>();

  for (const raw of pageText.match(EMAIL) ?? []) {
    const email = raw.toLowerCase().trim().replace(/[.,;:)]+$/, '');
    if (seen.has(email)) continue;
    if (IGNORED.some((ignored) => email.includes(ignored))) continue;

    // Une adresse d'un autre domaine que celui de l'entreprise est, le plus
    // souvent, celle d'un prestataire mentionné sur la page.
    if (options.domain && !email.endsWith(`@${options.domain}`)) {
      const host = email.split('@')[1] ?? '';
      if (!host.endsWith(options.domain) && !options.domain.endsWith(host)) continue;
    }

    seen.add(email);
    const mailbox = email.split('@')[0] ?? '';
    found.push({
      kind: 'email',
      value: email,
      label: null,
      generic: GENERIC_MAILBOXES.some((generic) => mailbox === generic || mailbox.startsWith(`${generic}.`)),
    });
    if (found.length >= 6) break;
  }

  for (const raw of pageText.match(PHONE) ?? []) {
    const phone = raw.trim().replace(/\s+/g, ' ');
    // Un numéro professionnel a une longueur plausible ; en dessous on ramasse
    // des dates, des codes postaux et des numéros de TVA.
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    found.push({ kind: 'phone', value: phone, label: null, generic: true });
    if (found.filter((c) => c.kind === 'phone').length >= 2) break;
  }

  return found;
}

/** Les URL à essayer pour une entreprise, dans l'ordre de probabilité. */
export function contactUrlsFor(website: string | null, domain: string | null): string[] {
  const base = website?.trim() || (domain ? `https://${domain}` : null);
  if (!base) return [];

  let origin: string;
  try {
    origin = new URL(base.startsWith('http') ? base : `https://${base}`).origin;
  } catch {
    return [];
  }
  return [origin, ...CONTACT_PATHS.map((path) => `${origin}${path}`)];
}
