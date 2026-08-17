import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestSystem, type TestSystem } from '@atlas/testing';
import {
  DiscoveryService,
  RegistryDiscoveryProvider,
  SimulationDiscoveryProvider,
  extractContacts,
  contactUrlsFor,
  toCsv,
  toPrintableHtml,
  type DiscoveryProvider,
  type DiscoveryQuery,
} from '@atlas/intelligence';
import { createLogger } from '@atlas/core';

/**
 * Découverte réelle, contacts et export.
 *
 * Le test central de ce fichier est le premier : en mode réel, aucun candidat
 * fabriqué ne doit pouvoir entrer. C'est la garantie sur laquelle repose la
 * promesse commerciale, et elle doit être tenue par le service, pas par la
 * bonne volonté de chaque provider.
 */

let system: TestSystem | null = null;

afterEach(() => {
  system?.cleanup();
  system = null;
});

const logger = createLogger({ level: 'error', pretty: false });

const QUERY: DiscoveryQuery = {
  targetTypes: [
    { key: 'distributor', label: 'Distributeur', description: 'Achète pour revendre sur un territoire' },
    { key: 'integrator', label: 'Intégrateur', description: 'Conçoit et installe des systèmes complets' },
  ],
  countries: ['Allemagne'],
  industries: ['Équipement industriel'],
  keywords: [],
  exclusions: [],
  clientOffering: 'Machines-outils compactes',
  limit: 5,
};

/** Un provider réel scripté, pour observer le service sans réseau. */
function fakeReal(key: string, names: string[]): DiscoveryProvider {
  return {
    key,
    label: `Source ${key}`,
    kind: 'directory',
    synthetic: false,
    availability: () => ({ available: true, reason: 'disponible' }),
    async search() {
      return {
        candidates: names.map((name) => ({
          name,
          website: `https://${name.toLowerCase().replace(/\W+/g, '')}.de`,
          country: 'Allemagne',
          region: null,
          city: null,
          description: null,
          industries: [],
          relevance: null,
          roles: ['distributor'],
          sources: [
            {
              kind: 'directory' as const,
              ref: `https://annuaire.example/${encodeURIComponent(name)}`,
              title: 'Annuaire',
              retrievedAt: new Date().toISOString(),
              provider: key,
            },
          ],
          confidence: 0.6,
        })),
        notes: [],
        tokensUsed: 0,
        outcome: names.length > 0 ? ('success-with-results' as const) : ('success-empty' as const),
      };
    },
  };
}

describe('la frontière réel / fabriqué', () => {
  test('en mode réel, un provider fabriqué est écarté avant d’être interrogé', async () => {
    let called = false;
    const inner = new SimulationDiscoveryProvider();
    // Spread would drop the prototype methods, so the delegation is explicit.
    const spy: DiscoveryProvider = {
      key: inner.key,
      label: inner.label,
      kind: inner.kind,
      synthetic: inner.synthetic,
      availability: () => inner.availability(),
      async search(query, ctx) {
        called = true;
        return inner.search(query, ctx);
      },
    };

    const service = new DiscoveryService([spy], { live: true, logger });
    const report = await service.discover(QUERY, { logger });

    assert.equal(called, false, 'un provider fabriqué ne doit même pas être appelé en mode réel');
    assert.equal(report.candidates.length, 0);
    assert.equal(report.usedRealSource, false);
    assert.match(report.providers[0]!.reason, /mode réel/);
  });

  test('en mode simulation, le provider fabriqué répond et se déclare comme tel', async () => {
    const service = new DiscoveryService([new SimulationDiscoveryProvider()], { live: false, logger });
    const report = await service.discover(QUERY, { logger });

    assert.ok(report.candidates.length >= 3);
    assert.ok(
      report.candidates.every((c) => c.name.includes('[SIMULÉ]')),
      'une entreprise fabriquée doit être reconnaissable à l’œil nu',
    );
    assert.ok(report.candidates.every((c) => c.sources[0]!.kind === 'simulation'));
    assert.equal(report.usedRealSource, false);
    assert.match(report.providers[0]!.notes.join(' '), /ne doivent en aucun cas/);
  });

  test('les capacités du déploiement sont lisibles avant toute dépense', () => {
    const live = new DiscoveryService([new SimulationDiscoveryProvider()], { live: true, logger });
    const [capability] = live.capabilities();

    assert.equal(capability!.usable, false);
    assert.match(capability!.reason, /fabrique ses résultats/);
  });
});

describe('la combinaison des providers', () => {
  test('la même entreprise vue par deux sources donne un candidat à deux origines', async () => {
    const service = new DiscoveryService(
      [fakeReal('a', ['Nordantrieb', 'Bayerntechnik']), fakeReal('b', ['Nordantrieb'])],
      { live: true, logger },
    );
    const report = await service.discover(QUERY, { logger });

    assert.equal(report.candidates.length, 2, 'le doublon inter-providers doit fusionner');
    assert.equal(report.merged, 1);

    const corroborated = report.candidates.find((c) => c.name === 'Nordantrieb')!;
    assert.equal(corroborated.sources.length, 2, 'la corroboration ne doit pas être perdue');
    assert.deepEqual(
      corroborated.sources.map((s) => s.provider).sort(),
      ['a', 'b'],
    );
  });

  test('le nombre demandé borne le total et évite d’interroger inutilement', async () => {
    const service = new DiscoveryService(
      [fakeReal('a', ['Un', 'Deux', 'Trois', 'Quatre', 'Cinq']), fakeReal('b', ['Six'])],
      { live: true, logger },
    );
    const report = await service.discover({ ...QUERY, limit: 5 }, { logger });

    assert.equal(report.candidates.length, 5);
    const second = report.providers.find((p) => p.key === 'b')!;
    assert.equal(second.used, false);
    assert.match(second.reason, /déjà atteint/);
  });

  test('la mémoire d’ATLAS est une source réelle et gratuite', async () => {
    const sys = createTestSystem({ handler: async () => ({ kind: 'text', text: 'ok' }) });
    system = sys;

    const { company } = sys.repos.companies.upsert({
      canonicalKey: 'd:deja-connue.de',
      name: 'Déjà Connue GmbH',
      country: 'Allemagne',
      domain: 'deja-connue.de',
      industries: ['Équipement industriel'],
      enriched: true,
      // La lignée doit être déclarée : une fiche de provenance inconnue est
      // désormais refusée en mode réel, et c'est la propriété qu'on veut.
      dataOrigin: 'live',
    });
    sys.repos.companies.markVerified(company.id);

    const service = new DiscoveryService([new RegistryDiscoveryProvider(sys.repos)], {
      live: true,
      logger,
    });
    const report = await service.discover(QUERY, { logger });

    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0]!.name, 'Déjà Connue GmbH');
    assert.equal(report.tokensUsed, 0, 'relire la mémoire ne coûte rien');
    assert.equal(report.usedRealSource, true);
  });

  test('une fiche jamais enrichie n’est pas une découverte', async () => {
    const sys = createTestSystem({ handler: async () => ({ kind: 'text', text: 'ok' }) });
    system = sys;

    sys.repos.companies.upsert({
      canonicalKey: 'd:simple-mention.de',
      name: 'Simple Mention',
      country: 'Allemagne',
      domain: 'simple-mention.de',
    });

    const service = new DiscoveryService([new RegistryDiscoveryProvider(sys.repos)], {
      live: true,
      logger,
    });
    const report = await service.discover(QUERY, { logger });
    assert.equal(report.candidates.length, 0);
  });
});

describe('les coordonnées publiques', () => {
  test('une adresse générique est relevée et reconnue comme telle', () => {
    const page = 'Kontakt: info@nordantrieb.de — Telefon +49 40 123 456 78';
    const contacts = extractContacts(page, { domain: 'nordantrieb.de' });

    const email = contacts.find((c) => c.kind === 'email')!;
    assert.equal(email.value, 'info@nordantrieb.de');
    assert.equal(email.generic, true, 'info@ est le point d’entrée B2B, pas une personne');

    assert.ok(contacts.some((c) => c.kind === 'phone'));
  });

  test('une adresse d’un autre domaine est ignorée', () => {
    const page = 'Réalisation du site : hello@agence-web.fr — Contact : vertrieb@nordantrieb.de';
    const contacts = extractContacts(page, { domain: 'nordantrieb.de' });

    assert.deepEqual(
      contacts.filter((c) => c.kind === 'email').map((c) => c.value),
      ['vertrieb@nordantrieb.de'],
      'l’adresse de l’agence web n’est pas celle de l’entreprise',
    );
  });

  test('rien n’est fabriqué : une page sans coordonnées ne produit rien', () => {
    assert.deepEqual(extractContacts('Notre histoire depuis 1897. Nous employons 120 personnes.'), []);
  });

  test('un numéro trop court ou trop long n’est pas un téléphone', () => {
    const contacts = extractContacts('TVA DE 12 345 · fondée 1897 · 12.03.2024');
    assert.equal(contacts.filter((c) => c.kind === 'phone').length, 0);
  });

  test('les pages à consulter sont dérivées du site, jamais devinées ailleurs', () => {
    const urls = contactUrlsFor('https://www.nordantrieb.de/produkte', 'nordantrieb.de');
    assert.ok(urls.every((url) => url.startsWith('https://www.nordantrieb.de')));
    assert.ok(urls.some((url) => url.endsWith('/impressum')));
    assert.deepEqual(contactUrlsFor(null, null), []);
  });
});

describe('l’export client', () => {
  const detail = (over: Record<string, unknown> = {}) =>
    ({
      opportunity: {
        id: 'opp_1',
        missionId: 'msn_1',
        departmentKey: 'business-expansion',
        companyId: 'cmp_1',
        targetTypes: ['distributor'],
        stage: 'approved',
        score: 71.4,
        scoreDetail: {
          total: 71.4,
          components: [
            {
              dimension: 'sector-fit',
              label: 'Adéquation sectorielle',
              value: 80,
              weight: 20,
              contribution: 16,
              rationale: 'Sert la même base industrielle.',
              confidence: 0.8,
              evidenceIds: [],
              computed: false,
            },
          ],
          confidence: 0.72,
          roleFits: [
            {
              role: 'distributor',
              label: 'Distributeur',
              value: 78,
              rationale: 'Distribue déjà des équipements comparables.',
              confidence: 0.8,
              evidenceIds: [],
            },
            {
              role: 'integrator',
              label: 'Intégrateur',
              value: 41,
              rationale: "Peu de références d'intégration complète.",
              confidence: 0.5,
              evidenceIds: [],
            },
          ],
          modelVersion: 'v1',
          scoredBy: 'analyst',
          scoredAt: new Date().toISOString(),
        },
        qualification: null,
        rank: 1,
        justification: 'Classé #1 pour sa couverture nationale.',
        reusedKnowledge: false,
        review: {
          decision: 'approved' as const,
          note: 'À contacter en premier.',
          reviewedBy: 'fondateur@example.com',
          reviewedAt: new Date().toISOString(),
        },
        discoveredBy: 'explorer',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...over,
      },
      company: {
        id: 'cmp_1',
        canonicalKey: 'd:nordantrieb.de',
        name: 'Nordantrieb GmbH',
        legalName: null,
        country: 'Allemagne',
        region: null,
        city: 'Hambourg',
        website: 'https://nordantrieb.de',
        domain: 'nordantrieb.de',
        industries: [],
        sizeBand: 'medium' as const,
        employeesEstimate: null,
        foundedYear: null,
        description: 'Distributeur de composants industriels.',
        profile: {},
        enriched: true,
        firstSeenAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      evidence: [
        {
          id: 'evd_1',
          companyId: 'cmp_1',
          opportunityId: 'opp_1',
          missionId: 'msn_1',
          field: 'territory',
          claim: 'Agences à Hambourg, Munich et Cologne.',
          value: null,
          nature: 'observed' as const,
          sourceKey: 'company-website:nordantrieb.de',
          sourceRef: 'https://nordantrieb.de/standorte',
          sourceTitle: 'Standorte',
          basis: null,
          confidence: 0.9,
          simulated: false,
          collectedAt: new Date().toISOString(),
          agentKey: 'explorer',
          createdAt: new Date().toISOString(),
        },
      ],
      contacts: [
        {
          id: 'cnt_1',
          companyId: 'cmp_1',
          name: 'Contact général',
          role: 'Adresse publiée',
          email: 'info@nordantrieb.de',
          phone: null,
          linkedin: null,
          confidence: 0.85,
          evidenceId: 'evd_1',
          createdAt: new Date().toISOString(),
        },
      ],
      relations: [],
    }) as never;

  const input = (over: Record<string, unknown> = {}) => ({
    mission: {
      id: 'msn_1',
      code: 'M-TEST',
      title: 'Distributeurs allemands',
      objective: 'Trouver des distributeurs en Allemagne.',
    },
    department: null,
    opportunities: [detail()],
    economics: null,
    simulated: false,
    generatedAt: new Date().toISOString(),
    ...over,
  }) as never;

  test('le CSV porte les colonnes commerciales attendues', () => {
    const file = toCsv(input());

    assert.match(file.filename, /\.csv$/);
    assert.ok(file.content.startsWith('﻿'), 'le BOM est ce qui fait qu’Excel lit les accents');

    const [header, row] = file.content.replace('﻿', '').split('\r\n');
    for (const column of ['Rang', 'Entreprise', 'Score /100', 'Preuves principales', 'Sources', 'Contact']) {
      assert.ok(header!.includes(column), `colonne manquante : ${column}`);
    }
    assert.ok(row!.includes('Nordantrieb GmbH'));
    assert.ok(row!.includes('info@nordantrieb.de'));
    assert.ok(row!.includes('https://nordantrieb.de/standorte'));
  });

  test('une formule n’est jamais exécutée par le tableur', () => {
    const file = toCsv(
      input({ opportunities: [detail({ justification: '=cmd|calc' })] }),
    );
    assert.ok(file.content.includes("'=cmd|calc"), 'le préfixe apostrophe neutralise l’injection');
  });

  test('une exécution simulée est marquée sur chaque ligne du fichier', () => {
    const file = toCsv(input({ simulated: true }));
    assert.match(file.content, /SIMULÉ — ne pas transmettre/);
  });

  test('le rapport imprimable distingue visiblement constat et déduction', () => {
    const file = toPrintableHtml(input());

    assert.match(file.content, /nature observed/);
    assert.match(file.content, /constaté/);
    assert.match(file.content, /Nordantrieb GmbH/);
    assert.match(file.content, /Approuvé par fondateur@example.com/);
    assert.match(file.content, /lang="fr"/);
  });

  test('une shortlist non approuvée porte son avertissement', () => {
    const file = toPrintableHtml(
      input({ opportunities: [detail({ review: null, stage: 'shortlisted' })] }),
    );
    assert.match(file.content, /non encore revue/);
  });
});
