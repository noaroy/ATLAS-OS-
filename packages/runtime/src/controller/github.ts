import { redactSecrets } from '../ai-contracts.ts';

/**
 * Le transport du pont : l'API REST des issues GitHub, et rien d'autre.
 *
 * Sortant uniquement — aucun webhook, aucun port, aucun écouteur. Cinq appels :
 * lister les issues ouvertes d'une étiquette, lire les commentaires d'une
 * issue, en publier un, poser et retirer une étiquette. L'hôte est fixe : une
 * adresse configurable serait une façon d'envoyer le jeton ailleurs.
 *
 * Le jeton ne quitte jamais la fermeture qui le détient. Il n'est ni rendu, ni
 * journalisé, ni recopié dans un message d'erreur : une erreur rapporte un
 * statut et un motif GitHub, filtrés par `redactSecrets`.
 */

export const GITHUB_API = 'https://api.github.com';

export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  isPullRequest: boolean;
}

export interface GithubComment {
  id: number;
  author: string;
  body: string;
}

export interface ControllerGithub {
  listOpenIssues(label: string, limit: number): Promise<GithubIssue[]>;
  listComments(issue: number): Promise<GithubComment[]>;
  createComment(issue: number, body: string): Promise<{ id: number }>;
  addLabels(issue: number, labels: string[]): Promise<void>;
  removeLabel(issue: number, label: string): Promise<void>;
  /**
   * Effacer d'un texte le jeton de ce client (littéralement) et tout motif de
   * secret. Le jeton lui-même ne sort jamais du client.
   */
  redact(text: string): string;
}

export class ControllerGithubError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(redactSecrets(message));
    this.name = 'ControllerGithubError';
  }
}

/** « propriétaire/dépôt », sans détour. */
export function isValidRepoSlug(repo: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repo) && !repo.includes('..');
}

export type TokenSource = 'ATLAS_CONTROLLER_GITHUB_TOKEN' | 'GITHUB_TOKEN' | null;

/**
 * D'où vient le jeton — sans jamais rendre sa valeur à qui veut l'afficher.
 *
 * `ATLAS_CONTROLLER_GITHUB_TOKEN` d'abord, `GITHUB_TOKEN` à défaut. La valeur
 * n'est rendue que par `readControllerToken`, appelée au moment de construire
 * le client ; l'état (`controllerTokenSource`) ne porte que le nom.
 */
export function controllerTokenSource(env: NodeJS.ProcessEnv = process.env): TokenSource {
  if (env.ATLAS_CONTROLLER_GITHUB_TOKEN?.trim()) return 'ATLAS_CONTROLLER_GITHUB_TOKEN';
  if (env.GITHUB_TOKEN?.trim()) return 'GITHUB_TOKEN';
  return null;
}

export function readControllerToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const source = controllerTokenSource(env);
  return source ? env[source]!.trim() : null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GithubClientOptions {
  repo: string;
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Pages de commentaires lues au plus (100 par page). */
  maxCommentPages?: number;
}

export function createGithubClient(options: GithubClientOptions): ControllerGithub {
  if (!isValidRepoSlug(options.repo)) {
    throw new ControllerGithubError(null, `dépôt invalide : ${options.repo.slice(0, 80)}`);
  }
  const token = options.token;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxCommentPages = options.maxCommentPages ?? 3;
  const base = `${GITHUB_API}/repos/${options.repo}`;

  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'atlas-controller-bridge',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new ControllerGithubError(null, `GitHub injoignable (${method} ${path}) : ${scrub(reason, token)}`);
    }
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const message = typeof payload?.message === 'string' ? payload.message : response.statusText;
      throw new ControllerGithubError(response.status, `GitHub ${response.status} (${method} ${path}) : ${scrub(message, token)}`);
    }
    return payload;
  };

  return {
    async listOpenIssues(label, limit) {
      const perPage = Math.max(1, Math.min(100, limit));
      const query = `?state=open&labels=${encodeURIComponent(label)}&sort=created&direction=asc&per_page=${perPage}`;
      const list = await call('GET', `/issues${query}`);
      if (!Array.isArray(list)) throw new ControllerGithubError(null, 'réponse inattendue de GitHub (issues)');
      return list.map(toIssue);
    },

    async listComments(issue) {
      const out: GithubComment[] = [];
      for (let page = 1; page <= maxCommentPages; page++) {
        const list = await call('GET', `/issues/${issue}/comments?per_page=100&page=${page}`);
        if (!Array.isArray(list)) throw new ControllerGithubError(null, 'réponse inattendue de GitHub (commentaires)');
        for (const c of list as Array<Record<string, unknown>>) {
          out.push({
            id: Number(c.id),
            author: String((c.user as Record<string, unknown> | null)?.login ?? ''),
            body: String(c.body ?? ''),
          });
        }
        if (list.length < 100) break;
      }
      return out;
    },

    async createComment(issue, body) {
      const created = await call('POST', `/issues/${issue}/comments`, { body: scrub(body, token) }) as Record<string, unknown> | null;
      return { id: Number(created?.id ?? 0) };
    },

    async addLabels(issue, labels) {
      if (labels.length === 0) return;
      await call('POST', `/issues/${issue}/labels`, { labels });
    },

    async removeLabel(issue, label) {
      try {
        await call('DELETE', `/issues/${issue}/labels/${encodeURIComponent(label)}`);
      } catch (error) {
        // Déjà absente : l'état voulu est atteint.
        if (error instanceof ControllerGithubError && error.status === 404) return;
        throw error;
      }
    },

    redact: (text) => scrub(text, token),
  };
}

function toIssue(raw: unknown): GithubIssue {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    number: Number(o.number),
    title: String(o.title ?? ''),
    body: typeof o.body === 'string' ? o.body : '',
    author: String((o.user as Record<string, unknown> | null)?.login ?? ''),
    labels: Array.isArray(o.labels)
      ? (o.labels as unknown[]).map((l) => (typeof l === 'string' ? l : String((l as Record<string, unknown>)?.name ?? ''))).filter(Boolean)
      : [],
    isPullRequest: Boolean(o.pull_request),
  };
}

function scrub(value: string, token: string): string {
  const literal = token && token.length >= 8 ? value.split(token).join('[secret masqué]') : value;
  return redactSecrets(literal);
}
