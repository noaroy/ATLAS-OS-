/**
 * Reprise de LIVE PILOT 001 — une seule commande, une seule tentative.
 *
 *   npm run live:retry            contrôle seul, aucune dépense
 *   npm run live:retry -- --go    contrôle puis exécution, si tout est vert
 *
 * Pensée pour le moment où le moteur redeviendra disponible. Elle enchaîne les
 * cinq vérifications qui décident, et n'engage rien tant qu'une seule échoue :
 *
 *   1. le contrôle avant décollage
 *   2. la santé du moteur — répond-il ?
 *   3. son adéquation — peut-il répondre à *cette* mission ?
 *   4. le plafond de dépense
 *   5. le mode réellement déclaré
 *
 * Aucune reprise automatique, aucune boucle. Un moteur qui bride une adresse
 * bride plus longtemps si on insiste, et une tentative répétée en arrière-plan
 * est une dépense qu'on ne surveille plus.
 */
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig } from '../packages/core/src/index.ts';
import { preflight, formatPreflight } from '../packages/runtime/src/preflight.ts';
import { DuckDuckGoSearchProvider } from '../packages/intelligence/src/search/duckduckgo.ts';
import { MarginaliaSearchProvider } from '../packages/intelligence/src/search/marginalia.ts';
import { LIVE_PILOT_MISSION, LIVE_PILOT_LIMITS, LIVE_PILOT_NEED } from '../packages/departments/src/live-pilot.ts';

const c = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  green: '[32m',
  amber: '[33m',
  red: '[31m',
};

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);

  const search =
    config.search.provider === 'duckduckgo'
      ? new DuckDuckGoSearchProvider()
      : config.search.provider === 'marginalia'
        ? new MarginaliaSearchProvider()
        : null;

  console.log(`\n${c.bold}  Reprise de ${LIVE_PILOT_MISSION.code}${c.reset}\n`);

  const report = await preflight({
    config,
    repos: system.repos,
    search,
    logger: system.logger,
    missionBudgetUsd: LIVE_PILOT_LIMITS.maxCostUsd,
    need: LIVE_PILOT_NEED,
  });

  console.log(formatPreflight(report).replace(/^/gm, '  '));
  console.log();
  console.log(`  ${c.dim}santé du moteur    ${report.searchHealth}${c.reset}`);
  console.log(`  ${c.dim}adéquation         ${report.searchSuitability?.verdict ?? 'non évaluée'}${c.reset}`);
  console.log();

  if (!report.cleared) {
    // La distinction qui a coûté deux missions : un moteur peut répondre
    // parfaitement et ne rien savoir du marché visé.
    const cause =
      report.searchHealth !== 'healthy'
        ? 'BLOCKED-BY-SEARCH-PROVIDER (santé)'
        : report.searchSuitability?.verdict === 'unsuitable'
          ? 'BLOCKED-BY-SEARCH-PROVIDER (adéquation)'
          : 'BLOCKED-BY-PREFLIGHT';

    console.error(`  ${c.red}${cause}${c.reset} — aucune dépense engagée.\n`);
    await system.shutdown('reprise refusée');
    process.exitCode = 1;
    return;
  }

  console.log(`  ${c.green}Tout est vert.${c.reset}`);
  console.log(
    `  ${c.dim}Lancez : npm run live:pilot -- --go` +
      `  (plafond ${LIVE_PILOT_LIMITS.maxCostUsd.toFixed(2)} $, modèle ${LIVE_PILOT_LIMITS.model})${c.reset}\n`,
  );

  await system.shutdown('reprise autorisée');
}

void main().catch((err: unknown) => {
  console.error(`\n  ${c.red}Échec : ${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
  process.exitCode = 1;
});
