/**
 * Une recherche réelle, par le vrai provider, et rien d'autre.
 *
 * Sert à répondre à une seule question avant toute mission : le moteur
 * répond-il, et ce qu'il rend est-il exploitable ? Un `fetch` de trois lignes
 * aurait été plus court mais n'aurait rien prouvé — ce qu'on veut valider, c'est
 * le code qu'ATLAS exécutera, avec sa normalisation, sa provenance, son
 * traitement des publicités et son comportement en panne.
 *
 *   npm run search:probe
 *   PROBE_QUERY="..." npm run search:probe
 *
 * Ne touche ni à Hermès, ni à un agent, ni à Anthropic. Coût : zéro.
 */
import { createLogger, loadConfig } from '../packages/core/src/index.ts';
import { DuckDuckGoSearchProvider } from '../packages/intelligence/src/search/duckduckgo.ts';
import { MarginaliaSearchProvider } from '../packages/intelligence/src/search/marginalia.ts';

const config = loadConfig();
const QUERY = process.env.PROBE_QUERY ?? 'Verpackungsmaschinen Hersteller Deutschland';
const logger = createLogger({ level: 'error', pretty: false });

const c = { reset: '[0m', dim: '[2m', bold: '[1m', green: '[32m', red: '[31m' };

async function main(): Promise<void> {
  // Le moteur sondé suit la configuration : sonder autre chose que ce
  // qu'ATLAS utilisera ne prouverait rien.
  const provider =
    config.search.provider === 'marginalia'
      ? new MarginaliaSearchProvider()
      : new DuckDuckGoSearchProvider();
  console.log(`\n${c.bold}  Sonde de recherche — ${provider.label}${c.reset}`);
  console.log(`  ${c.dim}requête : « ${QUERY} »${c.reset}\n`);

  const response = await provider.search(
    { query: QUERY, count: 10, language: 'de', country: 'DE' },
    { logger, timeoutMs: config.search.timeoutMs },
  );

  console.log(`  issue        ${response.outcome}`);
  console.log(`  détail       ${response.detail}`);
  console.log(`  durée        ${response.durationMs} ms`);
  console.log(`  coût moteur  ${response.costUsd.toFixed(2)} $`);
  console.log(`  résultats    ${response.results.length}\n`);

  for (const result of response.results) {
    let host = '(url illisible)';
    try {
      host = new URL(result.url).hostname.replace(/^www\./, '');
    } catch {
      /* laissé tel quel */
    }
    console.log(`  ${String(result.rank).padStart(2)}. ${c.bold}${host}${c.reset}`);
    console.log(`      ${result.title.slice(0, 96)}`);
    if (result.snippet) console.log(`      ${c.dim}${result.snippet.slice(0, 110)}${c.reset}`);
  }

  // Contrôles de forme : ce que le reste du pipeline attend.
  const problems: string[] = [];
  const hosts = new Set<string>();
  for (const result of response.results) {
    if (!/^https?:\/\//.test(result.url)) problems.push(`URL non web : ${result.url}`);
    if (/duckduckgo\.com|marginalia\.nu/.test(result.url)) problems.push(`lien de redirection non déballé : ${result.url}`);
    if (!result.title.trim()) problems.push('titre vide');
    if (result.provider !== provider.key) problems.push(`provenance inattendue : ${result.provider}`);
    try {
      hosts.add(new URL(result.url).hostname);
    } catch {
      problems.push(`URL invalide : ${result.url}`);
    }
  }
  if (hosts.size !== response.results.length) problems.push('doublons de domaine dans la même page');

  console.log();
  if (problems.length === 0) {
    console.log(`  ${c.green}Forme conforme.${c.reset} ${hosts.size} domaine(s) distinct(s), aucune publicité, aucun lien de suivi.`);
  } else {
    console.log(`  ${c.red}Anomalies :${c.reset}`);
    for (const problem of problems) console.log(`    · ${problem}`);
  }
  console.log();

  // `exitCode` plutôt que `exit()` : couper le processus pendant qu'un handle
  // libuv se referme déclenche une assertion sur Windows.
  process.exitCode = response.outcome === 'ok' && problems.length === 0 ? 0 : 1;
}

void main().catch((err: unknown) => {
  console.error(`\n  ${c.red}Échec : ${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
  process.exit(1);
});
