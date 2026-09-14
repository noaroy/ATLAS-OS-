/**
 * Ce qu'il faut vérifier AVANT de lancer une mission client — et refuser si
 * ça manque.
 *
 *   npm run client:preflight -- --brief=briefs/acrn-sweden.json
 *   npm run client:preflight -- --brief=... --probe-llm      (un appel payant, ~0,001 $)
 *   npm run client:preflight -- --brief=... --budget=3.00 --batch-budget=0.40
 *                                       (les plafonds que ce même --budget donnera à batch)
 *
 * Le 10 septembre, tout « répondait » et rien ne cherchait. Ce contrôle
 * interroge chaque moteur pour de vrai avec une requête du marché visé, et
 * ne compte que ceux qui rendent des résultats. Sans moteur utilisable, il
 * sort en erreur : aucun modèle ne remplace une recherche.
 *
 * La vérification elle-même vit dans le runtime (`runClientPreflight`) : le
 * pilote automatique passe par la même porte, et ne peut pas la contourner.
 *
 * Aucune écriture. Aucun appel modèle sans --probe-llm.
 */
import { existsSync, accessSync, constants, readFileSync } from 'node:fs';
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createSearchFabric } from '../packages/intelligence/src/search/fabric/factory.ts';
import { parseClientBrief, type ClientBrief } from '../packages/departments/src/index.ts';
import { runClientPreflight } from '../packages/runtime/src/index.ts';

loadAtlasEnv();

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m' };
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const PROBE_LLM = process.argv.includes('--probe-llm');

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);

  // Le brief : lu ici, jugé par le runtime.
  const briefPath = arg('brief');
  let brief: ClientBrief | null = null;
  let briefError: string | null = null;
  if (!briefPath) briefError = 'aucun brief : --brief=briefs/<client>.json';
  else if (!existsSync(briefPath)) briefError = `fichier introuvable : ${briefPath}`;
  else {
    const v = parseClientBrief(JSON.parse(readFileSync(briefPath, 'utf8')));
    if (!v.ok) briefError = v.errors.join(' ; ');
    else brief = v.brief!;
  }

  let outputWritable = true;
  try { accessSync('out', constants.W_OK); } catch { outputWritable = false; }

  const fabric = createSearchFabric(config.search, {
    need: { countries: [brief ? 'SE' : 'FR'], languages: [brief ? 'sv' : 'fr'], commercial: true },
  });

  const r = await runClientPreflight({
    repos: system.repos, logger: system.logger, config,
    registry: fabric?.registry ?? null, provider: system.provider,
    hasApiKey: (process.env.ANTHROPIC_API_KEY ?? '').trim().length > 0, outputWritable,
  }, { brief, briefError, probeLlm: PROBE_LLM, budgetArgs: { budget: arg('budget'), batchBudget: arg('batch-budget') } });

  console.log(`\n${c.bold}  CLIENT PREFLIGHT${c.reset}  ${c.dim}${new Date().toISOString()}${c.reset}\n`);
  for (const l of r.lines) {
    const couleur = l.etat === 'READY' ? c.green : l.etat === 'DEGRADED' ? c.amber : l.etat === 'BLOCKED' ? c.red : c.dim;
    // Un détail sur plusieurs lignes s'aligne sous la première.
    console.log(`  ${couleur}${l.etat.padEnd(13)}${c.reset}${l.nom.padEnd(20)}${c.dim}${l.detail.split('\n').join(`\n${' '.repeat(35)}`)}${c.reset}`);
    if (l.nom === 'recherche') {
      for (const p of r.probes) {
        console.log(`      ${c.dim}${p.key.padEnd(12)} ${p.available ? (p.suitable ? `${p.outcome} · ${p.results} résultat(s) · ${p.durationMs} ms` : `inadapté — ${p.detail.slice(0, 70)}`) : `non configuré — ${p.detail.slice(0, 70)}`}${c.reset}`);
      }
    }
  }
  console.log();
  if (r.verdict === 'NO-GO') {
    console.log(`  ${c.red}${c.bold}NO-GO${c.reset} — ${r.blocked.join(', ')}`);
    if (r.readiness === 'SEARCH_BLOCKED') console.log(`  ${c.dim}Aucun moteur réel ne rend de résultat : la mission ne peut pas partir. Aucun modèle ne remplace une recherche.${c.reset}`);
    process.exitCode = 1;
  } else {
    console.log(`  ${c.green}${c.bold}GO${c.reset}${r.degraded.length ? ` ${c.amber}(dégradé : ${r.degraded.join(', ')})${c.reset}` : ''}`);
  }
  console.log();
  await system.shutdown('preflight terminé');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
