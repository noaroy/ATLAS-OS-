import type { LlmRequest } from '../types.ts';

/**
 * Ce qu'un fournisseur d'inférence sait faire — distinct de savoir s'il répond.
 *
 * La même distinction que pour les moteurs de recherche, et pour la même
 * raison : elle a coûté deux missions là-bas, et elle coûterait davantage ici.
 * Un fournisseur peut répondre en trois cents millisecondes sans savoir
 * produire du JSON structuré, sans accepter d'outils, ou avec une fenêtre de
 * contexte trop courte pour la requête qu'on lui envoie.
 *
 *   La santé — répond-il ? Se mesure en l'appelant.
 *   L'adéquation — peut-il servir *cette* requête-ci ? Se déduit de ce qu'il
 *   déclare, sans rien appeler.
 *
 * Un fournisseur sain mais inadapté est le cas coûteux : il passe le contrôle
 * de santé, accepte l'appel, et rend une réponse que le reste du pipeline ne
 * sait pas lire. On paie deux fois — l'appel, puis l'échec qu'il provoque.
 */

export interface InferenceCapabilities {
  /** Sait rendre une réponse conforme à un schéma JSON imposé. */
  structuredOutput: boolean;
  /** Sait appeler des outils déclarés par l'appelant. */
  toolUse: boolean;
  /** Sait exécuter des outils de son côté — recherche web, récupération de page. */
  serverTools: boolean;
  /** Fenêtre de contexte, en jetons. */
  contextWindow: number;
  /** Sortie maximale par appel, en jetons. */
  maxOutputTokens: number;
  /** Modèles servis, par préfixe. `['*']` signifie sans restriction connue. */
  models: string[];
  /** Ce que ce fournisseur ne sait pas faire, en une phrase lisible. */
  caveat: string | null;
}

/**
 * Les capacités d'un fournisseur inconnu.
 *
 * Volontairement pessimistes. Le sens de l'erreur compte : refuser à tort coûte
 * une question au fondateur, accepter à tort coûte une mission — et, pour
 * l'inférence, une mission dont les réponses sont inexploitables mais facturées.
 */
export const UNKNOWN_CAPABILITIES: InferenceCapabilities = {
  structuredOutput: false,
  toolUse: false,
  serverTools: false,
  contextWindow: 0,
  maxOutputTokens: 0,
  models: [],
  caveat: "Fournisseur non répertorié : ses capacités n'ont pas été établies.",
};

export const ANTHROPIC_CAPABILITIES: InferenceCapabilities = {
  structuredOutput: true,
  toolUse: true,
  serverTools: true,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  models: ['claude-'],
  caveat: null,
};

/**
 * Un point d'accès compatible OpenAI — Ollama local, vLLM, OpenRouter, autre.
 *
 * Déclaré prudemment parce que la famille est hétérogène : `structuredOutput`
 * et `toolUse` dépendent du modèle servi, pas du protocole. Annoncer des
 * capacités que l'instance n'a pas ferait échouer les missions au lieu de les
 * router ailleurs, ce qui est pire que de la sous-utiliser.
 */
export const OPENAI_COMPATIBLE_CAPABILITIES: InferenceCapabilities = {
  structuredOutput: false,
  toolUse: false,
  serverTools: false,
  contextWindow: 32_000,
  maxOutputTokens: 4_096,
  models: ['*'],
  caveat:
    "Capacités dépendantes du modèle servi par l'instance. Déclarées au minimum : " +
    'un fournisseur qui promet plus qu\'il ne tient fait échouer les missions au lieu de les router ailleurs.',
};

/**
 * Le fournisseur simulé.
 *
 * Capable de tout, gratuit, instantané — et c'est précisément ce qui le rend
 * dangereux comme secours. Il ne doit jamais servir de repli en mode réel : une
 * bascule silencieuse vers lui produirait des données métier fabriquées,
 * facturées zéro, indiscernables de vraies dans le rapport final. Le registre
 * l'écarte structurellement du routage réel ; ces capacités ne servent qu'au
 * mode simulation assumé.
 */
export const SIMULATION_CAPABILITIES: InferenceCapabilities = {
  structuredOutput: true,
  toolUse: true,
  serverTools: false,
  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  models: ['*'],
  caveat: 'Réponses fabriquées localement. Aucune valeur informative.',
};

// ─── Adéquation à une requête donnée ────────────────────────────────────────

export type InferenceSuitabilityVerdict = 'suitable' | 'degraded' | 'unsuitable';

export interface InferenceSuitability {
  verdict: InferenceSuitabilityVerdict;
  /** Ce qui manque, s'il manque quelque chose. */
  gaps: string[];
  detail: string;
}

const matchesModel = (model: string, patterns: string[]): boolean =>
  patterns.includes('*') || patterns.some((p) => model.toLowerCase().startsWith(p.toLowerCase()));

/**
 * Ce fournisseur peut-il servir cette requête ?
 *
 * Trois issues plutôt que deux. `degraded` existe parce qu'un fournisseur peut
 * convenir en tout sauf sur un point secondaire — une fenêtre un peu courte
 * pour un contexte confortable, par exemple. Ce n'est pas un refus, c'est un
 * avertissement à porter jusqu'au rapport.
 *
 * Ce qui rend une requête impossible à servir, en revanche, est structurel : un
 * schéma JSON demandé à un fournisseur qui n'en produit pas ne s'arrange pas
 * avec un réglage.
 */
export function assessInferenceSuitability(
  capabilities: InferenceCapabilities,
  request: Pick<LlmRequest, 'model' | 'jsonSchema' | 'tools' | 'serverTools' | 'maxTokens'> & {
    estimatedInputTokens?: number;
  },
): InferenceSuitability {
  const gaps: string[] = [];
  let structural = false;

  if (request.jsonSchema && !capabilities.structuredOutput) {
    gaps.push('ne produit pas de sortie structurée');
    structural = true;
  }
  if ((request.tools?.length ?? 0) > 0 && !capabilities.toolUse) {
    gaps.push("n'accepte pas d'outils");
    structural = true;
  }
  if ((request.serverTools?.length ?? 0) > 0 && !capabilities.serverTools) {
    gaps.push("n'exécute pas d'outils de son côté");
    structural = true;
  }
  if (!matchesModel(request.model, capabilities.models)) {
    gaps.push(`ne sert pas le modèle « ${request.model} »`);
    structural = true;
  }

  // La fenêtre de contexte : structurelle si l'entrée seule ne tient pas,
  // simplement dégradée si c'est la sortie souhaitée qui déborde — une réponse
  // plus courte reste une réponse.
  const input = request.estimatedInputTokens ?? 0;
  if (capabilities.contextWindow > 0 && input > capabilities.contextWindow) {
    gaps.push(
      `fenêtre de ${capabilities.contextWindow.toLocaleString('fr-FR')} jetons trop courte pour ` +
        `${input.toLocaleString('fr-FR')} en entrée`,
    );
    structural = true;
  }
  if (capabilities.maxOutputTokens > 0 && request.maxTokens > capabilities.maxOutputTokens) {
    gaps.push(
      `sortie plafonnée à ${capabilities.maxOutputTokens.toLocaleString('fr-FR')} jetons, ` +
        `${request.maxTokens.toLocaleString('fr-FR')} demandés`,
    );
  }

  const verdict: InferenceSuitabilityVerdict =
    gaps.length === 0 ? 'suitable' : structural ? 'unsuitable' : 'degraded';

  return {
    verdict,
    gaps,
    detail:
      verdict === 'suitable'
        ? 'couvre ce que la requête demande.'
        : `${gaps.join(' · ')}.` + (capabilities.caveat ? ` ${capabilities.caveat}` : ''),
  };
}
