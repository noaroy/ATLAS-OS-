import { describeError, nowIso, withDeadline } from '@atlas/core';
import type {
  SearchAvailability,
  SearchProvider,
  SearchProviderContext,
  SearchRequest,
  SearchResponse,
  SearchResult,
} from './types.ts';

/**
 * DuckDuckGo — le moteur de recherche d'ATLAS, en direct.
 *
 * Pourquoi celui-ci, et pourquoi sans intermédiaire.
 *
 * SearXNG restait le choix le plus propre : un métamoteur auto-hébergé qui
 * interroge plusieurs moteurs et fusionne. Mais il demande Docker, et Docker
 * refuse de démarrer sur ce poste depuis des semaines — un défaut au niveau des
 * sockets Windows, pas de Docker. ATLAS s'est donc retrouvé avec un moteur
 * configuré, injoignable, et aucune mission réelle possible.
 *
 * Or SearXNG n'invente rien : pour l'essentiel il interroge DuckDuckGo,
 * Startpage et Mojeek, puis fusionne. Retirer l'intermédiaire ne change ni la
 * source, ni la nature des données, ni le contrat. Cela retire une dépendance
 * d'infrastructure qui bloquait tout.
 *
 * Ce provider ne coûte rien, n'a pas de clé, pas de quota, pas de compte. Il
 * reste derrière {@link SearchProvider} : Business Expansion ne sait pas qui
 * répond, et rebasculer vers SearXNG ou Brave demande une variable
 * d'environnement.
 *
 * Deux limites, énoncées franchement. Le service peut brider un appelant trop
 * insistant — d'où les bornes strictes et l'absence de reprise agressive. Et
 * l'analyse d'une page HTML est plus fragile qu'une API : si DuckDuckGo change
 * sa mise en page, le provider rend `empty` et le dit, plutôt que d'inventer.
 */

const ENDPOINT = 'https://html.duckduckgo.com/html/';

/**
 * Ce qui trahit une publicité.
 *
 * DuckDuckGo place ses annonces dans la même liste que les résultats
 * organiques, sous la même classe CSS. Un parseur naïf ferait donc entrer un
 * annonceur dans le pipeline comme s'il avait été découvert — une entreprise
 * qui a payé pour apparaître, présentée au fondateur comme un candidat trouvé
 * par recherche. C'est exactement le genre de donnée fausse qu'ATLAS ne doit
 * jamais produire.
 */
const AD_MARKERS = ['duckduckgo.com/y.js', 'ad_provider=', 'ad_domain=', '/y.js?ad'];

export class DuckDuckGoSearchProvider implements SearchProvider {
  readonly key = 'duckduckgo';
  readonly label = 'DuckDuckGo (direct, sans clé)';

  availability(): SearchAvailability {
    return {
      available: true,
      reason: 'Moteur public interrogé en direct : ni clé, ni quota, ni compte.',
    };
  }

  async search(request: SearchRequest, ctx: SearchProviderContext): Promise<SearchResponse> {
    const started = Date.now();
    const retrievedAt = nowIso();
    const timeoutMs = ctx.timeoutMs ?? 15_000;

    const params = new URLSearchParams({ q: request.query });
    // Région et langue, quand le marché est connu : « de-de » ramène des sites
    // allemands plutôt que des pages anglophones qui parlent de l'Allemagne.
    if (request.country && request.language) {
      params.set('kl', `${request.language.toLowerCase()}-${request.country.toLowerCase()}`);
    }

    try {
      const response = await withDeadline(
        (signal) =>
          fetch(`${ENDPOINT}?${params.toString()}`, {
            method: 'GET',
            headers: {
              // Trois en-têtes, et le deuxième est celui qui compte.
              //
              // Sans `accept`, DuckDuckGo répond 202 avec une page de défi
              // anti-robot : statut de succès, quatorze kilo-octets, zéro
              // résultat. Un provider naïf y aurait lu « le marché est vide »
              // et l'aurait rapporté au fondateur comme un constat.
              'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'accept-language': request.language
                ? `${request.language}-${(request.country ?? request.language).toUpperCase()},${request.language};q=0.9,en;q=0.7`
                : 'en',
            },
            signal,
            redirect: 'follow',
          }),
        {
          ms: timeoutMs,
          label: `recherche « ${request.query} »`,
          signal: ctx.signal,
          onOrphan: (label) =>
            ctx.logger.error("une recherche n'a pas honoré son annulation", { label }),
        },
      );

      if (response.status === 429) {
        return this.#fail('rate-limited', 'DuckDuckGo limite le débit ; ralentissez les requêtes.', started);
      }
      // 202 n'est pas un succès ici : c'est la page de défi anti-robot. La
      // traiter comme une réponse valide ferait passer un blocage pour un
      // marché vide.
      if (response.status === 202) {
        return this.#fail(
          'rate-limited',
          'DuckDuckGo a servi sa page de vérification au lieu des résultats.',
          started,
        );
      }
      if (!response.ok) {
        return this.#fail('http-error', `DuckDuckGo a répondu ${response.status}.`, started);
      }

      const html = await response.text();

      // Un captcha n'est pas un résultat vide : on le nomme, et on ne le
      // contourne pas.
      if (/<title>\s*captcha/i.test(html) || html.includes('anomaly-modal')) {
        return this.#fail(
          'rate-limited',
          'DuckDuckGo demande une vérification humaine — trop de requêtes depuis cette adresse.',
          started,
        );
      }

      const results = parseResults(html, request, retrievedAt).slice(0, request.count);

      return {
        results,
        outcome: results.length > 0 ? 'ok' : 'empty',
        detail:
          results.length > 0
            ? `${results.length} résultat(s) organique(s).`
            : "Aucun résultat organique. La requête est peut-être trop étroite, ou la mise en page a changé.",
        costUsd: 0,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const failure = describeError(err);
      const timedOut = /timeout|deadline|abort/i.test(failure);
      return this.#fail(
        timedOut ? 'timeout' : 'unavailable',
        timedOut ? `Recherche interrompue après ${timeoutMs} ms.` : `Recherche impossible : ${failure}`,
        started,
      );
    }
  }

  #fail(
    outcome: SearchResponse['outcome'],
    detail: string,
    started: number,
  ): SearchResponse {
    return { results: [], outcome, detail, costUsd: 0, durationMs: Date.now() - started };
  }
}

// ─── Analyse de la page ─────────────────────────────────────────────────────

/** Un bloc de résultat, tel que DuckDuckGo le structure. */
const RESULT_BLOCK = /<div class="links_main links_deep result__body">([\s\S]*?)<\/div>\s*<\/div>/g;
const ANCHOR = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
const SNIPPET = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;

export function parseResults(
  html: string,
  request: SearchRequest,
  retrievedAt: string,
): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const [, block] of html.matchAll(RESULT_BLOCK)) {
    const anchor = ANCHOR.exec(block ?? '');
    if (!anchor) continue;

    // Déballer d'abord, filtrer ensuite. L'ordre inverse laissait passer les
    // annonces : DuckDuckGo enveloppe tout dans `/l/?uddg=<url encodée>`, si
    // bien que le href brut contient « %2Fy.js%3Fad_domain » et non
    // « /y.js?ad_domain ». Le filtre ne mordait sur rien, et deux annonceurs
    // sont entrés dans la liste des candidats comme s'ils avaient été trouvés
    // par la recherche.
    const url = unwrapRedirect(decodeEntities(anchor[1] ?? ''));
    if (!url) continue;
    if (AD_MARKERS.some((marker) => url.includes(marker))) continue;

    // Une même entreprise peut sortir deux fois sur la même page ; le pipeline
    // dédupliquera aussi plus tard, mais autant ne pas la compter deux fois ici.
    const canonical = url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    const title = stripTags(anchor[2] ?? '').trim();
    if (!title) continue;

    const snippetMatch = SNIPPET.exec(block ?? '');
    results.push({
      title,
      url,
      snippet: stripTags(snippetMatch?.[1] ?? '').trim(),
      provider: 'duckduckgo',
      rank: results.length + 1,
      query: request.query,
      retrievedAt,
    });
  }

  return results;
}

/**
 * Déballe le lien de redirection de DuckDuckGo.
 *
 * Les résultats organiques passent parfois par `//duckduckgo.com/l/?uddg=…`.
 * Garder cette forme ferait entrer un lien de suivi dans la provenance à la
 * place de la source réelle — et une preuve doit citer la page, pas le chemin
 * qui y mène.
 */
function unwrapRedirect(href: string): string | null {
  let candidate = href.startsWith('//') ? `https:${href}` : href;

  try {
    const parsed = new URL(candidate);
    const target = parsed.searchParams.get('uddg');
    if (target) candidate = target;
  } catch {
    return null;
  }

  try {
    const final = new URL(candidate);
    // Seulement du web public : ni javascript:, ni data:, ni ftp:.
    if (final.protocol !== 'https:' && final.protocol !== 'http:') return null;
    return final.toString();
  } catch {
    return null;
  }
}

const stripTags = (value: string): string => decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');

/**
 * Les entités nommées qui apparaissent réellement dans des titres européens.
 *
 * Pas de table complète : quelques dizaines suffisent, et les inconnues sont
 * laissées telles quelles plutôt que d'être effacées. Le marché allemand rend
 * les voyelles infléchies indispensables — « Verpackungsmaschinen für
 * Getränke » resterait « f&uuml;r Getr&auml;nke » dans une preuve, ce qui la
 * rend illisible pour le fondateur et fausse toute comparaison de noms.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  reg: '®', copy: '©', trade: '™', deg: '°', euro: '€', pound: '£',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', ccedil: 'ç', ugrave: 'ù',
  Eacute: 'É', Egrave: 'È', Agrave: 'À', Ccedil: 'Ç',
  aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  middot: '·', bull: '•', times: '×', minus: '−',
};

function decodeEntities(value: string): string {
  return value
    // Numériques d'abord : &#38; doit devenir « & » sans être relu ensuite.
    .replace(/&#(\d+);/g, (_, code: string) => safeChar(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => safeChar(parseInt(code, 16)))
    .replace(/&([a-zA-Z]+);/g, (whole, name: string) => NAMED_ENTITIES[name] ?? whole);
}

/** Un point de code hors plage rendrait une chaîne corrompue ; on préfère l'espace. */
function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
}
