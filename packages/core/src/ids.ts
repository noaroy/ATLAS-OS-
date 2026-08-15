import { randomBytes, randomUUID } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Lexicographically sortable, collision-resistant id (ULID-compatible layout:
 * 48-bit timestamp + 80 bits of randomness).
 *
 * Sortability matters here: ids double as the natural ordering for events and
 * messages, so the event log stays chronological without a secondary index.
 */
export function ulid(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }

  const bytes = randomBytes(10);
  let rand = '';
  for (let i = 0; i < 16; i++) {
    // 16 base-32 chars carry the 80 random bits, 5 bits at a time.
    const bitOffset = i * 5;
    const byteIndex = bitOffset >> 3;
    const shift = bitOffset & 7;
    const chunk = ((bytes[byteIndex]! << 8) | (bytes[byteIndex + 1] ?? 0)) >> (11 - shift);
    rand += CROCKFORD[chunk & 31]!;
  }
  return time + rand;
}

/** Prefixed id, e.g. `msn_01J...` — makes ids self-describing in logs. */
export function id(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export const uuid = (): string => randomUUID();

/**
 * Human-facing mission code, e.g. `M-2K4A9`. Short enough to say out loud,
 * unique enough for a single-founder workload.
 */
export function missionCode(): string {
  const raw = ulid().slice(-5);
  return `M-${raw}`;
}

/** URL/file-safe slug used for artifact names and workflow keys. */
export function slugify(input: string, maxLength = 60): string {
  const slug = input
    .normalize('NFKD')
    // Strip combining diacritics so accented input yields clean ASCII slugs.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || 'item').slice(0, maxLength).replace(/-+$/g, '');
}
