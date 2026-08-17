import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@atlas/core';
import { createRepositories, type Repositories } from '@atlas/data';
import { RegistryDiscoveryProvider } from '../src/discovery/registry.ts';

/**
 * La lignée des données, et le blanchiment qu'elle empêche.
 *
 * VAL-003 — mission réelle — a rendu dix candidats dont quatre fabriqués lors
 * d'une démonstration cinq jours plus tôt. Le registre de découverte relisait
 * la table `companies` et rendait tout ce qui correspondait au pays et au
 * secteur ; il n'avait aucun moyen de savoir d'où venait une fiche. Les preuves
 * produites portaient `simulated = 0`, puisque la mission *courante* était
 * réelle : la donnée fabriquée se blanchissait au passage.
 *
 * Le préfixe « [SIMULÉ] » du nom existait pendant tout l'incident. Il n'a rien
 * empêché et ne pouvait rien empêcher — c'est un affichage, pas une contrainte.
 * Aucun test de ce fichier ne s'y réfère, et c'est délibéré.
 */

const logger = createLogger({ level: 'error', pretty: false });
let repos: Repositories;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-prov-'));
  repos = createRepositories(join(dir, 'p.db'), logger);
});

afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Une entreprise connue d'ATLAS, avec la lignée que le test décide. */
function knownCompany(
  name: string,
  dataOrigin: 'live' | 'simulated' | 'unknown' | undefined,
  options: { domain?: string } = {},
) {
  const { company } = repos.companies.upsert({
    canonicalKey: `d:${options.domain ?? name.toLowerCase().replace(/\W/g, '')}`,
    name,
    country: 'Allemagne',
    domain: options.domain ?? `${name.toLowerCase().replace(/\W/g, '')}.de`,
    industries: ['Équipement industriel'],
    enriched: true,
    ...(dataOrigin ? { dataOrigin } : {}),
  });
  repos.companies.markVerified(company.id);
  return company;
}

const QUERY = {
  countries: ['Allemagne'],
  industries: ['Équipement industriel'],
  targetTypes: ['distributor'],
  limit: 10,
  keywords: [],
  exclusions: [],
};

const discover = async (mode: 'live' | 'simulation') => {
  const provider = new RegistryDiscoveryProvider(repos, mode);
  return provider.search(QUERY as never, { logger } as never);
};

describe('barrière de lignée du registre', () => {
  test('une entreprise simulée est exclue en mode réel', async () => {
    // Le cas exact de VAL-003.
    knownCompany('SudAutomation', 'simulated', { domain: 'sim-1055.example' });

    const result = await discover('live');
    assert.equal(result.candidates.length, 0, 'aucune fiche fabriquée ne doit ressortir');
  });

  test('une entreprise simulée reste utilisable en mode simulation', async () => {
    // Une démonstration doit continuer de fonctionner : la barrière protège le
    // réel, elle n'interdit pas de simuler.
    knownCompany('SudAutomation', 'simulated', { domain: 'sim-1055.example' });

    const result = await discover('simulation');
    assert.equal(result.candidates.length, 1);
  });

  test('une entreprise réelle est bien rendue en mode réel', async () => {
    // La barrière ne doit pas casser ce qu'elle protège : une fiche réelle
    // réutilisée est la source la moins chère dont ATLAS dispose.
    knownCompany('Lilie GmbH', 'live', { domain: 'lilie-gmbh.de' });

    const result = await discover('live');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.name, 'Lilie GmbH');
  });

  test('une provenance inconnue est refusée en mode réel', async () => {
    // Une fiche dont on ne sait rien n'est pas présumée bonne. Le sens de
    // l'erreur compte : refuser à tort coûte une question, accepter à tort
    // coûte la confiance dans tout le reste.
    knownCompany('Ambiguë GmbH', undefined, { domain: 'ambigue.de' });

    const result = await discover('live');
    assert.equal(result.candidates.length, 0);
  });

  test('le préfixe du nom n’est jamais une règle de sécurité', async () => {
    // Une fiche fabriquée dont le nom aurait été nettoyé doit rester exclue, et
    // une fiche réelle nommée « [SIMULÉ] … » doit rester admise. Seule la
    // colonne décide.
    knownCompany('Parfaitement Normale GmbH', 'simulated', { domain: 'normale.de' });
    knownCompany('[SIMULÉ] Mal Nommée GmbH', 'live', { domain: 'mal-nommee.de' });

    const result = await discover('live');
    assert.equal(result.candidates.length, 1);
    assert.equal(
      result.candidates[0]!.name,
      '[SIMULÉ] Mal Nommée GmbH',
      'le nom ne décide de rien — seule la lignée décide',
    );
  });
});

describe('la lignée ne se blanchit pas', () => {
  test('une mission réelle ne transforme pas une fiche simulée en réelle', () => {
    // Le blanchiment que toute cette colonne existe pour empêcher.
    const simulated = knownCompany('SudAutomation', 'simulated', { domain: 'sim-1055.example' });

    // Une mission réelle recroise la même entreprise et la ré-enregistre.
    const { company: after } = repos.companies.upsert({
      canonicalKey: simulated.canonicalKey,
      name: 'SudAutomation GmbH',
      country: 'Allemagne',
      domain: 'sim-1055.example',
      enriched: true,
      dataOrigin: 'live',
    });

    assert.equal(after.dataOrigin, 'simulated', 'la lignée d’origine doit survivre');
    assert.equal(
      repos.companies.get(simulated.id)!.dataOrigin,
      'simulated',
      'et rester telle quelle en base',
    );
  });

  test('une fiche sans lignée déclarée vaut « unknown », pas « live »', () => {
    // Le défaut sûr. Un appelant qui ne sait pas d'où vient sa donnée ne doit
    // pas pouvoir faire passer son ignorance pour une garantie.
    const company = knownCompany('Sans Lignée GmbH', undefined, { domain: 'sans-lignee.de' });
    assert.equal(company.dataOrigin, 'unknown');
  });

  test('une lignée réelle déclarée est conservée', () => {
    const company = knownCompany('Réelle GmbH', 'live', { domain: 'reelle.de' });
    assert.equal(company.dataOrigin, 'live');
  });
});

describe('migration des données historiques', () => {
  test('un domaine .example est classé simulé', () => {
    // RFC 2606 : `.example` est réservé et ne peut jamais résoudre. C'est le
    // seul marqueur structurel disponible sur les données d'avant la colonne,
    // et il est sûr — contrairement au nom.
    const { company } = repos.companies.upsert({
      canonicalKey: 'd:sim-4340.example',
      name: 'Peu importe le nom',
      domain: 'sim-4340.example',
      website: 'https://sim-4340.example/unternehmen',
      enriched: true,
    });

    // La migration s'applique aux lignes existantes ; on rejoue sa règle ici
    // pour vérifier qu'elle classe bien ce cas.
    repos.db
      .prepare(
        `UPDATE companies SET data_origin = 'simulated'
          WHERE website LIKE '%.example%' OR domain LIKE '%.example%'`,
      )
      .run();

    assert.equal(repos.companies.get(company.id)!.dataOrigin, 'simulated');
  });

  test('ce qui ne tombe sous aucune règle reste inconnu', () => {
    // La consigne était explicite : ne pas inventer. Une fiche qu'aucune règle
    // déterministe ne classe reste `unknown`, et `unknown` est refusé en réel.
    const company = knownCompany('Indéterminable GmbH', undefined, { domain: 'indeterminable.de' });
    assert.equal(company.dataOrigin, 'unknown');
  });
});

/**
 * Le scénario de VAL-003, reproduit de bout en bout.
 *
 * Des données simulées dorment en base depuis une démonstration. Une mission
 * réelle démarre, la découverte relit le registre, et tente de reprendre ces
 * fiches comme candidats. Rien de réel ne doit en sortir.
 *
 * Ce test échouerait sur le code d'avant la colonne `data_origin` : c'est
 * exactement ce qu'il doit garantir.
 */
describe('non-régression — données simulées persistantes puis mission réelle', () => {
  test('aucun candidat réel ne peut naître d’une lignée simulée', async () => {
    // ── Le passé : une démonstration a laissé quatre fiches en base ────────
    const fabricated = ['SudAntriebe', 'SudAutomation', 'VectorIndustrietechnik', 'AlpenAutomation'];
    for (const [i, name] of fabricated.entries()) {
      knownCompany(`[SIMULÉ] ${name} AG`, 'simulated', { domain: `sim-${1000 + i}.example` });
    }
    // ── Et une entreprise réelle, découverte lors d'une mission réelle ─────
    knownCompany('Lilie GmbH', 'live', { domain: 'lilie-gmbh.de' });

    assert.equal(repos.companies.count(), 5, 'les cinq fiches sont bien en base');

    // ── Le présent : une mission réelle relit le registre ──────────────────
    const result = await discover('live');

    assert.equal(result.candidates.length, 1, 'seule la fiche réelle doit ressortir');
    assert.equal(result.candidates[0]!.name, 'Lilie GmbH');

    for (const candidate of result.candidates) {
      assert.ok(
        !/\.example/.test(String(candidate.website ?? '') + String(candidate.sources?.[0]?.ref ?? '')),
        'aucune source fabriquée ne doit apparaître dans un candidat réel',
      );
    }
  });

  test('la même base rend tout en mode simulation', async () => {
    // La barrière protège le réel sans casser la démonstration : les cinq
    // fiches ressortent quand on assume de simuler.
    const fabricated = ['SudAntriebe', 'SudAutomation', 'VectorIndustrietechnik', 'AlpenAutomation'];
    for (const [i, name] of fabricated.entries()) {
      knownCompany(`[SIMULÉ] ${name} AG`, 'simulated', { domain: `sim-${1000 + i}.example` });
    }
    knownCompany('Lilie GmbH', 'live', { domain: 'lilie-gmbh.de' });

    const result = await discover('simulation');
    assert.equal(result.candidates.length, 5);
  });

  test('une base entièrement simulée ne produit rien en réel, plutôt que du faux', async () => {
    // Le cas limite qui compte : mieux vaut aucun candidat qu'un candidat
    // fabriqué. Une découverte vide est un résultat honnête ; une découverte
    // remplie de fiches inventées est un mensonge.
    for (let i = 0; i < 4; i++) {
      knownCompany(`[SIMULÉ] Fabriquée ${i}`, 'simulated', { domain: `sim-${2000 + i}.example` });
    }

    const result = await discover('live');
    assert.equal(result.candidates.length, 0);
  });
});
