/**
 * Le moteur commercial, depuis un terminal.
 *
 *   npm run sales:status                          la page unique, en texte
 *   npm run sales:status -- --range=7d|30d|all
 *   npm run sales:pause  -- --reason="…"          PAUSE ATLAS : plus rien ne part
 *   npm run sales:resume                          RESUME
 *   npm run sales:campaign -- list
 *   npm run sales:campaign -- create --name="PME B2B export" --countries=FR --keywords="machines spéciales|équipement industriel" [--angle=…]
 *   npm run sales:campaign -- approve <segmentId>   APPROVED_FOR_SEND, signé
 *   npm run sales:campaign -- pause|stop|resume <segmentId>
 *   npm run sales:campaign -- outcome <domaine> --kind=MEETING_BOOKED|MEETING_DONE|PROPOSAL_SENT|WON|LOST [--amount=1200 --currency=EUR --offer=… --note=…]
 *   npm run sales:campaign -- suppress <valeur> --kind=EMAIL|DOMAIN|COMPANY [--reason=MANUAL]
 *   npm run sales:campaign -- recommend            lance un cycle de recommandations
 *   npm run sales:campaign -- decide <recId> test|approve|reject
 *   npm run sales:campaign -- rollback <versionId> --reason="…"
 *   npm run sales:campaign -- schedule             pose les tâches du cycle courant
 *
 * Toute décision est signée par ATLAS_FOUNDER_EMAIL (ou --by=). Aucune de ces
 * commandes n'envoie un message : l'envoi passe par le daemon, la politique
 * d'envoi et la place exactement-une-fois — jamais par ici.
 */
import { createLogger, loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories, type OutcomeKind, type SuppressionKind, type SuppressionReason } from '../packages/data/src/index.ts';
import {
  buildSalesDashboard,
  setGlobalPause,
  readGlobalPause,
  decideRecommendation,
  rollbackStrategy,
  recordSalesOutcome,
  runOptimizationCycle,
  scheduleSalesCycle,
  type DashboardRange,
} from '../packages/runtime/src/index.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [command = 'status', ...rest] = positional;

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());
const repos = createRepositories(process.env.ATLAS_DB_PATH ?? config.paths.databaseFile, logger);
const by = flag('by') ?? process.env.ATLAS_FOUNDER_EMAIL ?? 'founder';

const pct = (n: number | null) => (n === null ? 'N/A' : `${(n * 100).toFixed(1)} %`);
const eur = (n: number | null, currency = 'EUR') => (n === null ? '—' : `${n.toFixed(0)} ${currency}`);
const list = (value: string | null) => (value ?? '').split('|').map((v) => v.trim()).filter(Boolean);

function status(): void {
  const range = (flag('range') ?? '30d') as DashboardRange;
  const d = buildSalesDashboard(repos, config, { range, segmentId: flag('segment') });
  const feu = (s: string) => (s === 'ok' ? `${c.green}●` : s === 'warn' ? `${c.amber}●` : s === 'down' ? `${c.red}●` : `${c.dim}○`) + c.reset;

  console.log(`\n  ${c.bold}${c.cyan}ATLAS — VENTES${c.reset}  ${c.dim}${range} · lu à ${d.generatedAt.slice(11, 19)} UTC${c.reset}`);
  if (d.system.outbound.paused) console.log(`  ${c.amber}PAUSE ATLAS — ${d.system.outbound.pauseReason ?? 'sans motif'}${c.reset}`);

  console.log(`\n  ${c.bold}RDV semaine ${d.cards.meetingsThisWeek}   Clients signés ${d.cards.clientsSigned}   CA signé ${eur(d.cards.revenueSigned, d.cards.currency)}   Pipeline ${eur(d.cards.pipelinePotential, d.cards.currency)}${c.reset}`);
  if (d.cards.pipelinePotential === null) console.log(`  ${c.dim}${d.cards.pipelineExplanation[0]}${c.reset}`);

  console.log(`\n  ${c.bold}ENTONNOIR${c.reset}`);
  for (const f of d.funnel) {
    console.log(`    ${f.label.padEnd(22)}${String(f.count).padStart(6)}   ${c.dim}${f.rate === null ? '' : pct(f.rate)}${c.reset}`);
  }

  console.log(`\n  ${c.bold}PERFORMANCE${c.reset}`);
  console.log(`    réponses positives    ${pct(d.performance.positiveReplyRate).padStart(8)}   RDV/contact ${pct(d.performance.meetingPerContact)}   client/contact ${pct(d.performance.clientPerContact)}`);
  console.log(`    CAC                   ${(d.performance.cac === null ? '—' : `${d.performance.cac.toFixed(2)} $`).padStart(8)}   CA/100 contactés ${eur(d.performance.revenuePer100, d.cards.currency)}   dépense IA ${d.performance.spendUsd === null ? 'N/A' : `${d.performance.spendUsd.toFixed(2)} $`}`);

  console.log(`\n  ${c.bold}SEGMENTS${c.reset}`);
  if (d.segments.length === 0) console.log(`    ${c.dim}aucun — sales:campaign create --name=…${c.reset}`);
  for (const s of d.segments) {
    console.log(`    ${s.name.slice(0, 28).padEnd(30)}${s.status.padEnd(10)}${String(s.contacted).padStart(5)} contactés  ${String(s.positiveReplies).padStart(3)} +  ${String(s.meetings).padStart(3)} RDV  ${String(s.clients).padStart(3)} clients  ${eur(s.revenuePer100, d.cards.currency).padStart(10)}/100  ${c.dim}${s.approvedForSend ? 'envoi approuvé' : 'envoi NON approuvé'} · ${s.decision}${c.reset}`);
  }
  if (d.best.segment) console.log(`    ${c.dim}meilleur segment : ${d.best.segment.name} (${pct(d.best.segment.positiveRate)})${c.reset}`);
  if (d.best.messageVariant) console.log(`    ${c.dim}meilleur message : ${d.best.messageVariant.key} (${pct(d.best.messageVariant.positiveRate)} sur ${d.best.messageVariant.contacted})${c.reset}`);

  console.log(`\n  ${c.bold}AUTO-OPTIMISATION${c.reset}`);
  if (d.recommendations.length === 0) {
    console.log(`    ${c.dim}aucune recommandation${d.insufficient.length ? ` — INSUFFICIENT_DATA : ${d.insufficient.slice(0, 3).map((i) => `${i.subject} ${i.sample}/${i.needed}`).join(' · ')}` : ''}${c.reset}`);
  }
  for (const r of d.recommendations) {
    console.log(`    ${c.amber}${r.kind}${c.reset} ${r.title}  ${c.dim}${r.status} · n=${r.sampleSize} · risque ${r.risk}${c.reset}`);
    console.log(`      ${c.dim}${r.reason}${c.reset}`);
    console.log(`      ${c.dim}npm run sales:campaign -- decide ${r.id} test|approve|reject${c.reset}`);
  }

  console.log(`\n  ${c.bold}RÉPONSES CHAUDES — ${d.hotLeadsTotal} à traiter${c.reset}`);
  for (const h of d.hotLeads) {
    console.log(`    ${h.status === 'OPEN' ? c.green : c.dim}${h.intent.padEnd(17)}${c.reset}${h.companyName.slice(0, 26).padEnd(28)}${c.dim}${h.receivedAt.slice(0, 10)} · ${(h.subject ?? '').slice(0, 40)}${h.status === 'HANDLED' ? ' · traité' : ''}${c.reset}`);
  }
  if (d.hotLeads.length === 0) console.log(`    ${c.dim}aucune${c.reset}`);

  const sys = d.system;
  console.log(`\n  ${c.bold}SYSTÈME${c.reset}  Search ${feu(sys.search.state)}  LLM ${feu(sys.llm.state)}  Gmail ${feu(sys.gmail.state)} ${c.dim}${sys.gmail.code}${c.reset}  Workers ${feu(sys.workers.state)}  Database ${feu(sys.database.state)}`);
  console.log(`    ${c.dim}Gmail ${sys.gmail.code} · ${sys.gmail.detail}${c.reset}`);
  console.log(`    ${c.dim}Outbound ${sys.outbound.enabled && !sys.outbound.paused && sys.outbound.mode === 'PRODUCTION' ? 'ACTIVE' : 'PAUSED'} · ${sys.outbound.mode} · fenêtre ${sys.outbound.window} ${sys.outbound.windowOpen ? '(ouverte)' : '(fermée)'}${sys.lastCycleAt ? ` · dernier cycle ${sys.lastCycleAt.slice(11, 16)} UTC` : ' · aucun cycle encore'}${c.reset}`);
  for (const line of sys.detail) console.log(`    ${c.dim}${line}${c.reset}`);
  console.log(`\n  ${c.dim}MESSAGES SENT: 0 (cette commande n'envoie rien)${c.reset}\n`);
}

function campaign(): void {
  const [action, target] = rest;
  switch (action) {
    case undefined:
    case 'list': {
      const segments = repos.salesEngine.segments();
      if (segments.length === 0) console.log(`\n  ${c.dim}aucun segment${c.reset}\n`);
      for (const s of segments) {
        console.log(`  ${s.id}  ${c.bold}${s.name}${c.reset}  ${s.status}  poids ${s.explorationWeight}  ${s.approvedForSend ? `${c.green}envoi approuvé par ${s.approvedBy}${c.reset}` : `${c.amber}envoi non approuvé${c.reset}`}`);
        console.log(`    ${c.dim}pays ${s.countries.join(', ') || '—'} · secteurs ${s.sectors.join(', ') || '—'} · mots-clés ${s.keywords.join(', ') || '—'} · angle ${s.offerAngle ?? '—'}${c.reset}`);
      }
      return;
    }
    case 'create': {
      const name = flag('name');
      if (!name) throw new Error('--name= requis');
      const { segment, created } = repos.salesEngine.createSegment({
        name,
        countries: list(flag('countries')),
        sectors: list(flag('sectors')),
        keywords: list(flag('keywords')),
        exclusions: list(flag('exclusions')),
        targetPersonas: list(flag('personas')),
        buyingSignals: list(flag('signals')),
        offerAngle: flag('angle'),
        explorationWeight: flag('weight') ? Number(flag('weight')) : undefined,
        notes: `créé par ${by}`,
      });
      console.log(`\n  ${created ? 'créé' : 'existait déjà'} : ${segment.id}  ${segment.name}  ${segment.status}`);
      console.log(`  ${c.dim}L'envoi reste fermé tant que : npm run sales:campaign -- approve ${segment.id}${c.reset}\n`);
      return;
    }
    case 'approve': {
      if (!target) throw new Error('segmentId requis');
      const s = repos.salesEngine.approveSegmentForSend(target, by);
      console.log(`\n  ${c.green}APPROVED_FOR_SEND${c.reset} ${s.name} — par ${s.approvedBy} le ${s.approvedAt?.slice(0, 16)}`);
      console.log(`  ${c.dim}Rien ne part tant que ATLAS_OUTBOUND_ENABLED=true et ATLAS_ENGINE_MODE=PRODUCTION ne sont pas posés.${c.reset}\n`);
      return;
    }
    case 'revoke': {
      if (!target) throw new Error('segmentId requis');
      repos.salesEngine.revokeSegmentApproval(target, by, flag('reason') ?? 'approbation retirée');
      console.log(`\n  approbation retirée pour ${target}\n`);
      return;
    }
    case 'pause':
    case 'stop':
    case 'resume': {
      if (!target) throw new Error('segmentId requis');
      const s = repos.salesEngine.setSegmentStatus(target, action === 'pause' ? 'PAUSED' : action === 'stop' ? 'STOPPED' : 'TESTING', by, flag('reason'));
      console.log(`\n  ${s.name} → ${s.status}\n`);
      return;
    }
    case 'outcome': {
      if (!target) throw new Error('domaine requis');
      const kind = flag('kind') as OutcomeKind | null;
      if (!kind) throw new Error('--kind=MEETING_BOOKED|MEETING_DONE|PROPOSAL_SENT|WON|LOST requis');
      const outcome = recordSalesOutcome(repos, {
        domain: target, kind,
        revenueAmount: flag('amount') !== null ? Number(flag('amount')) : kind === 'WON' ? 0 : null,
        currency: flag('currency') ?? undefined,
        offer: flag('offer'), note: flag('note'), by,
      });
      console.log(`\n  ${c.green}${outcome.kind}${c.reset} ${outcome.domain}${outcome.revenueAmount !== null ? ` — ${outcome.revenueAmount} ${outcome.currency}` : ''}  ${c.dim}${outcome.id} · par ${outcome.recordedBy}${c.reset}\n`);
      return;
    }
    case 'suppress': {
      if (!target) throw new Error('valeur requise');
      const kind = (flag('kind') ?? 'DOMAIN') as SuppressionKind;
      const reason = (flag('reason') ?? 'MANUAL') as SuppressionReason;
      const { entry, created } = repos.salesEngine.suppress({ kind, value: target, reason, source: 'cli', createdBy: by });
      if (kind === 'DOMAIN') repos.sales.recordOutreach({ domain: target, kind: 'DO_NOT_CONTACT', recordedBy: by, note: `suppression ${reason}` });
      console.log(`\n  ${created ? 'ajouté' : 'déjà présent'} : ${entry.kind} ${entry.value} — ${entry.reason}\n`);
      return;
    }
    case 'recommend': {
      const result = runOptimizationCycle(repos, config, new Date());
      console.log(`\n  ${result.proposed} recommandation(s) nouvelle(s)`);
      for (const i of result.insufficient) console.log(`  ${c.dim}INSUFFICIENT_DATA ${i.subject} : ${i.sample}/${i.needed}${c.reset}`);
      console.log();
      return;
    }
    case 'decide': {
      const decision = rest[2] as 'test' | 'approve' | 'reject' | undefined;
      if (!target || !decision || !['test', 'approve', 'reject'].includes(decision)) throw new Error('decide <recId> test|approve|reject');
      const result = decideRecommendation(repos, target, decision, by);
      console.log(`\n  ${result.recommendation.status} — ${result.reason}\n`);
      return;
    }
    case 'rollback': {
      if (!target) throw new Error('versionId requis');
      const result = rollbackStrategy(repos, target, by, flag('reason') ?? 'retour arrière demandé');
      console.log(`\n  ${result.applied ? c.green : c.red}${result.reason}${c.reset}\n`);
      return;
    }
    case 'schedule': {
      const report = scheduleSalesCycle(repos, config, new Date());
      console.log(`\n  ${report.created.length} tâche(s) posée(s), ${report.existing.length} déjà présente(s)`);
      for (const k of report.created) console.log(`    ${c.dim}${k}${c.reset}`);
      console.log();
      return;
    }
    default:
      throw new Error(`action inconnue : ${action}`);
  }
}

try {
  switch (command) {
    case 'status':
      status();
      break;
    case 'pause': {
      const state = setGlobalPause(repos, true, by, flag('reason') ?? 'pause demandée en ligne de commande');
      console.log(`\n  ${c.amber}PAUSE ATLAS${c.reset} — ${state.reason} (${state.by}, ${state.at?.slice(0, 16)})`);
      console.log(`  ${c.dim}Plus aucun message ne part. La découverte et la lecture de la boîte continuent.${c.reset}\n`);
      break;
    }
    case 'resume': {
      const before = readGlobalPause(repos);
      const state = setGlobalPause(repos, false, by, null);
      console.log(`\n  ${c.green}RESUME${c.reset} — ${before.paused ? `pause levée (${before.reason})` : 'ATLAS n’était pas en pause'} par ${state.by}\n`);
      break;
    }
    case 'campaign':
      campaign();
      break;
    default:
      console.error(`commande inconnue : ${command}. Attendu : status | pause | resume | campaign`);
      process.exitCode = 1;
  }
} catch (error) {
  console.error(`\n  ${c.red}${error instanceof Error ? error.message : String(error)}${c.reset}\n`);
  process.exitCode = 1;
} finally {
  repos.close();
}
