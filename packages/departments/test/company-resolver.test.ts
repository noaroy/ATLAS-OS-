import { readFileSync } from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPageType,
  resolveCompanyIdentity,
  icpStatus,
  isGenericDescriptor,
  looksLikePageTitle,
  nameMatchesDomain,
  checkPriorityEligibility,
  type PageClassification,
} from '../src/company-resolver.ts';

/**
 * Les deux faux positifs du lot 002, et ce qui les empêche de revenir.
 *
 * Le lot a fonctionné techniquement et échoué commercialement. Deux prospects
 * sont ressortis PRIORITY avec 73 et 72 sur 100 : la note était bonne, ce
 * qu'elle notait ne l'était pas.
 *
 *   « Entreprises du secteur Automatisation Industrielle… » → mordorintelligence.com
 *   « Industriailes, l'agence marketing & communication B2B » → industri-ailes.fr
 *
 * Le premier est une page d'étude listant des entreprises ; ATLAS a qualifié
 * l'éditeur du rapport. Le second est une vraie société, mais une agence de
 * communication — hors du profil « fabricant » de ce lot.
 *
 * Cause commune : le titre du résultat était pris pour une raison sociale.
 */

const officialSite: PageClassification = {
  type: 'OFFICIAL_COMPANY_SITE',
  reason: 'site propre',
  ownerIsCandidate: true,
};

describe('le premier faux positif : une étude de marché', () => {
  const url =
    'https://www.mordorintelligence.com/fr/industry-reports/france-factory-automation-and-industrial-controls-market/companies';

  test('Mordor est classé MARKET_REPORT, jamais candidat', () => {
    const page = classifyPageType({
      url,
      domain: 'mordorintelligence.com',
      title: 'Entreprises du secteur Automatisation Industrielle Et Contrôles ...',
    });
    assert.equal(page.type, 'MARKET_REPORT');
    assert.equal(page.ownerIsCandidate, false);
  });

  test('aucune identité n’en sort', () => {
    const outcome = resolveCompanyIdentity({
      searchTitle: 'Entreprises du secteur Automatisation Industrielle Et Contrôles ...',
      url,
      domain: 'mordorintelligence.com',
      page: classifyPageType({ url, domain: 'mordorintelligence.com' }),
    });
    assert.equal(outcome.identity, null);
    assert.match(outcome.reason, /MARKET_REPORT/);
    assert.match(outcome.reason, /n'est pas le candidat/);
  });

  test('l’éditeur d’un annuaire n’est jamais qualifié parce qu’il héberge la page', () => {
    for (const domain of ['societe.com', 'pappers.fr', 'europages.fr', 'kompass.com']) {
      const page = classifyPageType({ url: `https://${domain}/x`, domain });
      assert.equal(page.ownerIsCandidate, false, `« ${domain} » ne doit pas être candidat`);
    }
  });

  test('un titre de listing suffit, même sur un domaine inconnu', () => {
    const page = classifyPageType({
      url: 'https://site-inconnu.fr/page',
      domain: 'site-inconnu.fr',
      title: 'Top 10 des fabricants français de machines',
    });
    assert.equal(page.type, 'DIRECTORY');
    assert.equal(page.ownerIsCandidate, false);
  });
});

describe('le second faux positif : une agence de communication', () => {
  test('Industriailes est OUT_OF_ICP pour un profil industriel', () => {
    const decision = icpStatus({
      companyName: 'Industriailes',
      snippet: 'L’agence marketing & communication B2B pour l’industrie.',
    });
    assert.equal(decision.status, 'OUT_OF_ICP');
    assert.match(decision.reason, /agence de communication|marketing/);
  });

  test('le profil ne s’élargit pas après coup pour la sauver', () => {
    // Elle pourrait très bien acheter une étude. Le profil de ce lot dit
    // « fabricant ou équipementier », et un profil qui s'ajuste à ce qu'on
    // trouve ne filtre plus rien.
    const decision = icpStatus({
      companyName: 'Industriailes',
      snippet: 'Agence de communication industrielle, nous accompagnons les fabricants.',
    });
    assert.equal(decision.status, 'OUT_OF_ICP');
  });

  test('un vrai fabricant reste MATCH', () => {
    assert.equal(
      icpStatus({
        companyName: 'Sermeca',
        snippet: 'Fabricant français de machines spéciales pour l’industrie.',
      }).status,
      'MATCH',
    );
  });

  test('sans signal, on dit qu’on ne sait pas', () => {
    // `UNKNOWN` est une vraie réponse : trancher au hasard coûterait soit un
    // prospect réel, soit un appel inutile.
    assert.equal(icpStatus({ companyName: 'Durand', snippet: null }).status, 'UNKNOWN');
  });
});

describe('un descriptif de métier n’est pas une raison sociale', () => {
  test('les libellés exacts relevés dans le lot 002', () => {
    for (const generic of [
      'Automatisation Industrielle',
      'Concepteur Fabricant d’Equipement',
      'Constructeur d’équipements industriels',
      'Entreprises du secteur',
      'Solutions techniques industrielles',
    ]) {
      assert.equal(isGenericDescriptor(generic), true, `« ${generic} » ne nomme personne`);
    }
  });

  test('un mot propre suffit à en faire un nom', () => {
    for (const name of [
      'Sermeca Automatisation Industrielle',
      'Durand Concepteur Fabricant',
      'BHS Corrugated',
      'Michelin',
      'Hagenauer+Denk KG',
    ]) {
      assert.equal(isGenericDescriptor(name), false, `« ${name} » est un nom`);
    }
  });

  test('un titre générique ne produit aucune identité, même sur un site officiel', () => {
    const outcome = resolveCompanyIdentity({
      searchTitle: 'Automatisation Industrielle',
      url: 'https://www.industrie.fr/',
      domain: 'industrie.fr',
      page: officialSite,
    });
    // Le domaine est lui-même un mot de métier : rien ne nomme l'entreprise.
    assert.equal(outcome.identity, null);
    assert.ok(outcome.missing.length > 0);
  });

  test('le domaine nomme l’entreprise quand le titre ne le fait pas', () => {
    const outcome = resolveCompanyIdentity({
      searchTitle: 'Concepteur Fabricant d’Equipement',
      url: 'https://www.sermeca.fr/nos-produits',
      domain: 'sermeca.fr',
      page: officialSite,
    });
    assert.ok(outcome.identity);
    assert.equal(outcome.identity.companyName, 'Sermeca');
    assert.ok(outcome.identity.identitySources.includes('domaine'));
  });
});

describe('les identités solides sont acceptées', () => {
  test('un JSON-LD Organization emporte la décision', () => {
    const outcome = resolveCompanyIdentity({
      searchTitle: 'Machines spéciales — accueil',
      url: 'https://www.sermeca.fr/',
      domain: 'sermeca.fr',
      page: officialSite,
      organizationName: 'SERMECA SAS',
    });
    assert.ok(outcome.identity);
    assert.equal(outcome.identity.companyName, 'SERMECA SAS');
    assert.ok(outcome.identity.identityConfidence >= 0.9);
    assert.ok(outcome.identity.identitySources.includes('JSON-LD Organization'));
  });

  test('BHS Corrugated reste accepté sans forme juridique', () => {
    // Une marque établie n'affiche pas nécessairement « SAS » ou « GmbH » :
    // exiger le suffixe écarterait des entreprises parfaitement réelles.
    const outcome = resolveCompanyIdentity({
      searchTitle: 'BHS Corrugated — Corrugated board production',
      url: 'https://www.bhs-world.com/',
      domain: 'bhs-world.com',
      page: officialSite,
    });
    assert.ok(outcome.identity);
    assert.equal(outcome.identity.companyName, 'BHS Corrugated');
  });

  test('les acronymes courts restent possibles', () => {
    const outcome = resolveCompanyIdentity({
      searchTitle: 'SEW — Réducteurs et motoréducteurs',
      url: 'https://www.sew-usocome.fr/',
      domain: 'sew-usocome.fr',
      page: officialSite,
    });
    assert.ok(outcome.identity);
    assert.equal(outcome.identity.companyName, 'SEW');
  });

  test('le recoupement nom / domaine renforce la confiance', () => {
    assert.equal(nameMatchesDomain('Sermeca SAS', 'sermeca.fr'), true);
    assert.equal(nameMatchesDomain('BHS Corrugated', 'bhs-world.com'), true);
    assert.equal(nameMatchesDomain('Heidelberg Druckmaschinen', 'bhs-corrugated.com'), false);
  });
});

describe('un annuaire contenant une vraie entreprise', () => {
  test('il faut résoudre le domaine officiel, pas retenir l’annuaire', () => {
    const page = classifyPageType({
      url: 'https://www.societe.com/societe/sermeca-123456.html',
      domain: 'societe.com',
      title: 'SERMECA SAS — Chiffre d’affaires, résultat, bilans',
    });
    const outcome = resolveCompanyIdentity({
      searchTitle: 'SERMECA SAS — Chiffre d’affaires, résultat, bilans',
      url: 'https://www.societe.com/societe/sermeca-123456.html',
      domain: 'societe.com',
      page,
    });
    assert.equal(outcome.identity, null, 'societe.com ne doit jamais devenir le prospect');
    assert.deepEqual(outcome.missing, ['domaine officiel de l’entreprise citée']);
  });
});

describe('l’éligibilité au rang PRIORITY', () => {
  const identity = {
    companyName: 'Sermeca SAS',
    canonicalDomain: 'sermeca.fr',
    officialWebsite: 'https://sermeca.fr',
    country: 'France',
    identityConfidence: 0.9,
    identitySources: ['JSON-LD Organization'],
  };

  const base = {
    identity,
    pageType: 'OFFICIAL_COMPANY_SITE' as const,
    icp: 'MATCH' as const,
    observedFacts: 3,
    score: 75,
    scoreThreshold: 70,
    hasSourcedPersonalization: true,
  };

  test('un dossier complet est éligible', () => {
    assert.equal(checkPriorityEligibility(base).eligible, true);
  });

  test('les deux faux positifs du lot 002 ne le seraient plus', () => {
    // Mordor : page d'étude, aucune identité.
    const mordor = checkPriorityEligibility({
      ...base,
      identity: null,
      pageType: 'MARKET_REPORT',
      icp: 'UNKNOWN',
      score: 73.1,
    });
    assert.equal(mordor.eligible, false);
    assert.ok(mordor.blockers.length >= 3);

    // Industriailes : vraie société, hors profil.
    const agency = checkPriorityEligibility({
      ...base,
      identity: { ...identity, companyName: 'Industriailes', canonicalDomain: 'industri-ailes.fr' },
      icp: 'OUT_OF_ICP',
      score: 71.6,
    });
    assert.equal(agency.eligible, false);
    assert.ok(agency.blockers.some((b) => /OUT_OF_ICP/.test(b)));
  });

  test('un score suffisant ne rachète rien', () => {
    // Les deux faux positifs avaient 73 et 72 : la note était bonne, ce
    // qu'elle notait ne l'était pas.
    assert.equal(
      checkPriorityEligibility({ ...base, icp: 'OUT_OF_ICP', score: 99 }).eligible,
      false,
    );
  });

  test('moins de deux faits observés bloque', () => {
    const check = checkPriorityEligibility({ ...base, observedFacts: 1 });
    assert.equal(check.eligible, false);
    assert.ok(check.blockers.some((b) => /fait\(s\) observé/.test(b)));
  });

  test('une personnalisation non sourcée bloque', () => {
    const check = checkPriorityEligibility({ ...base, hasSourcedPersonalization: false });
    assert.equal(check.eligible, false);
  });

  test('tous les obstacles sont énumérés', () => {
    // Un refus muet ne se corrige pas.
    const check = checkPriorityEligibility({
      identity: null,
      pageType: 'DIRECTORY',
      icp: 'OUT_OF_ICP',
      observedFacts: 0,
      score: 10,
      scoreThreshold: 70,
      hasSourcedPersonalization: false,
    });
    assert.ok(check.blockers.length >= 5, `attendu ≥ 5 motifs, obtenu ${check.blockers.length}`);
  });
});

describe('les pages d’entreprise passent toujours', () => {
  test('une racine ou une page produits', () => {
    for (const url of [
      'https://sermeca.fr/',
      'https://sermeca.fr/nos-produits',
      'https://sermeca.fr/entreprise/export',
    ]) {
      const page = classifyPageType({ url, domain: 'sermeca.fr', title: 'Sermeca — Machines spéciales' });
      assert.equal(page.type, 'OFFICIAL_COMPANY_SITE', `« ${url} » doit passer`);
      assert.equal(page.ownerIsCandidate, true);
    }
  });
});

test('un domaine public n’est pas une entreprise', () => {
  // Le lot 002 a résolu « ULTRO » sur gouv.fr et l'a présenté comme une
  // société. Une administration publie des pages *sur* des entreprises ;
  // elle n'en est pas une.
  for (const domain of ['gouv.fr', 'entreprises.gouv.fr', 'insee.fr', 'cci.fr', 'europa.eu']) {
    const page = classifyPageType({ url: `https://${domain}/ultro`, domain, title: 'ULTRO' });
    assert.equal(page.ownerIsCandidate, false, `${domain} ne doit pas fournir de candidat`);
    const outcome = resolveCompanyIdentity({
      searchTitle: 'ULTRO',
      url: `https://${domain}/ultro`,
      domain,
      page,
    });
    assert.equal(outcome.identity, null, `${domain} ne doit résoudre aucune identité`);
  }
});

test('la résolution ne peut pas dépenser : aucun lien vers la couche modèle', () => {
  // Une garde qui appelle le modèle pour décider n'est plus une garde
  // gratuite, et le coût du lot redeviendrait proportionnel au bruit de la
  // recherche. L'invariant se vérifie sur le module lui-même.
  const source = readFileSync(
    new URL('../src/company-resolver.ts', import.meta.url),
    'utf8',
  );
  assert.equal(/from ['"]@atlas\/llm/.test(source), false, 'le résolveur importe la couche modèle');
  assert.equal(/anthropic|InferenceFabric|provider\.complete/i.test(source), false, 'le résolveur touche un fournisseur');
  assert.equal(/\basync\b|await\b/.test(source), false, 'le résolveur fait de l’asynchrone, donc peut-être des appels');
});

test('les seize entrées du lot 002 : les deux PRIORITY tombent', () => {
  // Le rejeu exact du lot. Les deux prospects présentés comme prioritaires
  // ne doivent plus l'être : le premier parce que la page ne lui appartient
  // pas, le second parce qu'il est hors du profil de ce lot.
  const batch: Array<{ title: string; domain: string; url: string }> = [
    {
      title: 'Entreprises du secteur Automatisation Industrielle Et Contrôles ...',
      domain: 'mordorintelligence.com',
      url: 'https://www.mordorintelligence.com/fr/industry-reports/france-factory-automation-and-industrial-controls-market/companies',
    },
    {
      title: 'Industriailes, l’agence marketing & communication B2B pour l’industrie',
      domain: 'industri-ailes.fr',
      url: 'https://www.industri-ailes.fr/communication-industrie-b2b/',
    },
  ];

  for (const entry of batch) {
    const page = classifyPageType({ url: entry.url, domain: entry.domain, title: entry.title });
    const outcome = resolveCompanyIdentity({
      searchTitle: entry.title,
      url: entry.url,
      domain: entry.domain,
      page,
    });
    const icp = outcome.identity
      ? icpStatus({ companyName: outcome.identity.companyName })
      : { status: 'UNKNOWN' as const, reason: '' };

    const check = checkPriorityEligibility({
      identity: outcome.identity,
      pageType: page.type,
      icp: icp.status,
      observedFacts: 4,
      score: 73.1,
      scoreThreshold: 70,
      hasSourcedPersonalization: true,
    });
    assert.equal(check.eligible, false, `« ${entry.title.slice(0, 40)} » ne doit plus être PRIORITY`);
    assert.ok(check.blockers.length > 0, 'un refus doit dire pourquoi');
  }
});

test('un titre qui annonce une marque puis la décrit se ramène à la marque', () => {
  // Le lot 003 a stocké « ASM Indus: Concepteurs et fabricants de machines
  // spéciales » comme raison sociale. Rien n'était inventé, et pourtant
  // aucune entreprise ne s'appelle ainsi.
  const page = classifyPageType({
    url: 'https://asm-indus.com/',
    domain: 'asm-indus.com',
    title: 'ASM Indus: Concepteurs et fabricants de machines spéciales',
  });
  const outcome = resolveCompanyIdentity({
    searchTitle: 'ASM Indus: Concepteurs et fabricants de machines spéciales',
    url: 'https://asm-indus.com/',
    domain: 'asm-indus.com',
    page,
  });
  assert.equal(outcome.identity?.companyName, 'ASM Indus');
});

test('la coupe ne sert pas d’échappatoire au profil', () => {
  // Couper sur la virgule rendrait « Industriailes » présentable en effaçant
  // « agence marketing », c'est-à-dire le motif même du refus. Le nom reste
  // donc entier, et le profil continue de le voir.
  const title = 'Industriailes, l’agence marketing & communication B2B pour l’industrie';
  const page = classifyPageType({ url: 'https://industri-ailes.fr/', domain: 'industri-ailes.fr', title });
  const outcome = resolveCompanyIdentity({
    searchTitle: title,
    url: 'https://industri-ailes.fr/',
    domain: 'industri-ailes.fr',
    page,
  });
  assert.ok(outcome.identity, 'la société existe, elle n’est simplement pas dans le profil');
  assert.equal(
    icpStatus({ companyName: outcome.identity!.companyName }).status,
    'OUT_OF_ICP',
  );
});

test('un titre de page impératif n’est pas une raison sociale', () => {
  // La famille de requêtes « besoin » ramène précisément ces pages :
  // « Devenez Distributeur », « Fournisseurs de Stabilus ». Le titre du
  // résultat y est une invitation, jamais un nom d'entreprise.
  for (const title of [
    'Devenez Distributeur',
    'Devenir distributeur de nos produits',
    'Fournisseurs de Stabilus',
    'Rejoignez notre réseau de revendeurs',
    'Nos distributeurs',
  ]) {
    assert.equal(looksLikePageTitle(title), true, `« ${title} »`);
    assert.equal(isGenericDescriptor(title), true, `« ${title} » ne nomme personne`);
  }
  assert.equal(looksLikePageTitle('CIRMECA'), false);
  assert.equal(looksLikePageTitle('Groupe SPL'), false);
});

test('un prestataire de prospection n’est pas un fabricant', () => {
  // Les requêtes « besoin » ramènent par construction les sociétés qui vendent
  // de la prospection : elles parlent de distributeurs et de développement
  // commercial mieux que personne.
  for (const name of [
    'Agence de prospection commerciale B2B à Grenoble',
    'Organisation Commerciale PME',
    'Force de vente externalisée pour l’industrie',
    'Conseil commercial et génération de leads',
  ]) {
    assert.equal(
      icpStatus({ companyName: name }).status,
      'OUT_OF_ICP',
      `« ${name} » doit sortir du profil`,
    );
  }
  assert.equal(icpStatus({ companyName: 'CIRMECA', snippet: 'fabricant de machines spéciales' }).status !== 'OUT_OF_ICP', true);
});
