/**
 * Company identity and deduplication.
 *
 * Deduplication is a platform mechanism rather than a skill an agent invokes:
 * a candidate is reconciled against the registry at the moment it is written,
 * so an agent that *forgets* to deduplicate cannot inflate a shortlist. Skills
 * describe what an agent chooses to do; this is a guarantee it cannot opt out of.
 */

/** Suffixes that carry no identity, only legal form. */
const LEGAL_FORMS = [
  'gmbh',
  'gmbh & co kg',
  'ag',
  'kg',
  'ohg',
  'ug',
  'mbh',
  'sa',
  'sas',
  'sarl',
  'sasu',
  'eurl',
  'sca',
  'spa',
  'srl',
  'bv',
  'nv',
  'ab',
  'as',
  'oy',
  'aps',
  'plc',
  'ltd',
  'limited',
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'holding',
  'holdings',
  'group',
  'groupe',
  'gruppe',
];

/** Hosts that identify a platform, never the company itself. */
const GENERIC_HOSTS = new Set([
  'linkedin.com',
  'facebook.com',
  'x.com',
  'twitter.com',
  'instagram.com',
  'youtube.com',
  'wikipedia.org',
  'crunchbase.com',
  'europages.com',
  'kompass.com',
  'wlw.de',
  'google.com',
]);

/**
 * Reduces a website to its registrable domain.
 *
 * Returns null for platform hosts: `linkedin.com/company/acme` identifies a
 * page, not an organisation, and treating it as identity would merge every
 * company that only had a LinkedIn page into one.
 */
export function normaliseDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  let host = website.trim().toLowerCase();
  if (!host) return null;

  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split('/')[0] ?? '';
  host = host.split('?')[0] ?? '';
  host = host.split('@').pop() ?? '';
  host = host.replace(/:\d+$/, '');
  host = host.replace(/^www\./, '');
  if (!host || !host.includes('.')) return null;
  if (/\s/.test(host)) return null;

  const labels = host.split('.');
  // Two-part public suffixes (co.uk, com.br) need three labels to be a domain.
  const registrable =
    labels.length > 2 && labels.at(-2)!.length <= 3 && labels.at(-1)!.length === 2
      ? labels.slice(-3).join('.')
      : labels.slice(-2).join('.');

  return GENERIC_HOSTS.has(registrable) ? null : registrable;
}

/** Strips accents, punctuation and legal form from a company name. */
export function normaliseName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[&+]/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  let words = base.split(' ').filter(Boolean);

  // Legal forms trail the name, so strip from the end until something real
  // remains — "Müller Antriebstechnik GmbH & Co KG" and "Muller
  // Antriebstechnik" must land on the same key.
  //
  // The conjunction in "& Co. KG" is only stripped once a legal form already
  // has been: that keeps the tail of a legal form from surviving as "and",
  // while leaving a genuine "Johnson and Johnson" intact.
  let strippedForm = false;
  while (words.length > 1) {
    const last = words.at(-1)!;
    if (LEGAL_FORMS.includes(last)) {
      strippedForm = true;
    } else if (!(last === 'and' && strippedForm)) {
      break;
    }
    words = words.slice(0, -1);
  }

  return words.join(' ');
}

/**
 * The key two sightings of one company must agree on.
 *
 * Domain wins when there is one: it is unambiguous and survives rebranding of
 * the display name. Otherwise identity falls back to normalised name plus
 * country, which is weaker but stops the obvious duplicates.
 */
export function canonicalKey(input: {
  name: string;
  website?: string | null;
  domain?: string | null;
  country?: string | null;
}): string {
  const domain = input.domain ?? normaliseDomain(input.website);
  if (domain) return `d:${domain}`;

  const name = normaliseName(input.name);
  const country = (input.country ?? '').trim().toLowerCase() || 'xx';
  return `n:${country}:${name}`;
}

/**
 * Whether two candidates are the same organisation.
 *
 * Used to catch same-mission duplicates that differ only in spelling, which the
 * canonical key alone would miss when one sighting has a domain and the other
 * does not.
 */
export function isSameCompany(
  a: { name: string; domain?: string | null; country?: string | null },
  b: { name: string; domain?: string | null; country?: string | null },
): boolean {
  if (a.domain && b.domain) return a.domain === b.domain;

  const nameA = normaliseName(a.name);
  const nameB = normaliseName(b.name);
  if (!nameA || !nameB) return false;
  if (nameA === nameB) {
    const countryA = a.country?.toLowerCase();
    const countryB = b.country?.toLowerCase();
    return !countryA || !countryB || countryA === countryB;
  }
  // One name containing the other only counts when the shorter is substantial,
  // or "Meyer" would swallow "Meyer Industrietechnik" and "Meyer Logistik".
  const [shorter, longer] = nameA.length <= nameB.length ? [nameA, nameB] : [nameB, nameA];
  return shorter.length >= 12 && longer.startsWith(`${shorter} `);
}
