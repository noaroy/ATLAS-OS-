import type { Logger } from '@atlas/core';
import type { Repositories } from '@atlas/data';

/**
 * Ce qu'ATLAS fait des missions qu'un arrêt brutal a laissées en l'air.
 *
 * Un processus tué en pleine mission laisse la base dans un état qui ment : la
 * mission est `running`, ses étapes sont `running`, le village les anime, le
 * cockpit les compte comme actives — et plus rien ne les fera jamais avancer.
 * L'état n'est pas seulement faux, il est indétectable de l'extérieur : une
 * mission bloquée depuis trois jours et une mission lancée il y a dix secondes
 * se lisent exactement pareil.
 *
 * La reprise met ces missions en pause. Pas en échec — elles n'ont pas échoué,
 * elles ont été interrompues, et la nuance décide de ce qu'on peut en faire.
 * Pas en reprise automatique non plus, et c'est le point qui compte : **rien
 * n'est relancé tout seul.** Une mission réelle qui reprend sans qu'on l'ait
 * demandé dépense de l'argent que personne ne surveille, et le scénario qui
 * rend cela dangereux est précisément celui qui déclenche cette fonction —
 * l'exploitant n'était pas devant l'écran.
 *
 * La mise en pause est donc une fin, pas un différé. Reprendre est une décision
 * humaine, prise depuis le cockpit, en connaissant le budget déjà consommé.
 */

export interface RecoveredMission {
  missionId: string;
  code: string;
  title: string;
  /** L'état dans lequel l'arrêt l'a trouvée. */
  wasStatus: string;
  /** Étapes qui tournaient au moment de l'arrêt et sont revenues en file. */
  requeuedTasks: number;
  /** Ce que la mission avait déjà dépensé avant d'être interrompue. */
  spentUsd: number | null;
  startedAt: string | null;
}

export interface RecoveryReport {
  /** Les missions remises en pause. Vide quand l'arrêt précédent était propre. */
  missions: RecoveredMission[];
  /** Somme déjà engagée par les missions interrompues, quand elle est connue. */
  totalSpentUsd: number;
  /** Vrai dès qu'une mission demande une décision humaine. */
  needsAttention: boolean;
  generatedAt: string;
}

/** Les états d'où un arrêt brutal laisse une mission qui ne repartira pas seule. */
const INTERRUPTED_FROM = ['running', 'assigned'] as const;

export function recoverInterruptedMissions(repos: Repositories, logger: Logger): RecoveryReport {
  const stranded = repos.missions.listByStatus(...INTERRUPTED_FROM);
  const recovered: RecoveredMission[] = [];

  for (const mission of stranded) {
    // Les étapes qui tournaient reviennent en file plutôt que d'être marquées
    // en échec : elles n'ont pas échoué, et les compter comme des échecs
    // fausserait le taux de réussite dont l'évolution se sert pour décider.
    const requeuedTasks = repos.missions.requeueUnfinishedTasks(mission.id);

    // Depuis `assigned`, la transition directe vers `paused` est permise ;
    // depuis `running` aussi. Aucun état intermédiaire à traverser.
    //
    // `error` reste nul, délibérément : une interruption n'est pas une panne, et
    // la remplir ferait apparaître dans le cockpit une mission en échec qui n'a
    // fait que s'arrêter. La trace va dans le contexte, où elle est auditable
    // sans salir le statut.
    repos.missions.transition(mission.id, 'paused');
    repos.missions.setContext(mission.id, {
      ...mission.context,
      interruptedAt: new Date().toISOString(),
      interruptedFrom: mission.status,
      resumeRequiresHuman: true,
    });

    const spent = repos.llmCalls.hasCalls(mission.id)
      ? repos.llmCalls.totals(mission.id).costUsd
      : null;

    recovered.push({
      missionId: mission.id,
      code: mission.code,
      title: mission.title,
      wasStatus: mission.status,
      requeuedTasks,
      spentUsd: spent,
      startedAt: mission.startedAt,
    });
  }

  const totalSpentUsd = Number(
    recovered.reduce((sum, m) => sum + (m.spentUsd ?? 0), 0).toFixed(4),
  );

  if (recovered.length > 0) {
    // Un avertissement, pas une information : il faut que cela se voie dans un
    // journal qu'on parcourt vite.
    logger.warn('missions interrompues remises en pause — aucune reprise automatique', {
      count: recovered.length,
      spentUsd: totalSpentUsd,
      codes: recovered.map((m) => m.code),
    });
  }

  return {
    missions: recovered,
    totalSpentUsd,
    needsAttention: recovered.length > 0,
    generatedAt: new Date().toISOString(),
  };
}

/** Le rapport de reprise en texte, pour la console de démarrage. */
export function formatRecovery(report: RecoveryReport): string {
  if (report.missions.length === 0) return "Aucune mission interrompue : l'arrêt précédent était propre.";

  const lines = [
    `${report.missions.length} mission(s) interrompue(s), remises en pause.`,
    'Aucune ne reprendra seule — la reprise est une décision, prise depuis le cockpit.',
    '',
  ];

  for (const m of report.missions) {
    const spent = m.spentUsd === null ? 'aucune dépense enregistrée' : `${m.spentUsd.toFixed(4)} $ déjà engagés`;
    lines.push(`  ${m.code}  ${m.title}`);
    lines.push(`      ${m.wasStatus} → paused · ${m.requeuedTasks} étape(s) remise(s) en file · ${spent}`);
  }

  if (report.totalSpentUsd > 0) {
    lines.push('');
    lines.push(`  Total déjà engagé : ${report.totalSpentUsd.toFixed(4)} $`);
  }

  return lines.join('\n');
}
