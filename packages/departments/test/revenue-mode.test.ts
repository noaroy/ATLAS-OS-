import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  REVENUE_STEPS, CYCLE_INNER_STEPS, SENDING_STEPS,
  decideSearchGate, decideBudgetGate, classifyReply, prioritizeInbox,
  classifyDraft, revenueMomentum, topActions,
  type DraftFacts, type SearchProbe,
} from '../src/revenue-mode.ts';

/**
 * Ce que le mode revenu doit tenir, quoi qu'il arrive.
 *
 * Ces tests ne vérifient pas la prospection : elle a les siens. Ils vérifient
 * l'orchestration — l'ordre, les portes, et surtout ce qui doit arrêter la
 * séquence AVANT une dépense. Une garde placée après l'appel qu'elle protège
 * n'est pas une garde, et c'est exactement l'erreur que cet ordre encode.
 */

// ─── L'ORDRE ────────────────────────────────────────────────────────────────

describe('la séquence se déroule dans un ordre qui protège', () => {
  const rang = (id: string) => REVENUE_STEPS.findIndex((s) => s.id === id);

  test('les vingt étapes annoncées sont là, sans doublon', () => {
    assert.equal(REVENUE_STEPS.length, 20);
    assert.equal(new Set(REVENUE_STEPS.map((s) => s.id)).size, 20);
  });

  test('la boîte est lue avant de chercher de nouveaux prospects', () => {
    /*
     * L'ordre qui compte le plus. Prospecter d'abord ferait apparaître une
     * réponse commerciale sous une pile de nouveaux dossiers — la façon la
     * plus fiable de perdre la seule vente en cours.
     */
    assert.ok(rang('INBOX_SYNC') < rang('PROSPECTING_CYCLE'));
    assert.ok(rang('HUMAN_REPLIES') < rang('PROSPECTING_CYCLE'));
    assert.ok(rang('ACTION_REQUIRED') < rang('PROSPECTING_CYCLE'));
  });

  test('toutes les portes précèdent la dépense', () => {
    const cycle = rang('PROSPECTING_CYCLE');
    for (const porte of REVENUE_STEPS.filter((s) => s.gate)) {
      assert.ok(
        rang(porte.id) < cycle,
        `${porte.id} est une porte mais s'ouvre après le cycle qu'elle protège`,
      );
    }
  });

  test('la santé de la recherche et le budget sont des portes', () => {
    const portes = REVENUE_STEPS.filter((s) => s.gate).map((s) => s.id);
    assert.ok(portes.includes('HEALTH_SEARXNG'));
    assert.ok(portes.includes('HEALTH_SEARCH_FABRIC'));
    assert.ok(portes.includes('BUDGET'));
  });

  test('les étapes internes du cycle sont bien dans le cycle', () => {
    const cycle = rang('PROSPECTING_CYCLE');
    const revue = rang('READY_FOR_REVIEW');
    for (const id of CYCLE_INNER_STEPS) {
      assert.ok(rang(id) >= cycle && rang(id) <= revue, `${id} hors du cycle`);
    }
  });

  test('l’arrêt avant envoi est la dernière étape', () => {
    assert.equal(REVENUE_STEPS[REVENUE_STEPS.length - 1]!.id, 'STOP_BEFORE_SEND');
  });

  test('aucune étape n’envoie de courriel', () => {
    // Le contrat central du mode. La liste vide est vérifiée, pas supposée.
    assert.deepEqual(SENDING_STEPS, []);
    assert.equal(REVENUE_STEPS.some((s) => /SEND/.test(s.id) && s.id !== 'STOP_BEFORE_SEND'), false);
  });

  test('seules deux étapes écrivent en base', () => {
    const ecrivent = REVENUE_STEPS.filter((s) => s.writes && !CYCLE_INNER_STEPS.includes(s.id));
    assert.deepEqual(ecrivent.map((s) => s.id), ['INBOX_SYNC', 'PROSPECTING_CYCLE']);
  });
});

// ─── LA RECHERCHE ───────────────────────────────────────────────────────────

describe('un moteur qui n’a pas répondu n’est jamais dit disponible', () => {
  const sonde = (o: Partial<SearchProbe>): SearchProbe =>
    ({ engine: 'searxng', responded: true, results: 5, ...o });

  test('un moteur qui répond avec des résultats est sain', () => {
    const g = decideSearchGate([sonde({})]);
    assert.equal(g.verdict, 'HEALTHY');
    assert.equal(g.engineInUse, 'searxng');
  });

  test('un moteur muet et sans secours bloque', () => {
    const g = decideSearchGate([sonde({ responded: false, results: 0, error: 'ECONNREFUSED' })]);
    assert.equal(g.verdict, 'SEARCH_BLOCKED');
    assert.equal(g.engineInUse, null);
    assert.match(g.reason, /ECONNREFUSED/);
  });

  test('joignable mais zéro résultat n’est pas sain', () => {
    /*
     * La nuance qui coûte de l'argent. Un service qui répond 200 sur /healthz
     * sans rien savoir chercher laisse lancer un cycle qui paiera des appels
     * de modèle pour une liste vide.
     */
    const g = decideSearchGate([sonde({ responded: true, results: 0 })]);
    assert.equal(g.verdict, 'SEARCH_BLOCKED');
    assert.match(g.reason, /0 résultat/);
  });

  test('le repli est signalé comme tel, et nomme le moteur réellement utilisé', () => {
    const g = decideSearchGate([
      sonde({ engine: 'searxng', responded: false, results: 0 }),
      sonde({ engine: 'duckduckgo', results: 4 }),
    ]);
    assert.equal(g.verdict, 'DEGRADED');
    assert.equal(g.engineInUse, 'duckduckgo');
    assert.match(g.reason, /searxng indisponible/);
  });

  test('aucun moteur configuré bloque plutôt que d’en inventer un', () => {
    assert.equal(decideSearchGate([]).verdict, 'SEARCH_BLOCKED');
    assert.equal(decideSearchGate([]).engineInUse, null);
  });
});

// ─── LE BUDGET ──────────────────────────────────────────────────────────────

describe('le budget arrête avant de dépenser', () => {
  test('un plafond de cycle disponible autorise', () => {
    const g = decideBudgetGate({ cycleCapUsd: 0.12, todayUsd: 0.02, monthUsd: 1.4, unknownCostCalls: 0 });
    assert.equal(g.allowed, true);
  });

  test('un plafond nul refuse', () => {
    assert.equal(decideBudgetGate({ cycleCapUsd: 0, todayUsd: 0, monthUsd: 0, unknownCostCalls: 0 }).allowed, false);
  });

  test('un plafond quotidien presque atteint refuse le cycle', () => {
    const g = decideBudgetGate({
      cycleCapUsd: 0.12, todayUsd: 0.95, monthUsd: 3, unknownCostCalls: 0, dailyCapUsd: 1,
    });
    assert.equal(g.allowed, false);
    assert.match(g.reason, /0\.0500 \$/);
  });

  test('une dépense non mesurée ne bloque pas, mais reste comptée', () => {
    /*
     * `null` n'est pas `0`. Traiter l'absence de mesure comme une dépense nulle
     * ferait passer un budget inconnu pour un budget intact ; la transformer en
     * refus arrêterait ATLAS sur une lacune de mesure plutôt que sur un coût.
     */
    const g = decideBudgetGate({
      cycleCapUsd: 0.12, todayUsd: null, monthUsd: null, unknownCostCalls: 7, dailyCapUsd: 1,
    });
    assert.equal(g.allowed, true);
  });
});

// ─── LA PRIORITÉ AUX RÉPONSES ───────────────────────────────────────────────

describe('une réponse commerciale ne se noie jamais sous les nouveaux prospects', () => {
  const sig = (state: string, humanReplied = true) =>
    ({ domain: 'x.fr', company: 'X', state, humanReplied });

  test('chaque état trouve son rang', () => {
    assert.equal(classifyReply(sig('MEETING_REQUESTED')), 'HOT_REPLY');
    assert.equal(classifyReply(sig('INTERESTED')), 'POSITIVE_REPLY');
    assert.equal(classifyReply(sig('REPLIED')), 'ACTION_REQUIRED');
    assert.equal(classifyReply(sig('CONTACTED', false)), 'NEW_PROSPECTING');
  });

  test('une machine qui répond ne compte pas comme une personne', () => {
    assert.equal(classifyReply(sig('AUTO_REPLIED', false)), 'NEW_PROSPECTING');
  });

  test('une réponse neutre n’est pas comptée comme positive', () => {
    /*
     * Relevé sur ACRN : « je regarde et reviens la semaine prochaine ». Une
     * réponse, pas une intention d'achat. La ranger en POSITIVE_REPLY faisait
     * afficher « Positive replies: 0 » juste au-dessus d'une ligne qui
     * l'annonçait positive.
     */
    assert.equal(classifyReply(sig('CONTACTED')), 'ACTION_REQUIRED');
    assert.equal(classifyReply(sig('FOLLOW_UP_SCHEDULED')), 'ACTION_REQUIRED');
  });

  test('le rang prime toujours sur la fraîcheur', () => {
    const ordre = prioritizeInbox([
      { domain: 'c.fr', company: 'C', state: 'REPLIED', humanReplied: true, lastHumanReplyAt: '2026-08-28' },
      { domain: 'a.fr', company: 'A', state: 'MEETING_REQUESTED', humanReplied: true, lastHumanReplyAt: '2026-08-01' },
      { domain: 'b.fr', company: 'B', state: 'INTERESTED', humanReplied: true, lastHumanReplyAt: '2026-08-27' },
    ]);
    assert.deepEqual(ordre.map((o) => o.company), ['A', 'B', 'C']);
    assert.equal(ordre[0]!.priority, 'HOT_REPLY');
  });

  test('les prospects sans réponse ne polluent pas la liste des décisions', () => {
    const ordre = prioritizeInbox([
      { domain: 'n.fr', company: 'N', state: 'CONTACTED', humanReplied: false },
    ]);
    assert.equal(ordre.length, 0);
  });
});

// ─── LE TRI DES BROUILLONS ──────────────────────────────────────────────────

describe('un brouillon est classé sur ce qui l’empêche de partir', () => {
  const parfait: DraftFacts = {
    company: 'Precobox',
    actionType: 'EMAIL',
    hasTarget: true,
    contactObserved: true,
    suitabilityLow: false,
    personalIntent: false,
    identityConfidence: 0.9,
    sourcedFacts: 2,
    everyFactSourced: true,
    alreadySent: false,
    doNotContact: false,
    quotaRemaining: 9,
    missingSubject: false,
    crossDomain: false,
    nameLooksLikePageTitle: false,
  };

  test('tout en règle donne SENDABLE', () => {
    assert.equal(classifyDraft(parfait).klass, 'SENDABLE');
  });

  test('un objet absent demande une retouche, pas un blocage', () => {
    // Relevé pour de bon sur trois dossiers : le corps était bon, la ligne
    // d'objet n'existait nulle part. Deux minutes de correction, pas un rejet.
    const v = classifyDraft({ ...parfait, missingSubject: true });
    assert.equal(v.klass, 'NEEDS_SMALL_EDIT');
    assert.match(v.reasons.join(' '), /objet absent/);
  });

  test('un nom qui est un titre de page demande une retouche', () => {
    assert.equal(classifyDraft({ ...parfait, nameLooksLikePageTitle: true }).klass, 'NEEDS_SMALL_EDIT');
  });

  test('un destinataire hors domaine avertit sans bloquer', () => {
    assert.equal(classifyDraft({ ...parfait, crossDomain: true }).klass, 'NEEDS_SMALL_EDIT');
  });

  test('un téléphone n’est jamais un envoi, même parfait par ailleurs', () => {
    const v = classifyDraft({ ...parfait, actionType: 'PHONE' });
    assert.equal(v.klass, 'MANUAL_CHANNEL');
  });

  test('un formulaire non plus', () => {
    assert.equal(classifyDraft({ ...parfait, actionType: 'FORM' }).klass, 'MANUAL_CHANNEL');
  });

  test('aucun canal exploitable bloque', () => {
    assert.equal(classifyDraft({ ...parfait, actionType: 'UNAVAILABLE', hasTarget: false }).klass, 'BLOCKED');
  });

  test('une adresse devinée bloque', () => {
    const v = classifyDraft({ ...parfait, contactObserved: false });
    assert.equal(v.klass, 'BLOCKED');
    assert.match(v.reasons.join(' '), /devinée/);
  });

  test('un seul fait sourcé bloque', () => {
    assert.equal(classifyDraft({ ...parfait, sourcedFacts: 1 }).klass, 'BLOCKED');
  });

  test('un fait sans source vérifiable bloque', () => {
    assert.equal(classifyDraft({ ...parfait, everyFactSourced: false }).klass, 'BLOCKED');
  });

  test('un ancien envoi bloque', () => {
    assert.equal(classifyDraft({ ...parfait, alreadySent: true }).klass, 'BLOCKED');
  });

  test('DO_NOT_CONTACT bloque', () => {
    assert.equal(classifyDraft({ ...parfait, doNotContact: true }).klass, 'BLOCKED');
  });

  test('un quota épuisé bloque', () => {
    assert.equal(classifyDraft({ ...parfait, quotaRemaining: 0 }).klass, 'BLOCKED');
  });

  test('une adresse personnelle bloque', () => {
    assert.equal(classifyDraft({ ...parfait, personalIntent: true }).klass, 'BLOCKED');
  });

  test('un canal impropre au démarchage bloque', () => {
    assert.equal(classifyDraft({ ...parfait, suitabilityLow: true }).klass, 'BLOCKED');
  });

  test('un blocage dur prime sur un canal manuel', () => {
    // Un dossier déjà contacté ET joignable seulement par téléphone n'est pas
    // « à traiter à la main » : il ne doit plus rien recevoir du tout.
    const v = classifyDraft({ ...parfait, actionType: 'PHONE', alreadySent: true });
    assert.equal(v.klass, 'BLOCKED');
  });
});

// ─── L'ÉLAN ─────────────────────────────────────────────────────────────────

describe('l’élan commercial se lit en un mot', () => {
  const base = {
    blockers: [] as string[], positiveReplies: 0, hotReplies: 0, actionRequired: 0,
    sendable: 0, readyForReview: 0, paidClients: 0,
  };

  test('un blocage prime sur tout, même sur une réponse chaude', () => {
    /*
     * Si la messagerie ne répond plus, un prospect intéressé ne peut pas être
     * servi. Afficher HOT laisserait croire que la journée avance.
     */
    const v = revenueMomentum({ ...base, hotReplies: 3, blockers: ['SEARCH BLOCKED'] });
    assert.equal(v.momentum, 'BLOCKED');
  });

  test('une réponse chaude donne HOT', () => {
    assert.equal(revenueMomentum({ ...base, hotReplies: 1 }).momentum, 'HOT');
  });

  test('un client payant donne HOT', () => {
    assert.equal(revenueMomentum({ ...base, paidClients: 1 }).momentum, 'HOT');
  });

  test('des dossiers prêts donnent ACTIVE', () => {
    assert.equal(revenueMomentum({ ...base, sendable: 3 }).momentum, 'ACTIVE');
  });

  test('une boucle qui tourne sans rien produire donne LOW', () => {
    assert.equal(revenueMomentum({ ...base, readyForReview: 4 }).momentum, 'LOW');
    assert.equal(revenueMomentum(base).momentum, 'LOW');
  });
});

// ─── LES ACTIONS ────────────────────────────────────────────────────────────

describe('les trois prochaines actions suivent l’argent', () => {
  const base = {
    blockers: [] as string[], positiveReplies: 0, hotReplies: 0, actionRequired: 0,
    sendable: 0, readyForReview: 0, paidClients: 0,
    followUpsDue: 0, needsSmallEdit: 0, manualChannel: 0, quotaRemaining: 9,
  };

  test('jamais plus de trois', () => {
    const a = topActions({
      ...base, hotReplies: 1, positiveReplies: 2, actionRequired: 3,
      sendable: 4, followUpsDue: 5, needsSmallEdit: 6, manualChannel: 7,
    });
    assert.equal(a.length, 3);
  });

  test('une réponse chaude passe avant un dossier prêt', () => {
    const a = topActions({ ...base, hotReplies: 1, sendable: 5 });
    assert.match(a[0]!, /chaude/);
  });

  test('un blocage passe avant tout', () => {
    const a = topActions({ ...base, blockers: ['SEARCH BLOCKED'], hotReplies: 2 });
    assert.match(a[0]!, /débloquer/);
  });

  test('un quota épuisé n’invite pas à approuver ce qui ne peut pas partir', () => {
    const a = topActions({ ...base, sendable: 5, quotaRemaining: 0, followUpsDue: 2 });
    assert.equal(a.some((x) => /approuver/.test(x)), false);
  });

  test('rien en attente laisse une action utile', () => {
    assert.equal(topActions(base).length, 1);
    assert.match(topActions(base)[0]!, /nouveau cycle/);
  });
});
