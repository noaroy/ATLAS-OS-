import { AtlasError } from '@atlas/core';
import { isSimulatedModel } from './pricing.ts';

/**
 * Quels modèles ce déploiement accepte d'appeler.
 *
 * Le preflight annonçait « aucun modèle interdit : rien n'empêche d'appeler le
 * plus cher », et c'était exact. Un réglage changé dans la console, une variable
 * d'environnement oubliée, un agent portant son propre `model` — trois chemins
 * différents menaient au modèle le plus coûteux pour un travail d'extraction.
 * Opus facture dix-huit fois le tarif de Haiku ; l'écart entre une mission à
 * 0,04 $ et la même à 0,72 $ tient à un mot dans un fichier de configuration.
 *
 * La règle vit donc sous les appels, dans le décorateur que tout le monde
 * traverse, et non dans une vérification que chaque appelant devrait penser à
 * faire. C'est le même déplacement que pour le budget, pour la même raison :
 * il n'y a plus d'oubli possible, seulement une fraude délibérée.
 *
 * Deux listes, et l'interdiction l'emporte toujours :
 *
 *   `forbidden` — jamais appelé, quelle que soit la configuration par ailleurs.
 *   `allowed`   — si la liste n'est pas vide, seuls ces modèles passent.
 *
 * Une liste d'autorisation vide signifie « tout sauf les interdits ». C'est le
 * réglage permissif, adapté au développement ; une mission réelle devrait
 * toujours énumérer ce qu'elle s'autorise.
 */

export interface ModelPolicy {
  /** Modèles autorisés. Vide = tous, hors interdits. */
  allowed: string[];
  /** Modèles refusés, quoi qu'il arrive. */
  forbidden: string[];
}

export const PERMISSIVE_POLICY: ModelPolicy = { allowed: [], forbidden: [] };

/** Correspondance par préfixe : `claude-opus` attrape `claude-opus-5-20260101`. */
const matches = (model: string, pattern: string): boolean =>
  model.toLowerCase().startsWith(pattern.toLowerCase()) ||
  model.toLowerCase().includes(pattern.toLowerCase());

export function isModelAllowed(model: string, policy: ModelPolicy): boolean {
  // Un modèle simulé ne coûte rien et ne quitte pas la machine : le refuser
  // empêcherait toute démonstration sans protéger quoi que ce soit.
  if (isSimulatedModel(model)) return true;

  if (policy.forbidden.some((pattern) => matches(model, pattern))) return false;
  if (policy.allowed.length === 0) return true;
  return policy.allowed.some((pattern) => matches(model, pattern));
}

/**
 * Refuse un modèle non autorisé, avant que l'appel ne parte.
 *
 * Non réessayable : reprendre le même appel avec le même modèle donnerait le
 * même refus, et chaque tentative repaierait le contexte accumulé.
 */
export function assertModelAllowed(model: string, policy: ModelPolicy): void {
  if (isModelAllowed(model, policy)) return;

  const reason = policy.forbidden.some((pattern) => matches(model, pattern))
    ? `« ${model} » figure parmi les modèles interdits (${policy.forbidden.join(', ')})`
    : `« ${model} » ne figure pas parmi les modèles autorisés (${policy.allowed.join(', ')})`;

  throw new AtlasError(
    'INVALID_STATE',
    `Appel refusé : ${reason}. ` +
      "Ce refus est appliqué sous les appels, pas au-dessus : aucun réglage de console, " +
      "aucune variable d'environnement et aucun modèle propre à un agent ne peut le contourner.",
    { retryable: false },
  );
}

/** Résume la politique pour un rapport lisible. */
export function describePolicy(policy: ModelPolicy): string {
  if (policy.allowed.length > 0 && policy.forbidden.length > 0) {
    return `${policy.allowed.join(', ')} autorisé(s) · ${policy.forbidden.join(', ')} interdit(s)`;
  }
  if (policy.allowed.length > 0) return `${policy.allowed.join(', ')} uniquement`;
  if (policy.forbidden.length > 0) return `${policy.forbidden.join(', ')} interdit(s)`;
  return 'aucune restriction — le modèle le plus cher reste appelable';
}
