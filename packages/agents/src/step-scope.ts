/**
 * Ce qu'une étape a le droit de faire — indépendamment de la panoplie de l'agent.
 *
 * Les outils étaient choisis d'après les compétences déclarées de l'agent, et
 * rien d'autre. L'explorateur porte à la fois « découvrir » et « documenter » :
 * il disposait donc d'`enrich_company` et de `find_contacts` dès la première
 * étape, et rien ne l'empêchait de les employer.
 *
 * REVENUE-001 l'a mesuré. Dans la seule étape `discovery`, l'explorateur a
 * passé 4 `enrich_company`, 6 `find_contacts` et 6 `http_fetch`. Il a épuisé
 * les douze appels autorisés et 116 257 des 120 000 jetons de la mission avant
 * que la qualification ne démarre. Les six entreprises trouvées étaient
 * réelles et bien sourcées — mais aucune ne portait de score ni de verdict,
 * donc aucune n'était vendable.
 *
 * Le plan disait pourtant six étapes. Un plan qui décrit une séquence sans
 * pouvoir l'imposer ne décrit qu'une intention.
 *
 * La compétence dit ce qu'un agent *sait* faire ; l'étape dit ce qu'on lui
 * demande *maintenant*. L'autorisation est l'intersection des deux — jamais
 * l'union, et jamais la première seule.
 */

/**
 * Les outils ouverts à chaque action de plan.
 *
 * `record_evidence` et `memory_search` traversent : consigner ce qu'on vient de
 * lire et relire ce qu'ATLAS sait déjà appartiennent à toutes les étapes, et
 * les en priver forcerait chaque étape à redécouvrir ce que la précédente
 * savait.
 *
 * `http_fetch` s'arrête à l'enrichissement. La découverte a besoin de lire un
 * minimum pour établir qu'une entreprise existe ; au-delà, lire des pages est
 * du travail de documentation, et c'est ce glissement qui a coûté la mission.
 */
const TOOLS_BY_ACTION: Readonly<Record<string, readonly string[]>> = {
  /** Découverte : trouver des candidats, établir qu'ils existent. Rien de plus. */
  research: ['discover_companies', 'http_fetch', 'record_evidence', 'memory_search'],
  /** Enrichissement : documenter un candidat déjà enregistré. */
  collect: ['enrich_company', 'find_contacts', 'http_fetch', 'record_evidence', 'memory_search'],
  /** Qualification : trancher, sur les preuves déjà réunies. */
  qualify: ['qualify_opportunity', 'record_evidence', 'memory_search'],
  /** Notation : mesurer l'adéquation. */
  score: ['score_opportunity', 'score_candidates', 'record_evidence', 'memory_search'],
  /** Classement : ordonner ce qui a été noté. */
  evaluate: ['rank_shortlist', 'score_opportunity', 'memory_search'],
  /** Restitution : écrire, et retenir ce qui mérite de l'être. */
  produce: ['create_document', 'memory_remember', 'memory_search', 'inspect_mission'],
};

/**
 * Les outils réellement autorisés pour cette étape.
 *
 * Une action inconnue rend la panoplie complète de l'agent, sans restriction.
 * C'est délibéré : cette table décrit le pipeline commercial, et un plan
 * ailleurs dans ATLAS — évolution, opérations, atelier — ne doit pas se
 * retrouver muet parce qu'une action n'y figure pas. Restreindre par défaut
 * casserait silencieusement des chemins qui fonctionnent, ce qui coûte plus
 * cher que le glissement qu'on corrige.
 */
export function toolsForAction(action: string, agentTools: readonly string[]): string[] {
  const scope = TOOLS_BY_ACTION[action.trim().toLowerCase()];
  if (!scope) return [...agentTools];
  return agentTools.filter((tool) => scope.includes(tool));
}

/** Les actions dont le périmètre est effectivement borné. */
export function scopedActions(): string[] {
  return Object.keys(TOOLS_BY_ACTION);
}

/**
 * Ce que cette étape s'est vu refuser, pour le dire à l'agent.
 *
 * Un outil retiré sans explication pousse le modèle à le réclamer tour après
 * tour, ce qui coûte exactement ce que la restriction voulait économiser.
 */
export function withheldFrom(action: string, agentTools: readonly string[]): string[] {
  const allowed = new Set(toolsForAction(action, agentTools));
  return agentTools.filter((tool) => !allowed.has(tool));
}
