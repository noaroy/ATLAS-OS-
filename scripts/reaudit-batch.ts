/**
 * Rejouer les gardes de résolution d'identité sur un lot déjà collecté.
 *
 * Aucun appel modèle, aucune requête réseau, aucune écriture : les données du
 * lot 002 sont la trace d'un défaut, et une trace qu'on corrige ne prouve plus
 * rien. Ce script lit, applique les nouvelles gardes, et dit ce qui serait
 * tombé si elles avaient existé au moment du lot.
 */
import { loadAtlasEnv } from '../packages/core/src/index.ts';
import Database from 'better-sqlite3';
import {
  classifyPageType,
  resolveCompanyIdentity,
  icpStatus,
  checkPriorityEligibility,
  SALES_TIER_THRESHOLDS,
} from '../packages/departments/src/index.ts';

// Avant toute lecture de process.env : sans cet appel, `.env.local` n'existe
// pas pour ce processus et la configuration parait absente sans qu'aucune
// erreur ne le dise.
loadAtlasEnv();

const batchId = process.argv[2];
if (!batchId) throw new Error('usage: reaudit-batch <batch-id>');

// Lecture seule, volontairement : le lot 002 est la trace d'un défaut. Une
// connexion incapable d'écrire vaut mieux qu'une promesse de ne pas le faire.
const db = new Database(process.env.ATLAS_DB_PATH ?? 'data/atlas.db', { readonly: true });
const rows = db
  .prepare(
    `SELECT id, company_name, domain, website, country, industry, source_url,
            state, tier, score
       FROM sales_prospects WHERE batch_id = ? ORDER BY score DESC NULLS LAST`,
  )
  .all(batchId) as Array<Record<string, string | number | null>>;

if (rows.length === 0) throw new Error(`lot « ${batchId} » introuvable`);

const facts = db.prepare(
  `SELECT COUNT(*) AS n FROM sales_evidence WHERE prospect_id = ? AND nature = 'observed'`,
);

let survivors = 0;
let removed = 0;
let priorityBefore = 0;
let priorityAfter = 0;

console.log(`RE-AUDIT HORS-LIGNE — ${batchId} — ${rows.length} entrées — 0 appel LLM\n`);

for (const row of rows) {
  const title = String(row.company_name ?? '');
  const domain = row.domain ? String(row.domain) : null;
  const url = String(row.source_url ?? row.website ?? '');

  const page = classifyPageType({ url, domain, title });
  const outcome = resolveCompanyIdentity({
    searchTitle: title,
    url,
    domain,
    country: row.country ? String(row.country) : null,
    page,
  });
  const icp = outcome.identity
    ? icpStatus({
        companyName: outcome.identity.companyName,
        industry: row.industry ? String(row.industry) : null,
        country: outcome.identity.country,
      })
    : { status: 'UNKNOWN' as const, reason: 'aucune identité à évaluer.' };

  const observed = (facts.get(row.id) as { n: number }).n;
  const wasPriority = row.tier === 'PRIORITY';
  if (wasPriority) priorityBefore += 1;

  const priority = checkPriorityEligibility({
    identity: outcome.identity,
    pageType: page.type,
    icp: icp.status,
    observedFacts: observed,
    score: Number(row.score ?? 0),
    scoreThreshold: SALES_TIER_THRESHOLDS.priority,
    hasSourcedPersonalization: observed > 0,
  });

  const passes = outcome.identity !== null && icp.status === 'MATCH';
  const final = !passes ? 'REJECTED' : priority.eligible ? 'PRIORITY' : 'REVIEW_ONLY';
  if (passes) survivors += 1;
  else removed += 1;
  if (final === 'PRIORITY') priorityAfter += 1;

  const reason = !outcome.identity
    ? outcome.reason
    : icp.status !== 'MATCH'
      ? icp.reason
      : priority.eligible
        ? 'identité, domaine et profil cohérents.'
        : priority.blockers.join(' · ');

  console.log(`ORIGINAL TITLE   ${title}`);
  console.log(`DOMAIN           ${domain ?? '—'}`);
  console.log(`PAGE TYPE        ${page.type} — ${page.reason}`);
  console.log(`RESOLVED COMPANY ${outcome.identity?.companyName ?? '— (non résolue)'}`);
  console.log(`OFFICIAL DOMAIN  ${outcome.identity?.canonicalDomain ?? '—'}`);
  console.log(`ICP STATUS       ${icp.status}`);
  console.log(`FINAL STATUS     ${final}${wasPriority ? '   (était PRIORITY dans le lot)' : ''}`);
  console.log(`REASON           ${reason}`);
  console.log('');
}

console.log('─'.repeat(72));
console.log(`entrées            ${rows.length}`);
console.log(`retenues           ${survivors}`);
console.log(`écartées           ${removed}`);
console.log(`PRIORITY avant     ${priorityBefore}`);
console.log(`PRIORITY après     ${priorityAfter}`);
console.log(`faux positifs      ${priorityBefore - priorityAfter} retirés`);
console.log(`appels LLM         0`);
