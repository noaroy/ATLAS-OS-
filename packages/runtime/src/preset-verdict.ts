import type { Repositories } from '@atlas/data';
import type { MissionId } from '@atlas/contracts';

/**
 * Le verdict d'une mission de validation, jugée sur ses propres critères.
 *
 * L'évaluateur imposait six étapes sur six à toutes les missions. VAL-001,
 * dont l'objectif déclaré est de valider la découverte et de mesurer la
 * proportionnalité, se retrouvait donc PARTIAL pour n'avoir pas produit de
 * rapport final — alors qu'elle avait rempli chacun de ses propres critères :
 * sept candidats réels, onze preuves sourcées, aucune simulation, budget tenu.
 *
 * Juger toutes les validations à la même aune revient à ne mesurer qu'une seule
 * chose cinq fois. Chaque preset porte donc ce qu'il exige, et le verdict le
 * lit.
 *
 * Mais l'assouplissement s'arrête là. Un **socle commun** s'applique à tout
 * PASS, sans exception et sans qu'un preset puisse s'en exempter :
 *
 *   budget respecté · aucune preuve simulée · aucune donnée inventée ·
 *   aucune garde critique violée · aucun statut de mission incohérent
 *
 * C'est ce socle qui empêche la personnalisation des critères de devenir une
 * façon de baisser la barre. Un preset décide de ce qu'il **exige en plus**,
 * jamais de ce dont il se dispense.
 */

export type PresetVerdictKind = 'PASS' | 'PARTIAL' | 'FAIL' | 'BLOCKED';

/**
 * Ce qu'un preset exige, au-delà du socle commun.
 *
 * Déclaratif plutôt qu'impératif : les critères d'une validation doivent se
 * lire d'un coup d'œil à côté de son objectif, pas se reconstituer en suivant
 * des branches de code.
 */
export interface VerdictGate {
  /** Étapes qui doivent avoir abouti. Vide = le déroulement n'est pas l'objet. */
  requiredSteps: string[];
  minCandidates: number;
  minSourcedEvidence: number;
  /** Preuves `observed` ou `reported` — une inférence n'est pas une source. */
  minFirsthandEvidence: number;
  /** La revue humaine doit-elle avoir été atteinte ? */
  requiresHumanReview: boolean;
  /** Un moteur réel doit avoir servi la découverte. */
  requiresRealProvider: boolean;
  /**
   * Un arrêt sur garde budgétaire compte-t-il comme une réussite ?
   *
   * Vrai pour la validation de sûreté économique, dont c'est précisément
   * l'objet : le plafond doit être un mur, et l'atteindre proprement est le
   * résultat attendu. Faux partout ailleurs, où c'est une mission tronquée.
   */
  budgetStopIsSuccess: boolean;
}

export const DEFAULT_GATE: VerdictGate = {
  requiredSteps: ['discovery', 'enrichment', 'qualification', 'scoring', 'ranking', 'report'],
  minCandidates: 1,
  minSourcedEvidence: 1,
  minFirsthandEvidence: 1,
  requiresHumanReview: true,
  requiresRealProvider: true,
  budgetStopIsSuccess: false,
};

export interface VerdictCriterion {
  label: string;
  met: boolean;
  observed: string;
  /** Un critère du socle commun ne peut jamais être contourné par un preset. */
  foundational: boolean;
  required: boolean;
}

export interface PresetVerdictReport {
  verdict: PresetVerdictKind;
  rationale: string;
  criteria: VerdictCriterion[];
  incompleteSteps: Array<{ ref: string; status: string; reason: string | null }>;
  generatedAt: string;
}

export interface PresetVerdictInput {
  repos: Repositories;
  missionId: MissionId;
  gate: VerdictGate;
  maxCostUsd: number;
  spentUsd: number;
}

export function evaluatePreset(input: PresetVerdictInput): PresetVerdictReport {
  const { repos, missionId, gate } = input;

  const mission = repos.missions.get(missionId);
  const mode = (mission?.context as { executionMode?: unknown } | null)?.executionMode === 'live'
    ? 'live'
    : 'simulation';
  const tasks = repos.missions.tasksFor(missionId);
  const opportunities = repos.opportunities.forMission(missionId);
  const evidence = repos.companies.evidenceForMission(missionId);
  const tools = repos.toolCalls.forMission(missionId);

  const sourced = evidence.filter((e) => Boolean(e.sourceRef));
  const simulated = evidence.filter((e) => e.simulated);
  const firsthand = evidence.filter((e) => e.nature === 'observed' || e.nature === 'reported');
  // Une affirmation de première main sans source est une donnée inventée. Une
  // inférence sans source ne l'est pas : elle est dérivée, et sa nature le dit.
  const unsourcedFirsthand = firsthand.filter((e) => !e.sourceRef);
  const inferredCount = evidence.filter((e) => e.nature === 'inferred').length;
  const unsupported = repos.decisions.unsupportedClaims(missionId);

  // ── La lignée des entités utilisées ──────────────────────────────────────
  //
  // Le socle vérifiait `evidence.simulated`, et cela ne suffisait pas :
  // VAL-003 a produit quatre candidats fabriqués dont les preuves portaient
  // `simulated = 0`, puisque la mission *courante* était réelle. Le drapeau
  // décrit qui a écrit la ligne, pas d'où vient l'entité qu'elle décrit.
  //
  // Une conclusion réelle ne peut donc pas reposer sur une entité de lignée
  // `simulated` ou `unknown`, quel que soit le drapeau des preuves.
  const contaminated =
    mode === 'live'
      ? opportunities.filter((o) => {
          const company = repos.companies.get(o.companyId);
          return !company || company.dataOrigin !== 'live';
        })
      : [];

  const statusOf = (ref: string): string => tasks.find((t) => t.ref === ref)?.status ?? 'absent';
  const cancelled = tasks.filter((t) => t.status === 'cancelled');

  const incompleteSteps = gate.requiredSteps
    .filter((ref) => statusOf(ref) !== 'succeeded')
    .map((ref) => {
      const task = tasks.find((t) => t.ref === ref);
      return { ref, status: task?.status ?? 'absent', reason: task?.error ?? null };
    });

  // Un moteur réel a-t-il servi ? Un appel externe réussi le prouve ; le
  // déduire du mode déclaré ne prouverait que l'intention.
  const externalOk = tools.filter((t) => t.external && t.ok).length;

  // ── Le socle commun ──────────────────────────────────────────────────────
  // Aucun preset ne peut s'en exempter. C'est ce qui empêche des critères
  // propres à chaque validation de devenir une façon de baisser la barre.
  const foundation: VerdictCriterion[] = [
    {
      label: 'budget respecté',
      met: input.spentUsd <= input.maxCostUsd,
      observed: `${input.spentUsd.toFixed(4)} $ sur ${input.maxCostUsd.toFixed(2)} $`,
      foundational: true,
      required: true,
    },
    {
      label: 'aucune preuve simulée',
      met: simulated.length === 0,
      observed: simulated.length === 0 ? 'aucune' : `${simulated.length} simulée(s)`,
      foundational: true,
      required: true,
    },
    {
      // Une donnée inventée se reconnaît à ce qu'aucune source ne la porte —
      // mais seulement pour ce qui prétend rapporter le monde.
      //
      // Ce critère exigeait d'abord une source sur *chaque* preuve, et VAL-002
      // a échoué sur une inférence : « business model », dérivée de ce que les
      // autres preuves montraient. Une inférence n'a pas de source propre par
      // construction — c'est tout ce qui la distingue d'une observation, et
      // c'est pourquoi `EvidenceNature` sépare les trois natures.
      //
      // Exiger une URL sur une inférence ne la rendrait pas plus solide : cela
      // pousserait à en fabriquer une, ce qui est exactement le défaut qu'on
      // cherche à empêcher. Le durcissement reste entier là où il compte : une
      // preuve `observed` ou `reported` sans source **est** une donnée
      // inventée, et disqualifie.
      label: 'aucune affirmation de première main sans source',
      met: unsourcedFirsthand.length === 0,
      observed:
        unsourcedFirsthand.length === 0
          ? `${sourced.length} sourcée(s) sur ${evidence.length}` +
            (inferredCount > 0 ? ` · ${inferredCount} inférence(s)` : '')
          : `${unsourcedFirsthand.length} affirmation(s) sans source`,
      foundational: true,
      required: true,
    },
    {
      // Le drapeau `simulated` d'une preuve dit qui l'a écrite ; il ne dit pas
      // d'où vient l'entreprise qu'elle décrit. Les quatre candidats fabriqués
      // de VAL-003 passaient tous les contrôles pour cette seule raison.
      label: 'aucune entité de lignée douteuse',
      met: contaminated.length === 0,
      observed:
        contaminated.length === 0
          ? mode === 'live'
            ? `${opportunities.length} entité(s) de lignée réelle`
            : 'mode simulation — lignée non exigée'
          : `${contaminated.length} entité(s) simulated/unknown : ${contaminated
              .map((o) => repos.companies.get(o.companyId)?.name ?? o.companyId)
              .slice(0, 3)
              .join(', ')}`,
      foundational: true,
      required: true,
    },
    {
      label: 'aucune conclusion sans preuve',
      met: unsupported.length === 0,
      observed: unsupported.length === 0 ? 'aucune' : `${unsupported.length} sans preuve`,
      foundational: true,
      required: true,
    },
    {
      // Une mission `completed` dont des étapes ont été annulées est un statut
      // qui ment — le défaut corrigé après LIVE PILOT 001.
      label: 'statut de mission cohérent',
      met: !(mission?.status === 'completed' && cancelled.length > 0),
      observed: `${mission?.status ?? 'inconnu'}${cancelled.length ? ` · ${cancelled.length} annulée(s)` : ''}`,
      foundational: true,
      required: true,
    },
  ];

  // ── Ce que ce preset exige en plus ───────────────────────────────────────
  const specific: VerdictCriterion[] = [
    ...gate.requiredSteps.map((ref) => ({
      label: `étape ${ref} terminée`,
      met: statusOf(ref) === 'succeeded',
      observed: statusOf(ref),
      foundational: false,
      required: true,
    })),
    {
      label: `au moins ${gate.minCandidates} candidat(s) réel(s)`,
      met: opportunities.length >= gate.minCandidates,
      observed: `${opportunities.length} candidat(s)`,
      foundational: false,
      required: gate.minCandidates > 0,
    },
    {
      label: `au moins ${gate.minSourcedEvidence} source(s) consultable(s)`,
      met: sourced.length >= gate.minSourcedEvidence,
      observed: `${sourced.length} preuve(s) sourcée(s)`,
      foundational: false,
      required: gate.minSourcedEvidence > 0,
    },
    {
      label: `au moins ${gate.minFirsthandEvidence} preuve(s) de première main`,
      met: firsthand.length >= gate.minFirsthandEvidence,
      observed: `${firsthand.length} observed/reported`,
      foundational: false,
      required: gate.minFirsthandEvidence > 0,
    },
    {
      label: 'moteur réel utilisé',
      met: !gate.requiresRealProvider || externalOk > 0,
      observed: `${externalOk} appel(s) externe(s) réussi(s)`,
      foundational: false,
      required: gate.requiresRealProvider,
    },
    {
      label: 'revue humaine atteinte',
      met: !gate.requiresHumanReview || statusOf('report') === 'succeeded',
      observed: statusOf('report') === 'succeeded' ? 'rapport produit' : 'rapport non produit',
      foundational: false,
      required: gate.requiresHumanReview,
    },
  ];

  const criteria = [...foundation, ...specific];
  const brokenFoundation = foundation.filter((c) => !c.met);
  const brokenSpecific = specific.filter((c) => c.required && !c.met);

  // ── Le verdict ───────────────────────────────────────────────────────────
  // Le socle d'abord : une preuve simulée ou un budget dépassé disqualifie,
  // quels que soient les résultats par ailleurs. Un preset ne rachète jamais
  // une violation du socle en remplissant ses propres critères.
  if (brokenFoundation.length > 0) {
    return report(
      'FAIL',
      `Socle commun violé : ${brokenFoundation.map((c) => c.label).join(', ')}.`,
      criteria,
      incompleteSteps,
    );
  }

  if (brokenSpecific.length === 0) {
    return report(
      'PASS',
      gate.requiredSteps.length === 0
        ? "Les critères propres à cette validation sont remplis."
        : `Les ${gate.requiredSteps.length} étape(s) exigée(s) ont abouti, et les critères propres à cette validation sont remplis.`,
      criteria,
      incompleteSteps,
    );
  }

  // Une mission arrêtée par une garde budgétaire correcte, quand c'est
  // précisément ce qu'on validait.
  if (gate.budgetStopIsSuccess && cancelled.some((t) => /BUDGET_EXCEEDED/.test(t.error ?? ''))) {
    return report(
      'PASS',
      "Arrêt sur garde budgétaire, proprement : c'est le comportement que cette validation met à l'épreuve.",
      criteria,
      incompleteSteps,
    );
  }

  // Rien de réel n'a été produit : c'est un blocage, pas une insuffisance.
  if (opportunities.length === 0 && evidence.length === 0 && externalOk === 0) {
    return report(
      'BLOCKED',
      "Aucune donnée externe n'a pu être collectée : le blocage est en amont du pipeline.",
      criteria,
      incompleteSteps,
    );
  }

  if (opportunities.length > 0 && sourced.length > 0) {
    return report(
      'PARTIAL',
      `Des résultats réels et sourcés existent, mais ${brokenSpecific
        .map((c) => c.label)
        .join(', ')}.`,
      criteria,
      incompleteSteps,
    );
  }

  return report(
    'FAIL',
    `Critères non remplis : ${brokenSpecific.map((c) => c.label).join(', ')}.`,
    criteria,
    incompleteSteps,
  );
}

const report = (
  verdict: PresetVerdictKind,
  rationale: string,
  criteria: VerdictCriterion[],
  incompleteSteps: PresetVerdictReport['incompleteSteps'],
): PresetVerdictReport => ({
  verdict,
  rationale,
  criteria,
  incompleteSteps,
  generatedAt: new Date().toISOString(),
});

/** Le verdict en texte, critère par critère, socle d'abord. */
export function formatPresetVerdict(report: PresetVerdictReport): string {
  const lines: string[] = ['  SOCLE COMMUN'];
  for (const c of report.criteria.filter((x) => x.foundational)) {
    lines.push(`    ${c.met ? '✓' : '✗'} ${c.label.padEnd(34)} ${c.observed}`);
  }
  lines.push('', '  CRITÈRES DE CETTE VALIDATION');
  for (const c of report.criteria.filter((x) => !x.foundational)) {
    const mark = c.met ? '✓' : c.required ? '✗' : '·';
    lines.push(`    ${mark} ${c.label.padEnd(34)} ${c.observed}${!c.required ? ' (non requis)' : ''}`);
  }
  lines.push('', `  VERDICT : ${report.verdict}`, `  ${report.rationale}`);
  return lines.join('\n');
}
