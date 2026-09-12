import { readFileSync, existsSync } from 'node:fs';
import type { ModelPricing } from './pricing.ts';

/**
 * Déclarer un tarif sans toucher au code.
 *
 * Le besoin est concret : `gpt-5` n'a pas de tarif dans la table livrée, donc
 * toute chaîne qui l'emploie est arrêtée par `COST_UNKNOWN_BLOCKED`. C'est le
 * comportement voulu — mais le débloquer ne doit pas demander de modifier une
 * source et de redéployer. Un fichier déclaré par `ATLAS_MODEL_PRICING_CONFIG`
 * suffit.
 *
 * Trois règles gouvernent la lecture, et chacune répare une façon précise de se
 * mentir sur la dépense :
 *
 * 1. Une entrée invalide est *rejetée*, jamais rattrapée. Un champ manquant qui
 *    vaudrait zéro par défaut transformerait « je ne sais pas » en « c'est
 *    gratuit » — exactement l'erreur que tout le reste du système s'applique à
 *    ne pas commettre.
 *
 * 2. Une provenance est obligatoire. Un tarif sans source est un tarif inventé,
 *    et un tarif inventé est pire qu'un tarif absent : l'absence bloque, la
 *    fiction laisse dépenser.
 *
 * 3. Ce qui n'est pas déclaré est facturé au tarif le plus cher connu de
 *    l'entrée, jamais au moins cher. Un garde-fou budgétaire qui sous-estime
 *    s'ouvre en silence ; un qui surestime s'arrête trop tôt, ce qui se voit et
 *    se corrige.
 */

export interface PricingConfigEntry {
  provider: string;
  model: string;
  input_per_million: number;
  output_per_million: number;
  /** Facultatif. Absent, les jetons de cache sont facturés au tarif de sortie. */
  cached_input_per_million?: number;
  /** Facultatif. Même règle prudente que ci-dessus. */
  cache_write_per_million?: number;
  /** Date ISO à partir de laquelle ce tarif s'applique. */
  effective_from: string;
  /** D'où vient ce chiffre. Une URL, une référence de facture, un devis. */
  source: string;
}

export interface LoadedPricing {
  pricing: ModelPricing;
  provider: string;
  effectiveFrom: string;
  source: string;
  /**
   * Vrai quand les tarifs de cache n'étaient pas déclarés et ont été alignés
   * sur la sortie. Le chiffre reste sûr, mais il surestime : le signaler évite
   * qu'on prenne cette prudence pour une mesure.
   */
  cachePricesAssumed: boolean;
}

export interface PricingConfigResult {
  entries: Map<string, LoadedPricing>;
  /** Ce qui a été refusé, et pourquoi. Toujours rapporté, jamais avalé. */
  rejected: Array<{ model: string; reason: string }>;
  /** Le fichier lu, ou `null` si aucun n'était déclaré. */
  path: string | null;
}

const EMPTY: PricingConfigResult = { entries: new Map(), rejected: [], path: null };

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Valide une entrée. Rend le tarif, ou la raison du refus — jamais un
 * demi-tarif complété par des zéros.
 */
export function validateEntry(
  raw: unknown,
): { ok: true; model: string; loaded: LoadedPricing } | { ok: false; model: string; reason: string } {
  const e = raw as Partial<PricingConfigEntry>;
  const model = typeof e?.model === 'string' && e.model.trim() ? e.model.trim() : '(sans nom)';

  if (model === '(sans nom)') return { ok: false, model, reason: 'champ « model » absent ou vide' };
  if (typeof e.provider !== 'string' || !e.provider.trim()) {
    return { ok: false, model, reason: 'champ « provider » absent ou vide' };
  }
  if (!isFiniteNumber(e.input_per_million)) {
    return { ok: false, model, reason: '« input_per_million » doit être un nombre positif' };
  }
  if (!isFiniteNumber(e.output_per_million)) {
    return { ok: false, model, reason: '« output_per_million » doit être un nombre positif' };
  }
  if (e.cached_input_per_million !== undefined && !isFiniteNumber(e.cached_input_per_million)) {
    return { ok: false, model, reason: '« cached_input_per_million » doit être un nombre positif' };
  }
  if (e.cache_write_per_million !== undefined && !isFiniteNumber(e.cache_write_per_million)) {
    return { ok: false, model, reason: '« cache_write_per_million » doit être un nombre positif' };
  }
  if (typeof e.source !== 'string' || !e.source.trim()) {
    return {
      ok: false, model,
      reason: 'champ « source » absent : un tarif sans provenance est un tarif inventé',
    };
  }
  if (typeof e.effective_from !== 'string' || Number.isNaN(Date.parse(e.effective_from))) {
    return { ok: false, model, reason: '« effective_from » doit être une date ISO' };
  }

  // Non déclaré n'est pas gratuit : on aligne sur la sortie, le poste le plus
  // cher, pour que l'incertitude coûte plutôt qu'elle ne dispense.
  const cachePricesAssumed =
    e.cached_input_per_million === undefined || e.cache_write_per_million === undefined;

  return {
    ok: true,
    model,
    loaded: {
      pricing: {
        input: e.input_per_million,
        output: e.output_per_million,
        cacheRead: e.cached_input_per_million ?? e.output_per_million,
        cacheWrite: e.cache_write_per_million ?? e.output_per_million,
      },
      provider: e.provider.trim(),
      effectiveFrom: e.effective_from,
      source: e.source.trim(),
      cachePricesAssumed,
    },
  };
}

/**
 * Lit le fichier de tarifs déclaré par `ATLAS_MODEL_PRICING_CONFIG`.
 *
 * Un fichier absent n'est pas une erreur : c'est le cas normal tant que le
 * propriétaire n'a rien déclaré, et le système continue de bloquer les modèles
 * sans tarif. Un fichier *présent mais illisible* en est une, et elle est
 * rapportée — la découvrir au moment de la dépense serait trop tard.
 */
export function loadPricingConfig(
  path: string | undefined = process.env.ATLAS_MODEL_PRICING_CONFIG,
  now: Date = new Date(),
): PricingConfigResult {
  const file = path?.trim();
  if (!file) return EMPTY;
  if (!existsSync(file)) {
    return { entries: new Map(), rejected: [{ model: '(fichier)', reason: `introuvable : ${file}` }], path: file };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return {
      entries: new Map(), path: file,
      rejected: [{ model: '(fichier)', reason: `JSON illisible : ${err instanceof Error ? err.message : err}` }],
    };
  }

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { models?: unknown })?.models)
      ? (parsed as { models: unknown[] }).models
      : null;
  if (!list) {
    return {
      entries: new Map(), path: file,
      rejected: [{ model: '(fichier)', reason: 'attendu : un tableau, ou un objet avec une clé « models »' }],
    };
  }

  const entries = new Map<string, LoadedPricing>();
  const rejected: Array<{ model: string; reason: string }> = [];

  for (const raw of list) {
    const verdict = validateEntry(raw);
    if (!verdict.ok) {
      rejected.push({ model: verdict.model, reason: verdict.reason });
      continue;
    }
    // Un tarif daté du futur n'est pas encore le tarif. L'appliquer d'avance
    // ferait facturer aujourd'hui au prix de demain.
    if (Date.parse(verdict.loaded.effectiveFrom) > now.getTime()) {
      rejected.push({
        model: verdict.model,
        reason: `entre en vigueur le ${verdict.loaded.effectiveFrom.slice(0, 10)}, pas encore applicable`,
      });
      continue;
    }
    const existing = entries.get(verdict.model);
    // Plusieurs dates pour un même modèle : la plus récente déjà en vigueur.
    if (!existing || Date.parse(verdict.loaded.effectiveFrom) >= Date.parse(existing.effectiveFrom)) {
      entries.set(verdict.model, verdict.loaded);
    }
  }

  return { entries, rejected, path: file };
}
