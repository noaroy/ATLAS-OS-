/**
 * End-to-end demonstration (SRS §6.12).
 *
 * Drives a real mission through the whole organisation against a running
 * server and narrates each stage: Hermes receives the objective, plans it,
 * dispatches specialists, collects their results, synthesises a report, and
 * records what was learned.
 *
 *   npm run demo                     # against http://localhost:4700
 *   ATLAS_URL=https://... npm run demo
 */
import { loadConfig } from '../packages/core/src/config.ts';
import { DEMO_MISSION } from '../packages/departments/src/demo-mission.ts';

const config = loadConfig();
const BASE = (process.env.ATLAS_URL ?? `http://localhost:${config.server.port}`).replace(/\/+$/, '');

const c = {
  reset: '[0m',
  dim: '[2m',
  cyan: '[36m',
  green: '[32m',
  amber: '[33m',
  red: '[31m',
  bold: '[1m',
};

const step = (n: number, text: string): void =>
  console.log(`\n${c.cyan}${c.bold}[${n}]${c.reset} ${c.bold}${text}${c.reset}`);
const detail = (text: string): void => console.log(`    ${c.dim}${text}${c.reset}`);
const good = (text: string): void => console.log(`    ${c.green}✓${c.reset} ${text}`);
const warn = (text: string): void => console.log(`    ${c.amber}!${c.reset} ${text}`);

let token = '';

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  const body = (await response.json()) as { ok: boolean; data?: T; error?: { message: string } };
  if (!body.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  return body.data as T;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`\n${c.bold}  ATLAS OS — end-to-end demonstration${c.reset}`);
  console.log(`  ${c.dim}${BASE}${c.reset}`);

  // ── 1. Connect ───────────────────────────────────────────────────────────
  step(1, 'Connecting to ATLAS');
  try {
    const session = await call<{ token: string; user: { name: string; role: string } }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: config.security.founderEmail,
        password: config.security.founderPassword,
      }),
    });
    token = session.token;
    good(`Signed in as ${session.user.name} (${session.user.role})`);
  } catch (err) {
    console.error(
      `\n${c.red}Could not sign in.${c.reset} Is ATLAS running? Start it with: npm run dev\n${String(err)}\n`,
    );
    process.exit(1);
  }

  const health = await call<{ status: string; mode: string; checks: Array<{ name: string; status: string }> }>(
    '/api/health',
  );
  good(`System ${health.status} · inference mode: ${health.mode}`);
  if (health.mode === 'simulation') {
    warn('Simulation mode — the organisation runs fully, but findings are placeholders.');
  }

  const agents = await call<Array<{ name: string; role: string; building: string }>>('/api/agents');
  good(`${agents.length} specialists on duty`);
  for (const agent of agents) detail(`${agent.name.padEnd(18)} ${agent.role}`);

  // ── 2. Give ATLAS an objective ───────────────────────────────────────────
  // La même mission que le bouton de la console, par la même route. Deux
  // définitions jumelles finiraient par diverger, et « la démonstration passe »
  // ne voudrait plus dire la même chose selon l'endroit d'où on la lance.
  step(2, 'Giving ATLAS an objective');
  detail(DEMO_MISSION.objective);

  const mission = await call<{ id: string; code: string; title: string }>('/api/missions/demo', {
    method: 'POST',
  });
  good(`Mission ${mission.code} accepted by Hermes`);

  // ── 3. Watch Hermes work ─────────────────────────────────────────────────
  step(3, 'Hermes plans and dispatches');

  const seenTasks = new Set<string>();
  let planShown = false;
  let final: MissionView | null = null;

  for (let tick = 0; tick < 150; tick++) {
    const view = await call<MissionView>(`/api/missions/${mission.id}`);

    if (!planShown && view.mission.plan) {
      planShown = true;
      good(`Plan produced by ${view.mission.plan.producedBy}`);
      detail(`Strategy: ${view.mission.plan.strategy}`);
      detail(`Rationale: ${view.mission.plan.rationale}`);
      console.log();
      for (const s of view.mission.plan.steps) {
        detail(`${s.ref.padEnd(10)} → ${s.agentKey.padEnd(18)} ${s.title}`);
      }
      console.log();
    }

    for (const task of view.tasks) {
      const key = `${task.ref}:${task.status}`;
      if (seenTasks.has(key)) continue;
      seenTasks.add(key);

      if (task.status === 'running') detail(`${task.agentKey} started "${task.title}"`);
      else if (task.status === 'succeeded')
        good(`${task.agentKey} finished "${task.title}" (${Math.round(task.durationMs / 100) / 10}s)`);
      else if (task.status === 'failed') warn(`${task.agentKey} failed "${task.title}": ${task.error}`);
      else if (task.status === 'skipped') warn(`${task.ref} skipped — a prerequisite did not succeed`);
    }

    if (['completed', 'validated', 'failed'].includes(view.mission.status)) {
      final = view;
      break;
    }
    await sleep(1000);
  }

  if (!final) {
    warn('The mission is still running — open the console to follow it.');
    return;
  }

  // ── 4. The result ────────────────────────────────────────────────────────
  step(4, 'Hermes synthesises the result');

  if (final.mission.status === 'failed') {
    warn(`Mission failed: ${final.mission.error}`);
  } else {
    const result = final.mission.result!;
    good(`Quality ${result.quality}/100 · ${result.tokensUsed.toLocaleString()} tokens`);
    console.log();
    const preview = result.summary.split('\n').slice(0, 18).join('\n');
    console.log(
      preview
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
    );
    if (result.summary.split('\n').length > 18) detail('…');

    if (result.artifacts.length > 0) {
      console.log();
      for (const artifact of result.artifacts) {
        good(`Deliverable: ${artifact.name} → ${BASE}/api/artifacts/${artifact.path}`);
      }
    }
  }

  // ── 5. What ATLAS learned ────────────────────────────────────────────────
  step(5, 'What ATLAS learned');
  const memory = await call<{ items: Array<{ tier: string; kind: string; title: string }>; stats: { total: number } }>(
    '/api/memory?limit=5',
  );
  good(`${memory.stats.total} item(s) in memory`);
  for (const item of memory.items.slice(0, 5)) {
    detail(`[${item.tier}/${item.kind}] ${item.title}`);
  }

  // ── 6. Self-improvement ──────────────────────────────────────────────────
  step(6, 'Self-improvement analysis');
  const evolution = await call<{ proposed: number; autoApplied: number; skipped: number }>(
    '/api/evolution/run',
    { method: 'POST' },
  );
  good(
    `${evolution.proposed} proposal(s), ${evolution.autoApplied} auto-applied, ${evolution.skipped} already open`,
  );
  if (evolution.proposed === 0) {
    detail('Nothing to change — the Evolution Manager only proposes when the data supports it.');
  }

  console.log(`\n${c.green}${c.bold}  Demonstration complete.${c.reset}`);
  console.log(`  Open the console at ${c.cyan}${BASE}${c.reset} and enter ATLAS Village to watch it live.\n`);
}

interface MissionView {
  mission: {
    status: string;
    error: string | null;
    plan: {
      producedBy: string;
      strategy: string;
      rationale: string;
      steps: Array<{ ref: string; agentKey: string; title: string }>;
    } | null;
    result: {
      summary: string;
      quality: number;
      tokensUsed: number;
      artifacts: Array<{ name: string; path: string }>;
    } | null;
  };
  tasks: Array<{
    ref: string;
    title: string;
    agentKey: string;
    status: string;
    error: string | null;
    durationMs: number;
  }>;
}

main().catch((err) => {
  console.error(`\n${c.red}Demonstration failed:${c.reset} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
