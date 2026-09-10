import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOutreachDraft, pickPersonalizationFact, observationPhrase, customerFacingObservation,
  outreachFactFrom, isCommercialEvidence, personalizationIsGrounded, elide,
  type OutreachFact, type StoredEvidence,
} from '../src/outreach.ts';
import { checkHumanization } from '../src/humanization.ts';
import { INTERPRETATION_PREFIX } from '../src/verbatim-selection.ts';

/**
 * Le chemin réel : une preuve rangée en base jusqu'au message.
 *
 * Quatre défauts découverts sur des dossiers de production le rendaient
 * dangereux ou inutilisable, chacun invisible seul. L'interprétation était
 * écrite dans `basis` puis jamais relue ; la sélection retenait un fait que le
 * compositeur refusait ensuite ; le connecteur ne s'élidait pas devant une
 * voyelle ; et surtout, le message reprenait l'interprétation du modèle comme
 * si l'entreprise l'avait écrite.
 *
 * Ces tests suivent la donnée de bout en bout, dans l'ordre exact du lot, et
 * fixent la règle : ce que le client lit sur lui-même vient de ses mots.
 */

const contact = {
  name: null, role: null, email: null, phone: null,
  contactPage: 'https://asytec.fr/', sourceUrl: 'https://asytec.fr/',
  confidence: 0.7, named: false,
};

const brouillon = (facts: readonly OutreachFact[], company = 'ASYTEC') =>
  buildOutreachDraft({
    company, website: `https://${company.toLowerCase()}.fr`, facts, contact,
    whyThisCompany: 'fabricant industriel français',
    senderName: 'Noa Roy', offer: { priceEur: 49, deliveryHours: 24 },
  });

/** Une preuve telle que l'enrichissement verbatim l'écrit : relue à sa source. */
const preuveVerbatim = (
  id: string, claim: string, interpretation: string, sourceUrl = 'https://asytec.fr/',
): StoredEvidence => ({
  id, field: `verbatim:${id}`, claim, sourceUrl, nature: 'observed',
  basis: `${INTERPRETATION_PREFIX}${interpretation} — page « ASYTEC »`,
});

/** Une preuve d'avant le pipeline verbatim : reformulée par le modèle, jamais relue. */
const preuveAncienne = (id: string, claim: string): StoredEvidence => ({
  id, field: 'modèle_commercial', claim, sourceUrl: 'https://asytec.fr/',
  nature: 'observed', basis: null,
});

/* Le cas ASYTEC, tel qu'il est en base. */
const TIG = 'La Soudure TIG sur Inox La soudure TIG sur inox, alliée à l’automatisation, incarne '
  + 'l’apogée de la technique dans la production des capots de véhicules. Cette méthode, '
  + 'caractérisée par un arc électrique contrôlé, offre une qualité de soudure exceptionnelle.';
const TOLERIE = 'L’atelier de tôlerie industrielle est notre second pôle de compétences. Nous '
  + 'réalisons vos pièces métal en découpe et emboutissage.';
const MOULAGE = 'ASYTEC dispose de son propre atelier de moulage pour l’injection plastique et '
  + 'd’un atelier de tôlerie industrielle en Chine';

describe('la preuve stockée arrive au générateur entière', () => {
  test('le mapping du lot relit `basis` et marque la citation relue', () => {
    const fait = outreachFactFrom(preuveVerbatim('e1', MOULAGE, 'ASYTEC injecte du plastique'));
    assert.equal(fait.normalizedClaim, 'ASYTEC injecte du plastique');
    assert.equal(fait.claim, MOULAGE);
    assert.equal(fait.verbatim, true);
  });

  test('une reformulation n’est pas une citation relue', () => {
    const fait = outreachFactFrom(preuveAncienne('e2', 'Asytec propose de la sous-traitance'));
    assert.equal(fait.verbatim, false);
    assert.equal(fait.normalizedClaim, undefined);
  });

  test('une preuve d’identité ou de contact n’est jamais un fait commercial', () => {
    assert.equal(isCommercialEvidence({ field: 'identite:entite_juridique' }), false);
    assert.equal(isCommercialEvidence({ field: 'contact:email' }), false);
    assert.equal(isCommercialEvidence({ field: 'modèle_commercial' }), true);
    assert.equal(isCommercialEvidence({ field: 'verbatim:3' }), true);
  });
});

describe('ce que le client lit vient de ses mots, jamais de l’interprétation', () => {
  test('l’interprétation « ASYTEC produit des capots » ne peut pas devenir une phrase client', () => {
    /*
     * La source dit que la technique « incarne l'apogée […] dans la production
     * des capots de véhicules ». Elle ne dit pas qu'ASYTEC en fabrique. Le
     * modèle l'avait pourtant écrit, et le message l'aurait affirmé.
     */
    const fait = outreachFactFrom(preuveVerbatim('tig', TIG, 'ASYTEC produit des capots de véhicules par soudure TIG sur inox.'));
    const o = customerFacingObservation(fait);
    assert.doesNotMatch(o.observation, /produit des capots/);
    // Ce passage précis est un titre collé à son paragraphe : refusé, et dit.
    assert.equal(o.outreachSafe, false);
    assert.match(o.reason ?? '', /titre/);
  });

  test('une interprétation libre n’est jamais utilisée, même sur une citation sûre', () => {
    const fait = outreachFactFrom(preuveVerbatim('m', MOULAGE, 'ASYTEC est le leader mondial du moulage'));
    const o = customerFacingObservation(fait);
    assert.equal(o.outreachSafe, true);
    assert.doesNotMatch(o.observation, /leader mondial/);
    assert.match(o.observation, /vous écrivez « ASYTEC dispose de son propre atelier de moulage/);
  });

  test('une citation exacte est utilisable, entre guillemets', () => {
    const o = customerFacingObservation({ claim: MOULAGE, verbatim: true });
    assert.equal(o.outreachSafe, true);
    assert.equal(o.excerpt, MOULAGE);
    assert.equal(o.observation, `que vous écrivez « ${MOULAGE} ».`);
  });

  test('l’extrait est la première phrase, contiguë, telle quelle', () => {
    const o = customerFacingObservation({ claim: TOLERIE, verbatim: true });
    assert.equal(o.excerpt, 'L’atelier de tôlerie industrielle est notre second pôle de compétences');
    assert.ok(TOLERIE.includes(o.excerpt));
  });

  test('« nous sommes à la recherche de » devient « vous indiquez être à la recherche de »', () => {
    // L'exemple K2TEC, mot pour mot. Le complément passe tel quel.
    const o = customerFacingObservation({ claim: 'Nous sommes à la recherche de distributeurs !', verbatim: true });
    assert.equal(o.observation, 'que vous indiquez être à la recherche de distributeurs.');
  });

  test('une citation non relue à sa source ne parle jamais au client', () => {
    const o = customerFacingObservation({ claim: 'Nous sommes à la recherche de distributeurs !', verbatim: false });
    assert.equal(o.outreachSafe, false);
    assert.match(o.reason ?? '', /non relue/);
  });

  test('un titre de catalogue en capitales est refusé', () => {
    const o = customerFacingObservation({ claim: 'INJECTION PLASTIQUE SOUS-TRAITANCE MÉTAL', verbatim: true });
    assert.equal(o.outreachSafe, false);
  });

  test('un fragment sans proposition est refusé', () => {
    const o = customerFacingObservation({ claim: 'Conditionnement et logistique internationale', verbatim: true });
    assert.equal(o.outreachSafe, false);
  });

  test('un paragraphe entier n’est pas une phrase', () => {
    const long = `Nous ${'proposons des solutions '.repeat(12)}adaptées`;
    const o = customerFacingObservation({ claim: long, verbatim: true });
    assert.equal(o.outreachSafe, false);
    assert.match(o.reason ?? '', /trop long/);
  });
});

describe('la sélection retient un fait sûr, ou rien', () => {
  const ancienSignal = outreachFactFrom(
    preuveAncienne('vieux', 'Asytec s’adresse à des entreprises cherchant un sous-traitant industriel'),
  );
  const tig = outreachFactFrom(preuveVerbatim('tig', TIG, 'ASYTEC produit des capots de véhicules'));
  const tolerie = outreachFactFrom(preuveVerbatim('tol', TOLERIE, 'ASYTEC a un atelier de tôlerie'));
  const moulage = outreachFactFrom(preuveVerbatim('mou', MOULAGE, 'ASYTEC dispose d’un atelier de moulage'));

  test('premier fait non sûr → candidat suivant', () => {
    // L'ancien fait gagne le signal d'achat (« cherchant ») mais n'a jamais
    // été relu ; le TIG est relu mais commence par un titre collé.
    const retenu = pickPersonalizationFact([ancienSignal, tig, tolerie, moulage]);
    assert.ok(retenu);
    assert.notEqual(retenu.evidenceId, 'vieux');
    assert.notEqual(retenu.evidenceId, 'tig');
    assert.equal(customerFacingObservation(retenu).outreachSafe, true);
  });

  test('tous les faits non sûrs → aucun brouillon, et le motif est nommé', () => {
    const sortie = brouillon([ancienSignal, tig]);
    assert.equal(sortie.draft, null);
    assert.equal(sortie.refusal, 'NO_SOURCED_FACT');
    assert.match(sortie.reason, /cité au client/);
  });

  test('le signal d’achat garde la priorité quand il est sûr', () => {
    const signalSur = outreachFactFrom(
      preuveVerbatim('sig', 'Nous recherchons des distributeurs en France.', 'ASYTEC recherche des distributeurs'),
    );
    assert.equal(pickPersonalizationFact([moulage, signalSur, tolerie])?.evidenceId, 'sig');
  });

  test('un fait déduit reste écarté', () => {
    const deduit: OutreachFact = {
      evidenceId: 'd', claim: 'Nous exportons probablement.', sourceUrl: 'https://asytec.fr/',
      nature: 'inferred', verbatim: true,
    };
    assert.equal(pickPersonalizationFact([deduit]), null);
  });

  test('le message ne porte pas l’interprétation, et l’ancrage le vérifie', () => {
    const sortie = brouillon([ancienSignal, tig, tolerie, moulage]);
    assert.ok(sortie.draft, sortie.reason);
    assert.doesNotMatch(sortie.draft.messageEmail, /capots/);
    assert.doesNotMatch(sortie.draft.messageEmail, /cherchant un sous-traitant/);
    assert.ok(sortie.draft.messageEmail.includes(sortie.draft.evidenceExcerpt));
    assert.ok(sortie.draft.personalizationFact.claim.includes(sortie.draft.evidenceExcerpt));
    assert.equal(personalizationIsGrounded(sortie.draft), true);
  });
});

describe('l’objet et la question ne présupposent rien que la source n’établisse', () => {
  test('« Recherche de distributeurs » n’est écrit qu’à qui le publie', () => {
    const k2tec = outreachFactFrom(preuveVerbatim(
      'k', 'Nous sommes à la recherche de distributeurs !', 'K2TEC recherche des distributeurs',
      'https://www.k2tec.com/fr/contact/',
    ));
    const sortie = brouillon([k2tec], 'K2TEC');
    assert.ok(sortie.draft);
    assert.equal(sortie.draft.subject, 'Recherche de distributeurs');
    assert.match(sortie.draft.messageEmail, /Vous cherchez surtout des distributeurs/);
  });

  test('sans recherche publiée, ni l’objet ni la question ne l’inventent', () => {
    // L'interprétation dit « recherche des distributeurs » ; la source, non.
    const fait = outreachFactFrom(preuveVerbatim('m', MOULAGE, 'ASYTEC recherche des distributeurs'));
    const sortie = brouillon([fait]);
    assert.ok(sortie.draft);
    assert.doesNotMatch(sortie.draft.subject, /Recherche de/);
    assert.doesNotMatch(sortie.draft.messageEmail, /Vous cherchez surtout/);
    assert.match(sortie.draft.messageEmail, /\?/);
  });

  test('une page « devenir distributeur » est une recherche publiée par eux', () => {
    const harmony = outreachFactFrom(preuveVerbatim(
      'h', 'Nous vous proposons soit une distribution exclusive de nos produits soit de créer votre gamme.',
      'Harmony Béton propose une distribution exclusive',
      'https://www.harmony-beton.com/fr/content/15-devenir-distributeur',
    ));
    const sortie = brouillon([harmony], 'Harmony Béton');
    assert.ok(sortie.draft);
    assert.equal(sortie.draft.subject, 'Recherche de distributeurs');
  });
});

describe('le français tient', () => {
  test('« que » s’élide devant une voyelle ou un h, jamais devant une consonne', () => {
    assert.equal(elide('ASYTEC produit'), 'qu’ASYTEC produit');
    assert.equal(elide('Harmony Béton cherche'), 'qu’Harmony Béton cherche');
    assert.equal(elide('K2TEC recherche'), 'que K2TEC recherche');
    assert.equal(elide('vous écrivez'), 'que vous écrivez');
  });

  test('la casse n’est jamais touchée', () => {
    assert.match(elide('ASYTEC produit'), /ASYTEC/);
    assert.match(elide('Harmony Béton'), /Harmony Béton/);
  });

  test('aucun message produit ne contient « que » devant une voyelle', () => {
    const sortie = brouillon([outreachFactFrom(preuveVerbatim('m', MOULAGE, 'x'))]);
    assert.ok(sortie.draft);
    assert.doesNotMatch(sortie.draft.messageEmail, /\bque [AEIOUYÀÂÉÈÊËÎÏÔÙÛÜ]/);
    assert.doesNotMatch(sortie.draft.messageShort, /\bque [AEIOUYÀÂÉÈÊËÎÏÔÙÛÜ]/);
  });

  test('observationPhrase rend null quand le fait ne peut pas parler au client', () => {
    assert.equal(observationPhrase({ claim: 'INJECTION PLASTIQUE', verbatim: true }), null);
    assert.equal(observationPhrase({ claim: MOULAGE, verbatim: false }), null);
    assert.ok(observationPhrase({ claim: MOULAGE, verbatim: true }));
  });
});

describe('le canal décide de la longueur, et de rien d’autre', () => {
  const messageForm = [
    'Bonjour,', '',
    'J’ai vu sur votre site que vous écrivez « ASYTEC dispose de son propre atelier de moulage pour l’injection plastique ».', '',
    'Je peux vous en préparer 3 gratuitement, simplement pour que vous jugiez si le résultat est pertinent.', '',
    'Est-ce le genre de recherche qui pourrait vous être utile en ce moment ?', '',
    'Bien à vous,', 'Noa Roy',
  ].join('\n');

  test('un message de formulaire court et spécifique passe', () => {
    const r = checkHumanization({ body: messageForm, kind: 'FIRST_TOUCH', channel: 'FORM' });
    assert.equal(r.verdict, 'PASS', [...r.blockers, ...r.remarks].join(' · '));
    assert.ok(r.wordCount < 55);
  });

  test('le même texte reste NEEDS_EDIT en courriel', () => {
    const r = checkHumanization({ body: messageForm, kind: 'FIRST_TOUCH', channel: 'EMAIL' });
    assert.equal(r.verdict, 'NEEDS_EDIT');
    assert.ok(r.remarks.some((x) => /en deçà de 55/.test(x)));
  });

  test('sans canal précisé, ce sont les règles du courriel', () => {
    assert.equal(checkHumanization({ body: messageForm, kind: 'FIRST_TOUCH' }).verdict, 'NEEDS_EDIT');
  });

  test('le formulaire ne dispense d’aucune autre exigence', () => {
    const gabarit = ['Bonjour,', '', 'Je me permets de vous contacter dans le cadre de notre solution innovante.', '', 'Bien à vous,', 'Noa Roy'].join('\n');
    assert.equal(checkHumanization({ body: gabarit, kind: 'FIRST_TOUCH', channel: 'FORM' }).verdict, 'BLOCKED');
  });

  test('l’ancien gabarit reste refusé, quel que soit le canal', () => {
    const ancien = [
      'Bonjour,', '',
      'J’ai regardé ASYTEC et j’ai relevé ceci, publié sur votre site : sous-traitance industrielle.',
      'Source : https://asytec.fr/', '',
      'Je réalise des études de prospection B2B. 49 €, paiement unique, livré sous 24 h.', '',
      'Si ce n’est pas le moment, répondez « non merci » : je n’insisterai pas.', '',
      'Bien à vous,', 'Noa Roy',
    ].join('\n');
    for (const channel of ['EMAIL', 'FORM'] as const) {
      assert.notEqual(checkHumanization({ body: ancien, kind: 'FIRST_TOUCH', channel }).verdict, 'PASS', channel);
    }
  });
});

describe('bout en bout, dans l’ordre du lot', () => {
  const enBase: StoredEvidence[] = [
    { id: 'i1', field: 'identite:entite_juridique', claim: 'ASYTEC SAS', sourceUrl: 'https://asytec.fr/', nature: 'observed', basis: null },
    preuveAncienne('a1', 'Asytec s’adresse à des entreprises cherchant un sous-traitant industriel'),
    preuveVerbatim('tig', TIG, 'ASYTEC produit des capots de véhicules par soudure TIG sur inox.'),
    preuveVerbatim('tol', TOLERIE, 'ASYTEC a un atelier de tôlerie'),
    preuveVerbatim('mou', MOULAGE, 'ASYTEC dispose d’un atelier de moulage'),
  ];

  test('preuve stockée → mapping → sélection → brouillon → humanisation, sans un mot inventé', () => {
    const facts = enBase.filter(isCommercialEvidence).map(outreachFactFrom);
    assert.equal(facts.length, 4, 'la preuve d’identité est écartée');

    const sortie = brouillon(facts);
    assert.ok(sortie.draft, sortie.reason);
    assert.ok(sortie.draft.subject.length > 0);
    assert.doesNotMatch(sortie.draft.messageEmail, /capots/);
    assert.equal(personalizationIsGrounded(sortie.draft), true);

    const email = checkHumanization({ body: sortie.draft.messageEmail, kind: 'FIRST_TOUCH', channel: 'EMAIL' });
    assert.equal(email.verdict, 'PASS', [...email.blockers, ...email.remarks].join(' · '));
    const form = checkHumanization({ body: sortie.draft.messageShort, kind: 'FIRST_TOUCH', channel: 'FORM' });
    assert.equal(form.verdict, 'PASS', [...form.blockers, ...form.remarks].join(' · '));
  });

  test('aucune URL brute, aucun prix imposé', () => {
    const sortie = brouillon(enBase.filter(isCommercialEvidence).map(outreachFactFrom));
    assert.ok(sortie.draft);
    assert.doesNotMatch(sortie.draft.messageEmail, /Source\s*:/);
    assert.doesNotMatch(sortie.draft.messageEmail, /49\s*€/);
    assert.doesNotMatch(sortie.draft.messageEmail, /https?:\/\//);
  });

  test('des preuves jamais relues ne produisent toujours rien', () => {
    const facts = [preuveAncienne('a1', 'Asytec vend aux industriels.'), preuveAncienne('a2', 'Nous sommes à la recherche de distributeurs !')]
      .map(outreachFactFrom);
    assert.equal(brouillon(facts).draft, null);
  });
});
