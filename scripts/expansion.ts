/**
 * Le moteur d'expansion de prospects, à la main.
 *
 *   npm run expansion -- run [--seed=<domaine>…] [--depth=1] [--max=30] [--searches=12] [--ai=0.05] [--strategies=PARTNER,SIMILAR]
 *   npm run expansion -- run --prospect=<id>              partir d'un prospect du registre
 *   npm run expansion -- status                            l'état : totaux, derniers tours, graines fécondes
 *   npm run expansion -- graph <domaine>                   le voisinage d'une entreprise : relations, preuves
 *   npm run expansion -- candidates [--run=<id>] [--stage=HIGH_PRIORITY]
 *   npm run expansion -- report [--run=<id>]               le rapport d'un tour : entonnoir, preuves, coûts
 *   npm run expansion -- promote --run=<id> [--stage=HIGH_PRIORITY]   verser les candidats dans la file commerciale (DISCOVERED)
 *
 * Sans --seed ni --prospect, `run` part des prospects les plus forts du
 * registre (PRIORITY puis GOOD_FIT). Aucun message ne part, jamais : le
 * moteur lit, relie, note ; le lot commercial et ses gardes font le reste.
 */
import { createLogger, loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { createSearchFabric } from '../packages/intelligence/src/index.ts';
import { createInferenceFabric, BudgetedProvider, BudgetLedger } from '../packages/llm/src/index.ts';
import {
  runExpansion, expansionReport, expansionGraph, promoteCandidates, strongestSeeds, salesAiBudgetRemaining, seedNameOf,
  type ExpansionSeed, type StrategyKey, type ExpansionStats,
} from '../packages/runtime/src/index.ts';

loadAtlasEnv();

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m' };
const flag = (name: string): string | null => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const flags = (name: string): string[] => process.argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const command = positional[0] ?? 'status';

const config = loadConfig(process.cwd());
const logger = createLogger({ level: (flag('log') as 'debug' | 'info' | 'warn' | 'error') ?? 'error', pretty: true });
const repos = createRepositories(config.paths.databaseFile, logger);
const usd = (n: number | null | undefined) => (n === null || n === undefined ? 'N/A' : `${n.toFixed(4)} $`);
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : '—');
const tint: Record<string, string> = { HIGH_PRIORITY: c.green, QUALIFIED: c.cyan, RELEVANT: c.amber, UNIVERSE: c.dim, REJECTED: c.red, OFFICIAL: c.green, ASSOCIATION_EVENT: c.cyan, SECONDARY: c.dim };

function printReport(runId: string): void {
  const r = expansionReport(repos, runId);
  const s = r.stats;
  console.log(`\n  ${c.bold}${c.cyan}PROSPECT EXPANSION${c.reset}  ${c.dim}${runId} · ${r.status}${c.reset}\n`);
  console.log(`  Seeds: ${s.seeds}\n`);
  console.log(`  Discovered:`);
  for (const [type, n] of Object.entries(s.byRelationship).sort((a, b) => b[1] - a[1])) console.log(`  - ${type.toLowerCase().replace(/_/g, ' ')}: ${n}`);
  if (Object.keys(s.byRelationship).length === 0) console.log(`  ${c.dim}- aucune relation prouvée${c.reset}`);
  console.log(`\n  Unique companies: ${s.uniqueCompanies} ${c.dim}(${s.newCompanies} inconnues du registre)${c.reset}`);
  console.log(`  Relevant: ${s.funnel.relevant}\n  Qualified: ${s.funnel.qualified}\n  High priority: ${s.funnel.highPriority}${s.funnel.rejected ? `\n  ${c.dim}Rejected: ${s.funnel.rejected}${c.reset}` : ''}`);
  console.log(`\n  Evidence:\n  - official: ${s.evidence.OFFICIAL}\n  - association/event: ${s.evidence.ASSOCIATION_EVENT}\n  - secondary: ${s.evidence.SECONDARY}`);
  console.log(`\n  Rates: relevant ${pct(s.relevantRate)} · qualified ${pct(s.qualificationRate)} · with evidence ${pct(s.evidenceRate)}`);
  console.log(`  Calls: ${s.searchCalls} search · ${s.fetches} pages · ${s.aiCalls} model${s.stoppedBy.length ? ` · ${c.amber}stopped by ${s.stoppedBy.join(', ')}${c.reset}` : ''}`);
  console.log(`\n  Estimated spend: ${usd(s.searchCostUsd + s.aiCostUsd)} ${c.dim}(search ${usd(s.searchCostUsd)} · model ${usd(s.aiCostUsd)})${c.reset}`);
  console.log(`  Actual spend: ${usd(actualSpend(runId))} ${c.dim}(appels modèle consignés pour ce tour)${c.reset}`);
  console.log(`  Cost per retained: ${usd(s.costPerRetainedUsd)} · per qualified: ${usd(s.costPerQualifiedUsd)} · ${Math.round(s.durationMs / 1000)} s`);
  if (r.topCandidates.length) {
    console.log(`\n  ${c.bold}Top candidates:${c.reset}`);
    for (const t of r.topCandidates.slice(0, 15)) {
      console.log(`  ${tint[t.stage] ?? ''}${t.stage.padEnd(13)}${c.reset} ${String(t.score ?? '').padStart(3)}  ${t.name.slice(0, 34).padEnd(34)} ${c.dim}${t.domain ?? ''} · ${t.country ?? '?'} · ${t.relationships.join(', ')} · ${t.evidence} preuve(s)${t.bestTrust ? ` (${t.bestTrust})` : ''}${c.reset}`);
    }
  }
  console.log(`\n  ${c.dim}No messages sent. MESSAGES SENT: 0${c.reset}\n`);
}

const pct = (x: number | null) => (x === null ? 'N/A' : `${Math.round(x * 100)} %`);

function actualSpend(runId: string): number | null {
  const run = repos.expansion.run(runId);
  if (!run) return null;
  // Les appels du tour sont ceux consignés sous `prospect-expansion` entre son début et sa fin.
  const rows = repos.db.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) AS c FROM llm_calls WHERE purpose = 'prospect-expansion' AND created_at >= ? AND created_at <= ?",
  ).get(run.startedAt, run.finishedAt ?? new Date().toISOString()) as { c: number };
  return Number(rows.c);
}

try {
  if (command === 'run') {
    const seedDomains = flags('seed');
    const prospectIds = flags('prospect');
    let seeds: ExpansionSeed[] = [];
    for (const d of seedDomains) {
      const domain = d.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]!;
      const known = repos.sales.discoveredSince(null).find((p) => p.domain === domain);
      seeds.push({ name: seedNameOf(known?.companyName ?? domain, domain), domain, website: `https://${domain}`, country: known?.country ?? flag('country'), prospectId: known?.id ?? null, activity: known?.whyFit ?? null });
    }
    for (const id of prospectIds) {
      const p = repos.sales.get(id);
      if (!p || !p.domain) { console.error(`  prospect introuvable ou sans domaine : ${id}`); process.exitCode = 2; }
      else seeds.push({ name: seedNameOf(p.companyName, p.domain), domain: p.domain, website: p.website, country: p.country, prospectId: p.id, activity: p.whyFit ?? null });
    }
    if (seeds.length === 0) seeds = strongestSeeds(repos, { limit: Number(flag('seeds') ?? 3) });
    if (seeds.length === 0) { console.error('  aucune graine : --seed=<domaine>, --prospect=<id>, ou des prospects PRIORITY/GOOD_FIT dans le registre'); process.exitCode = 2; }
    else {
      const limits = {
        maxDepth: Number(flag('depth') ?? 1), maxCandidates: Number(flag('max') ?? 30), maxSearchCalls: Number(flag('searches') ?? 12),
        maxFetches: Number(flag('fetches') ?? 40), maxAiCostUsd: Number(flag('ai') ?? 0.05), maxSeeds: Math.max(seeds.length, 1),
      };
      const strategies = flag('strategies')?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) as StrategyKey[] | undefined;
      const search = createSearchFabric(config.search);
      const noAi = flag('ai') === '0' || config.llm.mode !== 'live';
      const provider = noAi ? null : new BudgetedProvider(createInferenceFabric(config, logger), new BudgetLedger((record) => repos.llmCalls.record(record)), { allowed: config.llm.allowedModels, forbidden: config.llm.forbiddenModels });
      console.log(`\n  ${c.bold}${c.cyan}PROSPECT EXPANSION${c.reset}  ${c.dim}${seeds.length} graine(s) · profondeur ${limits.maxDepth} · ${limits.maxCandidates} candidats · ${limits.maxSearchCalls} requêtes · ${limits.maxAiCostUsd.toFixed(2)} $ IA max · budget IA du jour restant ${salesAiBudgetRemaining(repos, config, new Date()).toFixed(2)} $${c.reset}`);
      console.log(`  ${c.dim}envoi ${config.sales.outboundEnabled ? 'ACTIVÉ' : 'coupé'} · mode ${config.sales.engineMode} · recherche ${search ? search.plan().order.map((o) => o.record.id).join(', ') || 'aucune utilisable' : 'aucune'} · modèle ${provider ? config.llm.agentModel : 'non (déterministe seulement)'}${c.reset}`);
      for (const s of seeds) console.log(`  · ${s.name} ${c.dim}(${s.domain}${s.country ? `, ${s.country}` : ''})${c.reset}`);
      const { run } = await runExpansion({ repos, config, logger, search, provider }, { seeds, limits, strategies, trigger: 'cli' });
      printReport(run.id);
    }
  } else if (command === 'status') {
    const t = repos.expansion.totals();
    console.log(`\n  ${c.bold}${c.cyan}PROSPECT EXPANSION${c.reset}  ${c.dim}${t.runs} tour(s)${c.reset}`);
    console.log(`  univers : ${t.universe} entreprise(s) · relations : ${t.relationships} · preuves : ${t.evidence} · qualifiées : ${t.qualified} · prioritaires : ${t.highPriority} · dépense : ${usd(t.costUsd)}`);
    const open = repos.expansion.openRuns();
    if (open.length) console.log(`  ${c.amber}${open.length} tour(s) encore ouvert(s) — repris au prochain tour${c.reset}`);
    console.log(`\n  ${c.bold}derniers tours${c.reset}`);
    for (const r of repos.expansion.runs(5)) {
      const s = r.stats as Partial<ExpansionStats>;
      console.log(`  ${r.status === 'DONE' ? c.green : r.status === 'RUNNING' ? c.amber : c.dim}${r.status.padEnd(9)}${c.reset} ${r.id} ${c.dim}${when(r.startedAt)} · ${r.trigger} · ${r.seeds.map((x) => x.name).join(', ')}${c.reset}`);
      if (r.summary) console.log(`  ${''.padEnd(10)}${r.summary}`);
      else if (s.funnel) console.log(`  ${''.padEnd(10)}${s.funnel.universe} entreprises · ${s.funnel.qualified} qualifiées · ${s.funnel.highPriority} prioritaires`);
    }
    if (repos.expansion.runs(1).length === 0) console.log(`  ${c.dim}aucun : npm run expansion -- run${c.reset}`);
    const seeds = repos.expansion.topSeeds(5);
    if (seeds.length) { console.log(`\n  ${c.bold}graines les plus fécondes${c.reset}`); for (const s of seeds) console.log(`  · ${s.seedKey} — ${s.companies} entreprise(s), ${s.qualified} qualifiée(s)`); }
    const methods = repos.expansion.topMethods(6);
    if (methods.length) console.log(`\n  ${c.bold}sources${c.reset}  ${methods.map((m) => `${m.method.toLowerCase()} ${m.relationships}`).join(' · ')}`);
    const next = strongestSeeds(repos, { limit: 3, excludeSeededWithinMs: 14 * 86_400_000 });
    console.log(`\n  ${c.bold}prochaine expansion${c.reset}  ${next.length ? next.map((s) => `${s.name} (${s.domain})`).join(' · ') : c.dim + 'aucun prospect fort non exploré' + c.reset}`);
    console.log(`  ${c.dim}MESSAGES SENT: 0 — le moteur n'envoie rien.${c.reset}\n`);
  } else if (command === 'graph') {
    const key = positional[1];
    if (!key) { console.error('  graph <domaine>'); process.exitCode = 2; }
    else {
      const g = expansionGraph(repos, key);
      console.log(`\n  ${c.bold}${c.cyan}${key}${c.reset}  ${g.entity ? `${c.dim}${g.entity.companyName} · ${g.entity.country ?? '?'} · ${g.entity.stage} · score ${g.entity.score ?? '—'}${g.entity.aliases.length ? ` · alias ${g.entity.aliases.join(', ')}` : ''}${c.reset}` : `${c.dim}inconnue de l'univers${c.reset}`}\n`);
      console.log(`  ${c.bold}relations (${g.relationships.length})${c.reset}`);
      for (const r of g.relationships) console.log(`  ${r.direction === 'IN' ? '←' : '→'} ${r.type.padEnd(20)} ${r.otherName.slice(0, 30).padEnd(30)} ${tint[r.trust] ?? ''}${r.status} ${r.confidence.toFixed(2)} ${r.trust}${c.reset} ${c.dim}${r.evidenceUrl}${c.reset}`);
      if (g.relationships.length === 0) console.log(`  ${c.dim}aucune${c.reset}`);
      console.log(`\n  ${c.bold}preuves (${g.evidence.length})${c.reset}`);
      for (const e of g.evidence) console.log(`  · ${e.kind.padEnd(12)} ${tint[e.trust] ?? ''}${e.trust}${c.reset} ${e.claim.slice(0, 70)} ${c.dim}${e.url}${c.reset}`);
      console.log();
    }
  } else if (command === 'candidates') {
    const runId = flag('run') ?? repos.expansion.runs(1)[0]?.id;
    if (!runId) { console.error('  aucun tour'); process.exitCode = 2; }
    else {
      const stage = flag('stage') as never;
      const rows = repos.expansion.candidates(runId, { limit: Number(flag('limit') ?? 50), kind: 'COMPANY', ...(stage ? { stage } : {}) }).filter((x) => !x.isSeed);
      console.log(`\n  ${c.bold}CANDIDATS${c.reset}  ${c.dim}${runId} · ${rows.length}${stage ? ` · ${stage}` : ''}${c.reset}\n`);
      for (const x of rows) {
        const rels = repos.expansion.relationshipsTo(x.entityKey);
        console.log(`  ${tint[x.stage] ?? ''}${x.stage.padEnd(13)}${c.reset} ${String(x.score ?? '').padStart(3)}  ${x.companyName.slice(0, 34).padEnd(34)} ${c.dim}${x.canonicalDomain ?? ''} · ${x.country ?? '?'} · d${x.depth} · ${[...new Set(rels.map((r) => r.relationshipType))].join(', ') || 'aucune relation'}${x.prospectId ? ' · versé' : ''}${c.reset}`);
        if (x.rejectReason) console.log(`  ${''.padEnd(19)}${c.dim}${x.rejectReason.slice(0, 110)}${c.reset}`);
      }
      console.log();
    }
  } else if (command === 'report') {
    const runId = flag('run') ?? repos.expansion.runs(1)[0]?.id;
    if (!runId) console.log(`\n  ${c.dim}aucun tour : npm run expansion -- run${c.reset}\n`);
    else printReport(runId);
  } else if (command === 'promote') {
    const runId = flag('run');
    if (!runId) { console.error('  promote --run=<id> [--stage=HIGH_PRIORITY]'); process.exitCode = 2; }
    else {
      const out = promoteCandidates(repos, runId, { minStage: (flag('stage') as never) ?? 'QUALIFIED', limit: Number(flag('limit') ?? 50) });
      console.log(`\n  ${c.green}${out.promoted.length} prospect(s) versé(s)${c.reset} dans la file commerciale (DISCOVERED, avec preuves) — aucun message envoyé.`);
      for (const s of out.skipped.slice(0, 20)) console.log(`  ${c.dim}· ${s.name} : ${s.reason}${c.reset}`);
      console.log();
    }
  } else {
    console.error(`  commande inconnue : ${command} (run · status · graph · candidates · report · promote)`);
    process.exitCode = 2;
  }
} finally {
  repos.close();
}
