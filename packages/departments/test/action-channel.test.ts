import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyActionChannel, classifyRecipientString, actionLabelFor,
  classifyRecipientDomain,
} from '../src/action-channel.ts';

/**
 * Par quel canal une décision peut réellement être exécutée.
 *
 * La file d'approbation mélangeait dix dossiers dont quatre n'ont qu'un numéro
 * de téléphone. Proposer « envoyer » sur les dix ment sur quatre : un brouillon
 * d'e-mail adressé à `+33 4 76 45 69 25` ne partira jamais.
 *
 * Ce que ces tests tiennent :
 *
 *   · Rien n'est deviné. Le canal consigné à la résolution de contact fait foi
 *     tant que sa cible existe ; sinon c'est la disponibilité réelle qui
 *     tranche, jamais une préférence.
 *   · Une adresse non relevée sur une page n'est jamais un destinataire. Elle a
 *     été déduite d'un nom de domaine — plausible, invérifiable, et parfois la
 *     boîte de quelqu'un d'autre.
 */

const base = {
  email: null as string | null,
  phone: null as string | null,
  formUrl: null as string | null,
  recordedMethod: null as string | null,
  observed: true,
};

describe('le canal se lit, il ne se devine pas', () => {
  test('une adresse relevée donne EMAIL', () => {
    const v = classifyActionChannel({
      ...base, email: 'contact@groupe-ledoux.com', recordedMethod: 'EMAIL',
    });
    assert.equal(v.channel, 'EMAIL');
    assert.equal(v.target, 'contact@groupe-ledoux.com');
  });

  test('un numéro seul donne PHONE', () => {
    const v = classifyActionChannel({
      ...base, phone: '+33 4 76 45 69 25', recordedMethod: 'PHONE',
    });
    assert.equal(v.channel, 'PHONE');
    assert.equal(v.target, '+33 4 76 45 69 25');
  });

  test('un formulaire donne FORM', () => {
    const v = classifyActionChannel({
      ...base, formUrl: 'https://exemple.fr/contact', recordedMethod: 'FORM',
    });
    assert.equal(v.channel, 'FORM');
    assert.equal(v.target, 'https://exemple.fr/contact');
  });

  test('aucun canal donne UNAVAILABLE', () => {
    const v = classifyActionChannel({ ...base });
    assert.equal(v.channel, 'UNAVAILABLE');
    assert.equal(v.target, null);
  });

  test('le canal consigné l’emporte quand sa cible existe', () => {
    // Une entreprise qui publie un formulaire et une adresse générique a pu
    // être classée FORM pour une raison ; l'écran ne la reclasse pas.
    const v = classifyActionChannel({
      ...base,
      email: 'contact@exemple.fr',
      formUrl: 'https://exemple.fr/contact',
      recordedMethod: 'FORM',
    });
    assert.equal(v.channel, 'FORM');
  });

  test('un canal consigné sans cible retombe sur ce qui existe', () => {
    const v = classifyActionChannel({
      ...base, phone: '02 44 76 03 70', recordedMethod: 'EMAIL',
    });
    assert.equal(v.channel, 'PHONE', 'EMAIL consigné mais aucune adresse');
    assert.equal(v.target, '02 44 76 03 70');
  });
});

describe('une adresse devinée n’est jamais un destinataire', () => {
  test('non relevée sur une page, elle bascule en MANUAL', () => {
    // Le cas exact que la garde empêche : `contact@<domaine>` déduit du nom de
    // domaine. Plausible, invérifiable, et parfois la boîte de quelqu'un
    // d'autre.
    const v = classifyActionChannel({
      ...base, email: 'contact@exemple.fr', recordedMethod: 'EMAIL', observed: false,
    });
    assert.equal(v.channel, 'MANUAL');
    assert.equal(v.target, null, 'aucune cible : rien ne doit pouvoir partir');
    assert.match(v.reason, /devin/);
  });

  test('le dossier n’est pas perdu pour autant', () => {
    // MANUAL et non UNAVAILABLE : quelque chose existe, mais personne ne l'a vu
    // écrit. La décision humaine garde un sens.
    const v = classifyActionChannel({
      ...base, phone: '02 44 76 03 70', observed: false,
    });
    assert.equal(v.channel, 'MANUAL');
  });
});

describe('ce qui n’est pas une adresse ne devient pas une adresse', () => {
  test('une adresse incomplète est refusée', () => {
    for (const faux of ['nom@societe', 'contact@', '@exemple.fr', 'contact exemple.fr']) {
      const v = classifyActionChannel({ ...base, email: faux, recordedMethod: 'EMAIL' });
      assert.notEqual(v.channel, 'EMAIL', `« ${faux} » ne doit pas passer`);
    }
  });

  test('un numéro trop court n’est pas composable', () => {
    const v = classifyActionChannel({ ...base, phone: '01 23', recordedMethod: 'PHONE' });
    assert.equal(v.channel, 'UNAVAILABLE');
  });

  test('un formulaire doit être une adresse web', () => {
    const v = classifyActionChannel({ ...base, formUrl: '/contact', recordedMethod: 'FORM' });
    assert.equal(v.channel, 'UNAVAILABLE');
  });
});

describe('un destinataire déjà résolu se classe par sa forme', () => {
  test('les quatre formes se distinguent', () => {
    assert.equal(classifyRecipientString('contact@exemple.fr').channel, 'EMAIL');
    assert.equal(classifyRecipientString('https://exemple.fr/contact').channel, 'FORM');
    assert.equal(classifyRecipientString('+33 4 76 45 69 25').channel, 'PHONE');
    assert.equal(classifyRecipientString('via le salon de Hanovre').channel, 'MANUAL');
    assert.equal(classifyRecipientString(null).channel, 'UNAVAILABLE');
  });
});

describe('le libellé dit ce qui est possible, pas ce qui est promis', () => {
  test('chaque canal porte son geste réel', () => {
    assert.equal(actionLabelFor('EMAIL'), 'EMAIL READY');
    assert.equal(actionLabelFor('FORM'), 'MANUAL FORM');
    assert.equal(actionLabelFor('PHONE'), 'PHONE CONTACT — MANUAL');
    assert.equal(actionLabelFor('MANUAL'), 'MANUAL ACTION REQUIRED');
    assert.equal(actionLabelFor('UNAVAILABLE'), 'NO CHANNEL');
    // Aucun libellé n'annonce un envoi : rien n'est automatisé.
    for (const c of ['EMAIL', 'FORM', 'PHONE', 'MANUAL', 'UNAVAILABLE'] as const) {
      assert.equal(/envoyer|send now|expédier/i.test(actionLabelFor(c)), false);
    }
  });
});

describe('le domaine du destinataire est signalé, jamais bloqué', () => {
  const sans = [] as Array<{ claim: string; sourceUrl: string | null }>;

  test('même domaine : MATCH', () => {
    const v = classifyRecipientDomain({
      email: 'contact@exemple.fr', prospectDomain: 'exemple.fr', evidence: sans,
    });
    assert.equal(v.match, 'MATCH');
    assert.equal(v.recipientDomain, 'exemple.fr');
  });

  test('sous-domaine : MATCH', () => {
    for (const [email, domaine] of [
      ['contact@mail.exemple.fr', 'exemple.fr'],
      ['contact@exemple.fr', 'www.exemple.fr'],
      ['contact@www.exemple.fr', 'exemple.fr'],
    ] as Array<[string, string]>) {
      const v = classifyRecipientDomain({ email, prospectDomain: domaine, evidence: sans });
      assert.equal(v.match, 'MATCH', `${email} / ${domaine}`);
    }
  });

  test('domaine différent sans preuve : CROSS_DOMAIN', () => {
    /*
     * Le cas Diversitech-air, relevé tel quel : le site `diversitech-air.com`
     * publie `info@diversitech.ca` sur sa propre page de contact. L'adresse est
     * réelle et observée — mais qu'une entreprise publie une adresse ne prouve
     * pas que les deux domaines appartiennent à la même entité.
     */
    const v = classifyRecipientDomain({
      email: 'info@diversitech.ca',
      prospectDomain: 'diversitech-air.com',
      evidence: [{ claim: 'Un fait commercial', sourceUrl: 'https://www.diversitech-air.com/a-propos' }],
    });
    assert.equal(v.match, 'CROSS_DOMAIN');
    assert.equal(v.recipientDomain, 'diversitech.ca');
    assert.equal(v.relatedDomainEvidence, null);
    assert.match(v.reason, /aucune preuve/);
  });

  test('une preuve qui nomme l’autre domaine : MATCH, avec sa source', () => {
    const v = classifyRecipientDomain({
      email: 'info@diversitech.ca',
      prospectDomain: 'diversitech-air.com',
      evidence: [{
        claim: 'Filiale européenne du groupe diversitech.ca',
        sourceUrl: 'https://www.diversitech-air.com/mentions-legales',
      }],
    });
    assert.equal(v.match, 'MATCH');
    assert.equal(v.relatedDomainEvidence, 'https://www.diversitech-air.com/mentions-legales');
  });

  test('une preuve hébergée sur l’autre domaine relie aussi', () => {
    const v = classifyRecipientDomain({
      email: 'info@diversitech.ca',
      prospectDomain: 'diversitech-air.com',
      evidence: [{ claim: 'Un fait', sourceUrl: 'https://www.diversitech.ca/groupe' }],
    });
    assert.equal(v.match, 'MATCH');
  });

  test('une adresse illisible : UNKNOWN, jamais une conclusion', () => {
    for (const email of [null, 'pas-une-adresse', 'nom@societe']) {
      const v = classifyRecipientDomain({
        email, prospectDomain: 'exemple.fr', evidence: sans,
      });
      assert.equal(v.match, 'UNKNOWN', String(email));
    }
    assert.equal(
      classifyRecipientDomain({ email: 'a@b.fr', prospectDomain: null, evidence: sans }).match,
      'UNKNOWN',
    );
  });

  test('CROSS_DOMAIN ne bloque rien : c’est un signalement', () => {
    // Maison mère, filiale, domaine national, marque du groupe : le cas est
    // banal et souvent légitime. L'écran prévient, il ne tranche pas.
    const v = classifyRecipientDomain({
      email: 'info@autre.ca', prospectDomain: 'exemple.fr', evidence: sans,
    });
    assert.equal(v.match, 'CROSS_DOMAIN');
    assert.equal(v.recipientDomain, 'autre.ca', 'le destinataire reste nommé et utilisable');
  });
});
