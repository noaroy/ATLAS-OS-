import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateApproval,
  parseDeclaredChecks,
  HUMAN_CHECKS,
  AUTOMATIC_CHECKS,
  type ApprovalInput,
} from '../src/review-approval.ts';
import { REVIEW_CHECKLIST } from '../src/delivery.ts';
import { canDeliver } from '../src/customer-flow.ts';

/**
 * L'approbation humaine, et tout ce qui la refuse.
 *
 * Quatre des huit points de revue demandent d'ouvrir le document : les URL
 * répondent-elles, la traduction est-elle fidèle, la synthèse dépasse-t-elle
 * ses preuves, l'entreprise correspond-elle au besoin. Aucun système ne peut
 * les cocher — ils comparent le document à quelque chose qui n'est pas dans la
 * base.
 *
 * Ils sont donc réclamés un par un sur la ligne de commande. Le relecteur qui
 * les tape déclare les avoir faits : c'est la seule signature qu'un logiciel
 * puisse recueillir, et c'est pourquoi elle ne doit jamais pouvoir être donnée
 * par défaut.
 */

const allAutomatic = Object.fromEntries(
  AUTOMATIC_CHECKS.map((k) => [k, 'PASS' as const]),
);

const input = (over: Partial<ApprovalInput> = {}): ApprovalInput => ({
  reportState: 'PENDING_REVIEW',
  declaredChecks: [...HUMAN_CHECKS],
  automaticVerdicts: allAutomatic,
  simulatedEvidence: 0,
  unsupportedClaims: 0,
  ...over,
});

describe('l’approbation aboutit quand tout est réuni', () => {
  test('les quatre points humains déclarés suffisent', () => {
    const decision = evaluateApproval(input());
    assert.equal(decision.approved, true);
    assert.deepEqual(decision.refusals, []);
    assert.deepEqual(decision.humanChecks, [...HUMAN_CHECKS]);
  });

  test('les huit clés sont consignées, pas seulement les quatre déclarées', () => {
    // Ce qui est écrit en base doit refléter la revue entière : quatre points
    // vérifiés à la main, quatre constatés par le système.
    const decision = evaluateApproval(input());
    assert.equal(decision.passedKeys.length, REVIEW_CHECKLIST.length);
    for (const item of REVIEW_CHECKLIST) {
      assert.ok(decision.passedKeys.includes(item.key), `« ${item.key} » absent du relevé`);
    }
  });

  test('les verdicts automatiques sont rendus avec leur valeur', () => {
    const decision = evaluateApproval(input());
    assert.equal(decision.automaticChecks.length, AUTOMATIC_CHECKS.length);
    assert.ok(decision.automaticChecks.every((k) => k.verdict === 'PASS'));
  });
});

describe('l’approbation est refusée', () => {
  test('sans les quatre points humains', () => {
    for (const missing of HUMAN_CHECKS) {
      const declared = HUMAN_CHECKS.filter((k) => k !== missing);
      const decision = evaluateApproval(input({ declaredChecks: declared }));
      assert.equal(decision.approved, false, `« ${missing} » manquant doit refuser`);
      assert.ok(
        decision.refusals.some((r) => r.code === 'MISSING_HUMAN_CHECK' && r.message.includes(missing)),
      );
    }
  });

  test('sans aucun point déclaré', () => {
    const decision = evaluateApproval(input({ declaredChecks: [] }));
    assert.equal(decision.approved, false);
    assert.equal(
      decision.refusals.filter((r) => r.code === 'MISSING_HUMAN_CHECK').length,
      HUMAN_CHECKS.length,
    );
  });

  test('sur une clé inconnue', () => {
    // Une faute de frappe ignorée ferait croire à un point coché qui ne l'est
    // pas — c'est pire que de la refuser.
    const decision = evaluateApproval(
      input({ declaredChecks: [...HUMAN_CHECKS, 'sources-vives'] }),
    );
    assert.equal(decision.approved, false);
    assert.ok(decision.refusals.some((r) => r.code === 'UNKNOWN_CHECK'));
  });

  test('un point automatique ne peut pas être coché à la main', () => {
    // Les quatre points calculés appartiennent au système. Les déclarer ne les
    // remplace pas : ils restent lus depuis les verdicts.
    const decision = evaluateApproval(
      input({
        declaredChecks: [...HUMAN_CHECKS, 'no-simulation'],
        automaticVerdicts: { ...allAutomatic, 'no-simulation': 'FAIL' },
      }),
    );
    assert.equal(decision.approved, false);
    assert.ok(decision.refusals.some((r) => r.code === 'AUTOMATIC_CHECK_FAILED'));
  });

  test('quand un contrôle automatique échoue', () => {
    for (const key of AUTOMATIC_CHECKS) {
      const decision = evaluateApproval(
        input({ automaticVerdicts: { ...allAutomatic, [key]: 'FAIL' } }),
      );
      assert.equal(decision.approved, false, `« ${key} » en échec doit refuser`);
    }
  });

  test('quand un verdict automatique est absent', () => {
    // Un point non calculé n'est pas un point réussi. L'absence vaut échec.
    const { 'no-simulation': _omitted, ...partial } = allAutomatic;
    const decision = evaluateApproval(input({ automaticVerdicts: partial }));
    assert.equal(decision.approved, false);
    assert.ok(decision.refusals.some((r) => r.code === 'AUTOMATIC_CHECK_FAILED'));
  });

  test('quand le rapport n’est pas en revue', () => {
    for (const state of ['GENERATED', 'APPROVED_FOR_DELIVERY', 'REJECTED', 'DELIVERED'] as const) {
      const decision = evaluateApproval(input({ reportState: state }));
      assert.equal(decision.approved, false, `« ${state} » ne doit pas être approuvable`);
      assert.ok(decision.refusals.some((r) => r.code === 'WRONG_STATE'));
    }
  });

  test('en présence d’une preuve simulée', () => {
    const decision = evaluateApproval(input({ simulatedEvidence: 1 }));
    assert.equal(decision.approved, false);
    assert.ok(decision.refusals.some((r) => r.code === 'SIMULATED_EVIDENCE'));
  });

  test('en présence d’une affirmation sans source', () => {
    const decision = evaluateApproval(input({ unsupportedClaims: 1 }));
    assert.equal(decision.approved, false);
    assert.ok(decision.refusals.some((r) => r.code === 'UNSUPPORTED_CLAIM'));
  });

  test('tous les motifs sont énumérés, pas seulement le premier', () => {
    // Corriger un point pour découvrir le suivant fait recommencer la lecture
    // à chaque fois, et une revue qu'on reprend trois fois finit expédiée.
    const decision = evaluateApproval({
      reportState: 'GENERATED',
      declaredChecks: ['clé-inventée'],
      automaticVerdicts: { ...allAutomatic, 'scores-justified': 'FAIL' },
      simulatedEvidence: 2,
      unsupportedClaims: 1,
    });
    const codes = new Set(decision.refusals.map((r) => r.code));
    for (const expected of [
      'WRONG_STATE',
      'UNKNOWN_CHECK',
      'MISSING_HUMAN_CHECK',
      'AUTOMATIC_CHECK_FAILED',
      'SIMULATED_EVIDENCE',
      'UNSUPPORTED_CLAIM',
    ]) {
      assert.ok(codes.has(expected as never), `motif « ${expected} » absent`);
    }
  });

  test('un refus ne consigne aucune clé', () => {
    // Sans quoi un rapport refusé porterait la trace d'une revue qui n'a pas eu
    // lieu.
    assert.deepEqual(evaluateApproval(input({ declaredChecks: [] })).passedKeys, []);
  });
});

describe('la lecture de la ligne de commande', () => {
  test('la forme répétée', () => {
    assert.deepEqual(
      parseDeclaredChecks(['--approve', '--check=sources-live', '--check=evidence-coherent']),
      ['sources-live', 'evidence-coherent'],
    );
  });

  test('la forme groupée, pour les shells qui s’en accommodent mieux', () => {
    assert.deepEqual(parseDeclaredChecks(['--checks=sources-live,evidence-coherent']), [
      'sources-live',
      'evidence-coherent',
    ]);
  });

  test('les doublons ne cochent pas deux fois', () => {
    assert.deepEqual(parseDeclaredChecks(['--check=sources-live', '--check=sources-live']), [
      'sources-live',
    ]);
  });

  test('une valeur vide n’est pas une clé', () => {
    assert.deepEqual(parseDeclaredChecks(['--check=', '--checks=,,']), []);
  });

  test('rien n’est deviné depuis les autres arguments', () => {
    assert.deepEqual(parseDeclaredChecks(['--approve', '--price=49', '--submit']), []);
  });
});

describe('la garde de livraison reste indépendante de la revue', () => {
  test('un rapport approuvé mais non payé ne part pas', () => {
    // C'est le cas attendu après l'approbation manuelle : la revue est faite,
    // le règlement ne l'est pas, et la porte reste fermée.
    const guard = canDeliver({
      paymentStatus: 'NONE',
      reviewStatus: 'APPROVED_FOR_DELIVERY',
      simulatedEvidence: 0,
      unsupportedClaims: 0,
    });
    assert.equal(guard.allowed, false);
    assert.equal(guard.blockers.length, 1);
    assert.match(guard.blockers[0]!, /règlement/);
  });

  test('approuver n’ouvre jamais la livraison à lui seul', () => {
    for (const payment of ['NONE', 'PENDING', 'REFUNDED', 'CANCELLED'] as const) {
      const guard = canDeliver({
        paymentStatus: payment,
        reviewStatus: 'APPROVED_FOR_DELIVERY',
        simulatedEvidence: 0,
        unsupportedClaims: 0,
      });
      assert.equal(guard.allowed, false, `« ${payment} » ne doit pas ouvrir la livraison`);
    }
  });

  test('les deux réunies ouvrent la porte', () => {
    const guard = canDeliver({
      paymentStatus: 'CONFIRMED',
      reviewStatus: 'APPROVED_FOR_DELIVERY',
      simulatedEvidence: 0,
      unsupportedClaims: 0,
    });
    assert.equal(guard.allowed, true);
  });
});
