import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATLAS_SALES_ICP,
  filterCandidate,
  dedupeCandidates,
  domainOf,
  whyNotACompanyName,
  type RawCandidate,
} from '../src/sales-icp.ts';
import {
  scoreSalesProspect,
  evidenceQuality,
  tierFor,
  SALES_SCORING_MODEL,
  SALES_TIER_THRESHOLDS,
  type SalesAssessment,
} from '../src/sales-score.ts';
import {
  buildOutreachDraft,
  personalizationIsGrounded,
  pickPersonalizationFact,
  canTransitionProspect,
  requiresHumanApproval,
  trimSentence,
  type OutreachFact,
} from '../src/outreach.ts';
import { planQueries, looksLikeCompanySite, SALES_QUERY_VOCABULARY } from '../src/sales-queries.ts';

/**
 * ATLAS travaille pour ATLAS, et les mêmes règles s'appliquent.
 *
 * La sortie n'est plus un rapport mais un message qui partira sous notre nom.
 * Ce qui était embarrassant dans un livrable devient ici irrattrapable : une
 * entreprise inventée, une adresse reconstruite ou un « j'ai vu que… » fabriqué
 * se découvrent chez le destinataire, en dix secondes, et il a raison de ne plus
 * rien lire ensuite.
 */

const candidate = (over: Partial<RawCandidate> = {}): RawCandidate => ({
  companyName: 'Atelier Mécanique Durand',
  domain: null,
  country: 'France',
  industry: 'Usinage de précision',
  sourceUrl: 'https://atelier-durand.fr/nos-produits',
  searchProvider: 'searxng',
  query: 'fabricant usinage précision France distributeurs',
  discoveredAt: '2026-08-18T10:00:00.000Z',
  snippet: 'Nous recherchons des distributeurs pour accompagner notre développement export.',
  ...over,
});

describe('le tri déterministe, avant toute dépense', () => {
  test('un candidat plausible est retenu, avec ses signaux', () => {
    const decision = filterCandidate(candidate(), ATLAS_SALES_ICP);
    assert.equal(decision.outcome, 'kept');
    assert.ok(decision.signals.expansion.includes('export'));
    assert.ok(decision.signals.prospectingNeed.includes('nous recherchons des distributeurs'));
  });

  test('un annuaire est écarté sans coûter un appel', () => {
    // C'est tout l'intérêt du tri gratuit : `societe.com` désigne une fiche,
    // pas une entreprise cliente. L'analyser reviendrait à payer pour
    // découvrir qu'on a trouvé un annuaire.
    for (const url of [
      'https://www.societe.com/societe/durand-123456.html',
      'https://fr.linkedin.com/company/durand',
      'https://www.pagesjaunes.fr/pros/durand',
    ]) {
      const decision = filterCandidate(candidate({ sourceUrl: url, domain: null }), ATLAS_SALES_ICP);
      assert.equal(decision.outcome, 'rejected', `« ${url} » doit être écarté`);
      assert.match(decision.reason, /annuaire|plateforme/);
    }
  });

  test('un mot écarté par le profil suffit', () => {
    const decision = filterCandidate(
      candidate({ snippet: 'Offres d’emploi et recrutement dans la région.' }),
      ATLAS_SALES_ICP,
    );
    assert.equal(decision.outcome, 'rejected');
  });

  test('une information absente ne disqualifie pas', () => {
    // Un pays inconnu est une information manquante, pas contraire. C'est la
    // qualification, plus loin, qui aura de quoi trancher.
    const decision = filterCandidate(
      candidate({ country: null, industry: null, snippet: null }),
      ATLAS_SALES_ICP,
    );
    assert.equal(decision.outcome, 'kept');
  });

  test('sans domaine exploitable, rien à identifier', () => {
    const decision = filterCandidate(
      candidate({ sourceUrl: 'pas une adresse', domain: null }),
      ATLAS_SALES_ICP,
    );
    assert.equal(decision.outcome, 'rejected');
  });

  test('deux pages d’un même site font un seul prospect', () => {
    // Sinon le compte de découverte gonfle sans rien ajouter, et le premier
    // chiffre qu'on regarde devient le moins fiable.
    const deduped = dedupeCandidates([
      candidate({ sourceUrl: 'https://atelier-durand.fr/produits' }),
      candidate({ sourceUrl: 'https://www.atelier-durand.fr/contact' }),
      candidate({ companyName: 'Autre', sourceUrl: 'https://autre-societe.fr/' }),
    ]);
    assert.equal(deduped.length, 2);
    assert.deepEqual(
      deduped.map((c) => c.domain).sort(),
      ['atelier-durand.fr', 'autre-societe.fr'],
    );
  });

  test('le domaine est réduit à son enregistrable', () => {
    assert.equal(domainOf('https://www.atelier-durand.fr/a/b?c=1'), 'atelier-durand.fr');
    // « co.uk » est un suffixe public : l'enregistrable est exemple.co.uk, et
    // « shop » n'est qu'un sous-domaine. Le confondre ferait de chaque
    // sous-domaine un prospect distinct.
    assert.equal(domainOf('http://shop.exemple.co.uk/'), 'exemple.co.uk');
    assert.equal(domainOf('pas-une-url'), null);
  });
});

describe('le score d’acquisition', () => {
  const assessment = (over: Partial<SalesAssessment> = {}): SalesAssessment => ({
    dimension: 'needFit',
    value: 70,
    rationale: 'Signal compatible avec un besoin de prospection.',
    confidence: 0.8,
    evidenceIds: ['sev_1'],
    ...over,
  });

  const full = (value: number): SalesAssessment[] =>
    SALES_SCORING_MODEL.filter((d) => !d.computed).map((d) =>
      assessment({ dimension: d.key, value }),
    );

  test('le total reste dans 0–100', () => {
    for (const value of [0, 50, 100]) {
      const score = scoreSalesProspect({
        assessments: full(value),
        evidence: { observed: 3, reported: 1, inferred: 0, sourced: 4 },
      });
      assert.ok(score.total >= 0 && score.total <= 100, `total hors bornes : ${score.total}`);
    }
  });

  test('le rang découle du total, il n’est jamais posé', () => {
    assert.equal(tierFor(SALES_TIER_THRESHOLDS.priority), 'PRIORITY');
    assert.equal(tierFor(SALES_TIER_THRESHOLDS.priority - 1), 'GOOD_FIT');
    assert.equal(tierFor(SALES_TIER_THRESHOLDS.goodFit - 1), 'WATCH');
    assert.equal(tierFor(SALES_TIER_THRESHOLDS.watch - 1), 'REJECTED');
  });

  test('un prospect faible ne peut pas être PRIORITY', () => {
    // La garde qui empêche de forcer cinq prospects prioritaires quand il n'y
    // en a que deux de bons.
    const score = scoreSalesProspect({
      assessments: full(20),
      evidence: { observed: 0, reported: 1, inferred: 2, sourced: 1 },
    });
    assert.notEqual(score.tier, 'PRIORITY');
    assert.equal(score.tier, 'REJECTED');
  });

  test('la qualité des preuves est calculée, jamais affirmée', () => {
    const score = scoreSalesProspect({
      assessments: [
        ...full(80),
        // Une tentative d'auto-évaluation : elle doit être ignorée.
        assessment({ dimension: 'evidenceQuality', value: 100, rationale: 'excellent' }),
      ],
      evidence: { observed: 0, reported: 0, inferred: 3, sourced: 0 },
    });
    const computed = score.components.find((c) => c.dimension === 'evidenceQuality')!;
    assert.equal(computed.computed, true);
    assert.ok(computed.value < 30, `une évaluation non sourcée ne vaut pas ${computed.value}`);
  });

  test('rien de sourcé ne vaut rien', () => {
    assert.equal(evidenceQuality({ observed: 0, reported: 0, inferred: 0, sourced: 0 }), 0);
    assert.equal(evidenceQuality({ observed: 3, reported: 0, inferred: 0, sourced: 0 }), 0);
  });

  test('un axe non évalué réduit la confiance, il ne compte pas zéro', () => {
    const partial = scoreSalesProspect({
      assessments: [assessment({ dimension: 'needFit', value: 90 })],
      evidence: { observed: 2, reported: 0, inferred: 0, sourced: 2 },
    });
    // Deux axes seulement : le total reste élevé parce que les poids sont
    // normalisés sur ce qui a pu être jugé.
    assert.ok(partial.total > 40, `un axe manquant ne doit pas écraser le total : ${partial.total}`);
    assert.equal(partial.components.length, 2);
  });

  test('chaque dimension porte sa justification', () => {
    const score = scoreSalesProspect({
      assessments: full(65),
      evidence: { observed: 2, reported: 1, inferred: 0, sourced: 3 },
    });
    for (const component of score.components) {
      assert.ok(component.rationale.trim().length > 0, `${component.dimension} sans justification`);
    }
  });
});

describe('l’approche ne se personnalise que sur un fait réel', () => {
  const fact = (over: Partial<OutreachFact> = {}): OutreachFact => ({
    evidenceId: 'sev_1',
    claim: 'Nous recherchons des distributeurs pour accompagner notre développement export.',
    // L'interprétation classe ; la citation exacte, relue, est la seule à parler au client.
    normalizedClaim: 'Atelier Mécanique Durand recherche des distributeurs à l’export',
    sourceUrl: 'https://atelier-durand.fr/partenaires',
    nature: 'observed',
    verbatim: true,
    ...over,
  });

  const draftWith = (facts: OutreachFact[]) =>
    buildOutreachDraft({
      company: 'Atelier Mécanique Durand',
      website: 'https://atelier-durand.fr',
      facts,
      contact: null,
      whyThisCompany: 'PME B2B cherchant des distributeurs.',
      offer: { priceEur: 49, deliveryHours: 24 },
    });

  test('un fait constaté et sourcé produit les deux messages', () => {
    const outcome = draftWith([fact()]);
    assert.ok(outcome.draft);
    assert.equal(outcome.draft.sourceUsedForPersonalization, 'https://atelier-durand.fr/partenaires');
    assert.equal(personalizationIsGrounded(outcome.draft), true);
  });

  test('sans fait sourcé, aucun brouillon n’est fabriqué', () => {
    // Le prospect reste dans la liste, sans message. C'est un meilleur
    // résultat qu'un brouillon plausible.
    const outcome = draftWith([]);
    assert.equal(outcome.draft, null);
    assert.equal(outcome.refusal, 'NO_SOURCED_FACT');
  });

  test('une déduction ne fonde jamais un « j’ai vu que »', () => {
    const outcome = draftWith([fact({ nature: 'inferred', sourceUrl: '' })]);
    assert.equal(outcome.draft, null);
    assert.equal(outcome.refusal, 'NO_SOURCED_FACT');
  });

  test('un fait sans adresse ne compte pas', () => {
    const outcome = draftWith([fact({ sourceUrl: '' })]);
    assert.equal(outcome.draft, null);
  });

  test('le message porte l’observation, ancrée sur le fait', () => {
    /*
     * Le message portait la citation exacte, collée après « j'ai relevé ceci,
     * publié sur votre site : » — une forme mécanique. Puis il a porté
     * l'interprétation du modèle, et sur asytec.fr celle-ci affirmait ce que la
     * source ne disait pas. Il porte désormais leurs mots, dans un habillage
     * déterministe : « nous recherchons » devient « vous indiquez rechercher ».
     * `personalizationIsGrounded` vérifie que l'extrait est bien dans le fait.
     */
    const outcome = draftWith([fact()]);
    assert.equal(personalizationIsGrounded(outcome.draft!), true);
    assert.match(outcome.draft!.messageEmail, /vous indiquez rechercher des distributeurs pour accompagner notre développement export/);
    // L'interprétation — « à l'export » — n'y est pas : la source ne le dit pas ainsi.
    assert.doesNotMatch(outcome.draft!.messageEmail, /à l’export/);
    assert.doesNotMatch(outcome.draft!.messageEmail, /j'ai relevé ceci/i);
  });

  test('la source reste attachée au brouillon, hors du texte', () => {
    /*
     * L'adresse était collée dans le corps, sous une ligne « Source : ». La
     * politique d'humanisation la retire du message — une URL brute après
     * chaque phrase se lit comme un rapport — mais elle ne disparaît pas : le
     * brouillon la porte, et Approvals l'affiche.
     */
    const outcome = draftWith([fact()]);
    assert.equal(outcome.draft!.sourceUsedForPersonalization, 'https://atelier-durand.fr/partenaires');
    assert.doesNotMatch(outcome.draft!.messageEmail, /https?:\/\//);
  });

  test('le fait le plus spécifique est retenu', () => {
    const chosen = pickPersonalizationFact([
      fact({ evidenceId: 'sev_a', claim: 'Société active.' }),
      fact({ evidenceId: 'sev_b' }),
    ]);
    assert.equal(chosen?.evidenceId, 'sev_b');
  });

  test('une citation tronquée ne coupe pas au milieu d’un mot', () => {
    const long = `${'Nous fabriquons des pièces usinées pour l’aéronautique. '.repeat(10)}`;
    const trimmed = trimSentence(long, 120);
    assert.ok(trimmed.length <= 121);
    assert.ok(!/\w…$/.test(trimmed) || trimmed.endsWith('. '), 'coupe propre attendue');
  });

  test('le message ne promet aucun résultat', () => {
    const outcome = draftWith([fact()]);
    const text = `${outcome.draft!.messageShort} ${outcome.draft!.messageEmail}`.toLowerCase();
    for (const forbidden of ['garanti', 'garantie', 'doublez', 'x2', 'immédiatement rentable']) {
      assert.ok(!text.includes(forbidden), `« ${forbidden} » n’a rien à faire dans un message`);
    }
  });
});

describe('rien ne part sans un humain', () => {
  test('la seule transition réservée est celle qui déclenche un envoi', () => {
    assert.equal(requiresHumanApproval('READY_FOR_REVIEW', 'APPROVED_TO_CONTACT'), true);
    assert.equal(requiresHumanApproval('DISCOVERED', 'QUALIFIED'), false);
  });

  test('on ne saute jamais de la découverte au contact', () => {
    assert.equal(canTransitionProspect('DISCOVERED', 'APPROVED_TO_CONTACT'), false);
    assert.equal(canTransitionProspect('DISCOVERED', 'CONTACTED'), false);
    assert.equal(canTransitionProspect('QUALIFIED', 'CONTACTED'), false);
  });

  test('le chemin complet reste possible', () => {
    const path = [
      ['DISCOVERED', 'QUALIFIED'],
      ['QUALIFIED', 'READY_FOR_REVIEW'],
      ['READY_FOR_REVIEW', 'APPROVED_TO_CONTACT'],
      ['APPROVED_TO_CONTACT', 'CONTACTED'],
      ['CONTACTED', 'REPLIED'],
      ['REPLIED', 'INTERESTED'],
      ['INTERESTED', 'ORDERED'],
      ['ORDERED', 'PAID'],
    ] as const;
    for (const [from, to] of path) {
      assert.equal(canTransitionProspect(from, to), true, `${from} → ${to} doit être permis`);
    }
  });

  test('un prospect payé est final', () => {
    assert.equal(canTransitionProspect('PAID', 'CONTACTED'), false);
    assert.equal(canTransitionProspect('LOST', 'REPLIED'), false);
  });
});

/**
 * Un titre de page n'est pas une raison sociale.
 *
 * Le premier batch réel a retenu « Nous recherchons des distributeurs » comme
 * nom d'entreprise, l'a qualifié et l'a noté 68 sur 100. Le pipeline a
 * parfaitement fonctionné sur une entrée qui n'était pas une entreprise — et un
 * message d'approche serait parti sous notre nom, adressé à une phrase.
 */
describe('un titre de page n’est pas une entreprise', () => {
  test('le cas exact du premier batch', () => {
    const decision = filterCandidate(
      candidate({ companyName: 'Nous recherchons des distributeurs' }),
      ATLAS_SALES_ICP,
    );
    assert.equal(decision.outcome, 'rejected');
    assert.match(decision.reason, /phrase, pas une raison sociale/);
  });

  test('les tournures de titre les plus courantes', () => {
    for (const title of [
      'Comment devenir revendeur',
      'Accueil - Machines industrielles',
      'Découvrez notre réseau de distribution',
      'Les meilleurs fabricants français',
      'Contact',
    ]) {
      assert.ok(whyNotACompanyName(title), `« ${title} » doit être écarté`);
    }
  });

  test('une phrase trop longue est un titre', () => {
    assert.ok(
      whyNotACompanyName('Fabricant de machines de découpe laser pour la tôlerie industrielle depuis 1985'),
    );
  });

  test('les vraies raisons sociales passent', () => {
    for (const name of [
      'Atelier Mécanique Durand',
      'SYS TEC electronic AG',
      'Hagenauer+Denk KG',
      'Burghardt Verpackungsmaschinen',
      'Lilie GmbH',
      'ACME',
    ]) {
      assert.equal(whyNotACompanyName(name), null, `« ${name} » ne doit pas être écarté`);
    }
  });

  test('dans le doute, on garde', () => {
    // Un rejet à tort fait perdre un prospect réel ; un faux positif sera
    // écarté plus loin pour quelques millièmes de dollar.
    assert.equal(whyNotACompanyName('Groupe Bernard'), null);
    assert.equal(whyNotACompanyName('SAS Martin & Fils'), null);
  });
});

/**
 * Chercher des entreprises, pas des intentions.
 *
 * Le premier lot cherchait « nous recherchons des distributeurs » — la
 * formulation la plus proche du besoin, et c'est pour cela qu'elle a échoué :
 * elle ramène des pages « devenir revendeur », dont le titre n'est jamais une
 * raison sociale. Un moteur sait trouver des fabricants ; il ne sait pas
 * trouver des intentions.
 */
describe('les requêtes sont engendrées par règles', () => {
  test('elles couvrent les trois familles', () => {
    const families = new Set(planQueries().map((p) => p.family));
    for (const expected of ['metier', 'site']) {
      assert.ok(families.has(expected), `famille « ${expected} » absente`);
    }
  });

  test('la famille « site » vise des pages qui n’existent que sur un site officiel', () => {
    // « nos produits » ou « notre entreprise » ne se trouvent pas sur un
    // annuaire. C'est le filtre anti-annuaire le moins cher : il est dans la
    // requête.
    const site = planQueries().filter((p) => p.family === 'site');
    assert.ok(site.length > 0);
    for (const plan of site) assert.match(plan.query, /"/, 'une expression exacte est attendue');
  });

  test('aucune requête ne cherche une intention en premier', () => {
    // Les familles qui ramènent des entreprises passent avant celle qui
    // ramène des intentions : le budget de qualification leur revient.
    const first = planQueries()[0]!;
    assert.notEqual(first.family, 'expansion');
  });

  test('le plan est déterministe : deux appels donnent le même lot', () => {
    assert.deepEqual(planQueries(), planQueries());
  });

  test('la limite est respectée', () => {
    assert.equal(planQueries(SALES_QUERY_VOCABULARY, 3).length, 3);
  });
});

describe('un article n’est pas un site d’entreprise', () => {
  test('les chemins de contenu sont écartés gratuitement', () => {
    for (const url of [
      'https://exemple.fr/actualites/2026/nouveau-fabricant',
      'https://exemple.fr/blog/comment-choisir',
      'https://exemple.fr/emploi/technicien',
      'https://exemple.fr/annuaire/fabricants',
      'https://exemple.fr/recherche?q=machines',
    ]) {
      assert.equal(looksLikeCompanySite(url).ok, false, `« ${url} » doit être écarté`);
    }
  });

  test('une page trop profonde est presque toujours un article', () => {
    assert.equal(looksLikeCompanySite('https://x.fr/a/b/c/d/e/f').ok, false);
  });

  test('les pages d’entreprise passent', () => {
    for (const url of [
      'https://atelier-durand.fr/',
      'https://atelier-durand.fr/nos-produits',
      'https://atelier-durand.fr/entreprise/export',
      'https://atelier-durand.fr/distributeurs',
    ]) {
      assert.equal(looksLikeCompanySite(url).ok, true, `« ${url} » doit passer`);
    }
  });

  test('une adresse illisible est écartée', () => {
    assert.equal(looksLikeCompanySite('pas une url').ok, false);
  });
});

test('la vague fait tourner le plan sans le rendre imprévisible', () => {
  // Le lot 005 a rendu 1 seul candidat : les mêmes deux requêtes partaient à
  // chaque lot, et la déduplication écartait tout. La rotation reste une
  // règle — à vague égale, le plan est identique.
  const first = planQueries(undefined, 4, 0);
  const second = planQueries(undefined, 4, 1);
  const firstAgain = planQueries(undefined, 4, 0);

  assert.deepEqual(first.map((p) => p.query), firstAgain.map((p) => p.query), 'reproductible');
  assert.notDeepEqual(first.map((p) => p.query), second.map((p) => p.query), 'un autre terrain');
  for (const plan of second) assert.ok(plan.query.length > 10);
});

test('la rotation est bornée : aucune vague ne produit de requête vide', () => {
  // La période est le ppcm des quatre listes ; l'affirmer rendrait le test
  // faux au premier mot ajouté au vocabulaire. Ce qui doit tenir, c'est
  // qu'aucune vague ne sorte du vocabulaire.
  const vocabulary = SALES_QUERY_VOCABULARY;
  for (const wave of [0, 1, 7, 59, 60, 199]) {
    const plans = planQueries(undefined, 8, wave);
    assert.ok(plans.length > 0, `vague ${wave} sans requête`);
    for (const plan of plans) {
      assert.ok(plan.query.trim().length > 10, `vague ${wave} : requête vide`);
      // La famille « besoin » cite des phrases exactes plutôt qu'un métier :
      // c'est l'entreprise qui déclare, pas nous qui décrivons.
      if (plan.family === 'besoin') continue;
      assert.ok(
        vocabulary.activities.some((a) => plan.query.includes(a)),
        `vague ${wave} : « ${plan.query} » sort du vocabulaire`,
      );
    }
  }
});

test('une famille cherche les entreprises qui déclarent un besoin', () => {
  // Les familles « métier » et « site » trouvent des entreprises conformes au
  // profil ; aucune ne trouvait celles qui cherchent des clients. Le
  // classement d'acquisition a plafonné à 52 sur 100 faute de ce signal.
  // Elle passe en tête : avec le plafond de huit requêtes du lot, placée en
  // dernier elle était tronquée et n'aurait jamais tourné.
  const plan = planQueries(undefined, 8, 0);
  const besoin = plan.filter((p) => p.family === 'besoin');
  assert.ok(besoin.length >= 2, 'la famille existe et survit à la troncature');
  assert.equal(plan[0]!.family, 'besoin', 'et elle part la première');
  // Les autres familles survivent aussi : le plan les entrelace au lieu de
  // les ranger bout à bout puis de couper.
  assert.ok(new Set(plan.map((p) => p.family)).size >= 3, 'aucune famille écrasée');
  for (const plan of besoin) {
    assert.ok(/"/.test(plan.query), 'une phrase exacte, pas un thème');
  }
  assert.ok(besoin.some((p) => p.query.includes('distributeur')));
});
