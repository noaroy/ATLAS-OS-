import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canTransitionLoop, type LoopState } from '../src/sales-loop.ts';
import { evaluateSendGate, type SendCandidate } from '../src/send-gate.ts';
import { shouldNotify } from '../src/sales-notify.ts';
import {
  evaluateFollowUp, addBusinessDays, MIN_FOLLOW_UP_BUSINESS_DAYS,
} from '../src/follow-up.ts';

/**
 * Les règles qui décident si un message a le droit de partir.
 *
 * Toutes sont pures et testées sur des cas figés. C'est délibéré : chacune de
 * ces règles a été écrite après un incident réel — une agence de communication
 * qualifiée comme prospect, une adresse de webmaster retenue comme canal
 * commercial, une bannière de cookies citée comme fait observé. Une règle qu'on
 * ne peut pas rejouer sur l'incident qui l'a motivée finit par dériver.
 */

const solid: SendCandidate = {
  domain: 'exemple-industrie.fr',
  companyName: 'Exemple Industrie',
  officialDomain: 'exemple-industrie.fr',
  icpStatus: 'IN_ICP',
  conversionScore: 72,
  observedFacts: [
    { quote: 'Nous fabriquons des tableaux électriques basse tension.', sourceUrl: 'https://exemple-industrie.fr/' },
    { quote: 'Notre atelier de Nantes double sa surface en 2026.', sourceUrl: 'https://exemple-industrie.fr/actualites' },
  ],
  commercialSignals: ['agrandissement d atelier'],
  contact: {
    value: 'commercial@exemple-industrie.fr',
    type: 'EMAIL',
    intent: 'SALES',
    suitability: 'HIGH',
    observed: true,
    sourceUrl: 'https://exemple-industrie.fr/contact',
  },
  ledger: 'ELIGIBLE',
};

const limits = { minConversionScore: 60, remainingToday: 10 };
const reasons = (c: SendCandidate) =>
  evaluateSendGate(c, limits).blocks.map((b) => b.reason);

describe('le portail d’envoi', () => {
  test('un dossier complet passe', () => {
    const verdict = evaluateSendGate(solid, limits);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.blocks.length, 0);
  });

  test('DO_NOT_CONTACT bloque, quel que soit le reste du dossier', () => {
    // Le dossier est parfait par ailleurs : c'est tout l'intérêt du test.
    assert.deepEqual(reasons({ ...solid, ledger: 'DO_NOT_CONTACT' }), ['DO_NOT_CONTACT']);
  });

  test('une entreprise déjà contactée ne reçoit pas un second premier message', () => {
    assert.deepEqual(reasons({ ...solid, ledger: 'ALREADY_CONTACTED' }), ['ALREADY_CONTACTED']);
  });

  test('une identité non résolue ne peut pas recevoir de message', () => {
    // « Devenez Distributeur » a été retenu comme raison sociale par un lot.
    assert.ok(reasons({ ...solid, companyName: null }).includes('IDENTITY_UNRESOLVED'));
  });

  test('une adresse reconstruite est refusée', () => {
    const guessed = {
      ...solid,
      contact: { ...solid.contact!, observed: false, sourceUrl: null },
    };
    assert.ok(reasons(guessed).includes('GUESSED_ADDRESS'));
  });

  test('le support et le juridique ne sont pas des canaux commerciaux', () => {
    for (const intent of ['TECHNICAL_SUPPORT', 'LEGAL', 'PRIVACY', 'WEBMASTER'] as const) {
      const candidate = { ...solid, contact: { ...solid.contact!, intent } };
      assert.ok(
        reasons(candidate).includes('UNSUITABLE_CONTACT_INTENT'),
        `${intent} aurait dû être refusé`,
      );
    }
  });

  test('un humain peut autoriser explicitement un canal support', () => {
    const candidate = { ...solid, contact: { ...solid.contact!, intent: 'TECHNICAL_SUPPORT' as const } };
    const verdict = evaluateSendGate(candidate, { ...limits, allowedIntents: ['TECHNICAL_SUPPORT'] });
    assert.equal(verdict.allowed, true);
  });

  test('un seul fait observé ne suffit pas', () => {
    const thin = { ...solid, observedFacts: solid.observedFacts.slice(0, 1) };
    assert.ok(reasons(thin).includes('NOT_ENOUGH_OBSERVED_FACTS'));
  });

  test('un fait sans source ne compte pas comme un fait', () => {
    const unsourced = {
      ...solid,
      observedFacts: [solid.observedFacts[0]!, { quote: 'Société dynamique.', sourceUrl: '' }],
    };
    assert.ok(reasons(unsourced).includes('NOT_ENOUGH_OBSERVED_FACTS'));
  });

  test('hors ICP, le score ne rachète rien', () => {
    const out = { ...solid, icpStatus: 'OUT_OF_ICP' as const, conversionScore: 98 };
    assert.ok(reasons(out).includes('OUT_OF_ICP'));
  });

  test('le quota du jour ferme la porte à tout le monde', () => {
    const verdict = evaluateSendGate(solid, { ...limits, remainingToday: 0 });
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.blocks.some((b) => b.reason === 'DAILY_QUOTA_REACHED'));
  });

  test('chaque refus porte un motif lisible', () => {
    const verdict = evaluateSendGate(
      { ...solid, companyName: null, ledger: 'DO_NOT_CONTACT' },
      limits,
    );
    for (const block of verdict.blocks) assert.ok(block.detail.length > 5, block.reason);
  });
});

describe('la machine à états', () => {
  test('on ne passe pas de la relecture à l’envoi sans approbation', () => {
    // Le verrou n'est pas un test qu'on peut oublier d'écrire : c'est une
    // transition qui n'existe pas dans la table.
    const check = canTransitionLoop('READY_FOR_APPROVAL', 'SENDING');
    assert.equal(check.allowed, false);
    assert.match(check.reason, /READY_FOR_APPROVAL/);
  });

  test('le chemin légitime passe par APPROVED_TO_SEND', () => {
    assert.equal(canTransitionLoop('READY_FOR_APPROVAL', 'APPROVED_TO_SEND').allowed, true);
    assert.equal(canTransitionLoop('APPROVED_TO_SEND', 'SENDING').allowed, true);
    assert.equal(canTransitionLoop('SENDING', 'CONTACTED').allowed, true);
  });

  test('on entre dans la boucle par la découverte, pas par l’envoi', () => {
    assert.equal(canTransitionLoop(null, 'QUALIFYING').allowed, true);
    assert.equal(canTransitionLoop(null, 'APPROVED_TO_SEND').allowed, false);
  });

  test('un opt-out bloque même après l’envoi', () => {
    for (const from of ['CONTACTED', 'WAITING_REPLY', 'REPLIED'] as LoopState[]) {
      assert.equal(canTransitionLoop(from, 'BLOCKED').allowed, true, from);
    }
  });

  test('un état terminal ne se rouvre pas tout seul', () => {
    assert.equal(canTransitionLoop('LOST', 'READY_FOR_APPROVAL').allowed, false);
    assert.equal(canTransitionLoop('LOST', 'QUALIFYING').allowed, true);
  });
});

describe('les notifications', () => {
  const base = { confidence: 0.9, subject: null, bodyExcerpt: null };

  test('une marque d’intérêt dérange immédiatement', () => {
    const n = shouldNotify({ ...base, status: 'INTERESTED', classification: 'REPLIED' });
    assert.equal(n.decision, 'NOTIFY');
    assert.ok(n.recommendedNextAction.length > 10);
  });

  test('une réponse qu’on n’a pas su classer se fait lire', () => {
    const n = shouldNotify({
      ...base, status: 'NEEDS_REVIEW', classification: 'NEEDS_REVIEW', confidence: 0.3,
    });
    assert.equal(n.decision, 'NOTIFY');
  });

  test('une newsletter ne dérange personne', () => {
    const n = shouldNotify({
      ...base,
      status: 'CONTACTED',
      classification: 'AUTO_REPLY',
      subject: 'Notre newsletter de septembre',
      bodyExcerpt: 'Pour ne plus recevoir nos messages, cliquez sur se desabonner.',
    });
    assert.equal(n.decision, 'SILENT');
  });

  test('un accusé de réception ne dérange personne', () => {
    const n = shouldNotify({
      ...base,
      status: 'CONTACTED',
      classification: 'AUTO_REPLY',
      subject: 'Accuse de reception',
      bodyExcerpt: 'Votre demande a bien ete prise en compte.',
    });
    assert.equal(n.decision, 'SILENT');
  });

  test('un rebond déjà compris ne dérange pas', () => {
    const n = shouldNotify({ ...base, status: 'BOUNCED', classification: 'BOUNCED' });
    assert.equal(n.decision, 'SILENT');
  });

  test('un pied de page « unsubscribe » ne fait pas taire une vraie réponse', () => {
    // Le piège inverse : beaucoup de signatures d'entreprise contiennent le mot.
    const n = shouldNotify({
      ...base,
      status: 'INTERESTED',
      classification: 'REPLIED',
      bodyExcerpt: 'Oui, cela m interesse. — Pour vous desabonner, cliquez ici.',
    });
    assert.equal(n.decision, 'NOTIFY');
  });
});

describe('la relance', () => {
  const base = {
    domain: 'exemple-industrie.fr',
    contactedOn: '2026-08-17',
    followUpsSent: 0,
    doNotContact: false,
    afterBusinessDays: 3,
    today: '2026-08-24',
  };

  test('les jours ouvrés sautent le week-end', () => {
    // Jeudi 20 août 2026 + 3 jours ouvrés = mardi 25.
    assert.equal(addBusinessDays('2026-08-20', 3), '2026-08-25');
  });

  test('une échéance atteinte déclenche la relance', () => {
    assert.equal(evaluateFollowUp({ ...base, status: 'CONTACTED' }).verdict, 'DUE');
  });

  test('avant l’échéance, rien ne part', () => {
    const early = evaluateFollowUp({ ...base, status: 'CONTACTED', today: '2026-08-18' });
    assert.equal(early.verdict, 'TOO_EARLY');
    assert.equal(early.dueOn, '2026-08-20');
  });

  test('il n’y a qu’une seule relance, jamais deux', () => {
    const second = evaluateFollowUp({ ...base, status: 'CONTACTED', followUpsSent: 1 });
    assert.equal(second.verdict, 'ALREADY_FOLLOWED_UP');
  });

  test('un refus explicite ferme la porte, échéance ou pas', () => {
    assert.equal(evaluateFollowUp({ ...base, status: 'NOT_INTERESTED' }).verdict, 'FORBIDDEN');
  });

  test('DO_NOT_CONTACT prime sur le calendrier', () => {
    const blocked = evaluateFollowUp({ ...base, status: 'CONTACTED', doNotContact: true });
    assert.equal(blocked.verdict, 'FORBIDDEN');
    assert.equal(blocked.dueOn, null);
  });

  test('quelqu’un qui a répondu ne se relance pas', () => {
    for (const status of ['REPLIED', 'INTERESTED', 'NEEDS_INFO', 'MEETING_REQUESTED'] as const) {
      assert.equal(evaluateFollowUp({ ...base, status }).verdict, 'ANSWERED', status);
    }
  });
});

describe('une entreprise contactee n’est jamais relancable des le lendemain', () => {
  /**
   * Trois jours ouvres, plancher compris.
   *
   * Le delai etait reglable a partir de un : une entreprise contactee le lundi
   * redevenait relancable le mardi si la configuration le disait. Une relance a
   * vingt-quatre heures ne lit pas comme une relance, elle lit comme une
   * machine -- et c'est ce qui fait classer un expediteur en indesirable.
   *
   * Le plancher vit dans `evaluateFollowUp`, pas seulement dans la
   * configuration : six appelants passent leur propre `afterBusinessDays`, et
   * une garde qui n'existe qu'au chargement de la configuration n'en protege
   * aucun.
   */
  const base = {
    domain: 'exemple-industrie.fr',
    status: 'CONTACTED' as const,
    followUpsSent: 0,
    doNotContact: false,
    afterBusinessDays: 3,
  };

  test('lundi contacte, echeance le jeudi', () => {
    // Lundi 24 aout 2026 + 3 ouvres : mardi, mercredi, jeudi 27.
    assert.equal(addBusinessDays('2026-08-24', 3), '2026-08-27');
    const d = evaluateFollowUp({ ...base, contactedOn: '2026-08-24', today: '2026-08-27' });
    assert.equal(d.verdict, 'DUE');
    assert.equal(d.dueOn, '2026-08-27');
  });

  test('vendredi contacte, echeance le mercredi', () => {
    // Vendredi 28 aout 2026 : le samedi et le dimanche ne comptent pas, donc
    // lundi 31, mardi 1er, mercredi 2 septembre.
    assert.equal(addBusinessDays('2026-08-28', 3), '2026-09-02');
    const d = evaluateFollowUp({ ...base, contactedOn: '2026-08-28', today: '2026-09-02' });
    assert.equal(d.verdict, 'DUE');
    assert.equal(d.dueOn, '2026-09-02');
  });

  test('le week-end ne rapproche jamais l’echeance', () => {
    // Le mardi qui suit un vendredi ne fait que deux jours ouvres.
    const mardi = evaluateFollowUp({ ...base, contactedOn: '2026-08-28', today: '2026-09-01' });
    assert.equal(mardi.verdict, 'TOO_EARLY');
    assert.equal(mardi.dueOn, '2026-09-02');

    // Et un contact du samedi ou du dimanche ne devient pas exigible le lundi.
    for (const jour of ['2026-08-29', '2026-08-30']) {
      const d = evaluateFollowUp({ ...base, contactedOn: jour, today: '2026-08-31' });
      assert.equal(d.verdict, 'TOO_EARLY', jour);
    }
  });

  test('le lendemain d’un contact ne declenche jamais rien', () => {
    // Le defaut que ce plancher ferme, verifie sur chaque jour de la semaine.
    const semaine = [
      '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28',
      '2026-08-29', '2026-08-30',
    ];
    for (const contacte of semaine) {
      const lendemain = addBusinessDays(contacte, 1);
      const d = evaluateFollowUp({ ...base, contactedOn: contacte, today: lendemain });
      assert.equal(d.verdict, 'TOO_EARLY', `contacte le ${contacte}, evalue le ${lendemain}`);
    }
  });

  test('un delai configure sous le plancher est ramene a trois jours ouvres', () => {
    /*
     * La garde qui compte. `afterBusinessDays: 1` decrit exactement la relance
     * du lendemain ; elle est ramenee au plancher plutot qu'appliquee.
     */
    for (const delai of [0, 1, 2]) {
      const d = evaluateFollowUp({
        ...base, afterBusinessDays: delai,
        contactedOn: '2026-08-24', today: '2026-08-26',
      });
      assert.equal(d.verdict, 'TOO_EARLY', `delai ${delai}`);
      assert.equal(d.dueOn, '2026-08-27', `delai ${delai}`);
    }
  });

  test('un delai plus long reste respecte', () => {
    // Le plancher borne par le bas, il ne remplace pas le reglage.
    const d = evaluateFollowUp({
      ...base, afterBusinessDays: 10,
      contactedOn: '2026-08-24', today: '2026-08-31',
    });
    assert.equal(d.verdict, 'TOO_EARLY');
    assert.equal(d.dueOn, addBusinessDays('2026-08-24', 10));
  });

  test('le plancher court aussi depuis la derniere activite', () => {
    /*
     * L'echeance part de la derniere action reelle. Un apercu envoye vendredi
     * ne rend pas l'entreprise relancable le lundi, meme si le premier contact
     * remonte a deux semaines.
     */
    const d = evaluateFollowUp({
      ...base, contactedOn: '2026-08-14', lastActivityOn: '2026-08-28',
      today: '2026-08-31',
    });
    assert.equal(d.verdict, 'TOO_EARLY');
    assert.equal(d.dueOn, '2026-09-02');
  });

  test('le plancher est une valeur nommee, pas un nombre disperse', () => {
    assert.equal(MIN_FOLLOW_UP_BUSINESS_DAYS, 3);
  });
});
