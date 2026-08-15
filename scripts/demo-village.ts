/**
 * La mission de démonstration, observée par le village.
 *
 * Lance `DEMO — Business Expansion` puis interroge `/api/village` chaque
 * seconde — exactement la source que le canevas consomme — et note chaque
 * changement : état d'un agent, statut d'un bâtiment, trajet en cours.
 *
 * L'intérêt est de pouvoir répondre à une question précise : *quel événement
 * du backend déclenche telle animation ?* Un villageois qui marche, une fenêtre
 * qui s'allume, une auréole qui pulse — chacun doit se retrouver ici sous forme
 * de transition datée. Ce qui n'apparaît pas dans ce journal et bouge quand
 * même à l'écran est, par définition, décoratif.
 *
 *   npm run demo:village
 *
 * Refuse de tourner hors simulation : la route de démonstration elle-même
 * l'interdit, et rien ici ne doit pouvoir contourner cela.
 */
import { loadConfig } from '../packages/core/src/config.ts';
import { DEMO_MISSION } from '../packages/departments/src/demo-mission.ts';
import type { VillageSnapshot } from '../packages/contracts/src/index.ts';

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
const at = (start: number): string => `${((Date.now() - start) / 1000).toFixed(1).padStart(5)}s`;

interface MissionView {
  mission: { id: string; code: string; status: string; progress: number };
  tasks: Array<{ ref: string; agentKey: string; status: string; title: string }>;
  economics: { tokensUsed: number; estimatedCostUsd: number | null; measured: { llmCalls: number } | null };
  mode: string;
}

async function main(): Promise<void> {
  console.log(`\n${c.bold}  ATLAS — la mission DEMO vue depuis le village${c.reset}`);
  console.log(`  ${c.dim}${BASE}${c.reset}\n`);

  const session = await call<{ token: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: config.security.founderEmail,
      password: config.security.founderPassword,
    }),
  });
  token = session.token;

  const health = await call<{ status: string; mode: string; checks: Array<{ name: string; status: string; detail: string }> }>(
    '/api/health',
  );
  console.log(`  Santé : ${c.bold}${health.status}${c.reset} · inférence : ${c.bold}${health.mode}${c.reset}`);
  for (const check of health.checks) {
    const mark = check.status === 'pass' ? `${c.green}✓${c.reset}` : check.status === 'warn' ? `${c.amber}!${c.reset}` : `${c.red}✗${c.reset}`;
    console.log(`    ${mark} ${check.name.padEnd(13)} ${c.dim}${check.detail}${c.reset}`);
  }

  if (health.mode !== 'simulation') {
    console.error(`\n${c.red}  Refus : ATLAS n'est pas en simulation.${c.reset} Démarrez-le avec npm run dev:sim\n`);
    process.exit(1);
  }

  const mission = await call<{ id: string; code: string }>('/api/missions/demo', { method: 'POST' });
  console.log(`\n  Mission ${c.bold}${mission.code}${c.reset} — ${DEMO_MISSION.title}\n`);
  console.log(`  ${c.dim}temps  │ ce que le village montre${c.reset}`);
  console.log(`  ${c.dim}───────┼──────────────────────────────────────────────────────────${c.reset}`);

  const start = Date.now();
  const agentState = new Map<string, string>();
  const agentWhere = new Map<string, string>();
  const buildingState = new Map<string, string>();
  const seenJourneys = new Set<string>();
  const seenTasks = new Set<string>();

  const log = (icon: string, text: string): void =>
    console.log(`  ${c.dim}${at(start)}${c.reset} │ ${icon} ${text}`);

  let final: MissionView | null = null;

  for (let tick = 0; tick < 240; tick++) {
    const [village, view] = await Promise.all([
      call<VillageSnapshot>('/api/village'),
      call<MissionView>(`/api/missions/${mission.id}`),
    ]);

    // ── Étapes ────────────────────────────────────────────────────────────
    for (const task of view.tasks) {
      const key = `${task.ref}:${task.status}`;
      if (seenTasks.has(key)) continue;
      seenTasks.add(key);
      if (task.status === 'running') log('▶', `étape ${c.bold}${task.ref}${c.reset} démarrée par ${task.agentKey}`);
      else if (task.status === 'succeeded') log(`${c.green}✓${c.reset}`, `étape ${c.bold}${task.ref}${c.reset} réussie`);
      else if (task.status === 'failed') log(`${c.red}✗${c.reset}`, `étape ${task.ref} échouée`);
      else if (task.status === 'skipped') log(`${c.amber}—${c.reset}`, `étape ${task.ref} sautée`);
    }

    // ── Agents : état et localisation ─────────────────────────────────────
    for (const agent of village.agents) {
      const previous = agentState.get(agent.key);
      if (previous !== agent.state.status) {
        agentState.set(agent.key, agent.state.status);
        if (previous !== undefined) {
          log('◆', `${c.bold}${agent.name}${c.reset} : ${previous} → ${c.cyan}${agent.state.status}${c.reset}` +
            (agent.state.currentActivity ? ` ${c.dim}(${agent.state.currentActivity.slice(0, 42)})${c.reset}` : ''));
        }
      }
      const where = agent.state.location || agent.building;
      const wasWhere = agentWhere.get(agent.key);
      if (wasWhere !== undefined && wasWhere !== where) {
        log('→', `${c.bold}${agent.name}${c.reset} se trouve maintenant à ${where}`);
      }
      agentWhere.set(agent.key, where);
    }

    // ── Trajets : ce qui fait marcher un villageois ────────────────────────
    for (const journey of village.journeys) {
      const key = `${journey.agentKey}:${journey.startedAt}`;
      if (seenJourneys.has(key)) continue;
      seenJourneys.add(key);
      log('🚶', `trajet ${journey.from} → ${journey.to} (${journey.agentKey}, ${journey.durationMs} ms) ` +
        `${c.dim}motif : ${journey.reason.slice(0, 40)}${c.reset}`);
    }

    // ── Bâtiments ─────────────────────────────────────────────────────────
    for (const building of village.buildings) {
      const previous = buildingState.get(building.key);
      if (previous !== building.status) {
        buildingState.set(building.key, building.status);
        if (previous !== undefined) {
          const colour = building.status === 'busy' ? c.green : building.status === 'alert' ? c.red : c.dim;
          log('▣', `bâtiment ${c.bold}${building.name}${c.reset} : ${previous} → ${colour}${building.status}${c.reset}`);
        }
      }
    }

    if (['completed', 'validated', 'failed'].includes(view.mission.status)) {
      final = view;
      break;
    }
    await sleep(1000);
  }

  console.log(`  ${c.dim}───────┴──────────────────────────────────────────────────────────${c.reset}\n`);

  if (!final) {
    console.log(`  ${c.amber}La mission tourne encore.${c.reset}\n`);
    return;
  }

  // ── Ce que le Command Center affichera ──────────────────────────────────
  const cost = final.economics.estimatedCostUsd;
  console.log(`  ${c.bold}Bilan${c.reset}`);
  console.log(`    statut          ${final.mission.status}`);
  console.log(`    avancement      ${Math.round(final.mission.progress * 100)} %`);
  console.log(`    étapes réussies ${final.tasks.filter((t) => t.status === 'succeeded').length} / ${final.tasks.length}`);
  console.log(`    jetons          ${final.economics.tokensUsed.toLocaleString('fr-FR')}`);
  console.log(
    `    coût réel       ${cost === null ? '—' : cost.toFixed(2).replace('.', ',') + ' $'}` +
      `  ${c.dim}(mode ${final.mode})${c.reset}`,
  );

  if (final.mode === 'simulation' && cost !== 0) {
    console.error(`\n${c.red}  ANOMALIE : mode simulation et coût non nul (${cost}).${c.reset}\n`);
    process.exit(1);
  }

  const opportunities = await call<{ shortlist: string[]; opportunities: Array<{ company: { legalName: string } }> }>(
    `/api/missions/${mission.id}/opportunities`,
  );
  console.log(`    candidats       ${opportunities.opportunities.length}`);
  console.log(`    shortlist       ${opportunities.shortlist.length}`);
  for (const id of opportunities.shortlist.slice(0, 5)) {
    const found = opportunities.opportunities.find((o) => (o as { id?: string }).id === id);
    if (found) console.log(`      ${c.dim}·${c.reset} ${found.company.legalName}`);
  }

  console.log(
    `\n  ${c.green}${c.bold}Démonstration terminée.${c.reset} ` +
      `${c.dim}Aucun appel facturé.${c.reset}\n`,
  );
}

void main().catch((err: unknown) => {
  console.error(`\n${c.red}  Échec : ${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
  process.exit(1);
});
