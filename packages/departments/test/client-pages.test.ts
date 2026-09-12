import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  siteLinks, planPages, relevancePrecheck, stemOf, extractSiteFacts, selectBlocksForModel, generalistRisk,
  rankContactChannels, buildBlockCatalogue, swedishPostalAddresses, extractCountryEvidence,
  type ResolvedContact,
} from '../src/index.ts';

/**
 * Lire un site comme un commercial pressé : ces tests fixent ce que le
 * premier lot suédois réel a coûté pour rien — 196 requêtes en 404 sur des
 * chemins devinés, 13 pays « à vérifier » sur des sites qui publiaient leur
 * adresse, 40 passages de cookies par page envoyés au modèle.
 */
const brief = {
  productKeywords: ['förpackningsmaskiner', 'kontrollutrustning'],
  industries: ['kosmetik', 'läkemedel'],
  targetRoles: ['distributor'],
  competitorExclusions: ['Ishida'],
  requiredCriteria: [{ key: 'vente', label: 'Vend des machines', hint: 'gamme de machines, marques représentées', weight: 3 }],
  preferredCriteria: [{ key: 'service', label: 'Assure le service', hint: 'kalibrering, underhåll', weight: 1 }],
  exclusionCriteria: [],
};

const ACCUEIL = `<html><head><title>Nordpack AB | Förpackningsmaskiner</title></head><body>
  <nav><a href="/">Hem</a><a href="/produkter/">Produkter</a><a href="/produkter/flowpack">Flowpack</a>
  <a href="/om-oss/">Om oss</a><a href="/kontakta-oss/">Kontakta oss</a><a href="/varumarken/">Varumärken</a>
  <a href="/service/">Service &amp; underhåll</a><a href="/nyheter/">Nyheter</a><a href="/en/">English</a>
  <a href="https://www.linkedin.com/company/nordpack">LinkedIn</a><a href="/katalog.pdf">Katalog</a><a href="/karriar/">Karriär</a></nav>
  <p>Nordpack AB är distributör av förpackningsmaskiner för kosmetik och läkemedel i Sverige.</p>
  <p>Denna webbplats använder cookies för att förbättra din upplevelse.</p>
  <p>Org.nr 556123-4567 · Box 12, 142 50 Skogås · <a href="mailto:info@nordpack.se">info@nordpack.se</a> · +46 8 123 45 67</p>
</body></html>`;

describe('siteLinks : les liens internes, classés par ce qu’ils promettent', () => {
  test('identité, produits, marques, service — et rien de ce qui ne dit rien de la société', () => {
    const liens = siteLinks(ACCUEIL, 'https://nordpack.se/', 'nordpack.se');
    const par = (k: string) => liens.filter((l) => l.kind === k).map((l) => new URL(l.url).pathname);
    assert.deepEqual(par('IDENTITY'), ['/om-oss/', '/kontakta-oss/']);
    assert.ok(par('PRODUCTS').includes('/produkter/'));
    assert.ok(par('BRANDS').includes('/varumarken/'));
    assert.ok(par('SERVICE').includes('/service/'));
    const chemins = liens.map((l) => l.url);
    assert.ok(!chemins.some((u) => /linkedin|\.pdf|\/en\/|nyheter|karriar/.test(u)), 'réseaux, PDF, autres langues, actualités et carrières sont écartés');
    assert.ok(!chemins.some((u) => u === 'https://nordpack.se/'), 'l’accueil lui-même n’est pas un lien à suivre');
  });

  test('un lien vers un autre domaine n’est jamais suivi', () => {
    const liens = siteLinks('<a href="https://autre.se/kontakt">Kontakt</a><a href="/kontakt">Kontakt</a>', 'https://nordpack.se/', 'nordpack.se');
    assert.equal(liens.length, 1);
    assert.equal(liens[0]!.url, 'https://nordpack.se/kontakt');
  });
});

describe('planPages : lire ce qui manque, dans l’ordre, jamais plus que le plafond', () => {
  const links = siteLinks(ACCUEIL, 'https://nordpack.se/', 'nordpack.se');

  test('pays inconnu : la page de contact d’abord, puis les produits', () => {
    const plan = planPages({ links, countryKnown: false, relevanceHits: 3, maxPages: 5, fallbackIdentityPaths: ['/kontakt'], origin: 'https://nordpack.se' });
    assert.equal(plan[0]!.kind, 'IDENTITY');
    assert.match(plan[0]!.url, /kontakta-oss/);
    assert.equal(plan[1]!.kind, 'PRODUCTS');
    assert.ok(plan.length <= 4);
  });

  test('pays déjà prouvé : les produits passent devant, l’identité reste pour les coordonnées', () => {
    const plan = planPages({ links, countryKnown: true, relevanceHits: 3, maxPages: 5, fallbackIdentityPaths: [], origin: 'https://nordpack.se' });
    assert.equal(plan[0]!.kind, 'PRODUCTS');
    assert.ok(plan.some((p) => p.kind === 'IDENTITY'));
  });

  test('un accueil pauvre en termes du brief vaut une seconde page produits', () => {
    const plan = planPages({ links, countryKnown: true, relevanceHits: 0, maxPages: 5, fallbackIdentityPaths: [], origin: 'https://nordpack.se' });
    assert.equal(plan.filter((p) => p.kind === 'PRODUCTS').length, 2);
  });

  test('sans aucun lien d’identité, les chemins conventionnels du marché servent de repli — pas vingt-cinq', () => {
    const plan = planPages({ links: [], countryKnown: false, relevanceHits: 1, maxPages: 3, fallbackIdentityPaths: ['/kontakt', '/om-oss', '/impressum'], origin: 'https://x.se' });
    assert.deepEqual(plan.map((p) => p.url), ['https://x.se/kontakt', 'https://x.se/om-oss']);
  });

  test('plafond à une page : rien après l’accueil', () => {
    assert.deepEqual(planPages({ links, countryKnown: false, relevanceHits: 0, maxPages: 1, fallbackIdentityPaths: ['/kontakt'], origin: 'https://nordpack.se' }), []);
  });
});

describe('relevancePrecheck : compter les termes du brief avant de payer', () => {
  test('les racines des mots-clés se lisent au pluriel et en composition', () => {
    assert.equal(stemOf('förpackningsmaskiner'), 'forpackningsmaskin');
    assert.equal(stemOf('kontrollutrustning'), 'kontrollutrustn');
    const r = relevancePrecheck([{ url: 'https://nordpack.se/', html: ACCUEIL }], brief);
    assert.ok(r.productHits.includes('förpackningsmaskiner'));
    assert.ok(r.industryHits.includes('kosmetik'));
    assert.ok(r.roleHits.length > 0, 'distributör est un mot de rôle');
    assert.match(r.quotes[0]!.quote, /förpackningsmaskiner/i);
  });

  test('une page sans aucun terme rend zéro — et c’est ce zéro qui écarte sans modèle', () => {
    const r = relevancePrecheck([{ url: 'https://x.se/', html: '<p>Välkommen till vår frisörsalong i Lund.</p>' }], brief);
    assert.equal(r.hits.length, 0);
  });
});

describe('extractSiteFacts : ce que les pages établissent sans être comprises', () => {
  test('org.nr, adresse suédoise, courriels', () => {
    const pages = [{ url: 'https://nordpack.se/', html: ACCUEIL }];
    const contacts: Array<Pick<ResolvedContact, 'type' | 'value'>> = [{ type: 'EMAIL', value: 'info@nordpack.se' }, { type: 'PHONE', value: '+46 8 123 45 67' }];
    const f = extractSiteFacts(pages, contacts, relevancePrecheck(pages, brief));
    assert.equal(f.orgNr, '556123-4567');
    assert.match(f.postalAddress ?? '', /142 50 Skogås/);
    assert.deepEqual(f.emails, ['info@nordpack.se']);
    assert.ok(f.briefTermsSeen.includes('förpackningsmaskiner'));
  });
});

describe('selectBlocksForModel : les passages qui peuvent fonder un critère, numérotés comme le catalogue entier', () => {
  test('les cookies partent, le passage de présentation reste, les numéros ne changent pas', () => {
    const cat = buildBlockCatalogue([{ url: 'https://nordpack.se/', html: ACCUEIL }]);
    const s = selectBlocksForModel(cat, brief, { maxBlocks: 60 });
    assert.ok(s.kept < cat.size || !/cookies/.test(s.text), 'le passage cookies n’est pas montré');
    assert.match(s.text, /förpackningsmaskiner/);
    assert.doesNotMatch(s.text, /cookies/);
    // Chaque numéro montré existe dans le catalogue, avec le même texte.
    for (const m of s.text.matchAll(/^\[(\d+)\] (.+)$/gm)) {
      const ref = cat.index.get(Number(m[1]))!;
      const bloc = cat.blocksByUrl.get(ref.url)!.find((b) => b.id === ref.blockId)!;
      assert.equal(bloc.text, m[2]);
    }
  });

  test('le plafond est respecté et les passages les plus pertinents passent en premier', () => {
    const html = `<html><body>${Array.from({ length: 80 }, (_, i) => `<p>Passage numéro ${i} sans intérêt particulier pour personne du tout.</p>`).join('')}<p>Vi är distributör av förpackningsmaskiner sedan 1990.</p></body></html>`;
    const cat = buildBlockCatalogue([{ url: 'https://x.se/', html }], { maxBlocksPerPage: 120 });
    const s = selectBlocksForModel(cat, brief, { maxBlocks: 10 });
    assert.ok(s.kept <= 10);
    assert.match(s.text, /distributör av förpackningsmaskiner/);
  });
});

describe('generalistRisk : plusieurs signaux, aucun décisif seul', () => {
  const links = siteLinks(ACCUEIL, 'https://nordpack.se/', 'nordpack.se');
  test('un spécialiste nommant le domaine visé : risque bas', () => {
    const pages = [{ url: 'https://nordpack.se/', html: ACCUEIL }];
    const r = generalistRisk({ pages, links, precheck: relevancePrecheck(pages, brief), modelVerdict: 'SPECIALIST' });
    assert.ok(r.score <= 20, `score ${r.score}`);
    assert.ok(r.signals.some((s) => /spécialiste/.test(s.signal)));
  });
  test('vocabulaire de catalogue, navigation large et lecture généraliste : risque haut — et chaque signal est nommé', () => {
    const nav = Array.from({ length: 30 }, (_, i) => `<a href="/produkter/kat-${i}">Produkter ${i}</a>`).join('');
    const html = `<html><body>${nav}<p>Allt inom industri: över 20 000 produkter, brett sortiment, grossist.</p></body></html>`;
    const pages = [{ url: 'https://all.se/', html }];
    const r = generalistRisk({ pages, links: siteLinks(html, 'https://all.se/', 'all.se'), precheck: relevancePrecheck(pages, brief), modelVerdict: 'GENERALIST', modelNote: 'catalogue large' });
    assert.ok(r.score >= 80, `score ${r.score}`);
    assert.ok(r.signals.some((s) => s.signal === 'vocabulaire de catalogue' && /allt inom/.test(s.detail)));
    assert.ok(r.signals.some((s) => /navigation/.test(s.signal)));
  });
  test('le score reste entre 0 et 100', () => {
    const pages = [{ url: 'https://x.se/', html: '<p>rien</p>' }];
    const r = generalistRisk({ pages, links: [], precheck: relevancePrecheck(pages, brief), modelVerdict: 'TO_CONFIRM' });
    assert.ok(r.score >= 0 && r.score <= 100);
  });
});

describe('rankContactChannels : export, commercial, accueil, formulaire, téléphone — jamais RH ni facturation', () => {
  const contact = (value: string, intent: ResolvedContact['intent'], suitability: ResolvedContact['suitability'], type: ResolvedContact['type'] = 'EMAIL'): ResolvedContact =>
    ({ type, value, sourceUrl: 'https://x.se/kontakt', observed: true, confidence: 'HIGH', label: null, intent, suitability });

  test('la boîte export passe devant la boîte commerciale, qui passe devant l’accueil', () => {
    const r = rankContactChannels({
      emails: [contact('info@x.se', 'GENERAL', 'MEDIUM'), contact('sales@x.se', 'SALES', 'HIGH'), contact('export@x.se', 'EXPORT', 'HIGH')],
      phones: [], form: null, officialDomain: 'x.se', personName: null, personRole: null,
    });
    assert.equal(r.value, 'export@x.se');
    assert.equal(r.confidence, 'HIGH');
  });

  test('RH, facturation, support et une personne sans fonction sont écartés — et dits', () => {
    const r = rankContactChannels({
      emails: [contact('jobb@x.se', 'HR', 'BLOCKED'), contact('faktura@x.se', 'BILLING', 'BLOCKED'), contact('support@x.se', 'TECHNICAL_SUPPORT', 'BLOCKED'), contact('anna.b@x.se', 'PERSONAL', 'LOW'), contact('info@x.se', 'GENERAL', 'MEDIUM')],
      phones: [], form: null, officialDomain: 'x.se', personName: null, personRole: null,
    });
    assert.equal(r.value, 'info@x.se');
    assert.equal(r.confidence, 'MEDIUM');
    assert.equal(r.rejected.length, 4);
    assert.ok(r.rejected.some((x) => /jobb@x.se \(hr\)/.test(x)));
  });

  test('une adresse hors du domaine passe après une adresse du domaine, et sa confiance est basse', () => {
    const r = rankContactChannels({
      emails: [contact('sales@groupe.com', 'SALES', 'HIGH'), contact('info@x.se', 'GENERAL', 'MEDIUM')],
      phones: [], form: null, officialDomain: 'x.se', personName: null, personRole: null,
    });
    assert.equal(r.value, 'info@x.se');
    const seul = rankContactChannels({ emails: [contact('sales@groupe.com', 'SALES', 'HIGH')], phones: [], form: null, officialDomain: 'x.se', personName: null, personRole: null });
    assert.equal(seul.confidence, 'LOW');
    assert.match(seul.why, /hors du domaine/);
  });

  test('sans courriel : le formulaire, puis le téléphone, puis rien — chacun avec sa confiance', () => {
    const form = contact('https://x.se/kontakt', 'GENERAL', 'MEDIUM', 'FORM');
    assert.equal(rankContactChannels({ emails: [], phones: [], form, officialDomain: 'x.se', personName: null, personRole: null }).method, 'FORM');
    const tel = rankContactChannels({ emails: [], phones: [contact('+46 8 1', 'GENERAL', 'MEDIUM', 'PHONE')], form: null, officialDomain: 'x.se', personName: null, personRole: null });
    assert.equal(tel.method, 'PHONE');
    assert.equal(tel.confidence, 'LOW');
    assert.equal(rankContactChannels({ emails: [], phones: [], form: null, officialDomain: 'x.se', personName: null, personRole: null }).confidence, 'NONE');
  });
});

describe('l’adresse suédoise, reconnue à sa forme', () => {
  test('« 142 50 Skogås » suffit : code en trois-et-deux, localité connue', () => {
    const a = swedishPostalAddresses('Inplastic Scandinavia AB, Box 12, 142 50 Skogås. Tel 08-123');
    assert.equal(a.length, 1);
    assert.equal(a[0]!.locality, 'Skogås');
    assert.equal(a[0]!.basis, 'LOCALITY');
  });
  test('une localité composée et une espace insécable : « 247 32 Södra Sandby »', () => {
    const a = swedishPostalAddresses('Storgatan 1, 247 32 Södra Sandby');
    assert.equal(a[0]?.locality, 'Södra Sandby');
  });
  test('« SE-» devant, ou « Sverige » derrière, rendent probante une localité inconnue', () => {
    assert.equal(swedishPostalAddresses('SE-123 45 Lillbyn')[0]?.basis, 'SE_PREFIX');
    assert.equal(swedishPostalAddresses('123 45 Lillbyn, Sverige')[0]?.basis, 'COUNTRY_SUFFIX');
  });
  test('la forme tchèque « 110 00 Praha » et l’allemande « 50996 Köln » ne sont pas suédoises', () => {
    assert.equal(swedishPostalAddresses('Sídlo: 110 00 Praha 1').length, 0);
    assert.equal(swedishPostalAddresses('50996 Köln, Deutschland').length, 0);
  });
  test('extractCountryEvidence conclut « Suède » par l’adresse — et la citation est l’adresse', () => {
    const v = extractCountryEvidence([{ url: 'https://x.se/kontakt', html: '<p>Besöksadress: Industrigatan 5, 602 23 Norrköping</p>' }]);
    assert.equal(v.country, 'Suède');
    assert.equal(v.basis, 'POSTAL_ADDRESS');
    assert.match(v.quote ?? '', /602 23 Norrköping/);
  });
  test('une adresse suédoise dans la section de l’hébergeur ne compte pas', () => {
    const v = extractCountryEvidence([{ url: 'https://x.fr/mentions', html: '<p>Hébergeur : Loopia AB, 721 30 Västerås. </p>' }]);
    assert.notEqual(v.country, 'Suède');
  });
});
