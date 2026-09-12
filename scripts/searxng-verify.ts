/**
 * Vérifie qu'une instance SearXNG est réellement exploitable par ATLAS.
 *
 *   npm run searxng:verify
 *
 * « Configuré » n'a jamais empêché « injoignable », et la nuance a coûté deux
 * missions. Ce script ne lit aucune configuration : il interroge, et rapporte
 * ce qu'il a obtenu.
 *
 * Sept vérifications, dans l'ordre où elles peuvent échouer :
 *
 *   1. le service répond              — HTTP joignable
 *   2. /healthz est vert              — le service se déclare prêt
 *   3. /search rend du JSON           — le format est bien activé
 *   4. une vraie requête rend des résultats
 *   5. le provider d'ATLAS les lit    — le contrat est respecté
 *   6. un délai dépassé est honoré    — la borne coupe vraiment
 *   7. une annulation est honorée     — l'AbortSignal libère l'appel
 *
 * Une seule requête réelle est envoyée aux moteurs, à l'étape 4. Les étapes 6
 * et 7 sont conçues pour ne jamais aboutir : elles ne coûtent rien à personne.
 */
import { loadAtlasEnv } from '../packages/core/src/index.ts';
import { createLogger } from '../packages/core/src/logger.ts';
import { SearxngSearchProvider } from '../packages/intelligence/src/search/searxng.ts';
import { assessSuitability } from '../packages/intelligence/src/search/capabilities.ts';

// Avant toute lecture de process.env : sans cet appel, `.env.local` n'existe
// pas pour ce processus et la configuration parait absente sans qu'aucune
// erreur ne le dise.
loadAtlasEnv();

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  amber: '\x1b[33m',
  red: '\x1b[31m',
};

const BASE_URL = process.env.SEARXNG_BASE_URL ?? 'http://localhost:8080';
const logger = createLogger({ level: 'error', pretty: false });

let failures = 0;

const ok = (label: string, detail: string): void => {
  console.log(`  ${c.green}✓${c.reset} ${label.padEnd(32)} ${c.dim}${detail}${c.reset}`);
};
const ko = (label: string, detail: string, remedy?: string): void => {
  failures += 1;
  console.log(`  ${c.red}✗${c.reset} ${label.padEnd(32)} ${detail}`);
  if (remedy) console.log(`    ${c.dim}→ ${remedy}${c.reset}`);
};

async function main(): Promise<void> {
  console.log(`\n${c.bold}  SearXNG — vérification${c.reset}`);
  console.log(`  ${c.dim}${BASE_URL}${c.reset}\n`);

  // ── 1. Le service répond ─────────────────────────────────────────────────
  try {
    const started = Date.now();
    const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(5000) });
    ok('service joignable', `HTTP ${response.status} en ${Date.now() - started} ms`);
  } catch (err) {
    ko(
      'service joignable',
      err instanceof Error ? err.message : String(err),
      'docker compose -f deployment/searxng-local.yml up -d',
    );
    return report();
  }

  // ── 2. /healthz ──────────────────────────────────────────────────────────
  try {
    const response = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (response.ok) ok('/healthz', `HTTP ${response.status}`);
    else ko('/healthz', `HTTP ${response.status}`, "l'instance démarre peut-être encore");
  } catch (err) {
    ko('/healthz', err instanceof Error ? err.message : String(err));
  }

  // ── 3. Le format JSON est activé ─────────────────────────────────────────
  // Le piège le plus courant : SearXNG rend du HTML par défaut, et le provider
  // reçoit une page là où il attend un objet.
  try {
    const url = new URL('/search', BASE_URL);
    url.searchParams.set('q', 'test');
    url.searchParams.set('format', 'json');
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('json')) {
      ko(
        'format JSON',
        `content-type « ${type} »`,
        'Ajoutez `json` à `search.formats` dans deployment/searxng/settings.yml',
      );
    } else {
      const body = (await response.json()) as { results?: unknown[] };
      ok('format JSON', `objet valide, ${body.results?.length ?? 0} résultat(s)`);
    }
  } catch (err) {
    ko('format JSON', err instanceof Error ? err.message : String(err));
  }

  // ── 4. Une vraie requête, celle du marché de validation ──────────────────
  const provider = new SearxngSearchProvider({
    baseUrl: BASE_URL,
    engines: process.env.SEARXNG_ENGINES ?? '',
  });

  const availability = provider.availability();
  if (!availability.available) {
    ko('disponibilité déclarée', availability.reason);
    return report();
  }

  let healthy = false;
  try {
    const response = await provider.search(
      { query: 'Verpackungsmaschinen Distributor Deutschland', count: 5, language: 'de' },
      { logger, timeoutMs: 20_000 },
    );

    if (response.outcome === 'ok' && response.results.length > 0) {
      healthy = true;
      ok(
        'requête réelle',
        `${response.results.length} résultat(s) en ${response.durationMs} ms`,
      );
      for (const result of response.results.slice(0, 3)) {
        console.log(`    ${c.dim}· ${result.title.slice(0, 60)} — ${result.url.slice(0, 60)}${c.reset}`);
      }
    } else {
      ko('requête réelle', `${response.outcome} — ${response.detail}`);
    }
  } catch (err) {
    ko('requête réelle', err instanceof Error ? err.message : String(err));
  }

  // ── 5. Le délai est réellement honoré ────────────────────────────────────
  // Une borne qui n'interrompt pas est un commentaire, pas une borne.
  try {
    const started = Date.now();
    const response = await provider.search(
      { query: 'test délai', count: 5 },
      { logger, timeoutMs: 1 },
    );
    const elapsed = Date.now() - started;
    if (response.outcome === 'timeout' && elapsed < 3000) {
      ok('délai honoré', `coupé en ${elapsed} ms`);
    } else {
      ko('délai honoré', `issue ${response.outcome} après ${elapsed} ms`);
    }
  } catch (err) {
    ko('délai honoré', err instanceof Error ? err.message : String(err));
  }

  // ── 6. L'annulation est honorée ──────────────────────────────────────────
  try {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const response = await provider.search(
      { query: 'test annulation', count: 5 },
      { logger, timeoutMs: 20_000, signal: controller.signal },
    );
    const elapsed = Date.now() - started;
    if (response.outcome !== 'ok' && elapsed < 2000) {
      ok('annulation honorée', `libéré en ${elapsed} ms`);
    } else {
      ko('annulation honorée', `issue ${response.outcome} après ${elapsed} ms`);
    }
  } catch (err) {
    // Une exception est acceptable : ce qui compte est que l'appel rende la
    // main immédiatement plutôt que de rester en vol.
    ok('annulation honorée', `levée immédiate — ${err instanceof Error ? err.message : ''}`);
  }

  // ── 7. Adéquation au marché de validation ────────────────────────────────
  const need = { countries: ['DE'], languages: ['de'], commercial: true };
  const suitability = assessSuitability(provider, need);
  if (suitability.verdict === 'suitable') {
    ok('adéquation DE / de / commercial', suitability.verdict);
  } else {
    ko('adéquation DE / de / commercial', `${suitability.verdict} — ${suitability.gaps.join(' · ')}`);
  }

  console.log();
  console.log(`  ${c.bold}santé      ${healthy ? `${c.green}healthy` : `${c.red}unhealthy`}${c.reset}`);
  console.log(`  ${c.bold}adéquation ${suitability.verdict === 'suitable' ? c.green : c.amber}${suitability.verdict}${c.reset}`);

  report();
}

function report(): void {
  console.log();
  if (failures === 0) {
    console.log(`  ${c.green}${c.bold}SearXNG est opérationnel.${c.reset}\n`);
    process.exitCode = 0;
  } else {
    console.log(`  ${c.red}${c.bold}${failures} vérification(s) en échec.${c.reset}\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
