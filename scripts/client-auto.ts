/**
 * Le pilote automatique d'une mission client : tout ce qui est certain,
 * et l'arrêt exact là où le jugement humain devient utile.
 *
 *   npm run client:auto -- --brief=briefs/<client>.json                 le plan et l'estimation, rien d'irréversible
 *   npm run client:auto -- --brief=briefs/<client>.json --go            preflight → mission → lots → tri → arrêt propre
 *   npm run client:auto -- --run=<id> --go                              reprise exactement où la mission en était
 *   npm run client:auto -- --run=<id> --feedback="…"                    le retour client → proposition de brief v2 (jamais appliquée seule)
 *   npm run client:auto -- --run=<id> --approve-brief [--go]            applique la proposition relue, puis continue
 *   npm run client:auto -- --run=<id> --review-done --go                la revue est faite : le pilote reprend
 *   npm run client:auto -- --run=<id> --final                           écrit le rapport FINAL (ne l'envoie pas)
 *   npm run client:auto -- --run=<id> --complete                        clôt, après les quatre contrôles humains
 *   npm run client:auto -- --run=<id> --budget=3.00 --raise-budget --go relève le plafond après une pause budget
 *
 * Options : --level=0|1|2|3 (2 par défaut) · --budget · --batch-budget · --concurrency
 *           --batch-size · --batch-max · --max-batches · --partial-at · --no-cache · --notify
 *
 * Ctrl+C : le candidat en cours est terminé, l'état écrit, la mission reprenable.
 * Un second exécutant sur la même mission est refusé.
 *
 * Ce script n'envoie rien, ne soumet rien, ne contacte personne, ne livre rien.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createSearchFabric } from '../packages/intelligence/src/search/fabric/factory.ts';
import { fetchRawPages } from '../packages/intelligence/src/contact-fetch.ts';
import { probeSearchProviders, classifySearchReadiness } from '../packages/intelligence/src/index.ts';
import { parseClientBrief, BUSINESS_EXPANSION, type ClientBrief } from '../packages/departments/src/index.ts';
import {
  runAutopilot, runClientPreflight, clientBudgetLimits, DEFAULT_LIMITS, LEVEL_LABELS,
  type AutopilotLevel, type MissionState, type AutopilotLimits,
} from '../packages/runtime/src/index.ts';

loadAtlasEnv();

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m' };
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => process.argv.includes(`--${n}`);
const entier = (n: string, defaut: number, min: number, max: number): number => {
  const brut = arg(n);
  if (brut === undefined || brut === '') return defaut;
  const v = Number(brut);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`--${n}=${brut} : un entier entre ${min} et ${max}`);
  return v;
};
const MODEL = 'claude-haiku-4-5-20251001';

/** Le verrou d'exécutant : un fichier créé atomiquement, avec le pid ; périmé après 30 minutes sans battement. */
function verrou(runId: string): (() => void) | null {
  const chemin = join('out', 'client', runId, 'runner.lock');
  mkdirSync(dirname(chemin), { recursive: true });
  const vivant = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (existsSync(chemin)) {
    try {
      const { pid, at } = JSON.parse(readFileSync(chemin, 'utf8')) as { pid: number; at: string };
      const age = Date.now() - Date.parse(at);
      if (pid !== process.pid && vivant(pid) && age < 30 * 60_000) return null;
    } catch { /* verrou illisible : on le remplace */ }
    unlinkSync(chemin);
  }
  const fd = openSync(chemin, 'wx');
  writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  closeSync(fd);
  const battement = setInterval(() => { try { writeFileSync(chemin, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } catch { /* ignoré */ } }, 60_000);
  return () => { clearInterval(battement); try { unlinkSync(chemin); } catch { /* déjà parti */ } };
}

/** Une notification Windows locale, sur demande seulement — jamais un email. */
function notifier(state: MissionState, message: string): void {
  process.stdout.write('\x07');
  if (process.platform !== 'win32') return;
  const texte = `${state} — ${message}`.replace(/'/g, '’').slice(0, 200);
  const script = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(8000, 'ATLAS mission client', '${texte}', [System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Seconds 9; $n.Dispose()`;
  try {
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* la notification est un confort, pas une garantie */ }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);
  const { repos } = system;
  const t0 = Date.now();

  try {
    if (config.search.fallbackEnabled) throw new Error('ATLAS_SEARCH_FALLBACK_ENABLED est actif : refus. Un modèle ne remplace pas un moteur.');

    let brief: ClientBrief | undefined;
    const briefPath = arg('brief');
    if (briefPath) {
      if (!existsSync(briefPath)) throw new Error(`brief introuvable : ${briefPath}`);
      const v = parseClientBrief(JSON.parse(readFileSync(briefPath, 'utf8')));
      if (!v.ok) throw new Error(`brief invalide :\n  ${v.errors.join('\n  ')}`);
      brief = v.brief!;
    }
    const runId = arg('run');
    if (!brief && !runId) throw new Error('--brief=<fichier.json> ou --run=<id> requis');
    repos.departments.ensure(BUSINESS_EXPANSION);

    const level = entier('level', 2, 0, 3) as AutopilotLevel;
    const plafonds = clientBudgetLimits(config.ai, { budget: arg('budget'), batchBudget: arg('batch-budget') });
    const limits: Partial<AutopilotLimits> = {
      batchSizeDefault: entier('batch-size', DEFAULT_LIMITS.batchSizeDefault, DEFAULT_LIMITS.batchSizeMin, 100),
      batchSizeMax: entier('batch-max', DEFAULT_LIMITS.batchSizeMax, DEFAULT_LIMITS.batchSizeMin, 100),
      maxBatchesPerInvocation: entier('max-batches', DEFAULT_LIMITS.maxBatchesPerInvocation, 1, 20),
      partialAtRetained: entier('partial-at', DEFAULT_LIMITS.partialAtRetained, 1, 100),
    };

    const fabric = createSearchFabric(config.search, { need: { countries: ['SE'], languages: ['sv'], commercial: true } });
    if (!fabric && flag('go')) throw new Error('aucun moteur configuré');

    // Le coupe-circuit : Ctrl+C, ou un fichier posé par `client:pause`.
    let stop = false;
    process.on('SIGINT', () => { if (!stop) console.log(`\n  ${c.amber}arrêt demandé — le candidat en cours se termine, l'état est écrit${c.reset}`); stop = true; });
    const pauseFile = (id: string) => join('out', 'client', id, 'pause.request');

    const writeFile = (relative: string, content: string): string => {
      const chemin = join('out', relative);
      mkdirSync(dirname(chemin), { recursive: true });
      writeFileSync(chemin, content, 'utf8');
      return chemin;
    };

    let runEnCours: string | null = runId ?? null;
    const outcome = await runAutopilot({
      repos, search: fabric ?? { key: 'none', label: 'aucun', availability: () => ({ available: false, reason: 'aucun moteur' }), search: async () => ({ results: [], outcome: 'unavailable', detail: 'aucun moteur', costUsd: 0, durationMs: 0 }) } as never,
      fetchPages: async (urls, maxPages, opts) => {
        const out = await fetchRawPages(urls, { logger: system.logger, timeoutMs: opts?.timeoutMs ?? 20_000, maxPages });
        return { pages: out.pages.map((p) => ({ url: p.url, html: p.html })), attempts: out.attempts, failures: out.failures.map((f) => ({ url: f.url, kind: f.kind, reason: f.reason })) };
      },
      llm: system.provider, model: MODEL, logger: system.logger,
      scoringModel: BUSINESS_EXPANSION.scoringModel, executionMode: config.llm.mode === 'live' ? 'live' : 'simulation',
      preflight: async (b) => runClientPreflight({
        repos, logger: system.logger, config, registry: fabric?.registry ?? null, provider: system.provider,
        hasApiKey: (process.env.ANTHROPIC_API_KEY ?? '').trim().length > 0, outputWritable: true,
      }, { brief: b, probeLlm: flag('probe-llm'), budgetArgs: { budget: arg('budget'), batchBudget: arg('batch-budget') } }),
      infra: async () => {
        if (!fabric) return { readiness: 'SEARCH_BLOCKED', detail: 'aucun moteur configuré' };
        const probes = await probeSearchProviders(fabric.registry, { query: 'distributör förpackningsmaskiner Sverige', count: 5, country: 'SE', language: 'sv' }, { countries: ['SE'], languages: ['sv'], commercial: true }, { logger: system.logger, timeoutMs: 20_000 });
        const r = classifySearchReadiness(probes);
        return { readiness: r.readiness, detail: r.summary };
      },
      writeFile,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      notify: flag('notify') ? notifier : undefined,
      shouldStop: () => stop || (runEnCours !== null && existsSync(pauseFile(runEnCours))),
      lock: (id) => { runEnCours = id; return verrou(id); },
    }, {
      brief, runId, level, go: flag('go'),
      runBudgetUsd: plafonds.mission.usd, batchBudgetUsd: plafonds.batch.usd, dailyBudgetUsd: plafonds.daily.usd,
      concurrency: entier('concurrency', 4, 1, 8), cache: !flag('no-cache'), limits, createdBy: process.env.ATLAS_FOUNDER_EMAIL ?? 'founder',
      feedback: arg('feedback'), approveBrief: flag('approve-brief'), reviewDone: flag('review-done'),
      final: flag('final'), complete: flag('complete'), raiseBudget: flag('raise-budget'),
    });

    // Un `client:pause` consommé est retiré : la prochaine reprise part propre.
    if (outcome.runId && existsSync(pauseFile(outcome.runId))) { try { unlinkSync(pauseFile(outcome.runId)); } catch { /* ignoré */ } }

    const nom = brief?.client.name ?? outcome.runId ?? '';
    console.log(`\n  ${c.bold}ATLAS CLIENT MISSION${c.reset}  ${nom}${brief?.client.internalTest ? ` ${c.amber}INTERNAL_TEST${c.reset}` : ''} · niveau ${LEVEL_LABELS[level]}${outcome.dryRun ? ` · ${c.amber}contrôle seul (sans --go)${c.reset}` : ''}`);
    if (outcome.preflight) {
      for (const l of outcome.preflight.lines) {
        const couleur = l.etat === 'READY' ? c.green : l.etat === 'DEGRADED' ? c.amber : l.etat === 'BLOCKED' ? c.red : c.dim;
        console.log(`  ${couleur}${l.etat.padEnd(13)}${c.reset}${l.nom.padEnd(20)}${c.dim}${l.detail.split('\n')[0]}${c.reset}`);
      }
    }
    if (outcome.estimate && (outcome.dryRun || outcome.created)) {
      const e = outcome.estimate;
      console.log(`\n  ${c.bold}Estimated:${c.reset}\n    Candidates max: ${e.maxCandidates}\n    Expected batches: ${e.expectedBatches} × ${e.batchSize}\n    Machine time: ~${e.machineMinutes[0]}–${e.machineMinutes[1]} min\n    Human review: ~${e.humanReviewMinutes[0]}–${e.humanReviewMinutes[1]} min\n    Expected AI cost: ~${e.aiCostUsd[0].toFixed(2)}–${e.aiCostUsd[1].toFixed(2)} USD\n    Hard budget: ${e.hardBudgetUsd.toFixed(2)} USD (mission) · ${plafonds.batch.usd.toFixed(2)} USD (lot) · ${plafonds.daily.configured ? `${plafonds.daily.usd.toFixed(2)} USD (jour)` : 'pas de plafond quotidien'}`);
      if (outcome.dryRun) console.log(`  ${c.amber}Proceed only with --go.${c.reset}`);
    }
    for (const m of outcome.messages) console.log(`  ${c.dim}· ${m}${c.reset}`);
    const humain = outcome.nextAction.human;
    console.log(`\n  État : ${humain ? c.amber : c.green}${outcome.state}${c.reset}${outcome.runId ? ` · ${outcome.runId}` : ''} · ${outcome.batchesRun} lot(s) ce lancement · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    console.log(`  Prochaine action : ${c.bold}${outcome.nextAction.action}${c.reset} — ${outcome.nextAction.reason}`);
    if (outcome.nextAction.command) console.log(`  Commande : ${outcome.nextAction.command}`);
    if (outcome.runId) console.log(`  ${c.dim}Suivi : npm run client:status -- --run=${outcome.runId}${c.reset}`);
    console.log(`  ${c.dim}MESSAGES SENT inchangé — ce pilote n'envoie rien, ne soumet rien, ne contacte personne${c.reset}\n`);
  } finally {
    await system.shutdown('client-auto terminé');
  }
}

main().catch((err) => {
  console.error(`\n  ${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
  process.exitCode = 1;
});
