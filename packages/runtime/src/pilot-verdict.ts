import type { Repositories } from '@atlas/data';
import type { MissionId } from '@atlas/contracts';

/**
 * Le verdict d'un pilote de bout en bout.
 *
 * L'ancien verdict regardait trois choses — des candidats, des preuves
 * sourcées, un budget tenu — et rendait PASS dès qu'elles étaient réunies.
 * LIVE-001 (M-1F5YW) a donc affiché **PASS** avec une seule étape réussie sur
 * six : l'enrichissement annulé par une garde, la qualification sautée, aucune
 * opportunité, aucune revue humaine. Trois candidats réels sont un bon début ;
 * ce n'est pas un pipeline qui aboutit.
 *
 * La correction tient en une phrase : **découvrir n'est pas conclure.** Un
 * verdict qui se prononce sur la première étape d'une chaîne de six ne mesure
 * pas ce qu'on lui demande de mesurer, et le pire est qu'il a l'air de le
 * faire — c'est exactement le genre de chiffre juste-en-apparence qu'un
 * tableau de bord ne doit jamais produire.
 *
 * Trois issues, et leur frontière est nette :
 *
 *   PASS     toutes les étapes obligatoires ont réellement tourné, et la
 *            conclusion — même « aucune opportunité » — est étayée.
 *   PARTIAL  la découverte a produit du réel, la chaîne s'est arrêtée après.
 *   FAIL     aucune donnée réelle, ou une donnée simulée présentée comme preuve.
 *   BLOCKED  rien n'a pu démarrer : moteur, budget ou configuration.
 */

export type PilotVerdict = 'PASS' | 'PARTIAL' | 'FAIL' | 'BLOCKED';

export interface VerdictCriterion {
  /** Ce qui est exigé, en une ligne lisible. */
  label: string;
  met: boolean;
  /** La valeur observée, pour que le verdict se vérifie sans relire le code. */
  observed: string;
  /** Un critère non rempli empêche-t-il PASS ? */
  required: boolean;
}

export interface PilotReport {
  verdict: PilotVerdict;
  /** Pourquoi ce verdict, en une phrase. */
  rationale: string;
  criteria: VerdictCriterion[];
  /** Les étapes obligatoires qui n'ont pas abouti. */
  incompleteSteps: Array<{ ref: string; status: string; reason: string | null }>;
  generatedAt: string;
}

/**
 * Les étapes sans lesquelles le pilote n'a pas de sens.
 *
 * Nommées ici plutôt que déduites du plan : un plan qui omettrait la
 * qualification produirait sinon un PASS pour n'avoir pas essayé, et c'est le
 * genre de succès qu'on obtient en baissant la barre.
 */
const MANDATORY_STEPS = ['discovery', 'enrichment', 'qualification', 'scoring', 'ranking', 'report'];

export interface PilotVerdictInput {
  repos: Repositories;
  missionId: MissionId;
  /** Le plafond du pilote, en dollars. */
  maxCostUsd: number;
  /** Ce que la mission a réellement coûté. */
  spentUsd: number;
}

export function evaluatePilot(input: PilotVerdictInput): PilotReport {
  const { repos, missionId } = input;

  const tasks = repos.missions.tasksFor(missionId);
  const opportunities = repos.opportunities.forMission(missionId);
  const evidence = repos.companies.evidenceForMission(missionId);

  const sourced = evidence.filter((e) => Boolean(e.sourceRef));
  const simulated = evidence.filter((e) => e.simulated);
  const firsthand = evidence.filter((e) => e.nature === 'observed' || e.nature === 'reported');
  const reviewed = repos.opportunities.reviewedFor(missionId);

  const stepStatus = (ref: string): string =>
    tasks.find((t) => t.ref === ref)?.status ?? 'absent';

  const incompleteSteps = MANDATORY_STEPS.filter((ref) => stepStatus(ref) !== 'succeeded').map(
    (ref) => {
      const task = tasks.find((t) => t.ref === ref);
      return { ref, status: task?.status ?? 'absent', reason: task?.error ?? null };
    },
  );

  // La revue humaine est « atteinte » dès que le pipeline lui a présenté
  // quelque chose — y compris rien. Une mission qui conclut honnêtement
  // « aucune opportunité » a bien atteint la revue : elle n'a simplement rien
  // à faire approuver, et c'est un résultat, pas un manque.
  const reportDone = stepStatus('report') === 'succeeded';
  const reviewReached = reportDone && (opportunities.length === 0 || reviewed.length >= 0);

  const criteria: VerdictCriterion[] = [
    {
      label: 'au moins un candidat réel',
      met: opportunities.length >= 1,
      observed: `${opportunities.length} candidat(s)`,
      required: true,
    },
    {
      label: 'au moins une source consultable',
      met: sourced.length >= 1,
      observed: `${sourced.length} preuve(s) sourcée(s) sur ${evidence.length}`,
      required: true,
    },
    {
      label: 'au moins une preuve observed ou reported',
      met: firsthand.length >= 1,
      observed: `${firsthand.length} preuve(s) de première main`,
      required: true,
    },
    ...MANDATORY_STEPS.map((ref) => ({
      label: `étape ${ref} terminée`,
      met: stepStatus(ref) === 'succeeded',
      observed: stepStatus(ref),
      required: true,
    })),
    {
      // Volontairement non requis : une analyse réelle peut conclure qu'aucun
      // des candidats ne mérite d'être proposé. Forcer une opportunité pour
      // faire passer un test reviendrait à fabriquer le résultat qu'on mesure.
      label: 'au moins une opportunité proposée',
      met: opportunities.some((o) => o.stage !== 'discovered'),
      observed: `${opportunities.filter((o) => o.stage !== 'discovered').length} proposée(s)`,
      required: false,
    },
    {
      label: 'revue humaine atteinte',
      met: reviewReached,
      observed: reportDone
        ? `${reviewed.length} décision(s) enregistrée(s)`
        : 'rapport non produit',
      required: true,
    },
    {
      label: 'budget respecté',
      met: input.spentUsd <= input.maxCostUsd,
      observed: `${input.spentUsd.toFixed(4)} $ sur ${input.maxCostUsd.toFixed(2)} $`,
      required: true,
    },
    {
      label: 'aucune donnée simulée présentée comme preuve',
      met: simulated.length === 0,
      observed: simulated.length === 0 ? 'aucune' : `${simulated.length} preuve(s) simulée(s)`,
      required: true,
    },
  ];

  const failedRequired = criteria.filter((c) => c.required && !c.met);

  // ── Le verdict ──────────────────────────────────────────────────────────
  // L'ordre des tests compte : une preuve simulée disqualifie tout, quelle que
  // soit la qualité du reste, parce qu'elle rend le reste invérifiable.
  if (simulated.length > 0) {
    return report('FAIL', 'Des preuves simulées ont été comptées comme réelles.', criteria, incompleteSteps);
  }

  if (opportunities.length === 0 && evidence.length === 0 && stepStatus('discovery') !== 'succeeded') {
    return report(
      'BLOCKED',
      "La découverte n'a pas abouti : aucune donnée réelle n'a pu être collectée.",
      criteria,
      incompleteSteps,
    );
  }

  if (failedRequired.length === 0) {
    const proposed = opportunities.filter((o) => o.stage !== 'discovered').length;
    return report(
      'PASS',
      proposed > 0
        ? `Pipeline complet : ${proposed} opportunité(s) proposée(s), toutes étayées.`
        : "Pipeline complet. Aucune opportunité retenue, et cette conclusion est étayée par les preuves collectées.",
      criteria,
      incompleteSteps,
    );
  }

  // Découverte réussie mais chaîne interrompue : le cas exact de LIVE-001.
  if (opportunities.length >= 1 && sourced.length >= 1) {
    return report(
      'PARTIAL',
      `La découverte a produit du réel, la chaîne s'est arrêtée ensuite : ` +
        `${incompleteSteps.map((s) => `${s.ref} (${s.status})`).join(', ')}.`,
      criteria,
      incompleteSteps,
    );
  }

  return report(
    'FAIL',
    `Aucun résultat réel exploitable : ${failedRequired.map((c) => c.label).join(', ')}.`,
    criteria,
    incompleteSteps,
  );
}

const report = (
  verdict: PilotVerdict,
  rationale: string,
  criteria: VerdictCriterion[],
  incompleteSteps: PilotReport['incompleteSteps'],
): PilotReport => ({
  verdict,
  rationale,
  criteria,
  incompleteSteps,
  generatedAt: new Date().toISOString(),
});

/** Le verdict en texte, critère par critère. */
export function formatPilotReport(report: PilotReport): string {
  const lines: string[] = [];
  for (const c of report.criteria) {
    const mark = c.met ? '✓' : c.required ? '✗' : '·';
    const tag = !c.met && !c.required ? ' (non requis)' : '';
    lines.push(`  ${mark} ${c.label.padEnd(38)} ${c.observed}${tag}`);
  }
  lines.push('');
  lines.push(`  VERDICT : ${report.verdict}`);
  lines.push(`  ${report.rationale}`);
  return lines.join('\n');
}
