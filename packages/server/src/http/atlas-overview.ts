import { canRunProvider, AUTONOMY_LEVELS, type AtlasConfig } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import {
  collectNeedsYou, todaySnapshot, pipelineSnapshot, inspectRepo, detectClaudeCode, summariseAutopilot,
} from '@atlas/runtime';

/**
 * Ce que l'interface de gestion affiche, calculé une fois.
 *
 * Une seule requête plutôt que six : l'écran est lu d'un coup, et six appels
 * qui arrivent séparément produisent un instant où les chiffres ne racontent
 * pas la même histoire — le pipeline d'avant, les agents d'après.
 *
 * Rien n'y est estimé. Chaque valeur vient d'une lecture en base, et ce qui n'a
 * pas de source rend `null` : l'affichage écrira N/A. Un zéro à la place d'une
 * absence de mesure ferait lire « rien » là où il faut lire « je ne sais pas »,
 * et c'est la seule erreur de tableau de bord qui se propage sans bruit.
 */

export type AtlasHealth = 'ONLINE' | 'DEGRADED' | 'ACTION_REQUIRED';

export interface AtlasOverview {
  status: AtlasHealth;
  statusReason: string;
  today: {
    prospects: number;
    contacted: number;
    replies: number;
    positiveReplies: number;
    clients: number;
    revenueEur: number;
    /** `null` quand aucun appel n'a de tarif connu. */
    aiCostUsd: number | null;
    aiCostUnknownCalls: number;
  };
  needsYou: Array<{
    kind: string; what: string; why: string; recommendation: string; action: string;
  }>;
  pipeline: {
    discovered: number; qualified: number; contacted: number;
    interested: number; preview: number | null; paid: number;
  };
  agents: Array<{
    name: string; status: string; currentTask: string | null;
    quota: string; lastResult: string | null;
  }>;
  system: Array<{ name: string; state: 'OK' | 'ATTENTION' | 'ABSENT'; detail: string }>;
  autonomy: { level: number; label: string; description: string };
  /** L'Autopilot, en mots d'affaires : ce qu'il vise, ce qu'il fait, ce qu'il attend de vous. */
  autopilot: {
    status: 'ACTIVE' | 'PAUSED' | 'IDLE' | 'NEVER_RAN';
    lastCycleAt: string | null;
    topObjective: string | null;
    topReason: string | null;
    inProgress: Array<{ id: string; objective: string; status: string }>;
    completedRecently: Array<{ id: string; objective: string; resolvedAt: string | null }>;
    waitingFounder: Array<{ id: string; objective: string; reason: string; command: string | null }>;
    estimatedSpendUsd: number;
    actualSpendUsd: number | null;
  };
  /** Les chiffres bruts, pour l'onglet avancé. Jamais sur l'écran principal. */
  advanced: {
    taskStates: Record<string, number>;
    workspaces: Record<string, number>;
    repoWriteLock: string | null;
    aiLive: boolean;
  };
}

export function buildAtlasOverview(
  repos: Repositories,
  config: AtlasConfig,
  options: { today?: string; cwd?: string } = {},
): AtlasOverview {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const now = Date.now();

  const systemBlockers: Array<{ what: string; why: string; action: string }> = [];
  const system: AtlasOverview['system'] = [];

  // --- Recherche ---
  const searxng = config.search.searxngBaseUrl?.trim();
  system.push({
    name: 'Recherche',
    state: searxng ? 'OK' : 'ABSENT',
    detail: searxng ?? 'aucune instance configurée',
  });

  // --- Messagerie ---
  const gmail = Boolean(process.env.GMAIL_REFRESH_TOKEN?.trim());
  system.push({
    name: 'Gmail',
    state: gmail ? 'OK' : 'ATTENTION',
    detail: gmail ? 'connecté en lecture' : 'non connecté — les réponses se saisissent à la main',
  });
  if (!gmail) {
    systemBlockers.push({
      what: 'la boîte Gmail n’est pas connectée',
      why: 'les réponses de prospects ne remontent pas seules',
      action: 'npm run gmail:authorize',
    });
  }

  // --- Daemon ---
  const run = repos.tasks.lastDaemonRun();
  system.push({
    name: 'Daemon',
    state: run && !run.stoppedAt ? 'OK' : 'ATTENTION',
    detail: run
      ? run.stoppedAt
        ? `arrêté le ${run.stoppedAt.slice(0, 16).replace('T', ' ')}`
        : 'démarré — non confirmé vivant'
      : 'jamais lancé',
  });

  // --- Base et sauvegarde ---
  system.push({
    name: 'Base',
    state: 'OK',
    detail: `${Object.values(repos.tasks.countByStatus()).reduce((s, n) => s + n, 0)} tâche(s)`,
  });

  let repoDetail = 'N/A';
  try {
    const state = inspectRepo(options.cwd ?? process.cwd());
    repoDetail = state.clean ? 'propre' : `${state.dirtyFiles.length} fichier(s) non commité(s)`;
  } catch { repoDetail = 'pas un dépôt git'; }
  system.push({ name: 'Dépôt', state: 'OK', detail: repoDetail });

  /**
   * Claude Code a un état de plus que les autres : il peut être absent.
   *
   * Les workers d'API sont toujours « là » — au pire leur clé est refusée.
   * Celui-ci est un binaire qu'il faut avoir installé, et une tâche qui l'attend
   * ne partira jamais tant qu'il manque. L'écran doit donc distinguer
   * `UNAVAILABLE` d'`AU_REPOS` : le premier appelle une action, le second non.
   *
   * Détecté AVANT la collecte de la file humaine : un blocage repéré après
   * coup n'y figurerait pas, et l'écran annoncerait un système sain pendant que
   * des tâches attendent un binaire absent.
   */
  const claudeCode = detectClaudeCode(config.engineering.claudeCodeBin);
  if (!claudeCode.available) {
    system.push({
      name: 'Claude Code',
      state: 'ABSENT',
      detail: 'binaire non installé — les tâches d’ingénierie attendront',
    });
    systemBlockers.push({
      what: 'Claude Code n’est pas installé',
      why: 'les tâches qui modifient le code attendront sans jamais démarrer',
      action: 'npm i -g @anthropic-ai/claude-code',
    });
  } else {
    system.push({ name: 'Claude Code', state: 'OK', detail: claudeCode.detail });
  }

  // --- Ce qui attend une personne ---
  const needs = collectNeedsYou({ repos, today, systemBlockers });
  const snapshot = todaySnapshot(repos, today);
  const pipeline = pipelineSnapshot(repos, today);

  // --- Les agents ---
  const running = repos.tasks.list({ status: 'RUNNING', limit: 30 });
  const agentFor = (name: string, workerType: string | null, provider: string | null) => {
    const mine = workerType ? running.filter((t) => t.workerType === workerType) : running;
    const health = provider ? repos.tasks.providerHealth(provider) : null;
    const quota = health ? canRunProvider(health, now) : null;
    const last = provider ? repos.tasks.lastAiCall(provider) : null;
    return {
      name,
      status: mine.length > 0 ? 'AU_TRAVAIL' : quota && !quota.allowed ? 'EN_PAUSE' : 'AU_REPOS',
      currentTask: mine[0]?.taskType ?? null,
      quota: health?.state ?? 'UNKNOWN',
      lastResult: last ? `${last.outcome} · ${last.occurredAt.slice(0, 16).replace('T', ' ')}` : null,
    };
  };

  const claudeCodeRunning = running.filter((t) => t.workerType === 'CLAUDE_CODE');
  const drafts = repos.salesLoop.draftsInState('READY_FOR_APPROVAL').length;
  const agents: AtlasOverview['agents'] = [
    agentFor('Hermes', null, null),
    agentFor('OpenAI', 'OPENAI', 'OPENAI'),
    {
      name: 'Claude Code',
      status: claudeCodeRunning.length > 0
        ? 'WORKING'
        : claudeCode.available ? 'AVAILABLE' : 'UNAVAILABLE',
      currentTask: claudeCodeRunning[0]?.taskType ?? null,
      quota: repos.tasks.providerHealth('ANTHROPIC')?.state ?? 'UNKNOWN',
      lastResult: (() => {
        const last = repos.tasks.lastAiCall('ANTHROPIC');
        return last
          ? `${last.outcome} · ${last.occurredAt.slice(0, 16).replace('T', ' ')}`
          : null;
      })(),
    },
    {
      name: 'Ventes',
      status: drafts > 0 ? 'ATTEND_VOUS' : 'AU_REPOS',
      currentTask: drafts > 0 ? `${drafts} brouillon(s) à relire` : null,
      quota: 'N/A',
      lastResult: `${pipeline.contacted} entreprise(s) au registre`,
    },
  ];

  // --- L'état d'ensemble ---
  //
  // Trois niveaux, décidés dans cet ordre : ce qui bloque d'abord, ce qui
  // dégrade ensuite. Un système qui attend une décision n'est pas en panne, et
  // les confondre ferait ignorer les vraies pannes.
  const failed = repos.tasks.countByStatus().FAILED ?? 0;
  const status: AtlasHealth = needs.some((n) => n.kind === 'SYSTEM')
    ? 'ACTION_REQUIRED'
    : needs.length > 0 || failed > 0
      ? 'DEGRADED'
      : 'ONLINE';
  const statusReason = status === 'ACTION_REQUIRED'
    ? 'une pièce du système attend une action de votre part'
    : status === 'DEGRADED'
      ? `${needs.length} décision(s) en attente${failed > 0 ? `, ${failed} tâche(s) en échec` : ''}`
      : 'tout tourne, rien à décider';

  const level = AUTONOMY_LEVELS[1];

  return {
    status,
    statusReason,
    today: {
      prospects: pipeline.discovered,
      contacted: snapshot.contacted,
      replies: snapshot.replies,
      positiveReplies: snapshot.positiveReplies,
      clients: snapshot.paidClients,
      revenueEur: snapshot.revenueEur,
      aiCostUsd: snapshot.aiCostUsd,
      aiCostUnknownCalls: snapshot.aiCostUnknownCalls,
    },
    needsYou: needs.map(({ kind, what, why, recommendation, action }) => ({
      kind, what, why, recommendation, action,
    })),
    pipeline: {
      ...pipeline,
      // Négatif en interne, `null` sur le fil : l'affichage écrira N/A sans
      // avoir à connaître la convention.
      preview: pipeline.preview < 0 ? null : pipeline.preview,
    },
    agents,
    system,
    autonomy: { level: level.level, label: level.label, description: level.description },
    autopilot: (() => {
      const s = summariseAutopilot(repos, config);
      return {
        status: s.status, lastCycleAt: s.lastCycleAt, topObjective: s.topObjective, topReason: s.topReason,
        inProgress: s.inProgress.map((a) => ({ id: a.id, objective: a.objective, status: a.status })),
        completedRecently: s.completedRecently, waitingFounder: s.waitingFounder,
        estimatedSpendUsd: s.estimatedSpendUsd, actualSpendUsd: s.actualSpendUsd,
      };
    })(),
    advanced: {
      taskStates: repos.tasks.countByStatus(),
      workspaces: repos.tasks.workspaceCounts(),
      repoWriteLock: repos.tasks.repoLockHolder('REPO_WRITE')?.owner ?? null,
      aiLive: config.ai.live,
    },
  };
}
