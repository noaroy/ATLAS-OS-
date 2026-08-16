import type { Repositories } from '@atlas/data';
import type { MissionId } from '@atlas/contracts';

/**
 * Le rapport d'une mission, assemblé à partir de ce qui a réellement été
 * enregistré.
 *
 * Une règle gouverne tout ce fichier : **rien n'est calculé à partir de rien.**
 * Un champ qui n'a pas de mesure vaut `null`, jamais `0`. La différence n'est
 * pas cosmétique — « zéro candidat trouvé » et « la recherche n'a jamais tourné »
 * mènent à des décisions opposées, et les cinq missions réelles qui ont échoué
 * rapportaient les deux de la même façon. On lisait « 0 candidat » et on
 * cherchait pourquoi le marché était vide, alors que le moteur n'avait pas
 * répondu une seule fois.
 *
 * Aucun de ces chiffres n'est demandé au modèle. Ils sont lus en base, dans les
 * tables que les appels ont écrites en passant : un rapport qu'on interroge un
 * modèle pour produire est un rapport qui peut être flatté.
 */

/** Une mesure, ou l'aveu qu'elle n'existe pas. */
export type Measured<T> = { measured: true; value: T } | { measured: false; reason: string };

const measured = <T>(value: T): Measured<T> => ({ measured: true, value });
const unmeasured = <T>(reason: string): Measured<T> => ({ measured: false, reason });

export interface MissionReport {
  missionId: string;
  code: string | null;
  title: string;
  status: string;
  mode: 'simulation' | 'live' | 'unknown';
  startedAt: string | null;
  endedAt: string | null;
  durationMs: Measured<number>;

  /** Ce que la mission a coûté. Zéro dépense et aucune dépense se distinguent. */
  economics: {
    costUsd: Measured<number>;
    budgetUsd: number | null;
    budgetUsedRatio: Measured<number>;
    llmCalls: Measured<number>;
    failedLlmCalls: Measured<number>;
    inputTokens: Measured<number>;
    outputTokens: Measured<number>;
    cacheReadTokens: Measured<number>;
    byModel: Measured<Array<{ model: string; calls: number; costUsd: number; tokens: number }>>;
  };

  /** Ce que la mission a fait dehors. */
  external: {
    toolCalls: Measured<number>;
    externalCalls: Measured<number>;
    byTool: Measured<Array<{ tool: string; calls: number; failures: number }>>;
  };

  /** Ce que la mission a produit. */
  results: {
    funnel: Measured<Record<string, number>>;
    candidates: Measured<number>;
    qualified: Measured<number>;
    shortlisted: Measured<number>;
    approved: Measured<number>;
    evidenceCount: Measured<number>;
    /** Combien de candidats ne portent aucune preuve sourcée. Doit valoir 0. */
    unsourcedCandidates: Measured<number>;
  };

  /** Ce que la mission a décidé, et sur quoi. */
  reasoning: {
    decisions: Measured<number>;
    /** Décisions structurantes rendues sans preuve à l'appui. Doit valoir 0. */
    unsupportedClaims: Measured<number>;
    byKind: Measured<Record<string, number>>;
  };

  /** Les réserves à lire avant de conclure quoi que ce soit de ce rapport. */
  caveats: string[];
  generatedAt: string;
}

export function buildMissionReport(repos: Repositories, missionId: MissionId): MissionReport | null {
  const mission = repos.missions.get(missionId);
  if (!mission) return null;

  const caveats: string[] = [];

  // ── Économie ────────────────────────────────────────────────────────────
  // `hasCalls` est la question qui décide : sans un seul appel enregistré,
  // tous les totaux valent zéro et ce zéro ne veut rien dire.
  const ranAnyCall = repos.llmCalls.hasCalls(missionId);
  const totals = ranAnyCall ? repos.llmCalls.totals(missionId) : null;

  if (!ranAnyCall) {
    caveats.push(
      "Aucun appel au modèle n'a été enregistré : les totaux économiques sont inconnus, pas nuls.",
    );
  }

  const context = (mission.context ?? {}) as Record<string, unknown>;
  const budgetUsd = typeof context.budgetUsd === 'number' ? context.budgetUsd : null;
  const declaredMode = context.executionMode;
  const mode: MissionReport['mode'] =
    declaredMode === 'live' || declaredMode === 'simulation' ? declaredMode : 'unknown';

  if (mode === 'unknown') {
    caveats.push(
      "Le mode d'exécution n'a pas été déclaré dans le contexte : impossible de dire si cette " +
        'mission a réellement appelé le modèle ou tourné en simulation.',
    );
  }

  // ── Outils ──────────────────────────────────────────────────────────────
  const toolUsage = repos.toolCalls.byTool(missionId);
  const ranAnyTool = toolUsage.length > 0;

  if (!ranAnyTool) {
    caveats.push(
      "Aucun outil n'a été appelé : la mission n'est jamais sortie de la machine, quelle que " +
        "soit la conclusion qu'elle rend.",
    );
  }

  // ── Résultats ───────────────────────────────────────────────────────────
  const opportunities = repos.opportunities.forMission(missionId);
  const evidenceCount = repos.companies.countEvidenceForMission(missionId);

  // Un candidat sans preuve sourcée est le défaut le plus grave que ce rapport
  // puisse révéler : il est plausible, nommé, et rien ne l'atteste.
  const unsourced = opportunities.filter(
    (opp) => repos.companies.evidenceForOpportunity(opp.id).length === 0,
  ).length;

  if (unsourced > 0) {
    caveats.push(
      `${unsourced} candidat(s) ne portent aucune preuve : ils ne doivent pas être présentés ` +
        `comme un résultat.`,
    );
  }

  // ── Décisions ───────────────────────────────────────────────────────────
  const decisions = repos.decisions.forMission(missionId);
  const unsupported = repos.decisions.unsupportedClaims(missionId);

  if (unsupported.length > 0) {
    caveats.push(
      `${unsupported.length} décision(s) structurante(s) rendue(s) sans preuve à l'appui.`,
    );
  }

  const byKind: Record<string, number> = {};
  for (const d of decisions) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;

  const startedAt = mission.startedAt ?? null;
  const endedAt = mission.finishedAt ?? null;

  return {
    missionId,
    code: mission.code,
    title: mission.title,
    status: mission.status,
    mode,
    startedAt,
    endedAt,
    durationMs:
      startedAt && endedAt
        ? measured(new Date(endedAt).getTime() - new Date(startedAt).getTime())
        : unmeasured("la mission n'a pas d'horodatage de fin"),

    economics: {
      costUsd: totals ? measured(totals.costUsd) : unmeasured('aucun appel enregistré'),
      budgetUsd,
      budgetUsedRatio:
        totals && budgetUsd && budgetUsd > 0
          ? measured(Number((totals.costUsd / budgetUsd).toFixed(4)))
          : unmeasured(budgetUsd ? 'aucun appel enregistré' : 'aucun plafond déclaré'),
      llmCalls: totals ? measured(totals.calls) : unmeasured('aucun appel enregistré'),
      failedLlmCalls: totals ? measured(totals.failedCalls) : unmeasured('aucun appel enregistré'),
      inputTokens: totals ? measured(totals.inputTokens) : unmeasured('aucun appel enregistré'),
      outputTokens: totals ? measured(totals.outputTokens) : unmeasured('aucun appel enregistré'),
      cacheReadTokens: totals
        ? measured(totals.cacheReadTokens)
        : unmeasured('aucun appel enregistré'),
      byModel: ranAnyCall
        ? measured(
            repos.llmCalls.byModel(missionId).map((m) => ({
              model: m.model,
              calls: m.calls,
              costUsd: m.costUsd,
              tokens: m.inputTokens + m.outputTokens,
            })),
          )
        : unmeasured('aucun appel enregistré'),
    },

    external: {
      toolCalls: ranAnyTool
        ? measured(toolUsage.reduce((sum, t) => sum + t.calls, 0))
        : unmeasured('aucun outil appelé'),
      externalCalls: measured(repos.toolCalls.countExternal(missionId)),
      byTool: ranAnyTool
        ? measured(toolUsage.map((t) => ({ tool: t.tool, calls: t.calls, failures: t.failures })))
        : unmeasured('aucun outil appelé'),
    },

    results: {
      // Le tunnel est toujours mesurable : ses compteurs sont écrits par les
      // transitions elles-mêmes, et zéro y signifie bien zéro.
      funnel: measured(repos.opportunities.funnelFor(missionId)),
      candidates: measured(opportunities.length),
      qualified: measured(repos.opportunities.countQualified(missionId)),
      shortlisted: measured(repos.opportunities.shortlistFor(missionId).length),
      approved: measured(repos.opportunities.approvedFor(missionId).length),
      evidenceCount: measured(evidenceCount),
      unsourcedCandidates: measured(unsourced),
    },

    reasoning: {
      decisions: measured(decisions.length),
      unsupportedClaims: measured(unsupported.length),
      byKind: measured(byKind),
    },

    caveats,
    generatedAt: new Date().toISOString(),
  };
}

/** Rend un nombre mesuré, ou dit pourquoi il ne l'est pas. */
const show = (m: Measured<number>, format: (n: number) => string = String): string =>
  m.measured ? format(m.value) : `inconnu — ${m.reason}`;

/**
 * Le rapport en texte, pour la console et pour les journaux.
 *
 * Les réserves passent en tête, pas en note de bas de page. Un rapport dont on
 * lit les chiffres avant d'apprendre qu'aucun appel n'a eu lieu est un rapport
 * qui trompe, même quand chaque chiffre est exact.
 */
export function formatMissionReport(report: MissionReport): string {
  const lines: string[] = [];
  const { economics: e, results: r, reasoning: d, external: x } = report;

  lines.push(`${report.title}`);
  lines.push(`${report.code ?? report.missionId} · ${report.status} · mode ${report.mode}`);
  lines.push('');

  if (report.caveats.length > 0) {
    lines.push('À LIRE AVANT LES CHIFFRES');
    for (const caveat of report.caveats) lines.push(`  ! ${caveat}`);
    lines.push('');
  }

  lines.push('Économie');
  lines.push(`  coût               ${show(e.costUsd, (n) => `${n.toFixed(4)} $`)}`);
  lines.push(
    `  plafond            ${e.budgetUsd === null ? 'aucun déclaré' : `${e.budgetUsd.toFixed(2)} $`}`,
  );
  lines.push(`  part consommée     ${show(e.budgetUsedRatio, (n) => `${(n * 100).toFixed(1)} %`)}`);
  lines.push(`  appels modèle      ${show(e.llmCalls)} (${show(e.failedLlmCalls)} en échec)`);
  lines.push(
    `  jetons             ${show(e.inputTokens)} entrée · ${show(e.outputTokens)} sortie · ${show(e.cacheReadTokens)} relus du cache`,
  );
  lines.push('');

  lines.push('Dehors');
  lines.push(`  appels d'outil     ${show(x.toolCalls)}`);
  lines.push(`  dont externes      ${show(x.externalCalls)}`);
  lines.push('');

  lines.push('Résultats');
  lines.push(`  candidats          ${show(r.candidates)}`);
  lines.push(`  qualifiés          ${show(r.qualified)}`);
  lines.push(`  présélectionnés    ${show(r.shortlisted)}`);
  lines.push(`  approuvés          ${show(r.approved)}`);
  lines.push(`  preuves            ${show(r.evidenceCount)}`);
  lines.push(`  sans source        ${show(r.unsourcedCandidates)}`);
  lines.push('');

  lines.push('Décisions');
  lines.push(`  enregistrées       ${show(d.decisions)}`);
  lines.push(`  sans preuve        ${show(d.unsupportedClaims)}`);

  return lines.join('\n');
}
