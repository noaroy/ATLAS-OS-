import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPricingConfig, validateEntry, reloadPricingConfig, pricingFor } from '../src/index.ts';

/**
 * Déclarer un tarif sans toucher au code — sans pouvoir se mentir non plus.
 *
 * Le fichier existe pour débloquer un modèle sans tarif. Le risque est donc
 * exactement l'inverse du problème qu'il résout : qu'on y écrive n'importe
 * quoi, que l'entrée soit à moitié acceptée, et qu'ATLAS se croie autorisé à
 * dépenser sur la foi d'un chiffre que personne n'a vérifié.
 */

const dirs: string[] = [];
const configFile = (contenu: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-pricing-'));
  dirs.push(dir);
  const file = join(dir, 'pricing.json');
  writeFileSync(file, typeof contenu === 'string' ? contenu : JSON.stringify(contenu), 'utf8');
  return file;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  reloadPricingConfig(undefined);
});

const complet = {
  provider: 'OPENAI',
  model: 'gpt-5',
  input_per_million: 1.25,
  output_per_million: 10,
  cached_input_per_million: 0.125,
  effective_from: '2026-01-01',
  source: 'https://exemple.invalid/tarifs',
};

describe('le fichier de tarifs déclarés', () => {
  test('aucun fichier déclaré n’est le cas normal, pas une erreur', () => {
    const result = loadPricingConfig(undefined);
    assert.equal(result.path, null);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.entries.size, 0);
  });

  test('un fichier déclaré mais introuvable est rapporté', () => {
    // Le découvrir au moment de la dépense serait trop tard.
    const result = loadPricingConfig(join(tmpdir(), 'nexiste-pas-atlas.json'));
    assert.equal(result.entries.size, 0);
    assert.match(result.rejected[0]!.reason, /introuvable/);
  });

  test('un JSON illisible ne rend pas un tarif vide en silence', () => {
    const result = loadPricingConfig(configFile('{ ceci n est pas du json'));
    assert.equal(result.entries.size, 0);
    assert.match(result.rejected[0]!.reason, /JSON illisible/);
  });

  test('une entrée complète est chargée', () => {
    const result = loadPricingConfig(configFile([complet]));
    const entry = result.entries.get('gpt-5');
    assert.ok(entry);
    assert.equal(entry.pricing.input, 1.25);
    assert.equal(entry.pricing.output, 10);
    assert.equal(entry.pricing.cacheRead, 0.125);
    assert.equal(entry.source, 'https://exemple.invalid/tarifs');
  });

  test('un tarif sans provenance est refusé', () => {
    // Un tarif inventé est pire qu'un tarif absent : l'absence bloque.
    const { source, ...sansSource } = complet;
    const result = loadPricingConfig(configFile([sansSource]));
    assert.equal(result.entries.size, 0);
    assert.match(result.rejected[0]!.reason, /provenance|source/);
  });

  test('un champ manquant rejette l’entrée au lieu de la compléter par zéro', () => {
    const { output_per_million, ...sansSortie } = complet;
    const result = loadPricingConfig(configFile([sansSortie]));
    assert.equal(result.entries.size, 0, 'aucune entrée à moitié valide');
    assert.match(result.rejected[0]!.reason, /output_per_million/);
  });

  test('un tarif négatif est refusé', () => {
    const result = loadPricingConfig(configFile([{ ...complet, input_per_million: -1 }]));
    assert.equal(result.entries.size, 0);
  });

  test('un tarif daté du futur n’est pas encore le tarif', () => {
    const result = loadPricingConfig(
      configFile([{ ...complet, effective_from: '2099-01-01' }]),
      new Date('2026-08-25'),
    );
    assert.equal(result.entries.size, 0);
    assert.match(result.rejected[0]!.reason, /vigueur/);
  });

  test('entre deux dates en vigueur, la plus récente gagne', () => {
    const result = loadPricingConfig(
      configFile([
        { ...complet, input_per_million: 5, effective_from: '2025-01-01' },
        { ...complet, input_per_million: 2, effective_from: '2026-06-01' },
      ]),
      new Date('2026-08-25'),
    );
    assert.equal(result.entries.get('gpt-5')!.pricing.input, 2);
  });

  test('des tarifs de cache non déclarés sont facturés au plus cher, jamais à zéro', () => {
    // Surestimer arrête trop tôt, ce qui se voit. Sous-estimer laisse filer.
    const verdict = validateEntry({
      provider: 'OPENAI', model: 'gpt-x', input_per_million: 1,
      output_per_million: 10, effective_from: '2026-01-01', source: 'facture #12',
    });
    assert.ok(verdict.ok);
    assert.equal(verdict.loaded.pricing.cacheRead, 10, 'aligné sur la sortie');
    assert.equal(verdict.loaded.pricing.cacheWrite, 10);
    assert.equal(verdict.loaded.cachePricesAssumed, true, 'la prudence est signalée');
  });

  test('un objet avec une clé « models » est accepté comme un tableau', () => {
    const result = loadPricingConfig(configFile({ models: [complet] }));
    assert.equal(result.entries.size, 1);
  });
});

describe('la résolution du tarif', () => {
  test('sans déclaration, un modèle inconnu reste inconnu', () => {
    reloadPricingConfig(undefined);
    assert.equal(pricingFor('gpt-5'), null, 'aucun tarif inventé');
  });

  test('une déclaration débloque le modèle sans modifier le code', () => {
    reloadPricingConfig(configFile([complet]));
    const pricing = pricingFor('gpt-5');
    assert.ok(pricing);
    assert.equal(pricing.input, 1.25);
  });

  test('la déclaration prime sur la table livrée', () => {
    // La table est un instantané du jour de la livraison ; le fichier est daté
    // et sourcé. C'est le second qui fait foi.
    reloadPricingConfig(configFile([{
      ...complet, model: 'claude-sonnet-5', provider: 'ANTHROPIC',
      input_per_million: 99, output_per_million: 99,
    }]));
    assert.equal(pricingFor('claude-sonnet-5')!.input, 99);
  });

  test('un modèle simulé reste gratuit malgré toute déclaration', () => {
    reloadPricingConfig(configFile([complet]));
    const pricing = pricingFor('claude-sonnet-5 (simulation)');
    assert.equal(pricing!.input, 0);
    assert.equal(pricing!.output, 0);
  });
});

describe('le fichier de tarifs déclaré à la racine du dépôt', () => {
  // `gpt-5` n'a pas de tarif dans la table livrée (voir pricing.ts) ; le
  // fichier à la racine est ce qui le débloque, sans redéploiement, une fois
  // que ATLAS_MODEL_PRICING_CONFIG le désigne. Ce test vérifie que le fichier
  // lui-même reste valide — un JSON cassé ou un champ manquant s'y verrait
  // immédiatement, plutôt que de le découvrir en production au moment de
  // constater qu'un appel réel reste UNKNOWN_PRICE.
  const path = fileURLToPath(new URL('../../../model-pricing.json', import.meta.url));

  afterEach(() => reloadPricingConfig(undefined));

  test('le fichier est un JSON valide, sans entrée rejetée', () => {
    const result = loadPricingConfig(path);
    assert.deepEqual(result.rejected, []);
    assert.ok(result.entries.size > 0);
  });

  test('gpt-5 et ses identifiants datés résolvent vers le même tarif déclaré', () => {
    reloadPricingConfig(path);
    const base = pricingFor('gpt-5');
    assert.ok(base, 'gpt-5 doit être débloqué par le fichier');
    // Le fournisseur rend un identifiant daté (« gpt-5-2025-08-07 » observé en
    // conditions réelles) ; la résolution par préfixe doit le couvrir sans
    // déclarer chaque snapshot séparément.
    assert.deepEqual(pricingFor('gpt-5-2025-08-07'), base);
  });
});
