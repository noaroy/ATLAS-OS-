import type { Repositories } from '@atlas/data';

/**
 * Ce qu'une mission réelle apprend sur ATLAS lui-même.
 *
 * L'observation ordinaire regarde les tendances : taux de réussite, durées,
 * qualité. Elle ne voit pas ce qui a coûté le plus cher jusqu'ici — des pannes
 * ponctuelles, chacune parfaitement identifiable, chacune découverte après
 * avoir payé. Un paramètre refusé par le modèle, un filtre qui écarte tout, un
 * moteur sain mais inadapté : rien de tout cela n'apparaît dans une moyenne.
 *
 * Ce module lit une mission terminée et en tire des propositions structurées.
 * Il propose ; il ne modifie rien. La distinction est absolue : un système qui
 * se corrige seul en production corrige aussi ses erreurs de diagnostic.
 */

export type ProposalPriority = 'low' | 'medium' | 'high' | 'critical';

export interface ImprovementProposal {
  problem: string;
  /** Ce qui l'établit — jamais une impression, toujours une trace. */
  evidence: string;
  missionIds: string[];
  impact: string;
  proposal: string;
  estimatedCost: string;
  risk: 'low' | 'medium' | 'high';
  priority: ProposalPriority;
  recommendedTest: string;
}

/**
 * Examine une mission terminée et propose ce qu'il faudrait changer.
 *
 * Chaque détecteur part d'une trace vérifiable — un appel refusé, un filtre qui
 * a tout écarté, un moteur déclaré inadapté — et jamais d'une intuition sur le
 * code. Une proposition sans preuve serait une opinion, et une opinion
 * automatique est du bruit.
 */
export function observeLiveMission(repos: Repositories, missionId: string): ImprovementProposal[] {
  const proposals: ImprovementProposal[] = [];
  const mission = repos.missions.get(missionId);
  if (!mission) return proposals;

  const tasks = repos.missions.tasksFor(missionId);
  const calls = repos.llmCalls.forMission?.(missionId) ?? [];
  const tools = repos.toolCalls.forMission?.(missionId) ?? [];
  const evidence = repos.companies.evidenceForMission(missionId);
  const opportunities = repos.opportunities.forMission(missionId);

  // ── Un paramètre que le modèle refuse ────────────────────────────────────
  // La panne la plus bête et la plus coûteuse : la requête est rejetée avant
  // toute inférence, donc la mission meurt en une seconde sans rien produire.
  const rejected = calls.filter(
    (call) => !call.ok && /does not support|not supported on this model/i.test(call.error ?? ''),
  );
  if (rejected.length > 0) {
    proposals.push({
      problem: "Un paramètre de requête n'est pas supporté par le modèle employé.",
      evidence: `${rejected.length} appel(s) rejeté(s) en 400 : ${rejected[0]!.error?.slice(0, 160)}`,
      missionIds: [missionId],
      impact:
        "Chaque appel échoue avant inférence. La mission meurt sans rien produire, et le coût " +
        "nul masque la gravité — un 400 n'est pas facturé, donc rien n'alerte.",
      proposal:
        "Étendre la table de capacités par modèle dans le provider Anthropic, en positif : " +
        "un modèle non répertorié ne reçoit aucun paramètre optionnel.",
      estimatedCost: 'quelques lignes, une table à tenir à jour',
      risk: 'low',
      priority: 'critical',
      recommendedTest:
        "Un test qui lit la source et refuse tout paramètre optionnel envoyé sans condition de modèle.",
    });
  }

  // ── Un filtre qui écarte tout ────────────────────────────────────────────
  const discovery = tools.filter((call) => call.tool === 'discover_companies');
  const foundNothing = discovery.length > 0 && discovery.every((call) => call.outcome === 'success-empty');
  if (foundNothing && opportunities.length === 0) {
    proposals.push({
      problem:
        "La découverte aboutit techniquement mais ne retient aucun candidat : le filtrage " +
        'déterministe écarte la totalité des résultats bruts.',
      evidence: `${discovery.length} appel(s) à discover_companies, tous en success-empty, 0 opportunité créée.`,
      missionIds: [missionId],
      impact:
        "Le rapport conclut « marché vide » là où le filtre a tout supprimé. C'est la pire " +
        'confusion possible : un défaut interne présenté comme un constat de terrain.',
      proposal:
        "Journaliser le taux de rejet du filtre et lever un avertissement quand il atteint 100 %. " +
        "Un filtre qui écarte tout est un filtre à revoir, pas un marché vide.",
      estimatedCost: 'un compteur et un seuil',
      risk: 'low',
      priority: 'high',
      recommendedTest:
        'Un filtrage rejetant 100 % des résultats doit produire un avertissement distinct de « marché vide ».',
    });
  }

  // ── Un moteur bridé ──────────────────────────────────────────────────────
  const throttled = tools.filter((call) => call.outcome === 'rate-limited');
  if (throttled.length > 0) {
    proposals.push({
      problem: 'Le moteur de recherche bride cette adresse.',
      evidence: `${throttled.length} appel(s) en rate-limited sur cette mission.`,
      missionIds: [missionId],
      impact:
        'Une partie des requêtes est perdue, et la mission conclut sur une fraction de ses sources ' +
        'sans que le rapport le signale.',
      proposal:
        "Porter le nombre de requêtes bridées jusqu'au rapport final, et déclarer la découverte " +
        'partielle plutôt que complète quand il est non nul.',
      estimatedCost: 'un champ de télémétrie',
      risk: 'low',
      priority: 'medium',
      recommendedTest: 'Une découverte dont une requête a été bridée ne doit pas se déclarer exhaustive.',
    });
  }

  // ── Une conclusion sans preuve ───────────────────────────────────────────
  const unsupported = repos.decisions.unsupportedClaims(missionId);
  if (unsupported.length > 0) {
    proposals.push({
      problem: "Hermès a conclu sans qu'aucune preuve sourcée ne soutienne sa synthèse.",
      evidence: `${unsupported.length} décision(s) de type conclude/escalate sans evidenceIds.`,
      missionIds: [missionId],
      impact:
        "Acceptable ici — le journal le dit franchement — mais un rapport lu vite pourrait " +
        'prendre la synthèse pour un constat.',
      proposal:
        "Marquer visuellement toute conclusion non étayée dans le Command Center et dans les exports.",
      estimatedCost: 'un badge dans deux vues',
      risk: 'low',
      priority: 'medium',
      recommendedTest: "Une conclusion sans evidenceIds doit être signalée dans la fiche de mission.",
    });
  }

  // ── Des étapes sautées en cascade ────────────────────────────────────────
  const skipped = tasks.filter((task) => (task.error ?? '').startsWith('SKIPPED_NO_INPUT'));
  if (skipped.length >= 3) {
    proposals.push({
      problem: `${skipped.length} étapes consécutives sautées faute d'entrée.`,
      evidence: `Étapes : ${skipped.map((t) => t.ref).join(', ')}.`,
      missionIds: [missionId],
      impact:
        "Le mécanisme fonctionne — aucun appel gaspillé — mais une mission qui saute la moitié " +
        'de son plan devrait être arrêtée plus tôt, et son échec attribué à sa cause première.',
      proposal:
        "Arrêter la mission dès que la première étape productrice échoue, plutôt que de dérouler " +
        'les préconditions une par une.',
      estimatedCost: 'une condition dans la boucle de dispatch',
      risk: 'medium',
      priority: 'low',
      recommendedTest: "Une découverte sans résultat doit clore la mission, pas sauter cinq étapes.",
    });
  }

  // ── Un moteur sain mais inadapté ─────────────────────────────────────────
  if (evidence.length === 0 && opportunities.length === 0 && discovery.length > 0) {
    proposals.push({
      problem:
        "La mission n'a produit aucune preuve alors que le moteur répondait : sa couverture ne " +
        'correspond pas au marché visé.',
      evidence: `0 preuve, 0 opportunité, ${discovery.length} recherche(s) pourtant abouties.`,
      missionIds: [missionId],
      impact:
        'Une mission entière payée pour interroger un index qui ne contient pas la réponse.',
      proposal:
        "Rendre le contrôle d'adéquation bloquant avant toute mission réelle, et le porter dans " +
        'le rapport de valeur pour distinguer « marché vide » de « mauvais index ».',
      estimatedCost: 'déjà implémenté ; reste à généraliser aux missions non pilotes',
      risk: 'low',
      priority: 'high',
      recommendedTest: 'Un moteur healthy mais unsuitable doit refuser le décollage sans dépense.',
    });
  }

  return proposals;
}
