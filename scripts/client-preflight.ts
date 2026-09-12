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
 * Aucune écriture. Aucun appel modèle sans --probe-llm.
 */
import { existsSync, accessSync, constants } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createSearchFabric } from '../packages/intelligence/src/search/fabric/factory.ts';
import { probeSearchProviders, classifySearchReadiness, planQueries } from '../packages/intelligence/src/index.ts';
import { parseClientBrief } from '../packages/departments/src/index.ts';
import { startOfUtcDay, clientBudgetLimits, describeClientBudgetLimits } from '../packages/runtime/src/index.ts';

loadAtlasEnv();

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m' };
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const PROBE_LLM = process.argv.includes('--probe-llm');

type Etat = 'READY' | 'DEGRADED' | 'BLOCKED' | 'NOT_REQUIRED';
const lignes: Array<{ nom: string; etat: Etat; detail: string }> = [];
const note = (nom: string, etat: Etat, detail: string) => lignes.push({ nom, etat, detail });

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);
  const { repos } = system;

  // ── Base ────────────────────────────────────────────────────────────────
  try {
    const n = repos.clientCandidates.counts('preflight-probe');
    note('base de données', 'READY', `${config.paths.databaseFile} · table client_candidates présente (${Object.keys(n).length} états)`);
  } catch (err) {
    note('base de données', 'BLOCKED', err instanceof Error ? err.message : String(err));
  }

  // ── Mode ────────────────────────────────────────────────────────────────
  if (config.search.fallbackEnabled) {
    note('mode', 'BLOCKED', 'ATLAS_SEARCH_FALLBACK_ENABLED est actif : un modèle remplacerait le moteur. Interdit en mission client.');
  } else if (config.llm.mode !== 'live') {
    note('mode', 'BLOCKED', `mode « ${config.llm.mode} » : une mission client exige le mode live`);
  } else {
    note('mode', 'READY', 'live · aucun repli recherche-par-modèle');
  }

  // ── Brief ───────────────────────────────────────────────────────────────
  const briefPath = arg('brief');
  let brief = null;
  if (!briefPath) {
    note('brief', 'BLOCKED', 'aucun brief : --brief=briefs/<client>.json');
  } else if (!existsSync(briefPath)) {
    note('brief', 'BLOCKED', `fichier introuvable : ${briefPath}`);
  } else {
    const v = parseClientBrief(JSON.parse(readFileSync(briefPath, 'utf8')));
    if (!v.ok) note('brief', 'BLOCKED', v.errors.join(' ; '));
    else {
      brief = v.brief;
      const requis = brief!.requiredCriteria.length;
      note('brief', 'READY', `${brief!.client.name} · ${brief!.market.countryLabel} · ${requis} critère(s) requis, ${brief!.preferredCriteria.length} souhaité(s), ${brief!.competitorExclusions.length} concurrent(s)${brief!.client.internalTest ? ' · INTERNAL_TEST' : ''}`);
    }
  }

  // ── Marché ──────────────────────────────────────────────────────────────
  let premiere: string | null = null;
  if (brief) {
    const plan = planQueries({
      targetTypes: brief.targetRoles.map((key) => ({ key, label: key, description: '' })),
      countries: [brief.market.country], industries: brief.industries, keywords: brief.productKeywords,
      exclusions: [], clientOffering: brief.client.offering, limit: 10,
    }, { maxQueries: 3 });
    if (plan.length === 0 || !plan[0]!.country) {
      note('marché', 'BLOCKED', `« ${brief.market.country} » n’est pas un marché connu du planificateur : les requêtes partiraient sans pays`);
    } else {
      premiere = plan[0]!.query;
      note('marché', 'READY', `${plan[0]!.country} / ${plan[0]!.language} · ex. « ${plan.map((q) => q.query).join(' » · « ')} »`);
    }
  }

  // ── Recherche : chaque moteur, pour de vrai ─────────────────────────────
  const fabric = createSearchFabric(config.search, {
    need: { countries: [brief ? 'SE' : 'FR'], languages: [brief ? 'sv' : 'fr'], commercial: true },
  });
  if (!fabric) {
    note('recherche', 'BLOCKED', 'aucun moteur configuré (ATLAS_SEARCH_PROVIDER)');
  } else {
    const probes = await probeSearchProviders(
      fabric.registry,
      { query: premiere ?? 'distributör förpackningsmaskiner Sverige', count: 5, country: 'SE', language: 'sv' },
      { countries: ['SE'], languages: ['sv'], commercial: true },
      { logger: system.logger, timeoutMs: 20_000 },
    );
    const r = classifySearchReadiness(probes);
    const etat: Etat = r.readiness === 'SEARCH_READY' ? 'READY' : r.readiness === 'SEARCH_DEGRADED' ? 'DEGRADED' : 'BLOCKED';
    note('recherche', etat, `${r.readiness} — ${r.summary}`);
    for (const p of probes) {
      console.log(`      ${c.dim}${p.key.padEnd(12)} ${p.available ? (p.suitable ? `${p.outcome} · ${p.results} résultat(s) · ${p.durationMs} ms` : `inadapté — ${p.detail.slice(0, 70)}`) : `non configuré — ${p.detail.slice(0, 70)}`}${c.reset}`);
    }
  }

  // ── Modèle ──────────────────────────────────────────────────────────────
  const cle = (process.env.ANTHROPIC_API_KEY ?? '').trim().length > 0;
  if (!cle) note('modèle', 'BLOCKED', 'ANTHROPIC_API_KEY absente');
  else if (PROBE_LLM) {
    try {
      const t0 = Date.now();
      await system.provider.complete({
        model: config.llm.agentModel, system: 'Répondez par le seul mot OK.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'OK ?' }] }], maxTokens: 5,
        meta: { purpose: 'client-preflight', missionId: null, taskRef: 'preflight', agentKey: 'preflight', subject: 'probe', evidenceCount: null },
      });
      note('modèle', 'READY', `${config.llm.agentModel} répond en ${Date.now() - t0} ms`);
    } catch (err) {
      note('modèle', 'BLOCKED', err instanceof Error ? err.message.slice(0, 120) : String(err));
    }
  } else {
    const dernier = repos.llmCalls.usageSince(startOfUtcDay(new Date(Date.now() - 7 * 86_400_000).toISOString()));
    note('modèle', dernier.calls > 0 ? 'READY' : 'DEGRADED', `clé présente · ${config.llm.agentModel} · ${dernier.calls} appel(s) sur 7 jours (non sondé : --probe-llm pour un appel réel)`);
  }

  // ── Budget ──────────────────────────────────────────────────────────────
  // Les plafonds affichés sont ceux que `client:mission batch` appliquera —
  // pas ATLAS_MAX_MISSION_COST_USD, que ce pipeline n'utilise pas.
  const jour = repos.llmCalls.usageSince(startOfUtcDay(new Date().toISOString())).knownCostUsd;
  try {
    const plafonds = clientBudgetLimits(config.ai, { budget: arg('budget'), batchBudget: arg('batch-budget') });
    const lignesPlafonds = describeClientBudgetLimits(plafonds).join('\n');
    if (!plafonds.daily.configured) {
      note('budget', 'DEGRADED', `${jour.toFixed(4)} $ dépensés aujourd’hui, sans plafond quotidien\n${lignesPlafonds}`);
    } else if (jour >= plafonds.daily.usd) {
      note('budget', 'BLOCKED', `plafond quotidien atteint : ${jour.toFixed(4)} $ / ${plafonds.daily.usd.toFixed(2)} $\n${lignesPlafonds}`);
    } else {
      note('budget', 'READY', `${jour.toFixed(4)} $ / ${plafonds.daily.usd.toFixed(2)} $ dépensés aujourd’hui\n${lignesPlafonds}`);
    }
  } catch (err) {
    note('budget', 'BLOCKED', err instanceof Error ? err.message : String(err));
  }

  // ── Sortie ──────────────────────────────────────────────────────────────
  try {
    accessSync('out', constants.W_OK);
    note('dossier de sortie', 'READY', 'out/ accessible en écriture');
  } catch {
    note('dossier de sortie', 'BLOCKED', 'out/ inaccessible en écriture');
  }

  // ── Aucune campagne email active ────────────────────────────────────────
  const approuves = repos.salesLoop.draftsInState('APPROVED').length;
  note('campagne email', approuves === 0 ? 'READY' : 'DEGRADED', approuves === 0 ? 'aucun brouillon approuvé en attente d’envoi' : `${approuves} brouillon(s) approuvé(s) en attente — une mission client ne les touche pas`);

  // ── Gmail : sans objet pour la mission ──────────────────────────────────
  note('gmail', 'NOT_REQUIRED', 'la livraison au client est un geste humain');

  // ── Verdict ─────────────────────────────────────────────────────────────
  console.log(`\n${c.bold}  CLIENT PREFLIGHT${c.reset}  ${c.dim}${new Date().toISOString()}${c.reset}\n`);
  for (const l of lignes) {
    const couleur = l.etat === 'READY' ? c.green : l.etat === 'DEGRADED' ? c.amber : l.etat === 'BLOCKED' ? c.red : c.dim;
    // Un détail sur plusieurs lignes s'aligne sous la première.
    console.log(`  ${couleur}${l.etat.padEnd(13)}${c.reset}${l.nom.padEnd(20)}${c.dim}${l.detail.split('\n').join(`\n${' '.repeat(35)}`)}${c.reset}`);
  }
  const bloque = lignes.filter((l) => l.etat === 'BLOCKED');
  const recherche = lignes.find((l) => l.nom === 'recherche');
  console.log();
  if (bloque.length > 0) {
    console.log(`  ${c.red}${c.bold}NO-GO${c.reset} — ${bloque.map((l) => l.nom).join(', ')}`);
    if (recherche?.etat === 'BLOCKED') console.log(`  ${c.dim}Aucun moteur réel ne rend de résultat : la mission ne peut pas partir. Aucun modèle ne remplace une recherche.${c.reset}`);
    process.exitCode = 1;
  } else {
    const degrade = lignes.filter((l) => l.etat === 'DEGRADED');
    console.log(`  ${c.green}${c.bold}GO${c.reset}${degrade.length ? ` ${c.amber}(dégradé : ${degrade.map((l) => l.nom).join(', ')})${c.reset}` : ''}`);
  }
  console.log();
  await system.shutdown('preflight terminé');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
