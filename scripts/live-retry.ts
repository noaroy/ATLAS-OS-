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
import { createSearchFabric } from '../packages/intelligence/src/search/fabric/factory.ts';
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

  // Un parc, plus un moteur. Le point de défaillance unique disparaît : la
  // reprise n'est bloquée que si *tous* les moteurs adaptés sont indisponibles.
  const search = createSearchFabric(config.search, { need: LIVE_PILOT_NEED });

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

  // ─── Le parc, moteur par moteur ─────────────────────────────────────────
  // C'est ce tableau qui remplace « attendez que DuckDuckGo revienne ». Un
  // moteur bridé n'y bloque plus rien : il y apparaît en refroidissement,
  // pendant qu'un autre prend la tête de file.
  if (report.fabric) {
    console.log(`  ${c.bold}Search Fabric${c.reset}`);
    for (const provider of report.fabric.providers) {
      const excluded = report.fabric.excluded.find((e) => e.id === provider.id);
      const rank = report.fabric.order.indexOf(provider.id);
      const marker = rank === 0 ? `${c.green}▶${c.reset}` : excluded ? `${c.dim}·${c.reset}` : ' ';
      const state = excluded
        ? `${c.dim}écarté — ${excluded.reason}${c.reset}`
        : `${provider.health} · circuit ${provider.circuit.state}` +
          (rank === 0 ? ` ${c.green}(actif)${c.reset}` : ` (secours ${rank + 1})`);
      console.log(`   ${marker} ${provider.id.padEnd(12)} ${state}`);
    }
    console.log();
  }

  console.log(`  ${c.dim}santé du moteur retenu  ${report.searchHealth}${c.reset}`);
  console.log(`  ${c.dim}adéquation              ${report.searchSuitability?.verdict ?? 'non évaluée'}${c.reset}`);
  console.log();

  if (!report.cleared) {
    // La cause nomme ce qu'il faut corriger. Un parc entièrement indisponible
    // et une configuration invalide appellent deux gestes différents ; les
    // confondre a fait chercher une panne réseau pendant qu'une variable
    // d'environnement manquait.
    //
    // Le blocage par le parc est désormais le seul cas lié à la recherche :
    // un moteur bridé ne bloque plus rien tant qu'un autre peut répondre.
    const cause = report.fabric?.blocked
      ? 'BLOCKED-BY-SEARCH-FABRIC'
      : report.searchSuitability?.verdict === 'unsuitable'
        ? 'BLOCKED-BY-SEARCH-PROVIDER (adéquation)'
        : 'BLOCKED-BY-PREFLIGHT';

    if (report.fabric?.blockedReason) {
      console.error(`  ${c.dim}${report.fabric.blockedReason}${c.reset}`);
    }

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
