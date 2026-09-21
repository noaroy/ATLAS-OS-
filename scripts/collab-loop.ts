/**
 * La boucle de collaboration Claude ↔ GPT.
 *
 * Les deux modèles échangent sur un objectif commun, à tour de rôle : chacun
 * lit ce que l'autre vient de dire et apporte son analyse, sa critique ou sa
 * proposition. Aucun des deux ne touche à un fichier, un terminal ou un envoi —
 * cette boucle raisonne, elle n'agit pas. Le dialogue s'arrête quand les deux
 * camps se déclarent d'accord, ou à un plafond (tours, coût du dialogue,
 * budget du jour).
 *
 *   npm run collab:loop -- --objective="..." [--context="..."] \
 *     [--max-rounds=6] [--max-cost=1] [--start=openai]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger, loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { createAiProviders, runCollabLoop } from '../packages/runtime/src/index.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', cyan: '\x1b[36m',
};
const flag = (name: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const objective = flag('objective');
if (!objective) {
  console.error('usage: collab:loop -- --objective="..." [--context="..."] [--max-rounds=6] [--max-cost=1] [--start=openai]');
  process.exit(1);
}

const config = loadConfig(process.cwd());
const logger = createLogger({ level: 'info', pretty: true });
const repos = createRepositories(config.paths.databaseFile, logger);

const { openai, anthropic, live } = createAiProviders({ config, logger, repos });
logger.info(live ? 'appels réels : ce dialogue sera facturé' : 'mode figé : ATLAS_AI_LIVE=false, aucun appel payant', {});

try {
  const report = await runCollabLoop(
    { repos, config, providers: { anthropic, openai }, logger },
    {
      objective,
      context: flag('context') ?? undefined,
      maxRounds: flag('max-rounds') ? Number(flag('max-rounds')) : undefined,
      maxCostUsd: flag('max-cost') ? Number(flag('max-cost')) : undefined,
      startWith: flag('start')?.toUpperCase() === 'OPENAI' ? 'OPENAI' : undefined,
    },
  );

  console.log(`\n  ${c.bold}DIALOGUE${c.reset}  ${report.turns.length} tour(s) · ${report.converged ? `${c.green}convergé${c.reset}` : `${c.amber}arrêté${c.reset}`} — ${report.stoppedReason}\n`);
  for (const t of report.turns) {
    const speakerTint = t.speaker === 'ANTHROPIC' ? c.cyan : c.amber;
    const retried = t.attempts > 1 ? ` ${c.dim}(${t.attempts} tentatives)${c.reset}` : '';
    console.log(`  [${String(t.round).padStart(2)} · ${speakerTint}${t.speaker.padEnd(9)}${c.reset}]${retried} ${t.message.slice(0, 220)}${t.message.length > 220 ? '…' : ''}`);
    if (t.proposedAction) console.log(`             ${c.dim}→ ${t.proposedAction}${c.reset}`);
  }
  console.log(`\n  coût total : ${report.totalCostUsd.toFixed(4)} $`);
  if (report.synthesis) console.log(`\n  ${c.bold}SYNTHÈSE${c.reset}\n  ${report.synthesis}\n`);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const path = join('out', 'collab', `${stamp}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const md = [
    `# Boucle de collaboration — ${objective}`,
    '',
    `- Tours : ${report.turns.length}`,
    `- ${report.converged ? 'Convergé' : 'Arrêté'} : ${report.stoppedReason}`,
    `- Coût : ${report.totalCostUsd.toFixed(4)} $`,
    '',
    ...report.turns.map((t) => `## Tour ${t.round} — ${t.speaker}\n\n${t.message}${t.proposedAction ? `\n\n**Action proposée :** ${t.proposedAction}` : ''}\n`),
    ...(report.synthesis ? [`## Synthèse\n\n${report.synthesis}`] : []),
  ].join('\n');
  writeFileSync(path, md, 'utf8');
  console.log(`  transcript écrit : ${path}`);
  console.log(`  Aucune action exécutée, aucun fichier du dépôt modifié, aucun envoi. MESSAGES SENT: 0\n`);
} finally {
  repos.close();
}
