import type { AtlasConfig } from '@atlas/core';

/**
 * Ce qu'une mission planifiée doit prouver avant de dépenser.
 *
 * Une mission déclenchée par un humain a un humain devant l'écran. Une mission
 * planifiée n'en a pas : elle part à trois heures du matin, et si elle échoue
 * mal, elle recommence le lendemain à la même heure. C'est le seul endroit du
 * système où une erreur se répète toute seule.
 *
 * D'où un contrôle plus strict que pour un lancement manuel, et une position
 * par défaut sans ambiguïté : **rien de réel n'est automatisé tant que tout
 * n'est pas déclaré**. Pas de valeur par défaut raisonnable, pas de repli
 * silencieux — l'absence d'une déclaration est un refus.
 */

export interface LiveAutomationRequest {
  /** La mission autorisée à tourner sans supervision. */
  missionKey: string | null;
  /** Plafond en dollars, obligatoire et strictement positif. */
  budgetUsd: number | null;
  /** Le moteur répond-il ? Mesuré, jamais supposé. */
  searchHealth: 'healthy' | 'unhealthy' | 'unknown';
  /** Peut-il répondre à cette mission ? */
  searchSuitability: 'suitable' | 'degraded' | 'unsuitable' | null;
  /** Bornes d'exécution déclarées. */
  limitsDeclared: boolean;
}

export interface LiveAutomationVerdict {
  allowed: boolean;
  /** Chaque motif de refus, nommé. Un refus muet ne se corrige pas. */
  refusals: string[];
}

/** Les missions qu'un déploiement accepte de lancer sans supervision. */
const ALLOWED_MISSIONS = new Set<string>(['live-pilot-001']);

export function guardLiveAutomation(
  config: AtlasConfig,
  request: LiveAutomationRequest,
): LiveAutomationVerdict {
  const refusals: string[] = [];

  // Le mode doit être déclaré, pas déduit. Une planification qui bascule en
  // réel parce qu'une clé traînait dans la configuration est exactement le
  // scénario qu'on refuse.
  if (config.llm.declaredMode !== 'live') {
    refusals.push(
      `le mode d'exécution doit être déclaré « live » (actuellement « ${config.llm.declaredMode} »)`,
    );
  }

  if (!request.budgetUsd || !Number.isFinite(request.budgetUsd) || request.budgetUsd <= 0) {
    refusals.push('aucun plafond de dépense déclaré');
  } else if (config.budget.maxMissionCostUsd > 0 && request.budgetUsd > config.budget.maxMissionCostUsd) {
    // Une planification ne peut pas s'octroyer plus que le cadre du
    // déploiement : le sens de la contrainte est à sens unique.
    refusals.push(
      `plafond demandé (${request.budgetUsd.toFixed(2)} $) supérieur à celui du déploiement ` +
        `(${config.budget.maxMissionCostUsd.toFixed(2)} $)`,
    );
  }

  if (!request.limitsDeclared) {
    refusals.push("aucune borne d'exécution déclarée (requêtes, pages, candidats, durée)");
  }

  if (!request.missionKey) {
    refusals.push('aucune mission désignée');
  } else if (!ALLOWED_MISSIONS.has(request.missionKey)) {
    refusals.push(`la mission « ${request.missionKey} » n'est pas autorisée en exécution planifiée`);
  }

  if (request.searchHealth !== 'healthy') {
    refusals.push(`moteur de recherche non sain (${request.searchHealth})`);
  }

  // `degraded` passe, avec la conscience que les résultats seront partiels ;
  // `unsuitable` ne passe pas — automatiser une mission dont l'index ne peut
  // pas contenir la réponse, c'est programmer une dépense inutile récurrente.
  if (request.searchSuitability === null) {
    refusals.push("adéquation du moteur non évaluée");
  } else if (request.searchSuitability === 'unsuitable') {
    refusals.push("le moteur ne couvre pas ce que la mission demande");
  }

  return { allowed: refusals.length === 0, refusals };
}
