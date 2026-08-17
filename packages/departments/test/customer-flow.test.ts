import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canStartProduction,
  canDeliver,
  orderEconomics,
  type CustomerOrder,
  type DeliveryFacts,
} from '../src/customer-flow.ts';
import { EVIDENCE_TRANSLATIONS, translationMap } from '../src/translations.ts';
import { REVIEW_CHECKLIST, reviewVerdict } from '../src/delivery.ts';

/**
 * Le premier parcours client, et les portes qui le referment.
 *
 * Deux moments où une erreur ne se rattrape pas : dépenser pour un client qui
 * ne paiera pas, et envoyer un document que personne n'a relu. Les deux portes
 * sont éprouvées ici sans monter de mission ni engager un centime — une garde
 * qui a besoin d'une dépense pour être testée n'est jamais testée.
 */

const order = (over: Partial<CustomerOrder> = {}): CustomerOrder => ({
  id: 'ord_1',
  customer: 'Machines Dubois',
  email: 'contact@machines-dubois.fr',
  company: 'Machines Dubois SAS',
  missionId: null,
  sellingPriceCents: 4900,
  currency: 'EUR',
  orderStatus: 'ORDERED',
  paymentStatus: 'CONFIRMED',
  paymentReference: 'VIR-2026-08-17-001',
  paidAt: '2026-08-17T10:00:00.000Z',
  deliveryStatus: 'NOT_READY',
  ...over,
});

const facts = (over: Partial<DeliveryFacts> = {}): DeliveryFacts => ({
  paymentStatus: 'CONFIRMED',
  reviewStatus: 'APPROVED_FOR_DELIVERY',
  simulatedEvidence: 0,
  unsupportedClaims: 0,
  ...over,
});

describe('aucune production avant paiement', () => {
  test('un règlement constaté autorise la production', () => {
    const decision = canStartProduction(order());
    assert.equal(decision.allowed, true);
    assert.equal(decision.refusal, null);
  });

  test('« en attente » n’autorise rien', () => {
    // La nuance qui coûte de l'argent quand on la laisse au jugement : attendre
    // le règlement n'est pas pouvoir commencer en attendant.
    const decision = canStartProduction(order({ paymentStatus: 'PENDING' }));
    assert.equal(decision.allowed, false);
    assert.equal(decision.refusal, 'BLOCKED_BY_PAYMENT');
    assert.match(decision.reason, /Aucune dépense n'est engagée avant constatation/);
  });

  test('aucun autre état de règlement ne passe', () => {
    for (const status of ['NONE', 'REFUNDED', 'CANCELLED'] as const) {
      const decision = canStartProduction(order({ paymentStatus: status }));
      assert.equal(decision.allowed, false, `« ${status} » ne doit pas autoriser une dépense`);
      assert.equal(decision.refusal, 'BLOCKED_BY_PAYMENT');
    }
  });

  test('une commande annulée ne produit rien, même réglée', () => {
    const decision = canStartProduction(order({ orderStatus: 'CANCELLED' }));
    assert.equal(decision.allowed, false);
    assert.equal(decision.refusal, 'BLOCKED_BY_STATUS');
  });

  test('sans prix convenu, la production est refusée', () => {
    // Produire sans prix rend la marge incalculable et la livraison
    // indéfendable si le client conteste.
    for (const price of [null, 0]) {
      const decision = canStartProduction(order({ sellingPriceCents: price }));
      assert.equal(decision.allowed, false);
      assert.equal(decision.refusal, 'BLOCKED_BY_PRICE');
    }
  });
});

describe('aucune livraison sans les quatre conditions', () => {
  test('les quatre réunies autorisent la livraison', () => {
    assert.equal(canDeliver(facts()).allowed, true);
  });

  test('sans règlement, rien ne part', () => {
    const decision = canDeliver(facts({ paymentStatus: 'PENDING' }));
    assert.equal(decision.allowed, false);
    assert.ok(decision.blockers.some((b) => /règlement/.test(b)));
  });

  test('sans revue humaine, rien ne part', () => {
    for (const state of ['GENERATED', 'PENDING_REVIEW', 'REJECTED'] as const) {
      const decision = canDeliver(facts({ reviewStatus: state }));
      assert.equal(decision.allowed, false, `« ${state} » ne doit pas autoriser une livraison`);
      assert.ok(decision.blockers.some((b) => /engagé sa parole/.test(b)));
    }
  });

  test('une seule preuve simulée bloque', () => {
    const decision = canDeliver(facts({ simulatedEvidence: 1 }));
    assert.equal(decision.allowed, false);
    assert.ok(decision.blockers.some((b) => /lignée simulée/.test(b)));
  });

  test('une seule affirmation sans source bloque', () => {
    // C'est la promesse centrale du produit, et une seule suffit à la rompre.
    const decision = canDeliver(facts({ unsupportedClaims: 1 }));
    assert.equal(decision.allowed, false);
    assert.ok(decision.blockers.some((b) => /sans source/.test(b)));
  });

  test('tous les obstacles sont énumérés, pas seulement le premier', () => {
    // Corriger un point pour découvrir le suivant fait perdre un aller-retour
    // à chaque fois, et le client attend pendant ce temps.
    const decision = canDeliver({
      paymentStatus: 'PENDING',
      reviewStatus: 'GENERATED',
      simulatedEvidence: 2,
      unsupportedClaims: 1,
    });
    assert.equal(decision.blockers.length, 4);
  });
});

describe('aucune auto-approbation', () => {
  test('une liste incomplète refuse, quelle que soit l’opinion du relecteur', () => {
    const verdict = reviewVerdict({
      passed: REVIEW_CHECKLIST.slice(0, 4).map((i) => i.key),
      reviewer: 'noaroy',
      reviewedAt: '2026-08-17T13:00:00.000Z',
      notes: 'Le reste me paraît évident.',
    });
    assert.equal(verdict.approved, false);
    assert.equal(verdict.nextState, 'REJECTED');
    assert.equal(verdict.missing.length, 4);
  });

  test('une liste vide n’approuve pas', () => {
    const verdict = reviewVerdict({
      passed: [],
      reviewer: 'atlas',
      reviewedAt: '2026-08-17T13:00:00.000Z',
    });
    assert.equal(verdict.approved, false);
    assert.equal(verdict.missing.length, REVIEW_CHECKLIST.length);
  });

  test('le verdict découle de la liste, il n’est pas déclaré', () => {
    // `reviewVerdict` ne prend aucun champ « approved » : il n'existe aucun
    // moyen de déclarer une approbation sans avoir coché les huit points.
    const outcome = {
      passed: REVIEW_CHECKLIST.map((i) => i.key),
      reviewer: 'noaroy',
      reviewedAt: '2026-08-17T13:00:00.000Z',
    };
    assert.equal(reviewVerdict(outcome).approved, true);
    assert.ok(!('approved' in outcome), 'le relecteur ne déclare pas son verdict');
  });
});

describe('la marge se calcule sur le coût réel', () => {
  test('un coût non nul ne donne jamais 100 %', () => {
    // 49 € pour 0,0244 $ donne 99,95 %. Arrondir à 100 % fait disparaître le
    // coût au lieu de le montrer petit — et c'est le genre de faux qui rassure.
    const e = orderEconomics({ sellingPriceEur: 49, productionCostUsd: 0.0244 });
    assert.ok(e.grossMarginPercent < 100, `marge affichée ${e.grossMarginPercent} %`);
    assert.ok(e.grossMarginPercent > 99.9);
  });

  test('même un coût minuscule reste visible', () => {
    const e = orderEconomics({ sellingPriceEur: 49, productionCostUsd: 0.0001 });
    assert.ok(e.grossMarginPercent < 100);
    assert.ok(e.productionCostUsd > 0);
  });

  test('les chiffres viennent du coût mesuré', () => {
    const e = orderEconomics({ sellingPriceEur: 49, productionCostUsd: 0.0244 });
    assert.equal(e.productionCostUsd, 0.0244);
    assert.equal(e.productionCostEur, 0.0226);
    assert.equal(e.grossMarginEur, 48.9774);
    assert.equal(e.sellingPriceEur, 49);
  });

  test('un coût nul donne bien 100 %', () => {
    // Le teaser, produit sans aucun appel : là, 100 % est exact.
    const e = orderEconomics({ sellingPriceEur: 49, productionCostUsd: 0 });
    assert.equal(e.grossMarginPercent, 100);
  });
});

describe('les traductions conservent la provenance', () => {
  test('chaque traduction est rattachée à une preuve identifiée', () => {
    for (const t of EVIDENCE_TRANSLATIONS) {
      assert.match(t.evidenceId, /^evd_/, `identifiant de preuve attendu, reçu « ${t.evidenceId} »`);
      assert.ok(t.french.trim().length > 0);
      assert.ok(t.translatedBy.trim().length > 0, 'une traduction est un acte éditorial, elle a un auteur');
    }
  });

  test('la table ne fait que traduire : elle ne porte ni source ni affirmation', () => {
    // La provenance reste dans la preuve. Dupliquer l'URL ici créerait deux
    // vérités à maintenir, et celle qu'on oublierait serait affichée au client.
    for (const t of EVIDENCE_TRANSLATIONS) {
      assert.ok(!('sourceRef' in t), 'la source appartient à la preuve, pas à sa traduction');
      assert.ok(!/https?:\/\//.test(t.french), 'une traduction ne recopie pas l’URL');
    }
  });

  test('la carte rend identifiant → texte, sans rien perdre', () => {
    const map = translationMap();
    assert.equal(Object.keys(map).length, EVIDENCE_TRANSLATIONS.length);
    for (const t of EVIDENCE_TRANSLATIONS) assert.equal(map[t.evidenceId], t.french);
  });

  test('les citations de la source restent citées', () => {
    // « jahrzehntelange Erfahrung » et « Seit 1803 » sont ce que le site dit :
    // le client doit pouvoir les retrouver mot pour mot.
    const all = EVIDENCE_TRANSLATIONS.map((t) => t.french).join(' ');
    assert.match(all, /jahrzehntelange Erfahrung/);
    assert.match(all, /Seit 1803/);
  });

  test('la distance de l’énonciateur est conservée', () => {
    // « described as Germany's oldest specialist » est une revendication de
    // l'entreprise. La traduire en constat ferait dire à ATLAS ce que seul le
    // site affirme.
    const claim = EVIDENCE_TRANSLATIONS.find((t) =>
      t.evidenceId === 'evd_01M06ZZZ05FGRWCTBM8WBP1664',
    )!;
    assert.match(claim.french, /présentée comme/);
  });

  test('le vocabulaire technique est traduit, pas anglicisé', () => {
    const portfolio = EVIDENCE_TRANSLATIONS.find(
      (t) => t.evidenceId === 'evd_01M06ZZZ05NG3YZ4QA7MCM4PP6',
    )!;
    assert.match(portfolio.french, /cercleuses/);
    assert.match(portfolio.french, /palettiseurs/);
    assert.ok(!/strapping machines/i.test(portfolio.french));
  });
});

describe('le parcours complet, transition par transition', () => {
  test('de l’extrait à la livraison, dans l’ordre', () => {
    // 1. Prospect : l'extrait est parti, rien n'est engagé.
    let o = order({ orderStatus: 'TEASER_SENT', paymentStatus: 'NONE', paymentReference: null, paidAt: null });
    assert.equal(canStartProduction(o).allowed, false, 'aucune dépense au stade de l’extrait');

    // 2. Commande passée, règlement attendu.
    o = { ...o, orderStatus: 'ORDERED', paymentStatus: 'PENDING' };
    assert.equal(canStartProduction(o).allowed, false, 'attendre le règlement n’est pas commencer');

    // 3. Règlement constaté, à la main.
    o = {
      ...o,
      paymentStatus: 'CONFIRMED',
      paymentReference: 'VIR-2026-08-17-001',
      paidAt: '2026-08-17T10:00:00.000Z',
    };
    assert.equal(canStartProduction(o).allowed, true, 'la production est enfin autorisée');

    // 4. Production faite, rapport généré — mais pas encore relu.
    assert.equal(
      canDeliver(facts({ reviewStatus: 'GENERATED' })).allowed,
      false,
      'un rapport généré n’est pas un rapport livrable',
    );

    // 5. Revue humaine, huit points constatés.
    const verdict = reviewVerdict({
      passed: REVIEW_CHECKLIST.map((i) => i.key),
      reviewer: 'noaroy',
      reviewedAt: '2026-08-17T14:00:00.000Z',
    });
    assert.equal(verdict.nextState, 'APPROVED_FOR_DELIVERY');

    // 6. Livraison.
    assert.equal(canDeliver(facts({ reviewStatus: verdict.nextState })).allowed, true);
  });

  test('un remboursement referme la porte de livraison', () => {
    assert.equal(canDeliver(facts({ paymentStatus: 'REFUNDED' })).allowed, false);
  });
});
