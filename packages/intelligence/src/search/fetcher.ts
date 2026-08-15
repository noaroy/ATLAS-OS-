import { describeError, nowIso, withDeadline } from '@atlas/core';
import type { Logger } from '@atlas/core';

/**
 * Lire quelques pages, pas explorer un site.
 *
 * La découverte a besoin de savoir ce qu'une organisation fait et où elle le
 * fait. Deux pages y suffisent presque toujours ; au-delà, chaque page entre
 * dans le contexte du modèle et y reste pour tous les tours suivants. LIVE #005
 * a payé 0,49 $ pour un seul tour à 154 000 jetons d'entrée — c'est ce que
 * coûte un contexte qu'on laisse enfler.
 */

export interface FetchedPage {
  url: string;
  title: string | null;
  /** Texte utile, tronqué. Jamais le HTML brut. */
  text: string;
  retrievedAt: string;
  bytes: number;
}

export interface FetchOutcome {
  pages: FetchedPage[];
  failures: Array<{ url: string; reason: string }>;
}

export interface PageFetcherOptions {
  logger: Logger;
  timeoutMs: number;
  /** Caractères conservés par page. Le reste est du bruit pour l'analyse. */
  maxCharsPerPage: number;
  signal?: AbortSignal;
}

/** Hôtes internes, jamais joignables depuis ATLAS. */
const BLOCKED_HOST =
  /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|metadata\.)/i;

const MAX_BYTES = 512 * 1024;

/** Récupère les pages demandées, en signalant chaque échec plutôt qu'en le taisant. */
export async function fetchPages(
  urls: string[],
  options: PageFetcherOptions,
): Promise<FetchOutcome> {
  const pages: FetchedPage[] = [];
  const failures: FetchOutcome['failures'] = [];

  for (const raw of urls) {
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
              accept: 'text/html,text/plain',
            },
          }),
        {
          ms: options.timeoutMs,
          label: `page ${target.hostname}`,
          signal: options.signal,
        },
      );

      if (!response.ok) {
        failures.push({ url: target.href, reason: `HTTP ${response.status}` });
        continue;
      }

      const raw = (await response.text()).slice(0, MAX_BYTES);
      pages.push({
        url: target.href,
        title: titleOf(raw),
        text: stripHtml(raw).slice(0, options.maxCharsPerPage),
        retrievedAt: nowIso(),
        bytes: raw.length,
      });
    } catch (err) {
      options.logger.warn('page non récupérée', { host: target.hostname, error: describeError(err) });
      failures.push({ url: target.href, reason: describeError(err) });
    }
  }

  return { pages, failures };
}

function titleOf(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
  return match?.[1]?.replace(/\s+/g, ' ').trim() || null;
}

/**
 * HTML → texte, sans dépendance.
 *
 * Les scripts, styles et balises de navigation partent : ce sont eux qui
 * gonflent le contexte sans rien apprendre au modèle.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
