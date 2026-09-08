import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOutreachDraft, pickPersonalizationFact,
  type OutreachFact, type OutreachContact,
} from '../src/outreach.ts';
import { checkHumanization } from '../src/humanization.ts';

// ─── LE GÉNÉRATEUR SUIT LA POLITIQUE D'HUMANISATION ─────────────────────────

describe('un premier contact généré est directement humain', () => {
  /**
   * `buildOutreachDraft` produisait « J'ai regardé X et j'ai relevé ceci,
   * publié sur votre site : … » suivi d'une URL brute, sans question finale et
   * jusqu'à 170 mots. Chaque brouillon automatique sortait donc en NEEDS_EDIT
   * et exigeait une réécriture à la main — une contradiction du pipeline.
   *
   * La règle vit dans `docs/SALES_HUMANIZATION_POLICY.md`.
   */
  const fait = (o: Partial<OutreachFact> = {}): OutreachFact => ({
    evidenceId: 'ev1',
    claim: 'Vous êtes un magasin de revêtement de sol, de peinture, marchand de matériaux.',
    normalizedClaim: 'Harmony Béton cherche des distributeurs parmi les magasins de revêtement de sol',
    sourceUrl: 'https://harmony-beton.com/fr/content/15-devenir-distributeur',
    nature: 'observed',
    ...o,
  });

  const construire = (facts: OutreachFact[], contact: OutreachContact | null = null) =>
    buildOutreachDraft({
      company: 'Harmony Béton', website: 'https://harmony-beton.com', facts, contact,
      whyThisCompany: 'fabricant', senderName: 'Noa Roy',
      offer: { priceEur: 49, deliveryHours: 24, freePreviewCount: 3 },
    });

  test('le message passe checkHumanization sans retouche', () => {
    const out = construire([fait()]);
    assert.ok(out.draft);
    const v = checkHumanization({ body: out.draft!.messageEmail, kind: 'FIRST_TOUCH' });
    assert.equal(v.verdict, 'PASS', [...v.blockers, ...v.remarks].join(' · '));
  });

  test('l’ouverture est spécifique et nomme la page', () => {
    const out = construire([fait()]);
    assert.match(out.draft!.messageEmail, /^Bonjour,\n\nJ'ai vu sur votre page distributeurs que /);
  });

  test('l’ancienne formule mécanique a disparu', () => {
    const t = construire([fait()]).draft!.messageEmail;
    assert.doesNotMatch(t, /j'ai relevé ceci/i);
    assert.doesNotMatch(t, /^Source :/m);
    assert.doesNotMatch(t, /Je réalise des études de prospection/i);
  });

  test('aucune URL brute dans le corps', () => {
    assert.equal((construire([fait()]).draft!.messageEmail.match(/https?:\/\//g) ?? []).length, 0);
  });

  test('le prix n’apparaît pas dans un premier contact', () => {
    assert.doesNotMatch(construire([fait()]).draft!.messageEmail, /49\s?€/);
  });

  test('l’aperçu gratuit de trois cibles est proposé', () => {
    assert.match(construire([fait()]).draft!.messageEmail, /3 gratuitement/);
  });

  test('le message finit par une vraie question', () => {
    const t = construire([fait()]).draft!.messageEmail;
    const avantSignature = t.split(/\nBien à vous,/)[0]!;
    assert.match(avantSignature.trimEnd(), /\?$/);
    assert.doesNotMatch(t, /n['’]hésitez pas à me contacter/i);
    assert.doesNotMatch(t, /répondez « non merci »/i);
  });

  test('un seul fait est cité, pas neuf', () => {
    const t = construire([fait(), fait({ evidenceId: 'ev2', normalizedClaim: 'Autre chose entièrement différente ici' })]).draft!.messageEmail;
    assert.equal(t.split('J\'ai vu sur votre').length - 1, 1);
  });

  test('le signal d’achat l’emporte sur le fait le plus long', () => {
    /*
     * Relevé sur k2tec.com : le tri par longueur retenait un paragraphe
     * d'histoire d'entreprise, alors que la même page publiait « Nous sommes à
     * la recherche de distributeurs ! ».
     */
    const long = fait({ evidenceId: 'long', normalizedClaim: 'K2TEC fabrique des filtres pour applications complexes depuis de nombreuses années et dispose de son propre atelier' });
    const signal = fait({ evidenceId: 'sig', normalizedClaim: 'K2TEC recherche des distributeurs' });
    assert.equal(pickPersonalizationFact([long, signal])?.evidenceId, 'sig');
  });

  test('les noms propres gardent leur majuscule', () => {
    // « que harmony Béton est fabricant » : forcer la minuscule mutilait le nom.
    assert.match(construire([fait()]).draft!.messageEmail, /que Harmony Béton/);
  });

  test('sans interprétation lisible, aucun brouillon n’est produit', () => {
    /*
     * La citation brute est souvent un fragment de catalogue — « distribution
     * de colis, consigne de matériels informatiques… » — qui ne s'enchaîne
     * après aucun connecteur. Mieux vaut aucun message qu'une phrase bancale.
     */
    const out = construire([fait({ normalizedClaim: null })]);
    assert.equal(out.draft, null);
    assert.equal(out.refusal, 'NO_SOURCED_FACT');
  });

  test('l’objet est court et sans suffixe de campagne', () => {
    const s = construire([fait()]).draft!.subject;
    assert.ok(s.length <= 60, s);
    assert.doesNotMatch(s, /étude de prospection B2B/);
  });

  test('la salutation passe par greetingFor', () => {
    // Boîte générique : pas de prénom, même avec un nom et un rôle publiés.
    const contact: OutreachContact = {
      name: 'Pascal Sartori', role: 'Dirigeant', email: 'contact@k2tec.com',
      phone: null, contactPage: null, sourceUrl: null, confidence: 0.9, named: true,
    };
    assert.match(construire([fait()], contact).draft!.messageEmail, /^Bonjour,\n/);
  });

  test('l’ancien gabarit mécanique reste NEEDS_EDIT', () => {
    // Le juge n'a pas été assoupli : c'est le générateur qui a changé.
    const ancien = 'Bonjour,\n\nJ\'ai regardé Untel et j\'ai relevé ceci, publié sur votre site : '
      + 'quelque chose.\nSource : https://untel.fr/\n\nJe réalise des études de prospection B2B. '
      + 'Concrètement : vous me dites ce que vous vendez et à qui, j\'identifie des entreprises '
      + 'cibles sur le marché visé, je les qualifie une par une.\n\n'
      + 'Si ce n\'est pas le moment, répondez « non merci ».\n\nBien à vous,\nNoa Roy';
    assert.notEqual(checkHumanization({ body: ancien, kind: 'FIRST_TOUCH' }).verdict, 'PASS');
  });
});
