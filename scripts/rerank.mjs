/**
 * Recalcule le classement d'une mission — sans aucun appel au modèle.
 *
 * L'ordre découle des scores déjà calculés, et la justification est produite
 * par `explainScore`, une fonction pure. Rejouer cette étape ne coûte rien et
 * régénère les textes avec les règles corrigées.
 *
 *   node scripts/rerank.mjs M-WX5T0
 */
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig } from '../packages/core/src/index.ts';

const code = process.argv[2] ?? 'M-WX5T0';
const system = createSystem(loadConfig());
const { repos } = system;

const mission = repos.missions.list({ limit: 200, offset: 0 }).items.find((m) => m.code === code);
if (!mission) {
  console.error(`Mission « ${code} » introuvable.`);
  process.exit(1);
}
const department = repos.departments.require(mission.departmentKey ?? 'business-expansion');

const shortlist = system.intelligence.rank({
  missionId: mission.id,
  agentKey: 'analyst',
  model: department.scoringModel,
});

console.log(`\n  ${shortlist.length} candidat(s) reclassé(s) — aucun appel au modèle.\n`);
for (const o of shortlist) {
  const company = repos.companies.require(o.companyId);
  console.log(`  ${o.rank}. ${company.name} — ${o.score}/100`);
}
console.log();
await system.shutdown('reclassement');
