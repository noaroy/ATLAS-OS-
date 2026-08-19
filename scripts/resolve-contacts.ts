/**
 * Rejouer la seule résolution de contacts sur des prospects déjà qualifiés.
 *
 * Ne touche ni au score, ni à l'identité, ni à l'état. N'appelle aucun modèle
 * et ne lance aucune recherche : les seules URL visitées sont celles du domaine
 * officiel déjà établi, plus les liens de contact qu'il publie lui-même.
 *
 * Le HTML est conservé brut, contrairement à la récupération de découverte qui
 * dépouille les pieds de page pour alléger le contexte du modèle. Ici c'est
 * précisément là que l'adresse se trouve le plus souvent.
 */
import { withDeadline, describeError, createLogger } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  resolveContacts,
  contactPagesFor,
  contactLinksIn,
  type ContactPage,
} from '../packages/departments/src/index.ts';

const batchId = process.argv[2];
const only = process.argv.slice(3).filter((a) => !a.startsWith('--'));
const apply = process.argv.includes('--apply');
if (!batchId) throw new Error('usage: resolve-contacts <batch-id> [DOMAINE…] [--apply]');

const TIMEOUT_MS = 12_000;
const MAX_PAGES = 10;
const MAX_BYTES = 512 * 1024;
const BLOCKED_HOST =
  /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|metadata\.)/i;

const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(process.env.ATLAS_DB_PATH ?? 'data/atlas.db', logger);

/** Une page, telle qu'un navigateur la reçoit. Jamais d'exploration au-delà. */
async function fetchRaw(url: string): Promise<ContactPage | { url: string; error: string }> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { url, error: 'URL invalide' };
  }
  if (target.protocol !== 'https:') return { url, error: 'seul https est autorisé' };
  if (BLOCKED_HOST.test(target.hostname)) return { url, error: 'hôte interne ou privé' };

  try {
    const response = await withDeadline(
      (signal) =>
        fetch(target, {
          signal,
          redirect: 'follow',
          headers: {
            'user-agent': 'ATLAS-OS/1.0 (+autonomous research agent)',
            accept: 'text/html,application/xhtml+xml',
          },
        }),
      { ms: TIMEOUT_MS, label: `page ${target.hostname}` },
    );
    if (!response.ok) return { url: target.href, error: `HTTP ${response.status}` };
    return { url: response.url || target.href, html: (await response.text()).slice(0, MAX_BYTES) };
  } catch (err) {
    return { url: target.href, error: describeError(err) };
  }
}

const prospects = repos.sales
  .forBatch(batchId)
  .filter((p) => (only.length === 0 ? p.tier === 'PRIORITY' : only.includes(p.domain ?? '')));

if (prospects.length === 0) throw new Error(`aucun prospect ciblé dans « ${batchId} »`);

console.log(
  `RÉSOLUTION DE CONTACTS — ${batchId} — ${prospects.length} prospect(s)\n` +
    `${apply ? 'écriture en base' : 'simulation'} · 0 appel LLM · 0 recherche\n`,
);

for (const p of prospects) {
  const domain = p.domain!;
  console.log('─'.repeat(74));
  console.log(`${p.companyName}  ·  ${p.website}`);

  const pages: ContactPage[] = [];
  const failures: Array<{ url: string; error: string }> = [];
  const queue = contactPagesFor(p.website, domain);
  const visited = new Set<string>();

  // Deux passes : les chemins habituels, puis les liens de contact que la
  // page d'accueil publie — beaucoup de sites ne suivent aucune convention.
  for (let pass = 0; pass < 2; pass++) {
    for (const url of [...queue]) {
      if (visited.size >= MAX_PAGES) break;
      if (visited.has(url)) continue;
      visited.add(url);
      const result = await fetchRaw(url);
      if ('error' in result) {
        failures.push(result);
        continue;
      }
      pages.push(result);
      if (pass === 0 && url.endsWith('/') && queue.length < MAX_PAGES) {
        for (const link of contactLinksIn(result.html, result.url, domain)) {
          if (!visited.has(link)) queue.push(link);
        }
      }
    }
  }

  const resolution = resolveContacts({ officialDomain: domain, pages });
  const email = resolution.publicEmails[0] ?? null;
  const phone = resolution.publicPhones[0] ?? null;
  const form = resolution.contactFormUrl;

  console.log(`  pages lues        ${pages.length} · échecs ${failures.length}`);
  for (const f of failures.slice(0, 4)) console.log(`    ${f.url} — ${f.error}`);
  console.log(`  PUBLIC EMAIL      ${email ? `${email.value}  [${email.confidence}]` : 'NONE'}`);
  console.log(`  EMAIL SOURCE      ${email?.sourceUrl ?? '—'}`);
  console.log(`  CONTACT FORM      ${form ? 'OUI' : 'NONE'}`);
  console.log(`  FORM SOURCE       ${form?.sourceUrl ?? '—'}`);
  console.log(`  PHONE             ${phone ? `${phone.value}  [${phone.confidence}]` : 'NONE'}`);
  console.log(`  CONTACT METHOD    ${resolution.method}`);
  if (resolution.publicEmails.length > 1) {
    console.log(`  autres adresses   ${resolution.publicEmails.slice(1).map((e) => e.value).join(', ')}`);
  }
  if (resolution.contactPersonName) {
    console.log(`  CONTACT PERSON    ${resolution.contactPersonName} · ${resolution.contactPersonRole ?? '—'}`);
  }

  if (apply && resolution.primary) {
    const confidence = resolution.primary.confidence === 'HIGH' ? 0.9
      : resolution.primary.confidence === 'MEDIUM' ? 0.7 : 0.5;
    repos.sales.setContact(p.id, {
      name: resolution.contactPersonName,
      role: resolution.contactPersonRole,
      email: email?.value ?? null,
      phone: phone?.value ?? null,
      contactPage: form?.value ?? null,
      sourceUrl: resolution.primary.sourceUrl,
      confidence,
      method: resolution.method,
      confidenceLabel: resolution.primary.confidence,
      observed: true,
    });
    console.log(`  → écrit · éligibilité ${repos.sales.outreachEligibility(p.id).eligibility}`);
  } else if (apply) {
    console.log('  → rien à écrire : aucune coordonnée observée.');
  }
  console.log('');
}

console.log('─'.repeat(74));
console.log('MESSAGES SENT: 0');
if (!apply) console.log('Rien écrit. Ajoutez --apply.');
repos.close();
