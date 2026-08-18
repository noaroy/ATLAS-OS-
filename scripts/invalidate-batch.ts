/**
 * Consigner ce qu'un ré-audit condamne, sans toucher à ce qu'il audite.
 *
 * Le lot 002 garde ses deux PRIORITY : les effacer effacerait la preuve du
 * défaut en même temps que le défaut. Ce script écrit le jugement dans
 * `sales_invalidations`, table séparée, et laisse `sales_prospects` intact.
 *
 * Aucun appel modèle, aucune requête réseau : les motifs viennent des gardes
 * déterministes, rejouées sur des données déjà collectées.
 */
import { createLogger } from '../packages/core/src/logger.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  classifyPageType,
  resolveCompanyIdentity,
  icpStatus,
} from '../packages/departments/src/index.ts';

const batchId = process.argv[2];
const apply = process.argv.includes('--apply');
if (!batchId) throw new Error('usage: invalidate-batch <batch-id> [--apply]');

const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(process.env.ATLAS_DB_PATH ?? 'data/atlas.db', logger);

const prospects = repos.sales.forBatch(batchId);
if (prospects.length === 0) throw new Error(`lot « ${batchId} » introuvable`);

console.log(`${apply ? 'INVALIDATION' : 'SIMULATION'} — ${batchId} — ${prospects.length} entrées\n`);

let condemned = 0;
for (const p of prospects) {
  const url = p.sourceUrl ?? p.website ?? '';
  const page = classifyPageType({ url, domain: p.domain, title: p.searchTitle ?? p.companyName });
  const outcome = resolveCompanyIdentity({
    searchTitle: p.searchTitle ?? p.companyName,
    url,
    domain: p.domain,
    country: p.country,
    page,
  });

  let reason: string | null = null;
  if (!outcome.identity) {
    reason = outcome.reason;
  } else {
    const icp = icpStatus({
      companyName: outcome.identity.companyName,
      industry: p.industry,
      country: outcome.identity.country,
    });
    if (icp.status === 'OUT_OF_ICP') reason = icp.reason;
  }

  if (!reason) continue;
  condemned += 1;
  console.log(`  ${p.tier ?? '—'} ${p.companyName.slice(0, 46).padEnd(48)}`);
  console.log(`    ${reason.slice(0, 110)}`);
  if (apply) {
    repos.sales.invalidate(p.id, reason);
    const verdict = repos.sales.outreachEligibility(p.id);
    console.log(`    → historique ${verdict.historicalState}/${verdict.historicalTier ?? '—'} · effectif ${verdict.eligibility}`);
  }
  console.log('');
}

console.log(`${condemned} ligne(s) condamnée(s) sur ${prospects.length}.`);
console.log(apply ? 'Écrit dans sales_invalidations. sales_prospects intact.' : 'Rien écrit. Ajoutez --apply.');
repos.close();
