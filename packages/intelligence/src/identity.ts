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

/** Ce qu'on sait d'une entreprise au moment de décider si c'est bien elle. */
export interface IdentityEvidence {
  name: string;
  domain?: string | null;
  website?: string | null;
  legalName?: string | null;
  country?: string | null;
  city?: string | null;
  /** Numéro de registre du commerce, quand il est connu. */
  registryId?: string | null;
}

export type IdentityVerdict =
  /** La même organisation, établie sur des signaux qui ne se contredisent pas. */
  | 'same'
  /** Deux organisations distinctes — un signal fort les sépare. */
  | 'different'
  /** Rien ne tranche : ni assez d'accord pour fusionner, ni de quoi séparer. */
  | 'uncertain';

export interface IdentityAssessment {
  verdict: IdentityVerdict;
  /** 0..1 — ce que valent les accords constatés. */
  confidence: number;
  agreements: string[];
  conflicts: string[];
}

/**
 * S'agit-il de la même entreprise ?
 *
 * REVENUE-001 a produit une fiche nommée « Heidelberg Druckmaschinen AG »
 * portant le domaine `bhs-corrugated.com` et la ville de BHS Corrugated. Deux
 * fabricants allemands réels, tous deux de lignée `live` — la barrière de
 * lignée ne pouvait rien voir, et n'avait rien à voir : le problème n'est pas
 * la provenance, c'est l'identité.
 *
 * Trois principes, dans cet ordre :
 *
 *   1. **Un désaccord fort tranche seul.** Deux domaines différents désignent
 *      deux organisations, point. C'est le cas explicitement interdit :
 *      l'entreprise A ne peut pas hériter du domaine de l'entreprise B.
 *   2. **Un accord fort ne suffit pas s'il est seul.** Un nom identique dans
 *      deux pays différents n'établit rien : « Meyer GmbH » existe partout.
 *   3. **L'incertitude reste l'incertitude.** Elle n'est pas arrondie vers la
 *      fusion sous prétexte que fusionner est plus commode.
 *
 * Purement déterministe : aucune comparaison n'appelle le modèle. Un verdict
 * d'identité doit pouvoir être rejoué à l'identique et expliqué à un client.
 */
export function assessIdentity(a: IdentityEvidence, b: IdentityEvidence): IdentityAssessment {
  const agreements: string[] = [];
  const conflicts: string[] = [];

  const domainA = a.domain ?? normaliseDomain(a.website);
  const domainB = b.domain ?? normaliseDomain(b.website);
  const nameA = normaliseName(a.name);
  const nameB = normaliseName(b.name);
  const legalA = a.legalName ? normaliseName(a.legalName) : null;
  const legalB = b.legalName ? normaliseName(b.legalName) : null;
  const countryA = a.country?.trim().toLowerCase() || null;
  const countryB = b.country?.trim().toLowerCase() || null;
  const cityA = a.city?.trim().toLowerCase() || null;
  const cityB = b.city?.trim().toLowerCase() || null;

  // ── Ce qui sépare, quoi qu'il en soit par ailleurs ──────────────────────
  if (a.registryId && b.registryId && a.registryId.trim() !== b.registryId.trim()) {
    conflicts.push(`identifiants légaux différents (${a.registryId} ≠ ${b.registryId})`);
    return { verdict: 'different', confidence: 0, agreements, conflicts };
  }
  if (domainA && domainB && domainA !== domainB) {
    conflicts.push(`domaines différents (${domainA} ≠ ${domainB})`);
    return { verdict: 'different', confidence: 0, agreements, conflicts };
  }
  if (countryA && countryB && countryA !== countryB) {
    conflicts.push(`pays différents (${a.country} ≠ ${b.country})`);
    return { verdict: 'different', confidence: 0, agreements, conflicts };
  }

  // ── Ce qui rapproche ────────────────────────────────────────────────────
  let score = 0;
  if (a.registryId && b.registryId) {
    agreements.push(`même identifiant légal (${a.registryId})`);
    score += 0.6;
  }
  if (domainA && domainB) {
    agreements.push(`même domaine (${domainA})`);
    score += 0.55;
  }
  if (legalA && legalB && legalA === legalB) {
    agreements.push('même raison sociale');
    score += 0.35;
  }
  if (nameA && nameB && nameA === nameB) {
    agreements.push('même nom normalisé');
    score += 0.3;
  } else if (nameA && nameB && !legalA && !legalB) {
    // Des noms qui divergent quand rien d'autre ne les rattache : signal
    // faible, mais c'est exactement le cas Heidelberg / BHS quand un seul des
    // deux côtés porte un domaine.
    conflicts.push(`noms sans rapport (« ${nameA} » ≠ « ${nameB} »)`);
    score -= 0.25;
  }
  if (countryA && countryB) {
    agreements.push(`même pays (${a.country})`);
    score += 0.1;
  }
  if (cityA && cityB) {
    if (cityA === cityB) {
      agreements.push(`même ville (${a.city})`);
      score += 0.1;
    } else {
      conflicts.push(`villes différentes (${a.city} ≠ ${b.city})`);
      score -= 0.2;
    }
  }

  const confidence = Math.max(0, Math.min(1, score));

  // Le seuil est haut, et il doit l'être : le coût d'une fusion erronée est un
  // dossier client mêlant deux entreprises, découvert par le client. Le coût
  // d'une fusion manquée est une fiche en double, découverte par nous.
  if (confidence >= 0.6 && conflicts.length === 0) {
    return { verdict: 'same', confidence, agreements, conflicts };
  }
  return { verdict: 'uncertain', confidence, agreements, conflicts };
}

/** La fusion n'est autorisée que sur une identité établie. */
export function canMerge(assessment: IdentityAssessment): boolean {
  return assessment.verdict === 'same';
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
