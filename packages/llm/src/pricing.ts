/**
 * Ce qu'un appel coûte réellement.
 *
 * ATLAS ne comptait qu'un total de jetons, facturé à un tarif mélangé. Cela
 * suffisait à dire qu'une mission avait coûté cher, jamais à dire *pourquoi* :
 * un tarif unique ne distingue pas un long contexte relu vingt fois d'une
 * réponse longue, alors que ce sont deux problèmes opposés — le premier se
 * règle par du cache, le second par un modèle moins cher.
 *
 * Les tarifs ci-dessous sont ceux du déploiement, pas une vérité gravée : ils
 * se règlent sans redéploiement, et un modèle inconnu rend `null` plutôt qu'une
 * estimation inventée.
 */

export interface ModelPricing {
  /** USD par million de jetons d'entrée. */
  input: number;
  /** USD par million de jetons de sortie. */
  output: number;
  /** Lecture de cache : nettement moins chère qu'une entrée ordinaire. */
  cacheRead: number;
  /** Écriture de cache : plus chère qu'une entrée, amortie sur les appels suivants. */
  cacheWrite: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

/**
 * Tarif mélangé historique, en USD par million de jetons.
 *
 * Conservé pour les missions antérieures à la télémétrie par appel : elles
 * n'ont qu'un total de jetons, et le recalculer avec une répartition
 * entrée/sortie inventée réécrirait leur coût après coup. LIVE #001 garde donc
 * le chiffre sous lequel il a été constaté.
 */
export const BLENDED_PRICES_USD_PER_MTOK: Record<string, number> = {
  'claude-opus-5': 18,
  'claude-sonnet-5': 6,
  'claude-haiku-4-5-20251001': 1.6,
};

/**
 * Un appel simulé est gratuit, et doit le rester dans toute la comptabilité.
 *
 * Le provider de simulation nomme son modèle « claude-sonnet-5 (simulation) »
 * pour que les journaux disent sur quoi la mission a tourné. La résolution par
 * préfixe y reconnaissait un vrai Sonnet et le facturait au tarif réel : la
 * mission de démonstration affichait 1,07 $ sans qu'un centime ait été dépensé.
 *
 * Deux conséquences, la seconde plus grave que la première. Un chiffre faux au
 * tableau de bord — et une somme fictive décomptée du plafond de mission, si
 * bien qu'une démonstration un peu longue se serait arrêtée pour épuisement
 * d'un budget qu'elle n'avait jamais entamé.
 */
export const SIMULATED_MODEL_MARKER = '(simulation)';

export const isSimulatedModel = (model: string): boolean => model.includes(SIMULATED_MODEL_MARKER);

/** Tarif nul : chaque poste à zéro, plutôt qu'une absence de tarif. */
const FREE_PRICING: ModelPricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Résout un tarif en tolérant les identifiants de modèle datés. */
export function pricingFor(model: string): ModelPricing | null {
  // Avant toute résolution par préfixe : c'est elle qui confondait les deux.
  if (isSimulatedModel(model)) return FREE_PRICING;

  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key)) return pricing;
  }
  return null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Le coût d'un appel, à partir de sa consommation réelle.
 *
 * Les jetons lus en cache sont comptés à leur propre tarif et *retirés* de
 * l'entrée facturable : le fournisseur les rapporte séparément, les compter
 * deux fois gonflerait le coût des missions qui bénéficient le mieux du cache.
 */
export function costOfCall(usage: TokenUsage, model: string): number | null {
  const pricing = pricingFor(model);
  if (!pricing) return null;

  const billableInput = Math.max(0, usage.inputTokens);
  const usd =
    (billableInput / 1_000_000) * pricing.input +
    (usage.outputTokens / 1_000_000) * pricing.output +
    (usage.cacheReadTokens / 1_000_000) * pricing.cacheRead +
    (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWrite;

  return round6(usd);
}

/**
 * Le coût qu'un appel *pourrait* atteindre, avant de le lancer.
 *
 * C'est ce chiffre qui autorise ou refuse un appel : on ne peut pas décider
 * après coup. Volontairement pessimiste — il suppose la sortie pleine, car un
 * plafond calculé sur une sortie moyenne serait dépassé la moitié du temps.
 */
export function worstCaseCostUsd(
  model: string,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): number | null {
  const pricing = pricingFor(model);
  if (!pricing) return null;
  return round6(
    (estimatedInputTokens / 1_000_000) * pricing.input +
      (maxOutputTokens / 1_000_000) * pricing.output,
  );
}

const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;
