import { AtlasError, describeError, nowIso, withDeadline } from '@atlas/core';
import type {
  SearchAvailability,
  SearchProvider,
  SearchProviderContext,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from './types.ts';

/**
 * SearXNG — le moteur de recherche d'ATLAS, auto-hébergé.
 *
 * Un métamoteur : il interroge plusieurs moteurs publics et fusionne leurs
 * résultats. Deux propriétés le rendent préférable à une API commerciale pour
 * cet usage.
 *
 * D'abord il ne coûte rien. ATLAS dépense déjà de l'argent réel à chaque appel
 * d'inférence ; ajouter un abonnement obligatoire pour la seule brique qui
 * peut être auto-hébergée serait un coût subi sans contrepartie.
 *
 * Ensuite il tourne sur notre VPS, sur le réseau interne Docker. Pas de clé à
 * protéger, pas de quota à surveiller, pas de tiers qui décide un jour de
 * changer ses conditions.
 *
 * Le contrat reste celui de {@link SearchProvider} : une requête courte entre,
 * des URLs et des extraits sortent. Business Expansion ne sait pas que SearXNG
 * existe, et basculer vers Brave demande une variable d'environnement.
 */

export interface SearxngOptions {
  /** Racine de l'instance, typiquement `http://searxng:8080` sur le réseau Docker. */
  baseUrl: string;
  /**
   * Moteurs interrogés, séparés par des virgules. Vide = ceux configurés dans
   * l'instance.
   */
  engines: string;
}

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
}

export class SearxngSearchProvider implements SearchProvider {
  readonly key = 'searxng';
  readonly label = 'SearXNG (auto-hébergé)';

  constructor(private readonly options: SearxngOptions) {}

  availability(): SearchAvailability {
    if (!this.options.baseUrl) {
      return {
        available: false,
        reason:
          "Aucune instance SearXNG configurée. Renseignez SEARXNG_BASE_URL — par exemple http://searxng:8080 sur le réseau Docker.",
      };
    }
    return {
      available: true,
      reason: 'Recherche auto-hébergée, sans clé ni quota, résultats sourcés.',
    };
  }

  async search(request: SearchRequest, ctx: SearchProviderContext): Promise<SearchResponse> {
    const started = Date.now();
    const retrievedAt = nowIso();

    let url: URL;
    try {
      url = new URL('/search', this.options.baseUrl);
    } catch {
      return fail('unavailable', `SEARXNG_BASE_URL est invalide : ${this.options.baseUrl}`, started);
    }

    url.searchParams.set('q', request.query);
    url.searchParams.set('format', 'json');
    // Les résultats web classiques suffisent : ni images, ni vidéos, ni
    // actualités. Une entreprise s'identifie par son site, pas par un clip.
    url.searchParams.set('categories', 'general');
    if (this.options.engines) url.searchParams.set('engines', this.options.engines);
    if (request.language) url.searchParams.set('language', request.language);
    // SearXNG pagine par dix ; une page suffit pour ce que le filtrage retient.
    url.searchParams.set('pageno', '1');

    try {
      const response = await withDeadline(
        (signal) =>
          fetch(url, {
            method: 'GET',
            signal,
            headers: {
              accept: 'application/json',
              'user-agent': 'ATLAS-OS/1.0 (+autonomous research agent)',
            },
          }),
        {
          ms: ctx.timeoutMs ?? 0,
          label: `recherche SearXNG « ${request.query.slice(0, 60)} »`,
          signal: ctx.signal,
          onOrphan: (label) =>
            ctx.logger.error("un appel de recherche n'a pas honoré son annulation", { label }),
        },
      );

      if (response.status === 429) {
        // Une instance auto-hébergée limite parfois ses propres appelants, ou
        // se fait limiter par les moteurs qu'elle interroge.
        return fail('rate-limited', 'SearXNG a répondu HTTP 429 (limite de débit).', started);
      }
      if (!response.ok) {
        return fail('http-error', `SearXNG a répondu HTTP ${response.status}.`, started);
      }

      let body: { results?: SearxngResult[]; unresponsive_engines?: unknown };
      try {
        body = (await response.json()) as {
          results?: SearxngResult[];
          unresponsive_engines?: unknown;
        };
      } catch {
        // Une instance mal configurée rend du HTML là où on attend du JSON :
        // le dire clairement évite une heure de recherche à côté.
        return fail(
          'http-error',
          "SearXNG n'a pas rendu de JSON. Vérifiez que le format `json` est autorisé dans settings.yml.",
          started,
        );
      }

      const results: SearchResult[] = [];
      for (const item of body.results ?? []) {
        // Sans URL, ce n'est pas un résultat de recherche : c'est du bruit.
        if (!item.url?.trim()) continue;
        results.push({
          title: (item.title ?? '').trim(),
          url: item.url.trim(),
          snippet: (item.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600),
          // Le moteur d'origine est conservé dans la provenance : comparer
          // SearXNG à Brave n'aurait aucun sens sans savoir qui a répondu.
          provider: item.engine ? `${this.key}:${item.engine}` : this.key,
          rank: results.length + 1,
          query: request.query,
          retrievedAt,
        });
        if (results.length >= request.count) break;
      }

      const muets = readUnresponsive(body.unresponsive_engines);
      const verdict = classifySearxngOutcome(results.length, muets);

      return {
        results,
        outcome: verdict.outcome,
        detail:
          results.length > 0
            ? `${results.length} résultat(s) pour « ${request.query} ».`
            : `${verdict.detail} — requête « ${request.query} ».`,
        // Auto-hébergé : la requête ne coûte rien au-delà du VPS déjà payé.
        costUsd: 0,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const timedOut = err instanceof AtlasError && err.code === 'TIMEOUT';
      ctx.logger.warn('la recherche a échoué', { provider: this.key, error: describeError(err) });
      return fail(
        timedOut ? 'timeout' : 'http-error',
        timedOut
          ? 'La recherche a dépassé son délai.'
          : `SearXNG injoignable : ${describeError(err)}`,
        started,
      );
    }
  }
}

/** Un moteur que SearXNG déclare muet, et la raison qu'il en donne. */
export interface MoteurMuet {
  engine: string;
  reason: string;
}

/**
 * Les moteurs muets, quelle que soit la forme sous laquelle l'instance les rend.
 *
 * SearXNG publie historiquement des paires `[moteur, raison]` ; certaines
 * versions rendent des objets. Une entrée sans nom ni raison n'apprend rien et
 * ne compte pas : le statut qui suit doit reposer sur une déclaration réelle.
 */
function readUnresponsive(brut: unknown): MoteurMuet[] {
  if (!Array.isArray(brut)) return [];
  const sortie: MoteurMuet[] = [];
  for (const entree of brut) {
    let engine = '';
    let reason = '';
    if (Array.isArray(entree)) {
      engine = String(entree[0] ?? '').trim();
      reason = String(entree[1] ?? '').trim();
    } else if (entree !== null && typeof entree === 'object') {
      const o = entree as { engine?: unknown; reason?: unknown };
      engine = String(o.engine ?? '').trim();
      reason = String(o.reason ?? '').trim();
    } else if (typeof entree === 'string') {
      engine = entree.trim();
    }
    if (engine === '' && reason === '') continue;
    sortie.push({ engine, reason });
  }
  return sortie;
}

/**
 * Un blocage, dit par le moteur lui-même.
 *
 * La liste reste volontairement étroite : elle ne reconnaît que ce qu'un moteur
 * écrit quand il refuse de servir. « Suspended » seul n'y figure pas — une
 * suspension peut suivre une panne comme un bridage, et deviner laquelle
 * reviendrait à inventer la raison au lieu de la lire.
 */
const BRIDAGE = /captcha|too many requests|rate.?limit|\b429\b|quota exceeded/i;

/**
 * Ce que vaut vraiment un « zéro résultat ».
 *
 * Zéro résultat se lisait « le web n'a rien », toujours. Le tissu de recherche
 * en déduisait une réponse valide et ne basculait sur aucun autre moteur —
 * `failedOver: false`, en toutes lettres dans la trace. Or le 8 septembre
 * l'instance rendait zéro avec trois moteurs sur quatre en CAPTCHA ou bridés :
 * la prospection s'est arrêtée une journée entière sans qu'aucune ligne ne
 * signale que personne n'avait cherché.
 *
 * Trois cas, et un seul change de statut :
 *
 * - des résultats → `ok`, quoi qu'un moteur secondaire soit tombé. Une vraie
 *   réponse ne se jette pas parce qu'un moteur d'appoint manque à l'appel ;
 * - zéro, aucun moteur muet → `empty`. Personne n'a été empêché : le vide est
 *   une information sur le monde, pas sur la plomberie ;
 * - zéro, au moins un moteur muet → l'incident remonte. `rate-limited` si une
 *   raison publiée dit le blocage, `unavailable` sinon. Les deux font basculer
 *   le tissu, qui savait déjà le faire.
 *
 * Le statut ne se déduit jamais de la seule présence d'une liste : c'est la
 * raison écrite qui décide entre bridage et indisponibilité.
 */
export function classifySearxngOutcome(
  resultCount: number,
  muets: readonly MoteurMuet[],
): { outcome: SearchResponse['outcome']; detail: string } {
  if (resultCount > 0) return { outcome: 'ok', detail: `${resultCount} résultat(s).` };
  if (muets.length === 0) return { outcome: 'empty', detail: 'Aucun résultat' };

  const nommes = muets
    .map((m) => (m.reason === '' ? m.engine : `${m.engine} (${m.reason})`))
    .join(', ');
  const bride = muets.filter((m) => BRIDAGE.test(m.reason));

  if (bride.length > 0) {
    return {
      outcome: 'rate-limited',
      detail: `Aucun résultat : moteur(s) bridé(s) — ${nommes}`,
    };
  }
  return {
    outcome: 'unavailable',
    detail: `Aucun résultat : moteur(s) sans réponse — ${nommes}`,
  };
}

function fail(
  outcome: SearchResponse['outcome'],
  detail: string,
  started: number,
): SearchResponse {
  return { results: [], outcome, detail, costUsd: 0, durationMs: Date.now() - started };
}
