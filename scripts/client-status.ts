/**
 * Où en est une mission client — en un écran.
 *
 *   npm run client:status -- --run=<id>
 *   npm run client:status -- --run=<id> --probe        sonde aussi les moteurs (requêtes réelles, gratuites)
 *
 * Aucune écriture, aucun appel modèle.
 */
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createSearchFabric } from '../packages/intelligence/src/search/fabric/factory.ts';
import { probeSearchProviders } from '../packages/intelligence/src/index.ts';
import {
  loadClientRun, readAutopilot, countsFor, nextAction, spendSoFar, missionMetrics, DEFAULT_LIMITS, LEVEL_LABELS,
} from '../packages/runtime/src/index.ts';

loadAtlasEnv();

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m' };
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => process.argv.includes(`--${n}`);

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);
  const { repos } = system;
  try {
    const runId = arg('run');
    if (!runId) throw new Error('--run=<id> requis');
    const { context, brief } = loadClientRun(repos, runId);
    const ap = readAutopilot(context);
    const candidates = repos.clientCandidates.forRun(runId);
    const counts = countsFor(candidates);
    const cost = spendSoFar(repos, { runId, batchStartedAt: '1970-01-01T00:00:00.000Z' }, new Date().toISOString()).run;
    const next = nextAction(ap, counts, brief, runId, DEFAULT_LIMITS);
    const metrics = missionMetrics(context, candidates, cost);
    const plafond = Number(arg('budget') ?? 1);

    // La progression : la part de l'objectif candidats déjà inspectée — pleine dès que l'objectif ou la saturation est atteint.
    const fini = ap ? ['FINAL_REVIEW_REQUIRED', 'FINAL_READY', 'COMPLETED'].includes(ap.state) || ap.saturation.saturated || counts.retained >= brief.objective.targetRetained : false;
    const progress = fini ? 1 : Math.min(1, counts.processed / brief.objective.maxCandidates);
    const barre = `${'█'.repeat(Math.round(progress * 18))}${'░'.repeat(18 - Math.round(progress * 18))}`;

    let moteurs = '';
    if (flag('probe')) {
      const fabric = createSearchFabric(config.search, { need: { countries: ['SE'], languages: ['sv'], commercial: true } });
      if (fabric) {
        const probes = await probeSearchProviders(fabric.registry, { query: 'distributör förpackningsmaskiner Sverige', count: 5, country: 'SE', language: 'sv' }, { countries: ['SE'], languages: ['sv'], commercial: true }, { logger: system.logger, timeoutMs: 20_000 });
        moteurs = probes.filter((p) => p.available && p.suitable).map((p) => `    ${p.key.padEnd(12)} ${p.outcome === 'ok' && p.results > 0 ? `${c.green}READY${c.reset}` : p.outcome === 'rate-limited' ? `${c.amber}DEGRADED${c.reset}` : `${c.red}BLOCKED${c.reset}`}`).join('\n');
      }
    } else {
      moteurs = `    ${c.dim}(--probe pour sonder les moteurs)${c.reset}`;
    }

    const etatCouleur = !ap ? c.dim : ['COMPLETED', 'FINAL_READY'].includes(ap.state) ? c.green : /PAUSED|FAILED|REQUIRED|WAITING/.test(ap.state) ? c.amber : c.green;
    console.log(`
  ${c.bold}ATLAS CLIENT MISSION${c.reset}
  ${brief.client.name} / ${brief.market.countryLabel}${brief.client.internalTest ? ` ${c.amber}INTERNAL_TEST${c.reset}` : ''} · brief v${brief.version} · ${runId}
  ${barre} ${Math.round(progress * 100)}%

  State:
    ${etatCouleur}${ap?.state ?? 'sans pilote (conduite manuelle)'}${c.reset}${ap ? ` · niveau ${LEVEL_LABELS[ap.level]} · depuis ${ap.since.slice(0, 16).replace('T', ' ')}` : ''}

  Candidates:
    ${String(counts.discovered).padStart(5)} discovered
    ${String(counts.processed).padStart(5)} processed
    ${String(counts.retained).padStart(5)} retained
    ${String(counts.excluded).padStart(5)} excluded
    ${String(counts.review).padStart(5)} review
    ${String(counts.pendingRetry).padStart(5)} retry
    ${String(counts.pending - counts.pendingRetry).padStart(5)} waiting

  Quality:
    ${ap?.quality ? `${ap.quality.label.replace('QUALITY_', '')} (${ap.quality.score}/100, lot #${ap.quality.batch})` : '—'}${ap?.saturation.saturated ? ` · marché saturé : ${ap.saturation.reason}` : ''}

  Cost:
    ${cost.toFixed(2)} / ${plafond.toFixed(2)} USD${arg('budget') ? '' : ` ${c.dim}(plafond par défaut ; --budget=… pour le vôtre)${c.reset}`} · ${metrics.llmCalls} appels · ${metrics.batches} lot(s) · ${metrics.machineSeconds} s machine · ${metrics.humanActions} intervention(s) humaine(s)

  Search:
${moteurs}

  Objective:
    ${counts.retained} / ${brief.objective.targetRetained} retenues (minimum ${brief.objective.targetRetainedMin}) · ${counts.discovered} / ${brief.objective.maxCandidates} candidats

  Next action:
    ${c.bold}${next.action}${c.reset} — ${next.reason}
  Command:
    ${next.command ?? '—'}
`);
  } finally {
    await system.shutdown('client-status terminé');
  }
}

main().catch((err) => {
  console.error(`\n  ${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
  process.exitCode = 1;
});
