import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Company, Contact, Evidence, Opportunity, ScoringModel } from '@atlas/contracts';
import { buildClientReport, isNamed, looksFrench, fieldLabel } from '../src/client-report.ts';
import {
  reportToHtml,
  reportToCsv,
  teaserToHtml,
  TEASER_FACT_LIMIT,
} from '../src/client-report-render.ts';
import {
  canTransition,
  reviewVerdict,
  reportEconomics,
  REVIEW_CHECKLIST,
  PIPELINE_VERSION,
  type ReportProvenance,
} from '../src/delivery.ts';

/**
 * Le document que le client paie, et ce qui l'empêche de partir trop tôt.
 *
 * Ce qui est vérifié ici n'est pas la mise en forme : c'est qu'aucune phrase
 * du rapport ne puisse être lue comme un fait sans que sa source soit à côté,
 * qu'aucun contact ne soit inventé, et qu'aucun document ne parte sans avoir
 * été relu par quelqu'un.
 */

const SCORING_MODEL: ScoringModel = {
  dimensions: [
    { key: 'sector-fit', label: 'Adéquation sectorielle', weight: 60, description: 'Cible.' },
    {
      key: 'evidence-quality',
      label: 'Qualité des preuves',
      weight: 40,
      description: 'Sourçage.',
      computed: true,
    },
  ],
  shortlistThreshold: 45,
  narrative: 'Un candidat marque des points lorsqu’il touche déjà nos clients.',
};

const company = (over: Partial<Company> = {}): Company =>
  ({
    id: 'cmp_1',
    canonicalKey: 'd:hagenauer-denk.de',
    name: 'Hagenauer+Denk KG',
    legalName: null,
    country: 'Germany',
    region: 'Bavaria',
    city: 'Immenstadt',
    website: 'https://www.hagenauer-denk.de',
    domain: 'hagenauer-denk.de',
    industries: ['Packaging machinery'],
    sizeBand: 'medium',
    employeesEstimate: null,
    foundedYear: null,
    description: null,
    profile: {},
    enriched: true,
    dataOrigin: 'live',
    identityStatus: 'ok',
    firstSeenAt: '2026-08-17T00:00:00.000Z',
    lastVerifiedAt: null,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    ...over,
  }) as Company;

const evidence = (over: Partial<Evidence> = {}): Evidence =>
  ({
    id: 'ev_1',
    companyId: 'cmp_1',
    opportunityId: 'opp_1',
    missionId: 'mis_1',
    field: 'sector',
    claim: 'Designs and manufactures complete packaging lines.',
    value: null,
    nature: 'observed',
    sourceKey: 'src_1',
    sourceRef: 'https://www.hagenauer-denk.de/en/products',
    sourceTitle: null,
    basis: null,
    confidence: 0.85,
    simulated: false,
    collectedAt: '2026-08-17T00:00:00.000Z',
    agentKey: 'explorer',
    createdAt: '2026-08-17T00:00:00.000Z',
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
    score: 69,
    scoreDetail: {
      total: 69,
      components: [
        {
          dimension: 'sector-fit',
          label: 'Adéquation sectorielle',
          value: 85,
          weight: 60,
          contribution: 51,
          rationale: 'Gamme directement compatible.',
          confidence: 0.9,
          evidenceIds: ['ev_1'],
          computed: false,
        },
        {
          dimension: 'evidence-quality',
          label: 'Qualité des preuves',
          value: 81,
          weight: 40,
          contribution: 32.4,
          rationale: '4 affirmations constatées.',
          confidence: 0.72,
          evidenceIds: [],
          computed: true,
        },
      ],
      confidence: 0.79,
      roleFits: [],
      modelVersion: 'v1',
      scoredBy: 'analyst',
      scoredAt: '2026-08-17T00:00:00.000Z',
    },
    qualification: {
      verdict: 'qualified',
      checks: [],
      rationale: 'Distributeur établi de machines d’emballage en Bavière.',
      confidence: 0.8,
      decidedBy: 'analyst',
      decidedAt: '2026-08-17T00:00:00.000Z',
    },
    rank: 1,
    justification: 'À contacter en premier.',
    ...over,
  }) as Opportunity;

const provenance = (over: Partial<ReportProvenance> = {}): ReportProvenance => ({
  missionId: 'mis_1',
  generatedAt: '2026-08-17T12:00:00.000Z',
  pipelineVersion: PIPELINE_VERSION,
  scoringVersion: 'v1',
  executionMode: 'live',
  evidenceIds: ['ev_1'],
  sources: ['https://www.hagenauer-denk.de/en/products'],
  costUsd: 0.0118,
  reviewer: null,
  approvedAt: null,
  state: 'GENERATED',
  ...over,
});

const build = (entries: Parameters<typeof buildClientReport>[0]['entries']) =>
  buildClientReport({
    clientName: 'Machines Dubois',
    missionTitle: 'Distributeurs allemands — emballage industriel',
    market: 'Allemagne · machines d’emballage',
    objective: 'Identifier des distributeurs allemands pour une offre B2B industrielle.',
    generatedAt: '2026-08-17T12:00:00.000Z',
    analysedCount: 6,
    entries,
    scoringModel: SCORING_MODEL,
    provenance: provenance(),
  });

const oneEntry = (over: { evidence?: Evidence[]; contacts?: Contact[] } = {}) => [
  {
    opportunity: opportunity(),
    company: company(),
    evidence: over.evidence ?? [evidence()],
    contacts: over.contacts ?? [],
  },
];

describe('le rapport reste sourcé', () => {
  test('chaque fait garde sa source, chaque déduction sa base', () => {
    const report = build(
      oneEntry({
        evidence: [
          evidence(),
          evidence({
            id: 'ev_2',
            nature: 'inferred',
            claim: 'Probablement ouverte à une représentation export.',
            sourceRef: null,
            basis: 'Mentions d’export sur le site',
          }),
        ],
      }),
    );
    const p = report.prospects[0]!;
    assert.equal(p.facts.length, 1);
    assert.equal(p.inferences.length, 1);
    assert.equal(p.facts[0]!.sourceRef, 'https://www.hagenauer-denk.de/en/products');
    assert.equal(p.inferences[0]!.basis, 'Mentions d’export sur le site');
  });

  test('une affirmation réelle sans source n’est jamais présentée comme un fait', () => {
    // Le contrat central du produit : ce qui est établi se distingue de ce qui
    // est supposé, et une preuve sans adresse ne peut pas franchir la ligne.
    const report = build(oneEntry({ evidence: [evidence({ sourceRef: null })] }));
    assert.equal(report.prospects[0]!.facts.length, 0);
  });

  test('la traduction ne supprime jamais l’original', () => {
    const report = buildClientReport({
      clientName: 'C',
      missionTitle: 'M',
      market: 'DE',
      objective: 'O',
      generatedAt: '2026-08-17T12:00:00.000Z',
      analysedCount: 1,
      scoringModel: SCORING_MODEL,
      provenance: provenance(),
      entries: [
        {
          opportunity: opportunity(),
          company: company(),
          evidence: [evidence()],
          contacts: [],
          translations: { ev_1: 'Conçoit et fabrique des lignes d’emballage complètes.' },
        },
      ],
    });
    const claim = report.prospects[0]!.facts[0]!;
    assert.equal(claim.original, 'Designs and manufactures complete packaging lines.');
    assert.equal(claim.french, 'Conçoit et fabrique des lignes d’emballage complètes.');
    assert.equal(claim.sourceRef, 'https://www.hagenauer-denk.de/en/products');

    const html = reportToHtml(report);
    assert.match(html, /Designs and manufactures/, 'l’original doit rester lisible');
    assert.match(html, /Conçoit et fabrique/, 'la traduction doit être affichée');
  });

  test('sans traduction fournie, rien n’est fabriqué', () => {
    // Traduire sans le texte source sous les yeux déformerait ce qu'on affirme
    // d'une entreprise réelle. Le champ reste vide, et l'original suffit.
    const report = build(oneEntry());
    assert.equal(report.prospects[0]!.facts[0]!.french, null);
  });

  test('les libellés de champ sont français', () => {
    assert.equal(fieldLabel('sector'), 'Secteur d’activité');
    assert.equal(fieldLabel('existence'), 'Existence établie');
    assert.equal(looksFrench('Distribue des machines dans le sud'), true);
    assert.equal(looksFrench('Designs and manufactures packaging lines'), false);
  });
});

describe('aucun contact inventé', () => {
  const contact = (over: Partial<Contact>): Contact =>
    ({
      id: 'ct_1',
      companyId: 'cmp_1',
      name: 'Contact général',
      role: null,
      email: null,
      phone: null,
      linkedin: null,
      confidence: 0.5,
      evidenceId: null,
      createdAt: '2026-08-17T00:00:00.000Z',
      ...over,
    }) as Contact;

  test('un contact de standard n’est pas présenté comme un interlocuteur', () => {
    assert.equal(isNamed({ name: 'Contact général' }), false);
    assert.equal(isNamed({ name: 'Service commercial' }), false);
    assert.equal(isNamed({ name: 'Vertrieb' }), false);
    assert.equal(isNamed({ name: 'Anna Weber' }), true);
  });

  test('un nom d’une seule partie n’est pas un interlocuteur', () => {
    // « Weber » seul ne permet pas d'ouvrir un message : c'est une mention,
    // pas une personne identifiée.
    assert.equal(isNamed({ name: 'Weber' }), false);
  });

  test('l’absence d’interlocuteur nommé est écrite, pas tue', () => {
    const report = build(oneEntry({ contacts: [contact({ email: 'info@hagenauer-denk.de' })] }));
    assert.ok(
      report.prospects[0]!.risks.some((r) => /aucun interlocuteur nommé/i.test(r)),
      'le risque doit être formulé au client',
    );
    assert.ok(report.limitations.some((l) => /aucun contact nominatif/i.test(l)));
    assert.equal(report.prospects[0]!.contacts[0]!.named, false);
  });

  test('le rapport distingue visuellement les deux', () => {
    const report = build(oneEntry({ contacts: [contact({ phone: '+49 8323 96600' })] }));
    const html = reportToHtml(report);
    assert.match(html, /contact général/);
    assert.ok(!/interlocuteur nommé/.test(html.split('Contacts')[1] ?? ''), 'aucun nom inventé');
  });
});

describe('la note reste décomposée', () => {
  test('chaque dimension porte sa valeur, son poids et son apport', () => {
    const report = build(oneEntry());
    const dims = report.prospects[0]!.dimensions;
    assert.equal(dims.length, 2);
    const sector = dims.find((d) => d.key === 'sector-fit')!;
    assert.equal(sector.value, 85);
    assert.equal(sector.weight, 60);
    assert.equal(sector.contribution, 51);
    assert.deepEqual(sector.evidenceIds, ['ev_1']);
  });

  test('la dimension calculée est signalée comme telle', () => {
    // Un client doit pouvoir distinguer ce qu'un analyste a jugé de ce que la
    // plateforme a mesuré : les deux ne se contestent pas de la même façon.
    const report = build(oneEntry());
    const computed = report.prospects[0]!.dimensions.find((d) => d.computed)!;
    assert.equal(computed.key, 'evidence-quality');
    assert.match(reportToHtml(report), /Calculée par la plateforme/);
  });

  test('le tableau de notation figure dans le rapport', () => {
    const html = reportToHtml(build(oneEntry()));
    assert.match(html, /Justification de la note/);
    assert.match(html, /Adéquation sectorielle/);
  });
});

describe('le teaser démontre sans livrer', () => {
  const manyFacts = Array.from({ length: 10 }, (_, i) =>
    evidence({ id: `ev_${i}`, field: `champ_${i}`, claim: `Affirmation ${i} sourcée.` }),
  );

  test('il ne montre qu’un prospect et une partie des faits', () => {
    const report = build(oneEntry({ evidence: manyFacts }));
    const teaser = teaserToHtml(report, { priceEur: 49, deliveryHours: 24 });

    const shown = manyFacts.slice(0, TEASER_FACT_LIMIT);
    const hidden = manyFacts.slice(TEASER_FACT_LIMIT);
    for (const e of shown) assert.match(teaser, new RegExp(e.claim));
    for (const e of hidden) {
      assert.ok(!teaser.includes(e.claim), `« ${e.claim} » ne doit pas figurer dans l’extrait`);
    }
  });

  test('il n’expose ni décomposition de note ni contacts', () => {
    const report = build(oneEntry({ evidence: manyFacts }));
    const teaser = teaserToHtml(report, { priceEur: 49, deliveryHours: 24 });
    assert.ok(!teaser.includes('Justification de la note'));
    assert.ok(!teaser.includes('Adéquation sectorielle'));
    assert.ok(!teaser.includes('Traçabilité'));
  });

  test('il annonce ce qu’il retient plutôt que de le taire', () => {
    const report = build(oneEntry({ evidence: manyFacts }));
    const teaser = teaserToHtml(report, { priceEur: 49, deliveryHours: 24 });
    assert.match(teaser, /autre\(s\) affirmation\(s\) sourcée\(s\)/);
    assert.match(teaser, /49 €/);
  });

  test('sans prospect retenu, il ne fabrique rien', () => {
    const report = build([]);
    const teaser = teaserToHtml(report, { priceEur: 49, deliveryHours: 24 });
    assert.match(teaser, /Aucun prospect retenu/);
    assert.ok(!teaser.includes('49 €'), 'on ne vend pas un extrait vide');
  });
});

describe('la revue humaine et les états', () => {
  test('un rapport ne saute jamais de généré à livré', () => {
    assert.equal(canTransition('GENERATED', 'DELIVERED'), false);
    assert.equal(canTransition('PENDING_REVIEW', 'DELIVERED'), false);
    assert.equal(canTransition('APPROVED_FOR_DELIVERY', 'DELIVERED'), true);
  });

  test('un point manquant refuse le rapport, quelle que soit l’opinion du relecteur', () => {
    const partial = REVIEW_CHECKLIST.slice(0, -1).map((i) => i.key);
    const verdict = reviewVerdict({
      passed: partial,
      reviewer: 'noaroy',
      reviewedAt: '2026-08-17T13:00:00.000Z',
      notes: 'Tout me paraît bon.',
    });
    assert.equal(verdict.approved, false);
    assert.equal(verdict.nextState, 'REJECTED');
    assert.equal(verdict.missing.length, 1);
  });

  test('la liste complète approuve', () => {
    const verdict = reviewVerdict({
      passed: REVIEW_CHECKLIST.map((i) => i.key),
      reviewer: 'noaroy',
      reviewedAt: '2026-08-17T13:00:00.000Z',
    });
    assert.equal(verdict.approved, true);
    assert.equal(verdict.nextState, 'APPROVED_FOR_DELIVERY');
  });

  test('la liste couvre les défauts qui ne se voient qu’en lisant', () => {
    const keys = REVIEW_CHECKLIST.map((i) => i.key);
    for (const expected of [
      'sources-live',
      'no-simulation',
      'no-invented-contact',
      'translation-faithful',
      'no-unsupported-claim',
    ]) {
      assert.ok(keys.includes(expected), `point « ${expected} » absent de la liste`);
    }
  });
});

describe('l’économie est mesurée, jamais estimée', () => {
  test('les coûts dérivent de la télémétrie fournie', () => {
    const e = reportEconomics(
      { llmCostUsd: 0.0273, searchCostUsd: 0, candidates: 4, usefulOpportunities: 2 },
      { sellingPriceEur: 49 },
    );
    assert.equal(e.totalCostUsd, 0.0273);
    assert.equal(e.costPerCandidateUsd, 0.0068);
    assert.equal(e.costPerUsefulOpportunityUsd, 0.0137);
    assert.ok(e.grossMarginPercent !== null && e.grossMarginPercent > 99);
  });

  test('aucun prix n’est fixé automatiquement', () => {
    // Le prix est une décision commerciale, pas une propriété du calcul.
    const e = reportEconomics({
      llmCostUsd: 0.02,
      searchCostUsd: 0,
      candidates: 2,
      usefulOpportunities: 1,
    });
    assert.equal(e.sellingPriceEur, null);
    assert.equal(e.grossMarginEur, null);
    assert.equal(e.grossMarginPercent, null);
  });

  test('zéro candidat ne donne pas un coût par candidat de zéro', () => {
    const e = reportEconomics({
      llmCostUsd: 0.01,
      searchCostUsd: 0,
      candidates: 0,
      usefulOpportunities: 0,
    });
    assert.equal(e.costPerCandidateUsd, null);
    assert.equal(e.costPerUsefulOpportunityUsd, null);
  });
});

describe('les formats de sortie', () => {
  test('le HTML est autonome et échappe ce qui vient du web', () => {
    const hostile = build([
      {
        opportunity: opportunity(),
        company: company({ name: '<script>alert(1)</script> GmbH' }),
        evidence: [evidence({ sourceRef: 'javascript:alert(1)' })],
        contacts: [],
      },
    ]);
    const html = reportToHtml(hostile);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!/href="javascript:/i.test(html));
    assert.ok(!/<link[^>]+stylesheet/i.test(html), 'aucune ressource externe');
  });

  test('le CSV neutralise les formules et porte un BOM', () => {
    const hostile = build([
      {
        opportunity: opportunity(),
        company: company({ name: '=cmd|calc!A1' }),
        evidence: [evidence()],
        contacts: [],
      },
    ]);
    const csv = reportToCsv(hostile);
    assert.ok(csv.startsWith('﻿'));
    assert.ok(csv.includes(`"'=cmd|calc!A1"`));
  });

  test('la traçabilité figure dans le document livré', () => {
    const html = reportToHtml(build(oneEntry()));
    assert.match(html, /Traçabilité de cette étude/);
    assert.match(html, /mis_1/);
    assert.match(html, new RegExp(PIPELINE_VERSION));
    assert.match(html, /live/);
  });
});
