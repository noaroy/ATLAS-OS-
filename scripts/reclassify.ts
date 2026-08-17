/**
 * Rejuge une mission de validation déjà exécutée, selon les critères de son preset.
 *
 *   npx tsx scripts/reclassify.ts M-FHPPM VAL-001-DISCOVERY
 *
 * Lecture seule, aucune dépense, aucune exécution. Sert quand les critères
 * changent après coup : les faits sont en base, seule la grille de lecture
 * bouge — et rejouer la mission pour obtenir le même verdict coûterait le prix
 * d'une mission pour n'apprendre rien.
 */
import { createLogger } from '../packages/core/src/logger.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { loadConfig } from '../packages/core/src/index.ts';
import { evaluatePreset, formatPresetVerdict } from '../packages/runtime/src/preset-verdict.ts';
import { missionEconomics } from '../packages/intelligence/src/economics.ts';
import { presetById } from '../packages/departments/src/validation-presets.ts';

const [code, presetId] = process.argv.slice(2);
const logger = createLogger({ level: 'error', pretty: false });

const preset = presetId ? presetById(presetId) : undefined;
if (!code || !preset) {
  console.error('\n  usage : npx tsx scripts/reclassify.ts <CODE_MISSION> <PRESET_ID>\n');
  process.exit(1);
}

const config = loadConfig();
const repos = createRepositories(config.paths.databaseFile, logger);

try {
  const mission = repos.missions.list({ limit: 200, offset: 0 }).items.find((m) => m.code === code);
  if (!mission) {
    console.error(`\n  Mission « ${code} » introuvable.\n`);
    process.exit(1);
  }

  const economics = missionEconomics({
    repos,
    missionId: mission.id,
    model: preset.limits.model,
    simulated: false,
  });
  const cost = economics.estimatedCostUsd ?? 0;

  const verdict = evaluatePreset({
    repos,
    missionId: mission.id,
    gate: preset.gate,
    maxCostUsd: preset.limits.maxCostUsd,
    spentUsd: cost,
  });

  console.log(`\n  ${preset.id} — ${mission.code} (${mission.status})`);
  console.log(`  reclassée selon les critères déclarés du preset, sans réexécution\n`);
  console.log(formatPresetVerdict(verdict));
  console.log();
} finally {
  repos.close();
}
