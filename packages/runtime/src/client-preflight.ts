import type { Repositories } from '@atlas/data';
import type { Logger } from '@atlas/core';
import type { LlmProvider } from '@atlas/llm';
import {
  planQueries, probeSearchProviders, classifySearchReadiness,
  type SearchReadiness, type ProviderProbe, SearchProviderRegistry,
} from '@atlas/intelligence';
import type { ClientBrief } from '@atlas/departments';
import { startOfUtcDay, clientBudgetLimits, describeClientBudgetLimits, type ClientBudgetLimits } from './client-mission.ts';

/**
 * Ce qu'il faut vérifier AVANT de lancer une mission client — et refuser si
 * ça manque. Une seule fonction, deux appelants : la commande `client:preflight`
 * qui l'affiche, et le pilote automatique qui s'y soumet. Le pilote ne peut
 * pas contourner un NO-GO : il n'a pas d'autre porte.
 *
 * Aucune écriture. Aucun appel modèle sans `probeLlm`.
 */
export type PreflightState = 'READY' | 'DEGRADED' | 'BLOCKED' | 'NOT_REQUIRED';

export interface PreflightLine { nom: string; etat: PreflightState; detail: string }

export interface PreflightVerdict {
  verdict: 'GO' | 'NO-GO';
  lines: PreflightLine[];
  blocked: string[];
  degraded: string[];
  readiness: SearchReadiness | null;
  probes: ProviderProbe[];
  budget: ClientBudgetLimits;
  sampleQueries: string[];
}

export interface PreflightDeps {
  repos: Repositories;
  logger: Logger;
  config: {
    search: { fallbackEnabled: boolean };
    llm: { mode: string; agentModel: string };
    ai: { dailyBudgetUsd: number; dailyBudgetMode: 'UNLIMITED' | 'CONFIGURED' | 'DISABLED' };
    paths: { databaseFile: string };
  };
  /** Le registre des moteurs, ou `null` si aucun n'est configuré. */
  registry: SearchProviderRegistry | null;
  /** Le fournisseur de modèle, pour la sonde payante. */
  provider: Pick<LlmProvider, 'complete'>;
  hasApiKey: boolean;
  outputWritable: boolean;
  now?: () => Date;
}

export interface PreflightInput {
  brief: ClientBrief | null;
  briefError?: string | null;
  probeLlm?: boolean;
  budgetArgs?: { budget?: string | undefined; batchBudget?: string | undefined };
}

export async function runClientPreflight(deps: PreflightDeps, input: PreflightInput): Promise<PreflightVerdict> {
  const lines: PreflightLine[] = [];
  const note = (nom: string, etat: PreflightState, detail: string) => lines.push({ nom, etat, detail });
  const now = deps.now ?? (() => new Date());
  const { repos, config } = deps;

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
  } else if (config.llm.mode !== 'live' && !input.brief?.client.internalTest) {
    note('mode', 'BLOCKED', `mode « ${config.llm.mode} » : une mission client exige le mode live`);
  } else {
    note('mode', 'READY', `${config.llm.mode} · aucun repli recherche-par-modèle`);
  }

  // ── Brief ───────────────────────────────────────────────────────────────
  const brief = input.brief;
  if (!brief) {
    note('brief', 'BLOCKED', input.briefError ?? 'aucun brief : --brief=briefs/<client>.json');
  } else {
    note('brief', 'READY', `${brief.client.name} · ${brief.market.countryLabel} · ${brief.requiredCriteria.length} critère(s) requis, ${brief.preferredCriteria.length} souhaité(s), ${brief.competitorExclusions.length} concurrent(s)${brief.client.internalTest ? ' · INTERNAL_TEST' : ''}`);
  }

  // ── Marché ──────────────────────────────────────────────────────────────
  let premiere: string | null = null;
  let country = 'SE';
  let language = 'sv';
  const sampleQueries: string[] = [];
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
      country = plan[0]!.country;
      language = plan[0]!.language ?? 'sv';
      sampleQueries.push(...plan.map((q) => q.query));
      note('marché', 'READY', `${plan[0]!.country} / ${plan[0]!.language} · ex. « ${sampleQueries.join(' » · « ')} »`);
    }
  }

  // ── Recherche : chaque moteur, pour de vrai ─────────────────────────────
  let readiness: SearchReadiness | null = null;
  let probes: ProviderProbe[] = [];
  if (!deps.registry) {
    note('recherche', 'BLOCKED', 'aucun moteur configuré (ATLAS_SEARCH_PROVIDER)');
  } else {
    probes = await probeSearchProviders(
      deps.registry,
      { query: premiere ?? 'distributör förpackningsmaskiner Sverige', count: 5, country, language },
      { countries: [country], languages: [language], commercial: true },
      { logger: deps.logger, timeoutMs: 20_000 },
    );
    const r = classifySearchReadiness(probes);
    readiness = r.readiness;
    const etat: PreflightState = r.readiness === 'SEARCH_READY' ? 'READY' : r.readiness === 'SEARCH_DEGRADED' ? 'DEGRADED' : 'BLOCKED';
    note('recherche', etat, `${r.readiness} — ${r.summary}`);
  }

  // ── Modèle ──────────────────────────────────────────────────────────────
  if (!deps.hasApiKey) note('modèle', 'BLOCKED', 'ANTHROPIC_API_KEY absente');
  else if (input.probeLlm) {
    try {
      const t0 = Date.now();
      await deps.provider.complete({
        model: config.llm.agentModel, system: 'Répondez par le seul mot OK.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'OK ?' }] }], maxTokens: 5,
        meta: { purpose: 'client-preflight', missionId: null, taskRef: 'preflight', agentKey: 'preflight', subject: 'probe', evidenceCount: null },
      });
      note('modèle', 'READY', `${config.llm.agentModel} répond en ${Date.now() - t0} ms`);
    } catch (err) {
      note('modèle', 'BLOCKED', err instanceof Error ? err.message.slice(0, 120) : String(err));
    }
  } else {
    const dernier = repos.llmCalls.usageSince(startOfUtcDay(new Date(now().getTime() - 7 * 86_400_000).toISOString()));
    note('modèle', dernier.calls > 0 ? 'READY' : 'DEGRADED', `clé présente · ${config.llm.agentModel} · ${dernier.calls} appel(s) sur 7 jours (non sondé : --probe-llm pour un appel réel)`);
  }

  // ── Budget : les plafonds que `batch` appliquera ────────────────────────
  const jour = repos.llmCalls.usageSince(startOfUtcDay(now().toISOString())).knownCostUsd;
  let budget: ClientBudgetLimits;
  try {
    budget = clientBudgetLimits(config.ai, input.budgetArgs ?? {});
    const lignesPlafonds = describeClientBudgetLimits(budget).join('\n');
    if (!budget.daily.configured) {
      note('budget', 'DEGRADED', `${jour.toFixed(4)} $ dépensés aujourd’hui, sans plafond quotidien\n${lignesPlafonds}`);
    } else if (jour >= budget.daily.usd) {
      note('budget', 'BLOCKED', `plafond quotidien atteint : ${jour.toFixed(4)} $ / ${budget.daily.usd.toFixed(2)} $\n${lignesPlafonds}`);
    } else {
      note('budget', 'READY', `${jour.toFixed(4)} $ / ${budget.daily.usd.toFixed(2)} $ dépensés aujourd’hui\n${lignesPlafonds}`);
    }
  } catch (err) {
    budget = clientBudgetLimits(config.ai, {});
    note('budget', 'BLOCKED', err instanceof Error ? err.message : String(err));
  }

  // ── Sortie ──────────────────────────────────────────────────────────────
  note('dossier de sortie', deps.outputWritable ? 'READY' : 'BLOCKED', deps.outputWritable ? 'out/ accessible en écriture' : 'out/ inaccessible en écriture');

  // ── Aucune campagne email active ────────────────────────────────────────
  const approuves = repos.salesLoop.draftsInState('APPROVED').length;
  note('campagne email', approuves === 0 ? 'READY' : 'DEGRADED', approuves === 0 ? 'aucun brouillon approuvé en attente d’envoi' : `${approuves} brouillon(s) approuvé(s) en attente — une mission client ne les touche pas`);

  // ── Gmail : sans objet pour la mission ──────────────────────────────────
  note('gmail', 'NOT_REQUIRED', 'la livraison au client est un geste humain');

  const blocked = lines.filter((l) => l.etat === 'BLOCKED').map((l) => l.nom);
  const degraded = lines.filter((l) => l.etat === 'DEGRADED').map((l) => l.nom);
  return { verdict: blocked.length > 0 ? 'NO-GO' : 'GO', lines, blocked, degraded, readiness, probes, budget, sampleQueries };
}
