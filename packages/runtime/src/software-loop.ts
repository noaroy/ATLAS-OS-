import type { AtlasConfig } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import { detectClaudeCode, detectClaudeCodeAuth } from './claude-code.ts';
import { repoRootOf, inspectRepo } from './workspace.ts';
import { assessModelProviders, type ProviderReadinessVerdict } from './provider-readiness.ts';
import { DAEMON_STALE_AFTER_MS } from './readiness.ts';

/**
 * La boucle logicielle : est-elle utilisable, ici, maintenant ?
 *
 *   Autopilot → revue OpenAI → tâche d'ingénierie → Claude Code dans un
 *   worktree isolé → tests/build → revue → corrections → READY_FOR_HUMAN_DEPLOYMENT
 *
 * Six pièces, chacune jugée pour ce qu'elle est : le relecteur (OpenAI), le
 * modèle d'ingénierie (Anthropic), le runner Claude Code (binaire +
 * authentification, ou le service `atlas-engineer` quand l'ingénierie est
 * externe), le dépôt de travail (git, propre), et deux constantes qui ne se
 * configurent pas : le déploiement automatique est DISABLED, la porte
 * humaine est ENABLED. Un diff ne quitte jamais son worktree sans une
 * personne.
 *
 * Relevé en production : « CLAUDE_CODE ✗ · dépôt N/A ». Le conteneur qui
 * joue le cycle n'a ni le binaire ni git ni le dépôt — et ne doit pas les
 * avoir : c'est le runner isolé qui les porte. La lecture doit le dire, au
 * lieu de faire passer une architecture voulue pour une pièce manquante.
 */

export const ENGINEER_HOST_LABEL = 'atlas-engineer';

export interface SoftwareLoopPiece {
  state: 'READY' | 'STALE' | 'CONFIGURED' | 'BLOCKED' | 'ABSENT' | 'MANUAL_ACTION_REQUIRED' | 'EXTERNAL' | 'DIRTY';
  ready: boolean;
  detail: string;
}

export interface SoftwareLoopStatus {
  runner: 'embedded' | 'external';
  openaiReviewer: ProviderReadinessVerdict;
  claude: ProviderReadinessVerdict;
  claudeCodeRunner: SoftwareLoopPiece;
  repositoryWorkspace: SoftwareLoopPiece & { root: string | null };
  autoDeploy: 'DISABLED';
  humanDeployGate: 'ENABLED';
  usable: boolean;
  blockers: string[];
}

export interface SoftwareLoopOptions {
  now?: Date;
  cwd?: string;
  /** Sonder les fournisseurs de modèle si la dernière sonde est ancienne (réseau, gratuit). */
  verifyProviders?: boolean;
  /** Sonder le binaire Claude Code (`--version`, local). */
  probeClaudeCode?: boolean;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Le runner externe vit-il ? Un tour de daemon ouvert, sous son nom, au battement récent. */
export function externalRunnerAlive(repos: Repositories, now: Date): { alive: boolean; detail: string } {
  const runs = repos.tasks.daemonRuns(20).filter((r) => r.host === ENGINEER_HOST_LABEL);
  const open = runs.find((r) => !r.stoppedAt);
  if (!open) return { alive: false, detail: runs.length ? `atlas-engineer arrêté (${runs[0]!.stoppedAt?.slice(0, 16) ?? '?'})` : 'atlas-engineer jamais démarré' };
  const beat = open.lastHeartbeatAt ?? open.startedAt;
  const age = now.getTime() - Date.parse(beat);
  if (age > DAEMON_STALE_AFTER_MS) return { alive: false, detail: `atlas-engineer sans battement depuis ${Math.round(age / 60_000)} min` };
  return { alive: true, detail: `atlas-engineer en marche (battement ${beat.slice(11, 16)} UTC)` };
}

export async function softwareLoopStatus(repos: Repositories, config: AtlasConfig, options: SoftwareLoopOptions = {}): Promise<SoftwareLoopStatus> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const models = await assessModelProviders(repos, config, { now, verify: options.verifyProviders, fetchImpl: options.fetchImpl, env });
  const runner = config.engineering.runner;

  let claudeCodeRunner: SoftwareLoopPiece;
  let repositoryWorkspace: SoftwareLoopStatus['repositoryWorkspace'];
  if (runner === 'external') {
    // Ce processus ne porte ni binaire ni dépôt : c'est voulu. Ce qui compte
    // est que le runner isolé vive.
    const alive = externalRunnerAlive(repos, now);
    claudeCodeRunner = { state: alive.alive ? 'EXTERNAL' : 'ABSENT', ready: alive.alive, detail: alive.detail };
    repositoryWorkspace = { state: alive.alive ? 'EXTERNAL' : 'ABSENT', ready: alive.alive, detail: alive.alive ? 'clone jetable dans atlas-engineer (/work/repo), worktrees /work/worktrees' : 'porté par atlas-engineer, non démarré', root: null };
  } else {
    if (options.probeClaudeCode === false) {
      claudeCodeRunner = { state: 'CONFIGURED', ready: false, detail: `Claude Code : non sondé (${config.engineering.claudeCodeBin})` };
    } else {
      const availability = detectClaudeCode(config.engineering.claudeCodeBin);
      if (!availability.available) claudeCodeRunner = { state: 'ABSENT', ready: false, detail: `Claude Code : ${availability.detail}` };
      else {
        const auth = detectClaudeCodeAuth(availability);
        claudeCodeRunner = auth.state === 'READY'
          ? { state: 'READY', ready: true, detail: `Claude Code : ${availability.detail} — ${auth.detail}` }
          : { state: 'MANUAL_ACTION_REQUIRED', ready: false, detail: `Claude Code : ${auth.detail}` };
      }
    }
    const root = repoRootOf(config.engineering.repo || options.cwd || process.cwd());
    if (!root) repositoryWorkspace = { state: 'ABSENT', ready: false, detail: `pas un dépôt git (git absent, ou ${config.engineering.repo || options.cwd || process.cwd()} hors dépôt)`, root: null };
    else {
      const repo = inspectRepo(root);
      repositoryWorkspace = repo.clean
        ? { state: 'READY', ready: true, detail: `${root} · ${repo.head.slice(0, 8)} · propre`, root }
        : { state: 'DIRTY', ready: true, detail: `${root} · ${repo.head.slice(0, 8)} · ${repo.dirtyFiles.length} fichier(s) non commité(s) : les worktrees partent du dernier commit`, root };
    }
  }

  const blockers: string[] = [];
  if (!models.OPENAI.ready) blockers.push(`relecteur OpenAI : ${models.OPENAI.detail}`);
  if (!models.ANTHROPIC.ready) blockers.push(`modèle Claude : ${models.ANTHROPIC.detail}`);
  if (!claudeCodeRunner.ready) blockers.push(`runner Claude Code : ${claudeCodeRunner.detail}`);
  if (!repositoryWorkspace.ready) blockers.push(`dépôt de travail : ${repositoryWorkspace.detail}`);

  return {
    runner,
    openaiReviewer: models.OPENAI,
    claude: models.ANTHROPIC,
    claudeCodeRunner,
    repositoryWorkspace,
    autoDeploy: 'DISABLED',
    humanDeployGate: 'ENABLED',
    usable: blockers.length === 0,
    blockers,
  };
}
