import type { AtlasConfig } from '@atlas/core';
import { describeError, withDeadline } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import {
  assessSuitability,
  OPEN_NEED,
  SearchFabric,
  type MissionSearchNeed,
  type ProviderStatus,
  type SearchProvider,
  type SuitabilityReport,
} from '@atlas/intelligence';

/**
 * Le contrôle avant décollage.
 *
 * ATLAS a lancé cinq missions réelles qui ont toutes échoué, pour 10,94 $ au
 * total et zéro candidat. Aucune n'a échoué pour une raison qu'on ne pouvait pas
 * connaître à l'avance : schéma incompatible, délai mal ordonné, moteur de
 * recherche injoignable. À chaque fois le blocage a été découvert *pendant* la
 * mission, donc après avoir payé.
 *
 * Ce module retourne la charge de la preuve. Rien ne part tant que chaque
 * condition n'est pas vérifiée — et vérifiée réellement : le moteur de recherche
 * est interrogé, pas seulement lu dans la configuration. Un moteur « configuré »
 * et injoignable est précisément ce qui a coûté LIVE #005.
 *
 * Le rapport est lisible par un humain. Un contrôle qui échoue doit dire quoi
 * faire, pas seulement que quelque chose ne va pas.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface PreflightCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Une remarque bloque le décollage ; un avertissement ne fait que prévenir. */
  blocking: boolean;
  /** Ce qu'il faut faire, quand il y a quelque chose à faire. */
  remedy?: string;
}

/**
 * L'état du parc de moteurs au moment du contrôle.
 *
 * Assemblé sans rien appeler : les statuts viennent des exécutions passées, et
 * l'ordre vient du routeur. Sonder chaque moteur pour remplir cet objet
 * enverrait, à chaque affichage du cockpit, exactement le trafic qui a fait
 * brider DuckDuckGo.
 */
export interface FabricReport {
  providers: ProviderStatus[];
  /** Les moteurs retenus, dans l'ordre où ils seraient essayés. */
  order: string[];
  /** Ceux qui ne le sont pas, et pourquoi. */
  excluded: Array<{ id: string; reason: string }>;
  blocked: boolean;
  blockedReason: string | null;
}

export interface PreflightReport {
  mode: 'simulation' | 'live';
  declaredMode: 'auto' | 'simulation' | 'live';
  /** Vrai lorsque aucun contrôle bloquant n'a échoué. */
  cleared: boolean;
  checks: PreflightCheck[];
  /** Le plafond que la mission ne pourra pas dépasser, en dollars. */
  budgetUsd: number;
  /** Le moteur réellement interrogé, et ce qu'il a répondu. */
  searchProvider: string | null;
  /** Le moteur répond-il ? Mesuré en l'appelant. */
  searchHealth: 'healthy' | 'unhealthy' | 'unknown';
  /** Peut-il répondre à *cette* mission ? Déduit, sans appel. */
  searchSuitability: SuitabilityReport | null;
  /**
   * Le parc, quand le déploiement en pilote un.
   *
   * `null` lorsqu'un moteur unique est câblé — ce qui reste possible, et reste
   * un point de défaillance unique assumé.
   */
  fabric: FabricReport | null;
  generatedAt: string;
}

export interface PreflightInput {
  config: AtlasConfig;
  repos: Repositories;
  /** Le moteur de recherche du déploiement, ou `null` s'il n'y en a pas. */
  search: SearchProvider | null;
  /** Plafond de la mission visée, s'il diffère de celui du déploiement. */
  missionBudgetUsd?: number;
  /**
   * Ce que la mission attend du moteur.
   *
   * Fourni, il déclenche le contrôle d'adéquation — celui qui manquait. Omis,
   * seule la santé est vérifiée, ce qui suffit pour un contrôle général mais
   * pas avant une mission réelle.
   */
  need?: MissionSearchNeed;
  /** Interroger réellement le moteur. Coupé dans les tests unitaires. */
  probeSearch?: boolean;
  /**
   * Interroger réellement l'API du modèle.
   *
   * Coûte un jeton de sortie. Coupé dans les tests, actif avant toute mission
   * réelle : une clé valide de forme et un compte sans solde se ressemblent
   * exactement, jusqu'à la première étape.
   */
  probeInference?: boolean;
  probeTimeoutMs?: number;
  logger: { child(bindings: Record<string, unknown>): unknown };
}

/**
 * L'API du modèle répond-elle vraiment ?
 *
 * Un appel minimal — un jeton de sortie — qui vérifie en une fois ce que la
 * lecture de la configuration ne peut pas vérifier : que la clé est acceptée,
 * que le compte a du solde, et que le service est joignable.
 *
 * Le diagnostic distingue les causes, parce qu'elles appellent des gestes
 * différents. Un solde épuisé se recharge, une clé révoquée se remplace, un
 * réseau coupé s'attend. « L'API ne répond pas » ne dit lequel des trois, et
 * c'est la phrase qui fait chercher au mauvais endroit.
 */
async function probeInference(
  config: AtlasConfig,
  timeoutMs: number,
): Promise<{ ok: boolean; durationMs: number; detail: string; remedy: string }> {
  const started = Date.now();

  try {
    const response = await withDeadline(
      (signal) =>
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': config.llm.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: config.llm.agentModel,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ok' }],
          }),
        }),
      { ms: timeoutMs, label: "sonde d'inférence" },
    );

    const durationMs = Date.now() - started;
    if (response.ok) return { ok: true, durationMs, detail: 'ok', remedy: '' };

    // Le corps porte la cause réelle. La clé n'y figure jamais : on ne recopie
    // que le message du fournisseur.
    const body = (await response.text().catch(() => '')).slice(0, 400);
    const lower = body.toLowerCase();

    if (lower.includes('credit balance') || lower.includes('insufficient')) {
      return {
        ok: false,
        durationMs,
        detail: 'solde du compte Anthropic épuisé — aucun appel ne peut aboutir.',
        remedy:
          'Rechargez le compte sur console.anthropic.com (Plans & Billing), ou passez ' +
          'ATLAS_EXECUTION_MODE=simulation pour travailler sans dépense.',
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        durationMs,
        detail: `clé refusée (HTTP ${response.status}).`,
        remedy: 'Vérifiez ANTHROPIC_API_KEY — la clé est peut-être révoquée ou mal copiée.',
      };
    }
    if (response.status === 429) {
      return {
        ok: false,
        durationMs,
        detail: 'quota atteint (HTTP 429).',
        remedy: 'Attendez la fin de la fenêtre de limitation, ou relevez le quota du compte.',
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        durationMs,
        detail: `modèle « ${config.llm.agentModel} » inconnu du fournisseur.`,
        remedy: 'Corrigez ATLAS_AGENT_MODEL : ce nom de modèle n’existe pas.',
      };
    }
    return {
      ok: false,
      durationMs,
      detail: `HTTP ${response.status} — ${body.slice(0, 160)}`,
      remedy: 'Consultez le statut du fournisseur avant de relancer.',
    };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      detail: `injoignable : ${describeError(err)}`,
      remedy: 'Vérifiez la connectivité réseau, puis relancez le contrôle.',
    };
  }
}

const pass = (name: string, detail: string): PreflightCheck => ({
  name,
  status: 'pass',
  detail,
  blocking: false,
});

const fail = (name: string, detail: string, remedy: string): PreflightCheck => ({
  name,
  status: 'fail',
  detail,
  blocking: true,
  remedy,
});

const warn = (name: string, detail: string, remedy?: string): PreflightCheck => ({
  name,
  status: 'warn',
  detail,
  blocking: false,
  ...(remedy ? { remedy } : {}),
});

export async function preflight(input: PreflightInput): Promise<PreflightReport> {
  const { config, repos, search } = input;
  const checks: PreflightCheck[] = [];
  const mode = config.llm.mode;
  const budgetUsd = input.missionBudgetUsd ?? config.budget.maxMissionCostUsd;

  // ── Mode ────────────────────────────────────────────────────────────────
  if (config.llm.declaredMode === 'auto') {
    checks.push(
      warn(
        'mode',
        `Mode déduit de la configuration : ${mode}. Rien ne l'a déclaré explicitement.`,
        "Posez ATLAS_EXECUTION_MODE=live ou =simulation pour lever toute ambiguïté.",
      ),
    );
  } else {
    checks.push(pass('mode', `Mode déclaré explicitement : ${config.llm.declaredMode}.`));
  }

  // ── Inférence ───────────────────────────────────────────────────────────
  if (mode === 'live') {
    if (!config.llm.apiKey) {
      checks.push(
        fail(
          'inférence',
          "Mode réel demandé sans clé Anthropic : aucun appel ne pourrait aboutir.",
          'Renseignez ANTHROPIC_API_KEY, ou passez ATLAS_EXECUTION_MODE=simulation.',
        ),
      );
    } else if (input.probeInference === false) {
      checks.push(warn('inférence', `Clé présente, non vérifiée · agents ${config.llm.agentModel}.`));
    } else {
      // ── L'inférence est interrogée, pas seulement lue ────────────────────
      //
      // Le contrôle disait « API Anthropic configurée » et VAL-001 est morte à
      // la première étape : le solde du compte était épuisé. La clé existait,
      // elle était valide de forme, et aucun appel ne pouvait aboutir.
      //
      // C'est exactement la leçon de LIVE #005 — « configuré » n'a jamais
      // empêché « injoignable » — appliquée au moteur de recherche mais jamais
      // à l'inférence. Le moteur était sondé pour de vrai ; le fournisseur du
      // modèle était cru sur parole, alors que c'est lui qui porte toute la
      // dépense.
      //
      // La sonde coûte un jeton de sortie, soit une fraction de centime. C'est
      // le prix de ne pas découvrir le problème après avoir lancé la mission.
      const probe = await probeInference(config, input.probeTimeoutMs ?? 15_000);

      if (probe.ok) {
        checks.push(
          pass('inférence', `API Anthropic répond en ${probe.durationMs} ms · agents ${config.llm.agentModel}.`),
        );
      } else {
        checks.push(
          fail(
            'inférence',
            `L'API Anthropic n'aboutit pas : ${probe.detail}`,
            probe.remedy,
          ),
        );
      }
    }
  } else {
    checks.push(pass('inférence', 'Mode simulation : aucun appel facturable ne partira.'));
  }

  // ── Politique de modèle ─────────────────────────────────────────────────
  // Le garde-fou qui empêche un modèle coûteux de servir à de l'extraction.
  //
  // Les deux listes tolèrent l'absence. Une liste manquante veut dire « aucune
  // restriction déclarée », ce que la branche d'avertissement rapporte déjà ;
  // la lire sans précaution ferait lever le preflight lui-même, et un contrôle
  // avant décollage qui plante ne rapporte rien du tout — c'est le seul mode de
  // défaillance qu'il n'a pas le droit d'avoir.
  const forbidden = config.llm.forbiddenModels ?? [];
  const inUse = [config.llm.agentModel, config.llm.hermesModel];
  const violations = inUse.filter((model) =>
    forbidden.some((banned) => model.toLowerCase().includes(banned.toLowerCase())),
  );

  const allowed = config.llm.allowedModels ?? [];
  const outsideAllowList =
    allowed.length > 0
      ? inUse.filter((model) => !allowed.some((ok) => model.toLowerCase().startsWith(ok.toLowerCase())))
      : [];

  if (forbidden.length === 0 && allowed.length === 0) {
    checks.push(
      warn(
        'modèles',
        "Aucune restriction : le modèle le plus cher reste appelable.",
        'Posez ATLAS_FORBIDDEN_MODELS=claude-opus au minimum.',
      ),
    );
  } else if (outsideAllowList.length > 0) {
    checks.push(
      fail(
        'modèles',
        `Modèle hors liste blanche : ${outsideAllowList.join(', ')}.`,
        `Autorisés : ${allowed.join(', ')}. Ajoutez-le, ou changez le modèle en service.`,
      ),
    );
  } else if (violations.length > 0) {
    checks.push(
      fail(
        'modèles',
        `Modèle interdit en service : ${violations.join(', ')}.`,
        `Changez ATLAS_AGENT_MODEL / ATLAS_HERMES_MODEL, ou retirez-le de ATLAS_FORBIDDEN_MODELS.`,
      ),
    );
  } else {
    // Le libellé nomme ce qui est interdit plutôt que d'en donner le nombre :
    // « 1 modèle interdit » n'apprend rien, « Opus interdit » se vérifie d'un
    // coup d'œil avant un lancement réel.
    const parts: string[] = [];
    if (forbidden.length > 0) parts.push(`${forbidden.join(', ')} interdit(s)`);
    if (allowed.length > 0) parts.push(`${allowed.join(', ')} seul(s) autorisé(s)`);
    parts.push(`en service : ${[...new Set(inUse)].join(', ')}`);

    checks.push(pass('modèles', parts.join(' · ')));
  }

  // ── Budget ──────────────────────────────────────────────────────────────
  if (mode === 'live' && (!Number.isFinite(budgetUsd) || budgetUsd <= 0)) {
    checks.push(
      fail(
        'budget',
        "Aucun plafond de dépense défini pour une mission réelle.",
        'Renseignez ATLAS_MAX_MISSION_COST_USD, ou passez un plafond à la mission.',
      ),
    );
  } else {
    checks.push(
      pass(
        'budget',
        `Plafond de mission : ${budgetUsd.toFixed(2)} $ · ${config.budget.maxCallsPerStep} appel(s) par étape · ` +
          `${config.budget.maxOutputTokensPerCall.toLocaleString('fr-FR')} jetons de sortie par appel.`,
      ),
    );
  }

  // ── Délais ──────────────────────────────────────────────────────────────
  const { providerTimeoutMs, toolTimeoutMs, taskTimeoutMs } = config.orchestration;
  const ordered = providerTimeoutMs < toolTimeoutMs && toolTimeoutMs < taskTimeoutMs;
  checks.push(
    ordered
      ? pass(
          'délais',
          `Hiérarchie respectée : fournisseur ${providerTimeoutMs} < outil ${toolTimeoutMs} < étape ${taskTimeoutMs} ms.`,
        )
      : fail(
          'délais',
          `Hiérarchie inversée : fournisseur ${providerTimeoutMs}, outil ${toolTimeoutMs}, étape ${taskTimeoutMs} ms.`,
          "Chaque niveau doit être strictement supérieur à celui qu'il contient.",
        ),
  );

  // ── Base de données ─────────────────────────────────────────────────────
  try {
    repos.db.prepare('SELECT 1').get();
    checks.push(pass('base', 'SQLite répond.'));
  } catch (err) {
    checks.push(
      fail(
        'base',
        `SQLite indisponible : ${err instanceof Error ? err.message : String(err)}`,
        "Vérifiez ATLAS_DATA_DIR et les droits d'écriture.",
      ),
    );
  }

  // ── Moteur de recherche ─────────────────────────────────────────────────
  // Le contrôle qui manquait. « Configuré » ne veut rien dire : on interroge.
  let searchHealth: 'healthy' | 'unhealthy' | 'unknown' = 'unknown';
  let fabricReport: FabricReport | null = null;
  let suitabilityFromFabric: SuitabilityReport | null = null;

  if (search instanceof SearchFabric) {
    // La question a changé, et c'est tout l'objet du Search Fabric.
    //
    // Avant : « DuckDuckGo répond-il ? » — une question à laquelle un seul
    // moteur pouvait répondre non, bloquant tout. ATLAS a passé deux jours à
    // attendre ce non-là.
    //
    // Maintenant : « existe-t-il au moins un moteur sain ET adapté ? » Une
    // mission n'est bloquée que lorsque le parc entier l'est.
    const need = input.need ?? OPEN_NEED;
    const plan = search.plan(need);

    fabricReport = {
      providers: search.statuses(),
      order: plan.order.map((c) => c.record.id),
      excluded: plan.considered
        .filter((c) => c.excluded !== null)
        .map((c) => ({ id: c.record.id, reason: c.excluded ?? '' })),
      blocked: plan.blocked,
      blockedReason: plan.blockedReason,
    };

    if (plan.blocked) {
      searchHealth = 'unhealthy';
      checks.push(
        mode === 'live'
          ? fail(
              'search fabric',
              `BLOCKED-BY-SEARCH-FABRIC — ${plan.blockedReason}`,
              'Attendez la fin du refroidissement, configurez une instance SearXNG (SEARXNG_BASE_URL), ' +
                'ou visez un marché que le parc couvre.',
            )
          : warn('search fabric', `Aucun moteur utilisable ; sans effet en simulation.`),
      );
    } else {
      const first = plan.order[0]!;
      suitabilityFromFabric = first.suitability;

      // La santé du parc est celle du premier moteur retenu — pas une moyenne.
      // C'est lui qui répondra ; les suivants ne servent qu'en cas de bascule,
      // et leur état ne dit rien de ce qui va se passer.
      searchHealth = first.health;

      const chain = plan.order.map((c) => c.record.id).join(' → ');
      const skipped = fabricReport.excluded.length;
      checks.push(
        pass(
          'search fabric',
          `${plan.order.length} moteur(s) adaptés : ${chain}` +
            (skipped > 0 ? ` · ${skipped} écarté(s)` : '') +
            `. Une bascule est automatique si le premier échoue.`,
        ),
      );

      // Un parc d'un seul moteur reste un point de défaillance unique. Le
      // signaler ne bloque pas — c'est une configuration légitime — mais le
      // taire reviendrait à laisser croire que la bascule protège quand elle
      // n'a nulle part où basculer.
      if (plan.order.length === 1) {
        checks.push(
          warn(
            'redondance',
            `Un seul moteur utilisable (${chain}) : aucune bascule possible s'il échoue.`,
            'Posez ATLAS_SEARCH_PROVIDER=auto et configurez SEARXNG_BASE_URL pour un second moteur.',
          ),
        );
      }
    }
  } else if (!search) {
    checks.push(
      mode === 'live'
        ? fail(
            'recherche',
            "Aucun moteur de recherche : une mission réelle n'aurait aucune source.",
            'Posez ATLAS_SEARCH_PROVIDER=duckduckgo, ou searxng si une instance tourne.',
          )
        : warn('recherche', 'Aucun moteur configuré ; sans effet en simulation.'),
    );
  } else if (input.probeSearch === false) {
    checks.push(warn('recherche', `${search.label} configuré, non interrogé.`));
  } else {
    const availability = search.availability();
    if (!availability.available) {
      searchHealth = 'unhealthy';
      checks.push(fail('recherche', availability.reason, 'Corrigez la configuration du moteur.'));
    } else {
      const probe = await search.search(
        // Une requête volontairement banale et courte : on teste le tuyau, pas
        // le marché.
        { query: 'test', count: 3 },
        {
          logger: input.logger as never,
          timeoutMs: Math.min(config.search.timeoutMs, 10_000),
        },
      );

      searchHealth = probe.outcome === 'ok' ? 'healthy' : 'unhealthy';

      if (probe.outcome === 'ok') {
        checks.push(
          pass(
            'recherche',
            `${search.label} · ${probe.results.length} résultat(s) en ${probe.durationMs} ms · ` +
              `${probe.costUsd.toFixed(2)} $.`,
          ),
        );
      } else {
        checks.push(
          fail(
            'recherche',
            `${search.label} ne répond pas correctement : ${probe.outcome} — ${probe.detail}`,
            "Une mission réelle sans moteur ne produirait aucun candidat, au prix d'une mission complète.",
          ),
        );
      }
    }
  }

  // ── Adéquation ──────────────────────────────────────────────────────────
  // Le contrôle qui manquait, et qui a coûté deux missions. Un moteur peut
  // répondre parfaitement et ne rien savoir du marché visé : « aucun
  // distributeur allemand » et « ce moteur ne couvre pas l'allemand » sont deux
  // constats opposés que rien ne distinguait.
  // Le Fabric a déjà tranché l'adéquation en choisissant : la reposer ici
  // interrogerait le Fabric lui-même, dont les capacités ne sont celles
  // d'aucun moteur réel.
  let suitability: SuitabilityReport | null = suitabilityFromFabric;
  if (search && !(search instanceof SearchFabric) && input.need) {
    suitability = assessSuitability(search, input.need);
    checks.push(
      suitability.verdict === 'suitable'
        ? pass('adéquation', suitability.detail)
        : suitability.verdict === 'degraded'
          ? warn(
              'adéquation',
              suitability.detail,
              "Les résultats seront partiels ; ne pas lire un résultat maigre comme un marché vide.",
            )
          : fail(
              'adéquation',
              suitability.detail,
              'Choisissez un moteur qui couvre ce marché, ou changez le marché visé. ' +
                "Lancer malgré tout dépenserait pour un index qui ne contient pas la réponse.",
            ),
    );
  }

  const cleared = !checks.some((check) => check.blocking && check.status === 'fail');

  return {
    mode,
    declaredMode: config.llm.declaredMode,
    cleared,
    checks,
    budgetUsd,
    searchProvider: search?.key ?? null,
    searchHealth,
    searchSuitability: suitability,
    fabric: fabricReport,
    generatedAt: new Date().toISOString(),
  };
}

/** Le rapport, mis en forme pour un terminal. */
export function formatPreflight(report: PreflightReport): string {
  const lines: string[] = [];
  const mark = (status: CheckStatus): string =>
    status === 'pass' ? '✓' : status === 'warn' ? '!' : '✗';

  lines.push(`Contrôle avant décollage — mode ${report.mode.toUpperCase()}`);
  lines.push(`Plafond : ${report.budgetUsd.toFixed(2)} $`);
  lines.push('');

  for (const check of report.checks) {
    lines.push(`  ${mark(check.status)} ${check.name.padEnd(12)} ${check.detail}`);
    if (check.remedy && check.status !== 'pass') lines.push(`                 → ${check.remedy}`);
  }

  lines.push('');
  lines.push(
    report.cleared
      ? 'Décollage autorisé.'
      : 'DÉCOLLAGE REFUSÉ — au moins un contrôle bloquant a échoué.',
  );
  return lines.join('\n');
}
