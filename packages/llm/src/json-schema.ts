/**
 * Ce qu'un schéma de sortie structurée a le droit de contenir.
 *
 * L'API de sortie structurée d'Anthropic n'accepte pas le JSON Schema complet :
 * elle rejette la requête entière, avant toute inférence, dès qu'un mot-clé
 * n'est pas supporté. C'est ce qui a fait échouer LIVE #001 — un `maxItems`
 * dans le schéma de découverte a suffi pour que chaque recherche soit refusée
 * en 400, sans qu'aucune protection ne s'en aperçoive.
 *
 * La leçon n'est pas « retirer maxItems » : c'est qu'un schéma refusé par le
 * fournisseur doit être détecté chez nous, pas en production. D'où deux pièces
 * complémentaires :
 *
 *  • {@link validateStructuredSchema} — utilisée par les tests. Elle refuse
 *    tout mot-clé hors liste blanche et nomme le chemin fautif, si bien qu'un
 *    schéma incompatible casse la CI et non une mission facturée.
 *  • {@link sanitiseStructuredSchema} — utilisée par le provider. Elle retire
 *    les mots-clés non structurels avant l'envoi. Une contrainte oubliée coûte
 *    alors une validation en moins, jamais une mission entière.
 *
 * La liste blanche est délibérément une liste *blanche*. Nous n'avons observé
 * qu'un seul refus réel (`maxItems`), et deviner la liste noire complète
 * reviendrait à réintroduire le même risque au prochain mot-clé. Autoriser ce
 * qui porte la structure et écarter le reste est le seul choix qui reste sûr
 * face à un mot-clé qu'on n'a pas encore rencontré.
 *
 * Ne s'applique qu'aux sorties structurées (`output_config.format`). Les
 * schémas d'entrée d'outils passent par `tools[].input_schema`, qui accepte le
 * JSON Schema ordinaire — ils fonctionnaient pendant LIVE #001 et ne sont pas
 * concernés.
 */

/**
 * Mots-clés qui portent la structure d'un schéma : les retirer changerait ce
 * que le modèle doit produire.
 */
const STRUCTURAL_KEYWORDS = new Set([
  'type',
  'properties',
  'items',
  'required',
  'additionalProperties',
  'enum',
  'const',
  'description',
  'title',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  '$ref',
  '$defs',
  'definitions',
  'nullable',
]);

/**
 * Mots-clés de contrainte : ils affinent une valeur sans changer la forme
 * attendue. Ce sont eux que l'API refuse, et les retirer ne coûte qu'une
 * validation — la `description` porte déjà la consigne au modèle.
 */
const CONSTRAINT_KEYWORDS = new Set([
  'maxItems',
  'minItems',
  'uniqueItems',
  'maxLength',
  'minLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'maxProperties',
  'minProperties',
  'format',
  'default',
  'examples',
  'contains',
  'maxContains',
  'minContains',
  'dependentRequired',
  'propertyNames',
  'patternProperties',
]);

export interface SchemaViolation {
  /** Où le mot-clé se trouve, en notation pointée depuis la racine. */
  path: string;
  keyword: string;
  reason: string;
}

export interface SchemaValidation {
  ok: boolean;
  violations: SchemaViolation[];
}

/**
 * Vérifie qu'un schéma ne contient que ce qu'une sortie structurée accepte.
 *
 * Destinée aux tests : elle décrit précisément quoi retirer et où.
 */
export function validateStructuredSchema(schema: unknown, path = '$'): SchemaValidation {
  const violations: SchemaViolation[] = [];
  walk(schema, path, violations);
  return { ok: violations.length === 0, violations };
}

function walk(node: unknown, path: string, violations: SchemaViolation[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, `${path}[${index}]`, violations));
    return;
  }
  if (!node || typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // Sous `properties`, les clés sont des noms de champs choisis par le
    // domaine, jamais des mots-clés de schéma : `properties.maxItems` serait
    // un champ légitime nommé « maxItems ».
    if (key === 'properties' || key === '$defs' || key === 'definitions') {
      if (value && typeof value === 'object') {
        for (const [field, sub] of Object.entries(value as Record<string, unknown>)) {
          walk(sub, `${path}.${key}.${field}`, violations);
        }
      }
      continue;
    }

    if (CONSTRAINT_KEYWORDS.has(key)) {
      violations.push({
        path: `${path}.${key}`,
        keyword: key,
        reason:
          "Mot-clé de contrainte refusé par output_config.format. Exprimez la consigne dans « description ».",
      });
      continue;
    }
    if (!STRUCTURAL_KEYWORDS.has(key)) {
      violations.push({
        path: `${path}.${key}`,
        keyword: key,
        reason: 'Mot-clé hors liste blanche : sa prise en charge par le fournisseur est inconnue.',
      });
      continue;
    }

    walk(value, `${path}.${key}`, violations);
  }
}

/**
 * Retire ce que l'API n'accepte pas, en préservant la structure.
 *
 * Appliquée par le provider juste avant l'envoi : c'est le filet qui garantit
 * qu'un schéma passé au travers des tests ne peut plus faire échouer une
 * mission réelle.
 */
export function sanitiseStructuredSchema<T>(schema: T): T {
  return prune(schema) as T;
}

function prune(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(prune);
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'properties' || key === '$defs' || key === 'definitions') {
      const fields: Record<string, unknown> = {};
      for (const [field, sub] of Object.entries((value ?? {}) as Record<string, unknown>)) {
        fields[field] = prune(sub);
      }
      out[key] = fields;
      continue;
    }
    if (CONSTRAINT_KEYWORDS.has(key) || !STRUCTURAL_KEYWORDS.has(key)) continue;
    out[key] = prune(value);
  }
  return out;
}

/** Les listes, exposées pour que les tests décrivent ce qu'ils vérifient. */
export const SCHEMA_KEYWORDS = {
  structural: STRUCTURAL_KEYWORDS,
  constraint: CONSTRAINT_KEYWORDS,
} as const;
