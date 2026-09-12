import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectSourcedFacts, enrichmentPagesFor, enrichmentLinksIn,
} from '../src/prospect-enrichment.ts';

/**
 * Chercher deux faits, puis s'arrêter.
 *
 * Le lot du 26/08/2026 a qualifié huit entreprises, en a retenu une seule en
 * PRIORITY — 71,6/100 — et n'a produit aucun brouillon, faute de deux faits
 * constatés et sourcés. La garde n'était pas trop stricte : il n'y avait
 * réellement aucun fait. Les pages du site avaient pourtant été lues quelques
 * lignes plus haut, pour y trouver une adresse, puis jetées.
 *
 * Ce que ces tests tiennent :
 *
 *   · La collecte s'arrête au deuxième fait. C'est ce qui autorise un plafond
 *     de quinze pages sans que quinze pages soient jamais lues : le plafond
 *     décrit le pire cas. Sans l'arrêt, augmenter la profondeur reviendrait à
 *     multiplier les requêtes par deux pour tout le monde.
 *   · Un fait porte l'adresse de la page où il a été lu, et cette page
 *     appartient au domaine officiel. Un fait relevé ailleurs n'est pas
 *     vérifiable par le destinataire, et c'est exactement ce qu'un message
 *     prétend offrir.
 *   · Deux faits sont de natures différentes. « Depuis 1976 » et « quarante
 *     ans d'expérience » disent la même chose ; les compter pour deux
 *     rouvrirait la porte que la garde ferme.
 */

const page = (path: string, sentences: string[]): string =>
  `<html><body><main>${sentences.map((s) => `<p>${s}</p>`).join('')}</main>` +
  `<!-- ${path} --></body></html>`;

/** Une phrase par nature, écrite comme un vrai site l'écrit. */
const EXPORT_FACT =
  'Nous accompagnons depuis 1976 des industriels à l’international, avec une équipe ' +
  'de quarante-deux personnes basée à Lyon.';
const HIRING_FACT =
  'Pour accompagner cette croissance nous recrutons un technicien de maintenance et ' +
  'un opérateur sur commande numérique.';
const CAPACITY_FACT =
  'Nous avons installé cette année une nouvelle machine de découpe laser dans notre ' +
  'atelier de Vénissieux.';
const MARKETS_FACT =
  'Nos pièces équipent des donneurs d’ordres de l’aéronautique et du ferroviaire, sur ' +
  'des séries de quelques dizaines à plusieurs milliers.';

/**
 * Une récupération qui compte ses appels, et se comporte comme la vraie.
 *
 * `fetchRawPages` parcourt les adresses jusqu'à en avoir assez qui répondent ;
 * les autres deviennent des échecs. Reproduire ce comportement compte : c'est
 * lui qui fait qu'une file de cinquante adresses dont trois existent coûte
 * trois pages et non cinquante.
 */
function fakeSite(pages: Record<string, string>, options: { catchAll?: string } = {}) {
  let calls = 0;
  let served = 0;
  const fetchPages = async (urls: readonly string[], maxPages: number) => {
    calls += 1;
    const out: Array<{ url: string; html: string }> = [];
    const failures: Array<{ url: string }> = [];
    for (const url of urls) {
      if (out.length >= maxPages) break;
      const html = pages[url] ?? options.catchAll;
      if (html === undefined) failures.push({ url });
      else { out.push({ url, html }); served += 1; }
    }
    return { pages: out, failures };
  };
  return { fetchPages, get calls() { return calls; }, get served() { return served; } };
}

const SITE = 'https://exemple-industrie.fr';
const DOMAIN = 'exemple-industrie.fr';

describe('la collecte s’arrête dès qu’elle a ce qu’elle cherchait', () => {
  test('deux faits distincts suffisent, et la lecture s’interrompt', async () => {
    // La propriété centrale : le plafond vaut quinze, la collecte en lit deux.
    const site = fakeSite({
      [`${SITE}/`]: page('/', [EXPORT_FACT]),
      [`${SITE}/a-propos`]: page('/a-propos', [HIRING_FACT]),
      [`${SITE}/savoir-faire`]: page('/savoir-faire', [CAPACITY_FACT]),
      [`${SITE}/references`]: page('/references', [MARKETS_FACT]),
    });

    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15, fetchPages: site.fetchPages,
    });

    assert.equal(outcome.factsFound, 2);
    assert.equal(outcome.earlyStopReason, 'ENOUGH_FACTS');
    assert.equal(outcome.pagesVisited, 2, 'deux pages lues, pas quinze');
    assert.equal(site.served, 2, 'la troisième page n’a jamais été demandée');
  });

  test('les pages déjà en main sont lues avant toute requête', async () => {
    // L'étape des contacts vient de lire ces pages. Les redemander doublerait
    // les requêtes pour obtenir exactement le même HTML.
    const site = fakeSite({}, { catchAll: page('/x', [MARKETS_FACT]) });
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15,
      seedPages: [
        { url: `${SITE}/`, html: page('/', [EXPORT_FACT]) },
        { url: `${SITE}/entreprise`, html: page('/entreprise', [HIRING_FACT]) },
      ],
      fetchPages: site.fetchPages,
    });

    assert.equal(outcome.factsFound, 2);
    assert.equal(outcome.earlyStopReason, 'ENOUGH_FACTS');
    assert.equal(outcome.pagesFetchedExtra, 0, 'aucune requête réseau');
    assert.equal(outcome.pagesReused, 2, 'les deux pages déjà en main sont bien comptées');
    assert.equal(site.calls, 0);
  });

  test('le plafond de pages tient quand le site ne dit rien de citable', async () => {
    const site = fakeSite({}, { catchAll: page('/x', ['Bienvenue sur notre site.']) });
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 4, fetchPages: site.fetchPages,
    });

    assert.equal(outcome.factsFound, 0);
    assert.equal(outcome.earlyStopReason, 'PAGE_BUDGET_REACHED');
    assert.equal(outcome.pagesVisited, 4, 'jamais plus que le plafond');
  });

  test('les pages déjà lues comptent dans le plafond', async () => {
    // Sinon « quinze pages par domaine » en autorise vingt-trois : huit à
    // l'étape des contacts, quinze ici.
    const seeds = Array.from({ length: 4 }, (_, i) => ({
      url: `${SITE}/p${i}`, html: page(`/p${i}`, ['Bienvenue sur notre site.']),
    }));
    const site = fakeSite({}, { catchAll: page('/x', ['Bienvenue sur notre site.']) });
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 6, seedPages: seeds, fetchPages: site.fetchPages,
    });

    assert.equal(outcome.pagesVisited, 6);
    assert.equal(outcome.pagesFetchedExtra, 2, 'six moins les quatre déjà lues');
    assert.equal(outcome.pagesReused, 4);
    assert.equal(outcome.earlyStopReason, 'PAGE_BUDGET_REACHED');
  });

  test('un site muet ne fait pas boucler la collecte', async () => {
    // Aucune adresse ne repond. Le second plafond tranche : une adresse morte
    // ne consomme pas le plafond de pages, mais elle coute une requete, et la
    // liste de chemins conventionnels en compte une cinquantaine.
    const site = fakeSite({});
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 4, fetchPages: site.fetchPages,
    });
    assert.equal(outcome.earlyStopReason, 'FETCH_BUDGET_REACHED');
    assert.equal(outcome.pagesVisited, 0);
    assert.equal(outcome.fetchFailures, 12, 'quatre pages autorisees, douze tentatives au plus');
  });

  test('une file epuisee s’arrete sur NO_MORE_PAGES', async () => {
    // Le cas distinct : il reste du budget, mais plus rien a demander.
    const site = fakeSite({ [`${SITE}/`]: page('/', ['Bienvenue sur notre site.']) });
    const outcome = await collectSourcedFacts({
      website: 'https://exemple-industrie.fr/', domain: DOMAIN, maxPages: 60,
      fetchPages: site.fetchPages,
    });
    assert.equal(outcome.earlyStopReason, 'NO_MORE_PAGES');
    assert.equal(outcome.pagesVisited, 1);
  });

  test('la montre arrête la collecte avant le plafond', async () => {
    const site = fakeSite({}, { catchAll: page('/x', ['Bienvenue sur notre site.']) });
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15,
      deadline: Date.now() - 1, fetchPages: site.fetchPages,
    });
    assert.equal(outcome.earlyStopReason, 'TIME_BUDGET_REACHED');
    assert.equal(site.calls, 0);
  });

  test('sans site officiel, rien n’est tenté', async () => {
    const site = fakeSite({}, { catchAll: page('/x', [EXPORT_FACT]) });
    const outcome = await collectSourcedFacts({
      website: null, domain: '', maxPages: 15, fetchPages: site.fetchPages,
    });
    assert.equal(outcome.earlyStopReason, 'NO_OFFICIAL_SITE');
    assert.equal(site.calls, 0);
  });
});

describe('un fait est vérifiable ou n’est pas un fait', () => {
  test('chaque fait porte l’adresse de la page où il a été lu', async () => {
    const site = fakeSite({
      [`${SITE}/`]: page('/', ['Bienvenue sur notre site.']),
      [`${SITE}/a-propos`]: page('/a-propos', [EXPORT_FACT]),
      [`${SITE}/savoir-faire`]: page('/savoir-faire', [CAPACITY_FACT]),
    });
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15, fetchPages: site.fetchPages,
    });

    assert.equal(outcome.factsFound, 2);
    assert.deepEqual(
      outcome.facts.map((f) => f.sourceUrl),
      [`${SITE}/a-propos`, `${SITE}/savoir-faire`],
    );
    // La citation figure telle quelle sur la page : rien n'est reformulé.
    for (const fact of outcome.facts) {
      assert.ok(fact.claim.length > 20);
      assert.ok(fact.marker.length > 0, 'le motif reste consultable');
    }
  });

  test('un fait lu hors du domaine officiel est refusé', async () => {
    // La garde de provenance, sur le chemin qu'elle protège. Un annuaire tiers
    // écrit exactement les mêmes phrases, et elles ne disent alors rien de
    // l'entreprise qui nous intéresse.
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15,
      seedPages: [
        { url: 'https://annuaire-usines.fr/fiche/exemple', html: page('/f', [EXPORT_FACT, CAPACITY_FACT]) },
      ],
      fetchPages: fakeSite({}).fetchPages,
    });
    assert.equal(outcome.factsFound, 0, 'aucune phrase d’un tiers ne devient un fait');
  });

  test('un sous-domaine officiel reste officiel', async () => {
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15,
      seedPages: [
        { url: `https://www.${DOMAIN}/a-propos`, html: page('/a', [EXPORT_FACT]) },
        { url: `https://blog.${DOMAIN}/actu`, html: page('/b', [CAPACITY_FACT]) },
      ],
      fetchPages: fakeSite({}).fetchPages,
    });
    assert.equal(outcome.factsFound, 2);
  });

  test('deux faits sont de natures différentes', async () => {
    // Deux phrases sur l'export ne font pas deux faits : le message n'aurait
    // qu'un angle, répété.
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15,
      seedPages: [
        { url: `${SITE}/`, html: page('/', [EXPORT_FACT]) },
        {
          url: `${SITE}/export`,
          html: page('/export', [
            'Notre service export accompagne les distributeurs de plusieurs pays ' +
            'européens depuis une quinzaine d’années maintenant.',
          ]),
        },
      ],
      fetchPages: fakeSite({}).fetchPages,
    });
    assert.equal(outcome.factsFound, 1);
    assert.equal(outcome.facts[0]!.kind, 'EXPORT');
  });

  test('la même phrase ne compte jamais deux fois', async () => {
    // Une phrase peut relever de deux natures à la fois. Elle reste une phrase,
    // et deux fois la même citation dans un message se remarque.
    const site = fakeSite({}, { catchAll: page('/x', ['Bienvenue sur notre site.']) });
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 3,
      seedPages: [{
        url: `${SITE}/`,
        html: page('/', [
          'Nos clients de l’aéronautique et du médical nous confient des séries à ' +
          'l’international depuis plus de vingt ans.',
        ]),
      }],
      fetchPages: site.fetchPages,
    });
    const quotes = new Set(outcome.facts.map((f) => f.claim));
    assert.equal(quotes.size, outcome.factsFound, 'aucune citation répétée');
  });

  test('une banalité juridique n’est pas un fait commercial', async () => {
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15,
      seedPages: [{
        url: `${SITE}/mentions-legales`,
        html: page('/mentions-legales', [
          'Politique de confidentialité : les données de nos clients sont traitées ' +
          'conformément au RGPD et ne sont jamais transmises à des tiers.',
          'Nous utilisons des cookies pour améliorer votre expérience de navigation ' +
          'sur l’ensemble de nos secteurs d’activité.',
        ]),
      }],
      fetchPages: fakeSite({}).fetchPages,
    });
    assert.equal(outcome.factsFound, 0);
  });

  test('un menu recopié n’est pas une phrase', async () => {
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15,
      seedPages: [{
        url: `${SITE}/`,
        html: page('/', ['Accueil Nos produits Nos clients En savoir plus Contact Actualités']),
      }],
      fetchPages: fakeSite({}).fetchPages,
    });
    assert.equal(outcome.factsFound, 0);
  });
});

describe('les pages qu’on va lire', () => {
  test('la page d’accueil vient en premier, puis les pages de présentation', () => {
    const urls = enrichmentPagesFor(SITE, DOMAIN);
    assert.equal(urls[0], `${SITE}/`);
    assert.ok(urls.includes(`${SITE}/qui-sommes-nous`));
    assert.ok(urls.includes(`${SITE}/savoir-faire`));
    // Les mentions légales n'ont jamais rien dit d'un besoin commercial.
    assert.ok(!urls.some((u) => u.includes('mentions-legales')));
    assert.ok(!urls.some((u) => u.includes('confidentialite')));
  });

  test('sans site ni domaine, aucune adresse n’est fabriquée', () => {
    assert.deepEqual(enrichmentPagesFor(null, null), []);
    assert.deepEqual(enrichmentPagesFor('pas une url', null), []);
  });

  test('les liens suivis restent sur le domaine officiel', () => {
    const html =
      '<a href="/notre-savoir-faire">Notre savoir-faire</a>' +
      '<a href="https://exemple-industrie.fr/references">Références</a>' +
      '<a href="https://annuaire-usines.fr/entreprise/exemple">Notre fiche entreprise</a>' +
      '<a href="/panier">Panier</a>';
    const links = enrichmentLinksIn(html, `${SITE}/`, DOMAIN);
    assert.deepEqual(links.sort(), [
      `${SITE}/notre-savoir-faire`, `${SITE}/references`,
    ].sort());
  });

  test('un lien découvert sur l’accueil est effectivement lu', async () => {
    // Beaucoup de sites ne suivent aucune convention de chemin. Sans le suivi
    // de liens, la page qui porte les faits n'est jamais demandée.
    const site = fakeSite({
      [`${SITE}/`]: `<html><body><p>${EXPORT_FACT}</p>` +
        '<a href="/fr/notre-metier-industriel">Notre métier</a></body></html>',
      [`${SITE}/fr/notre-metier-industriel`]: page('/m', [CAPACITY_FACT]),
    });
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15, fetchPages: site.fetchPages,
    });
    assert.equal(outcome.factsFound, 2);
    assert.ok(outcome.visitedUrls.includes(`${SITE}/fr/notre-metier-industriel`));
  });
});

describe('la profondeur reste réservée', () => {
  test('l’arrêt vient de l’objectif, pas d’une panne de pages', async () => {
    // Le même site que le premier test. Avec un objectif de quatre, la
    // collecte lit quatre pages : la preuve que s'arrêter à deux est une
    // décision. Sans ce contrôle, un test qui trouve deux pages lues ne
    // distinguerait pas l'arrêt anticipé d'un site à deux pages.
    const pages = {
      [`${SITE}/`]: page('/', [EXPORT_FACT]),
      [`${SITE}/a-propos`]: page('/a-propos', [HIRING_FACT]),
      [`${SITE}/savoir-faire`]: page('/savoir-faire', [CAPACITY_FACT]),
      [`${SITE}/references`]: page('/references', [MARKETS_FACT]),
    };
    const large = fakeSite(pages);
    const quatre = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15, targetFacts: 4, fetchPages: large.fetchPages,
    });
    assert.equal(quatre.factsFound, 4);
    assert.equal(quatre.pagesVisited, 4);

    const deux = fakeSite(pages);
    const arrete = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15, fetchPages: deux.fetchPages,
    });
    assert.equal(arrete.pagesVisited, 2, 'le même site, lu deux fois moins');
    assert.ok(deux.served < large.served, 'l’arrêt anticipé économise réellement des requêtes');
  });

  test('seuls les PRIORITY sont lus plus profondément', async () => {
    // Une garde structurelle. Le plafond élargi ne vaut que pour les dossiers
    // dont un brouillon peut sortir ; l'étendre à tous multiplierait les
    // requêtes sans changer une seule décision. Le vérifier sur la source
    // évite qu'un ajout distrait déplace la ligne.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../../../scripts/sales-batch.ts', import.meta.url), 'utf8',
    ).replace(/^\s*(\/\/.*|\*.*|\/\*.*)$/gm, '');

    const enrichissement = source.slice(source.indexOf('const toEnrich'));
    assert.match(
      enrichissement.slice(0, 400),
      /tier === 'PRIORITY'/,
      'la sélection à enrichir doit filtrer sur PRIORITY',
    );
    assert.match(
      enrichissement.slice(0, 2000),
      /maxPages: config\.sales\.maxPagesPerPriorityDomain/,
      'l’enrichissement lit le plafond réservé aux PRIORITY',
    );
    // Et l'étape des contacts, elle, garde le plafond commun.
    const contacts = source.slice(source.indexOf('const contacts = resolveContacts') - 3000);
    assert.match(
      source.slice(0, source.indexOf('const toEnrich')),
      /maxPages: Math\.max\(0, config\.sales\.maxPagesPerDomain - pages\.length\)/,
      'les contacts gardent le plafond commun, lu dans la configuration',
    );
    assert.ok(contacts.length > 0);
  });
});

describe('une redirection ne consomme pas le budget', () => {
  /** Un site où plusieurs chemins mènent au même document. */
  function redirectingSite(finalUrl: string, html: string) {
    let requests = 0;
    const fetchPages = async (urls: readonly string[]) => {
      requests += 1;
      // Toute adresse répond, mais toujours avec la même page finale : c'est
      // exactement ce que fait `fetchRawPages`, qui suit les redirections et
      // rend `response.url`.
      return { pages: [{ url: finalUrl, html }], failures: [] };
    };
    return { fetchPages, get requests() { return requests; } };
  }

  test('la même page n’est pas lue quinze fois', async () => {
    // Le défaut, relevé sur europe-industrie.fr le 26/08/2026 : quatorze
    // requêtes, une seule page, et un compteur annonçant « 15 pages
    // consultées ». La file était indexée sur l'adresse demandée, la marque
    // sur l'adresse finale — donc rien n'était jamais marqué.
    const site = redirectingSite(
      `${SITE}/qui-sommes-nous/`,
      page('/qui-sommes-nous/', ['Bienvenue sur notre site.']),
    );
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15, fetchPages: site.fetchPages,
    });

    assert.equal(outcome.pagesVisited, 1, 'une page lue, et une seule comptée');
    assert.equal(outcome.pagesFetchedExtra, 1);
    assert.ok(site.requests <= 45, `${site.requests} requêtes : le second plafond doit mordre`);
    assert.equal(outcome.earlyStopReason, 'FETCH_BUDGET_REACHED');
  });

  test('une redirection vers une page utile la compte une fois', async () => {
    const site = redirectingSite(`${SITE}/qui-sommes-nous/`, page('/q', [EXPORT_FACT]));
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15, targetFacts: 1, fetchPages: site.fetchPages,
    });
    assert.equal(outcome.factsFound, 1);
    assert.equal(outcome.pagesVisited, 1);
    assert.equal(outcome.earlyStopReason, 'ENOUGH_FACTS');
  });

  test('une adresse morte ne consomme pas le plafond de pages', async () => {
    // Un 404 n'a rien fait lire. Le compter comme une page consultée ferait
    // dire au rapport qu'on a lu un site qu'on n'a pas ouvert.
    const pages: Record<string, string> = {
      [`${SITE}/`]: page('/', ['Bienvenue sur notre site.']),
      [`${SITE}/references`]: page('/references', [EXPORT_FACT]),
      [`${SITE}/certifications`]: page('/certifications', [CAPACITY_FACT]),
    };
    const site = fakeSite(pages);
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15, fetchPages: site.fetchPages,
    });
    assert.equal(outcome.factsFound, 2);
    assert.equal(outcome.pagesVisited, 3, 'trois pages réelles, les 404 non comptés');
    assert.ok(outcome.fetchFailures > 0, 'les échecs restent visibles');
  });
});

describe('une page consultée et une page demandée ne sont pas la même mesure', () => {
  test('les trois compteurs se distinguent et s’additionnent', async () => {
    // Le défaut de lecture, relevé sur un vrai rapport : « PAGES_VISITED = 0 »
    // décrivait un prospect dont quatre pages avaient bien été lues — par
    // l'étape précédente. Un seul chiffre ne pouvait pas répondre à la fois à
    // « combien ce site a-t-il coûté » et « combien cette étape a-t-elle
    // demandé ». Il y en a trois maintenant.
    const site = fakeSite({
      [`${SITE}/a-propos`]: page('/a-propos', [HIRING_FACT]),
      [`${SITE}/qui-sommes-nous`]: page('/qui', [CAPACITY_FACT]),
    });
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15, targetFacts: 3,
      seedPages: [
        { url: `${SITE}/`, html: page('/', [EXPORT_FACT]) },
        { url: `${SITE}/contact`, html: page('/contact', ['Bienvenue sur notre site.']) },
      ],
      fetchPages: site.fetchPages,
    });

    // Les deux pages reprises donnent un fait ; les deux suivantes sont
    // demandees pour atteindre l'objectif de trois.
    assert.equal(outcome.pagesReused, 2, 'deux pages reprises sans requête');
    assert.equal(outcome.pagesFetchedExtra, 2, 'deux pages réellement demandées');
    assert.equal(
      outcome.pagesVisited, outcome.pagesReused + outcome.pagesFetchedExtra,
      'le total est la somme, toujours',
    );
    assert.equal(outcome.factsFound, 3);
  });

  test('sans reprise, le total est ce que l’étape a demandé', async () => {
    const site = fakeSite({
      [`${SITE}/`]: page('/', [EXPORT_FACT]),
      [`${SITE}/a-propos`]: page('/a-propos', [HIRING_FACT]),
    });
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15, fetchPages: site.fetchPages,
    });
    assert.equal(outcome.pagesReused, 0);
    assert.equal(outcome.pagesFetchedExtra, outcome.pagesVisited);
  });

  test('une reprise suffisante ne demande rien, et le dit', async () => {
    const site = fakeSite({}, { catchAll: page('/x', [MARKETS_FACT]) });
    const outcome = await collectSourcedFacts({
      website: SITE, domain: DOMAIN, maxPages: 15,
      seedPages: [
        { url: `${SITE}/`, html: page('/', [EXPORT_FACT]) },
        { url: `${SITE}/a-propos`, html: page('/a', [HIRING_FACT]) },
      ],
      fetchPages: site.fetchPages,
    });
    assert.equal(outcome.pagesVisited, 2, 'deux pages ont bien été consultées');
    assert.equal(outcome.pagesReused, 2);
    assert.equal(outcome.pagesFetchedExtra, 0, 'et aucune n’a coûté de requête');
    assert.equal(site.calls, 0);
  });
});
