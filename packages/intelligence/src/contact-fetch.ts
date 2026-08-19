import { withDeadline, describeError } from '@atlas/core';
import type { Logger } from '@atlas/core';

/**
 * Récupérer des pages en gardant leur HTML.
 *
 * La récupération de découverte dépouille le HTML — scripts, styles, nav, et
 * surtout `<footer>` — parce que tout cela entre dans le contexte du modèle et
 * y reste. Pour chercher des coordonnées, c'est exactement l'inverse : le pied
 * de page est souvent le seul endroit où l'adresse figure, et un `mailto:` vit
 * dans un attribut que le nettoyage efface.
 *
 * D'où deux fonctions plutôt qu'un drapeau : les deux besoins sont opposés, et
 * un appelant qui se trompe de mode obtient un silence, pas une erreur.
 */

export interface RawPage {
  url: string;
  html: string;
}

export interface RawFetchOutcome {
  pages: RawPage[];
  failures: Array<{ url: string; reason: string }>;
}

export interface RawFetchOptions {
  logger: Logger;
  timeoutMs: number;
  /** Combien de pages au maximum. Lire un site n'est pas l'explorer. */
  maxPages: number;
}

/** Hôtes internes, jamais joignables depuis ATLAS. */
const BLOCKED_HOST =
  /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|metadata\.)/i;

const MAX_BYTES = 512 * 1024;

export async function fetchRawPages(
  urls: readonly string[],
  options: RawFetchOptions,
): Promise<RawFetchOutcome> {
  const pages: RawPage[] = [];
  const failures: RawFetchOutcome['failures'] = [];

  for (const raw of urls) {
    if (pages.length >= options.maxPages) break;

    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      failures.push({ url: raw, reason: 'URL invalide' });
      continue;
    }
    if (target.protocol !== 'https:') {
      failures.push({ url: raw, reason: 'seul https est autorisé' });
      continue;
    }
    if (BLOCKED_HOST.test(target.hostname)) {
      failures.push({ url: raw, reason: 'hôte interne ou privé' });
      continue;
    }

    try {
      const response = await withDeadline(
        (signal) =>
          fetch(target, {
            signal,
            redirect: 'follow',
            headers: {
              'user-agent': 'ATLAS-OS/1.0 (+autonomous research agent)',
              accept: 'text/html,application/xhtml+xml',
            },
          }),
        { ms: options.timeoutMs, label: `page ${target.hostname}` },
      );
      if (!response.ok) {
        failures.push({ url: target.href, reason: `HTTP ${response.status}` });
        continue;
      }
      pages.push({
        url: response.url || target.href,
        html: (await response.text()).slice(0, MAX_BYTES),
      });
    } catch (err) {
      options.logger.warn('page non récupérée', {
        host: target.hostname,
        error: describeError(err),
      });
      failures.push({ url: target.href, reason: describeError(err) });
    }
  }

  return { pages, failures };
}
