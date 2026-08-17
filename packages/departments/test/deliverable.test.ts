import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Company, Contact, Evidence, Opportunity } from '@atlas/contracts';
import { buildPack, detectSignals, approachAngleFor } from '../src/deliverable.ts';
import { packToHtml, packToCsv } from '../src/deliverable-render.ts';

/**
 * Le document que le client paie.
 *
 * Ce qu'on vérifie ici n'est pas la mise en forme : c'est qu'aucune phrase du
 * livrable ne puisse être lue comme un fait sans que sa source soit à côté.
 * Un pack qui mélange constats et suppositions se fait juger sur sa plus
 * mauvaise ligne, et une seule affirmation fausse coûte plus que les 49 €.
 */

const company = (over: Partial<Company> = {}): Company =>
  ({
    id: 'cmp_1',
    canonicalKey: 'd:bhs-world.com',
    name: 'BHS Corrugated',
    legalName: null,
    country: 'Allemagne',
    region: 'Bavière',
    city: 'Weiherhammer',
    website: 'https://bhs-world.com',
    domain: 'bhs-world.com',
    industries: ['Machines d’emballage'],
    sizeBand: 'large',
    employeesEstimate: null,
    foundedYear: null,
    description: null,
    profile: {},
    enriched: true,
    dataOrigin: 'live',
    firstSeenAt: '2026-08-16T10:00:00.000Z',
    lastVerifiedAt: null,
    createdAt: '2026-08-16T10:00:00.000Z',
    updatedAt: '2026-08-16T10:00:00.000Z',
    ...over,
  }) as Company;

const evidence = (over: Partial<Evidence> = {}): Evidence =>
  ({
    id: 'ev_1',
    companyId: 'cmp_1',
    opportunityId: 'opp_1',
    missionId: 'mis_1',
    field: 'sector',
    claim: 'Produit des machines de carton ondulé.',
    value: null,
    nature: 'reported',
    sourceKey: 'src_1',
    sourceRef: 'https://bhs-world.com/produkte',
    sourceTitle: 'Produkte',
    basis: null,
    confidence: 0.8,
    simulated: false,
    collectedAt: '2026-08-16T10:00:00.000Z',
    agentKey: 'explorer',
    createdAt: '2026-08-16T10:00:00.000Z',
    ...over,
  }) as Evidence;

const opportunity = (over: Partial<Opportunity> = {}): Opportunity =>
  ({
    id: 'opp_1',
    missionId: 'mis_1',
    departmentKey: 'business-expansion',
    companyId: 'cmp_1',
    targetTypes: ['distributor'],
    stage: 'ranked',
    score: 78,
    scoreDetail: {
      total: 78,
      components: [],
      confidence: 0.72,
      roleFits: [],
      modelVersion: 'v1',
      scoredBy: 'analyst',
      scoredAt: '2026-08-16T10:00:00.000Z',
    },
    qualification: {
      verdict: 'qualified',
      checks: [],
      rationale: 'Distributeur établi de machines d’emballage en Bavière.',
      confidence: 0.75,
      decidedBy: 'analyst',
      decidedAt: '2026-08-16T10:00:00.000Z',
    },
    rank: 1,
    justification: 'Le plus proche de la cible, et le mieux documenté.',
    ...over,
  }) as Opportunity;

const pack = (entries: Parameters<typeof buildPack>[0]['entries']) =>
  buildPack({
    title: 'Pack Expansion B2B Allemagne',
    brief: 'Distributeurs de machines d’emballage industriel en Allemagne.',
    generatedAt: '2026-08-16T12:00:00.000Z',
    entries,
  });

describe('la séparation fait / déduction / recommandation', () => {
  test('un fait garde sa source, une déduction garde sa base', () => {
    const built = pack([
      {
        opportunity: opportunity(),
        company: company(),
        evidence: [
          evidence(),
          evidence({
            id: 'ev_2',
            nature: 'inferred',
            claim: 'Probablement ouverte à une représentation export.',
            sourceRef: null,
            basis: 'Mentions d’export sur le site',
            confidence: 0.5,
          }),
        ],
        contacts: [],
      },
    ]);

    const [p] = built.prospects;
    assert.equal(p!.facts.length, 1);
    assert.equal(p!.inferences.length, 1);
    assert.equal(p!.facts[0]!.sourceRef, 'https://bhs-world.com/produkte');
    assert.equal(p!.inferences[0]!.basis, 'Mentions d’export sur le site');
  });

  test('une déduction ne peut pas se retrouver parmi les faits', () => {
    // La séparation vient de `nature`, posée à l'écriture de la preuve. Elle
    // n'est pas recalculée ici, où la tentation d'arrondir serait maximale.
    const built = pack([
      {
        opportunity: opportunity(),
        company: company(),
        evidence: [evidence({ nature: 'inferred', sourceRef: null, basis: 'une base' })],
        contacts: [],
      },
    ]);
    assert.equal(built.prospects[0]!.facts.length, 0);
    assert.equal(built.prospects[0]!.inferences.length, 1);
  });

  test('chaque recommandation dit sur quoi elle repose', () => {
    const built = pack([
      { opportunity: opportunity(), company: company(), evidence: [evidence()], contacts: [] },
    ]);
    for (const reco of built.prospects[0]!.recommendations) {
      assert.ok(reco.because.trim().length > 0, 'une recommandation sans fondement est un avis nu');
    }
  });
});

describe('rien n’est inventé pour combler un trou', () => {
  test('sans contact trouvé, aucune adresse n’est fabriquée', () => {
    const built = pack([
      { opportunity: opportunity(), company: company(), evidence: [evidence()], contacts: [] },
    ]);
    const contact = built.prospects[0]!.contact;
    // Une page de contact est une information réelle ; `kontakt@bhs-world.com`
    // serait une adresse plausible, invérifiable, et fausse une fois sur deux.
    assert.equal(contact?.email, null);
    assert.equal(contact?.name, null);
    assert.match(contact!.contactPage!, /^https:\/\/bhs-world\.com/);
  });

  test('un contact réellement trouvé est rendu tel quel', () => {
    const named: Contact = {
      id: 'ct_1',
      companyId: 'cmp_1',
      name: 'Anna Weber',
      role: 'Vertriebsleitung',
      email: 'a.weber@bhs-world.com',
      phone: null,
      linkedin: null,
      confidence: 0.8,
      evidenceId: 'ev_1',
      createdAt: '2026-08-16T10:00:00.000Z',
    };
    const built = pack([
      { opportunity: opportunity(), company: company(), evidence: [evidence()], contacts: [named] },
    ]);
    assert.equal(built.prospects[0]!.contact?.name, 'Anna Weber');
    assert.equal(built.prospects[0]!.contact?.email, 'a.weber@bhs-world.com');
  });

  test('ce qui manque est écrit, pas tu', () => {
    const built = pack([
      { opportunity: opportunity(), company: company(), evidence: [evidence()], contacts: [] },
    ]);
    // Un livrable qui tait ses trous se fait juger sur eux.
    assert.ok(built.limitations.some((l) => /aucun contact nominatif/.test(l)));
    assert.ok(built.limitations.some((l) => /première main/.test(l)));
  });

  test('un score non mesuré ne devient pas un zéro', () => {
    const built = pack([
      {
        opportunity: opportunity({ score: null, scoreDetail: null }),
        company: company(),
        evidence: [evidence()],
        contacts: [],
      },
    ]);
    assert.equal(built.prospects[0]!.score, null);
    assert.equal(built.prospects[0]!.confidence, null);
    assert.match(packToHtml(built), /—<span>\/100<\/span>/);
  });
});

describe('les signaux et l’angle d’approche', () => {
  test('un signal renvoie toujours au fait qui l’a déclenché', () => {
    const signals = detectSignals([
      {
        field: 'hiring',
        text: 'Karriere : plusieurs postes ouverts au service export.',
        sourceRef: 'https://bhs-world.com/karriere',
        sourceTitle: null,
        basis: null,
        confidence: 0.8,
        collectedAt: '2026-08-16T10:00:00.000Z',
      },
    ]);
    assert.ok(signals.includes('Recrutement en cours'));
    assert.ok(signals.includes('Expansion internationale'));
  });

  test('sans rôle établi, l’angle le dit au lieu de proposer', () => {
    const angle = approachAngleFor([], []);
    assert.match(angle, /Aucun rôle n’a été retenu avec certitude/);
  });

  test('l’angle suit les rôles retenus', () => {
    assert.match(approachAngleFor(['distributor'], []), /distribution/);
    assert.match(approachAngleFor(['integrator'], []), /intégration/);
  });
});

describe('les deux formats de sortie', () => {
  const built = pack([
    {
      opportunity: opportunity(),
      company: company(),
      evidence: [
        evidence(),
        evidence({ id: 'ev_2', nature: 'inferred', sourceRef: null, basis: 'une base' }),
      ],
      contacts: [],
    },
  ]);

  test('le HTML est autonome — aucune ressource externe', () => {
    const html = packToHtml(built);
    // Il doit s'ouvrir depuis une pièce jointe, hors ligne, sur un poste qui
    // n'a jamais entendu parler d'ATLAS.
    assert.ok(!/<script/i.test(html), 'aucun script');
    assert.ok(!/<link[^>]+stylesheet/i.test(html), 'aucune feuille de style externe');
    assert.ok(!/src=["']https?:/i.test(html), 'aucune ressource distante');
    assert.match(html, /<style>/);
  });

  test('les trois catégories sont visibles dans la page', () => {
    const html = packToHtml(built);
    assert.match(html, /FAIT/);
    assert.match(html, /DÉDUCTION/);
    assert.match(html, /RECOMMANDATION/);
  });

  test('le HTML échappe ce qui vient du web', () => {
    const hostile = pack([
      {
        opportunity: opportunity(),
        company: company({ name: '<script>alert(1)</script> GmbH' }),
        evidence: [evidence({ claim: 'Texte avec <img src=x onerror=alert(1)>' })],
        contacts: [],
      },
    ]);
    const html = packToHtml(hostile);
    assert.ok(!html.includes('<script>alert(1)</script>'), 'le nom doit être échappé');
    assert.ok(!html.includes('<img src=x'), 'l’affirmation doit être échappée');
    assert.match(html, /&lt;script&gt;/);
  });

  test('une adresse non http n’est jamais rendue cliquable', () => {
    // Le fichier est ouvert par le client, sur son poste : un `javascript:`
    // venu d'une référence de source y deviendrait exécutable.
    const hostile = pack([
      {
        opportunity: opportunity(),
        company: company(),
        evidence: [evidence({ sourceRef: 'javascript:alert(1)' })],
        contacts: [],
      },
    ]);
    const html = packToHtml(hostile);
    assert.ok(!/href="javascript:/i.test(html), 'aucun lien javascript:');
  });

  test('le CSV a une ligne par prospect et des colonnes séparées par nature', () => {
    const csv = packToCsv(built);
    const lines = csv.trim().split('\r\n');
    assert.equal(lines.length, 2, 'un en-tête et un prospect');
    assert.match(lines[0]!, /"nb_faits"/);
    assert.match(lines[0]!, /"nb_deductions"/);
    // Faits et déductions dans des colonnes distinctes : un import CRM ne doit
    // jamais mélanger ce qui est établi et ce qui est supposé.
    assert.notEqual(lines[0]!.indexOf('"faits"'), lines[0]!.indexOf('"deductions"'));
  });

  test('le CSV neutralise les formules', () => {
    // Excel exécute toute cellule commençant par `=`, `+`, `-` ou `@`.
    const hostile = pack([
      {
        opportunity: opportunity(),
        company: company({ name: '=cmd|calc!A1' }),
        evidence: [evidence()],
        contacts: [],
      },
    ]);
    const csv = packToCsv(hostile);
    assert.ok(csv.includes(`"'=cmd|calc!A1"`), 'la formule doit être neutralisée par une apostrophe');
  });

  test('le CSV s’ouvre correctement en allemand', () => {
    // Sans BOM, Excel lit l'UTF-8 en ANSI et rend « München » en « MÃ¼nchen »
    // dès la première ligne d'un livrable allemand.
    assert.ok(packToCsv(built).startsWith('﻿'));
  });
});
