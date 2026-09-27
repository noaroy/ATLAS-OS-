/**
 * Diagnostic de la fabrique, en lecture seule : pourquoi 0 SEND_ELIGIBLE ?
 *
 *   npx tsx scripts/revenue-factory-diagnose.ts            (ou via atlas-cli)
 *
 * Ouvre la base en `readonly` — aucune migration, aucune écriture — et
 * affiche : la répartition par classe, chaque blocage avec sa fréquence, les
 * DROP par motif, et l'état de l'offre (prospects jamais examinés, candidats
 * d'expansion qualifiés non versés). Aucun secret, aucune adresse de contact.
 */
import Database from 'better-sqlite3';
import { loadAtlasEnv, loadConfig } from '../packages/core/src/index.ts';

loadAtlasEnv();
const config = loadConfig(process.cwd());
const db = new Database(config.paths.databaseFile, { readonly: true, fileMustExist: true });

const rows = db.prepare('SELECT domain, classification, send_eligible, blockers, attempts FROM revenue_factory_verdicts').all() as Array<{ domain: string; classification: string; send_eligible: number; blockers: string; attempts: number }>;
const norm = (b: string) => b.replace(/_\d+(\/\d+)?$|\d+\/\d+$/, '').replace(/^QUALITY_GATE:.*/, 'QUALITY_GATE');
const byClass: Record<string, number> = {};
const blockers: Record<string, number> = {};
const dropBy: Record<string, number> = {};
for (const r of rows) {
  byClass[r.classification] = (byClass[r.classification] ?? 0) + 1;
  const list = JSON.parse(r.blockers) as string[];
  for (const b of new Set(list.map(norm))) blockers[b] = (blockers[b] ?? 0) + 1;
  if (r.classification === 'DROP') { const k = norm(list[0] ?? 'SANS_MOTIF'); dropBy[k] = (dropBy[k] ?? 0) + 1; }
}
const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));

const neverExamined = (db.prepare(`SELECT COUNT(DISTINCT lower(replace(domain, 'www.', ''))) AS n FROM sales_prospects
  WHERE domain IS NOT NULL AND lower(replace(domain, 'www.', '')) NOT IN (SELECT domain FROM revenue_factory_verdicts)`).get() as { n: number }).n;
const backlog = (db.prepare(`SELECT COUNT(*) AS n FROM expansion_candidates c JOIN prospect_expansion_runs r ON r.id = c.run_id
  WHERE r.purpose = 'SALES' AND r.status IN ('DONE', 'CAPPED') AND c.stage IN ('QUALIFIED', 'HIGH_PRIORITY')
    AND c.is_seed = 0 AND c.prospect_id IS NULL AND c.canonical_domain IS NOT NULL AND c.entity_kind = 'COMPANY'`).get() as { n: number }).n;

console.log(JSON.stringify({
  verdicts: rows.length,
  sendEligible: rows.filter((r) => r.send_eligible === 1).length,
  byClass: sorted(byClass),
  blockersByFrequency: sorted(blockers),
  dropByReason: sorted(dropBy),
  supply: { prospectsNeverExamined: neverExamined, expansionCandidatesNotPromoted: backlog },
  readOnly: true,
}, null, 2));
db.close();
