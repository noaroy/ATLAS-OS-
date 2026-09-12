/**
 * L'aperçu ACRN : trois distributeurs, sur un brief précis.
 *
 * C'est le premier livrable payé par une réponse. ACRN connaît son marché
 * infiniment mieux que nous ; un nom hors sujet ne passera pas inaperçu et
 * conclura l'affaire. La contrainte n'est donc pas d'en trouver trois, c'est
 * de n'en montrer aucun qui soit faux.
 *
 * Le brief n'est pas géographique. ACRN veut « le plus de distributeurs dans le
 * plus de pays » : c'est le **profil** qui trie, pas la carte. Un distributeur
 * espagnol sans service technique vaut moins qu'un distributeur roumain qui
 * étalonne, installe et qualifie. Le score reflète cet ordre.
 *
 * Rien n'est produit par un modèle. Chaque point vient d'une phrase relevée sur
 * le site du candidat, avec son adresse.
 */
import { writeFileSync } from 'node:fs';
import { createLogger, loadConfig } from '../packages/core/src/index.ts';
import { createSearchFabric } from '../packages/intelligence/src/search/fabric/factory.ts';
import { fetchRawPages } from '../packages/intelligence/src/contact-fetch.ts';
import {
  classifyPageType,
  resolveCompanyIdentity,
  resolveContacts,
  contactPagesFor,
  contactLinksIn,
  cleanQuote,
  readsAsSentence,
  type ContactPage,
  type ResolvedContact,
} from '../packages/departments/src/index.ts';

const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

/** Les pays où ACRN a déjà un distributeur : acceptables, mais moins prioritaires. */
const ALREADY_COVERED = ['pologne', 'poland', 'polska', 'italie', 'italy', 'italia',
  'ukraine', 'colombie', 'colombia', 'taiwan'];

/**
 * Les marques qui concurrencent directement ACRN.
 *
 * ACRN mesure couple, force et étanchéité d'emballages. Ces fabricants font la
 * même chose. Leur présence chez un candidat n'est pas rédhibitoire — le brief
 * le dit — mais elle doit être vue et nommée pour qu'ACRN tranche.
 */
/**
 * La concurrence ne se lit pas qu'aux marques.
 *
 * Himatrix ne nomme aucune marque sur ses pages, mais annonce « tensile
 * machines, force gauges, permeation analyzers » : c'est la gamme d'ACRN,
 * categorie par categorie. Ne chercher que des noms de marques laissait passer
 * un concurrent frontal en le creditant de « aucune marque concurrente ».
 */
const COMPETING_CATEGORIES = [
  'force gauge', 'force gauges', 'torque tester', 'torque testers',
  'torque meter', 'cap torque', 'closure torque', 'tensile machine',
  'tensile tester', 'leak tester', 'leak testing', 'seal integrity',
  'permeation analyzer', 'permeability tester', 'burst tester',
  'dinamometro', 'par de apriete',
];

const COMPETING_BRANDS = [
  'labthink', 'at2e', 'pbi-dansensor', 'dansensor', 'systech illinois',
  'tqc sheen', 'hanatek', 'steinfurth', 'sotax', 'torqo', 'imada',
  'chatillon', 'lloyd instruments', 'ametek', 'zwick', 'instron', 'mark-10',
];

/** Les marques d'équipement voisines mais non concurrentes : bon signe. */
const ADJACENT_BRANDS = [
  'multivac', 'ilapak', 'bosch packaging', 'syntegon', 'marchesini', 'ima ',
  'krones', 'sidel', 'gea ', 'tetra pak', 'coesia', 'nordson', 'videojet',
  'markem', 'domino', 'mettler', 'ishida', 'minebea', 'anritsu', 'loma',
];

/**
 * La porte d'entrée : cette société revend-elle du matériel fabriqué par
 * d'autres ?
 *
 * Sans cette question posée en premier, le score note des mots-clés et non un
 * métier. La première passe a retenu une société d'inspection tierce partie à
 * 70/100 : son site parle de contrôle qualité, de validation et de packaging —
 * tous les marqueurs y étaient, et elle ne vend aucune machine.
 *
 * Un distributeur le dit toujours, parce que c'est son argument.
 */
const DISTRIBUTOR_CLAIMS = [
  'authorised distributor', 'authorized distributor', 'official distributor',
  'exclusive distributor', 'we distribute', 'we represent',
  'official dealer', 'authorised dealer', 'sales partner of',
  'brands we represent', 'represented companies', 'companies we represent',
  'distribuidor oficial', 'distribuidor exclusivo', 'representamos',
  'empresas que representamos', 'marcas que representamos',
  'distributore ufficiale', 'distributore esclusivo', 'rappresentiamo',
  'distributeur exclusif', 'distributeur officiel',
  'vertriebspartner', 'offizieller distributor', 'yetkili distribütör',
];

/**
 * Le piège symétrique : un fabricant qui *a* des distributeurs écrit aussi le
 * mot « distributeur ».
 *
 * TriVision est ressorti à 80/100 — c'est un fabricant danois de systèmes de
 * vision, dont le site dit « find a distributor ». Ces formulations sont celles
 * du vendeur qui recrute, exactement comme ACRN : elles désignent le contraire
 * de ce qu'on cherche.
 */
const MANUFACTURER_SIDE = [
  'our distributors', 'find a distributor', 'become a distributor',
  'distributor login', 'distributor portal', 'distributor network',
  'nos distributeurs', 'devenir distributeur', 'nuestros distribuidores',
  'i nostri distributori', 'unsere distributoren', 'our dealers',
  'find a dealer', 'dealer locator', 'where to buy',
];

/**
 * Les métiers qui ressemblent à un distributeur sans en être un.
 *
 * Inspection, certification, audit, sourcing : ils parlent le même vocabulaire
 * — qualité, packaging, pharmaceutique — et n'achètent aucune machine.
 */
const NOT_A_DISTRIBUTOR = [
  'third party inspection', 'third-party inspection', 'inspection services',
  'certification body', 'notified body', 'accredited laboratory',
  'testing laboratory services', 'audit services', 'sourcing agent',
  'supplier audit', 'pre-shipment inspection', 'quality assurance services',
  'consulting services', 'engineering consultancy',
];

interface Dimension {
  key: string;
  label: string;
  weight: number;
  markers: string[];
}

/** Les sept critères du brief ACRN, avec leur pondération exacte. */
const DIMENSIONS: Dimension[] = [
  {
    key: 'machineSales',
    label: 'Expérience de vente de machines techniques',
    weight: 20,
    markers: [
      'distributor', 'distribuidor', 'distributore', 'distributeur', 'vertrieb',
      'we distribute', 'we supply', 'exclusive representative', 'representamos',
      'sales and service', 'machines', 'maquinaria', 'macchine', 'equipment supplier',
      'test equipment', 'testing instruments', 'packaging machines',
    ],
  },
  {
    key: 'acrnMarkets',
    label: 'Présence sur les marchés d’ACRN',
    weight: 20,
    markers: [
      'cosmetic', 'cosmetica', 'cosmétique', 'kosmetik', 'perfume', 'parfum',
      'pharmaceutical', 'pharma', 'farmaceutic', 'food', 'alimentaria',
      'beverage', 'packaging', 'envase', 'embalaje', 'imballaggio', 'verpackung',
    ],
  },
  {
    key: 'commercial',
    label: 'Capacité commerciale / prospection',
    weight: 15,
    markers: [
      'sales team', 'sales network', 'sales engineer', 'our sales',
      'commercial team', 'account manager', 'we visit', 'demonstration',
      'demo at your', 'showroom', 'trade fair', 'exhibition', 'nationwide',
      'across the country', 'consulting', 'advice', 'we accompany',
      // Un distributeur espagnol, italien ou allemand décrit sa force de vente
      // dans sa langue. Ne chercher qu'en anglais lui donnait zéro par
      // construction : Viclinapack, dont l'adresse publique est
      // « comercial@ », marquait 0 sur 15 à cette ligne.
      'equipo comercial', 'departamento comercial', 'red comercial',
      'te acompanamos', 'le acompanamos', 'asesoramiento', 'asesoria',
      'te asesoramos', 'atencion personalizada', 'venta y alquiler',
      'rete commerciale', 'ufficio commerciale', 'consulenza',
      'equipe commerciale', 'force de vente', 'conseil personnalise',
      'vertriebsteam', 'beratung', 'aussendienst',
    ],
  },
  {
    key: 'service',
    label: 'Capacité de service technique',
    weight: 15,
    markers: [
      'calibration', 'calibración', 'calibrazione', 'kalibrierung',
      'installation', 'commissioning', 'after-sales', 'after sales',
      'servicio técnico', 'technical service', 'service department',
      'maintenance', 'qualification', 'iq oq pq', 'validation', 'repair',
      'spare parts', 'training',
    ],
  },
  {
    key: 'smallStructure',
    label: 'Profil de petite structure',
    weight: 10,
    markers: [
      'family business', 'family-owned', 'empresa familiar', 'azienda familiare',
      'small team', 'our team of', 'independent company', 'a taille humaine',
      'privately owned', 'owner-managed', 'inhabergeführt',
    ],
  },
  {
    key: 'webEnglish',
    label: 'Site actif et anglais exploitable',
    weight: 10,
    markers: [
      'about us', 'our products', 'contact us', 'services', 'solutions',
      'quality control', 'read more', 'welcome',
    ],
  },
];

const fold = (t: string) =>
  t.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

const strip = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();

interface Hit { quote: string; marker: string; sourceUrl: string }

/** Les phrases qui portent un marqueur, citées telles quelles. */
function sentencesFor(pages: readonly ContactPage[], markers: readonly string[], max = 3): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const sentence of strip(page.html).split(/(?<=[.!?])\s+/)) {
      const quote = cleanQuote(sentence);
      if (quote.length < 35 || quote.length > 260) continue;
      if (!/^[A-ZÀ-ÜÁÉÍÓÚÑ]/.test(quote)) continue;
      if (!readsAsSentence(quote)) continue;
      const f = fold(quote);
      const marker = markers.find((m) => f.includes(fold(m)));
      if (!marker || seen.has(quote)) continue;
      seen.add(quote);
      hits.push({ quote, marker, sourceUrl: page.url });
      if (hits.length >= max) return hits;
    }
  }
  return hits;
}

/** Combien de marqueurs distincts la totalité du site porte. */
function markerCoverage(pages: readonly ContactPage[], markers: readonly string[]): string[] {
  const text = fold(pages.map((p) => strip(p.html)).join(' '));
  return markers.filter((m) => text.includes(fold(m)));
}

/**
 * Une marque doit etre un mot, pas une suite de lettres.
 *
 * « IMA » a ete rapporte comme marque distribuee par IMCO : les trois lettres
 * viennent de « envasado primario ». Une marque citee dans un rapport client
 * doit resister a la verification.
 */
function containsWord(text: string, term: string): boolean {
  const needle = fold(term);
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? ' ' : text[at - 1]!;
    const after = text[at + needle.length] ?? ' ';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = at + 1;
  }
}

function brandsFound(pages: readonly ContactPage[], brands: readonly string[]): string[] {
  const text = fold(pages.map((p) => strip(p.html)).join(' '));
  return brands.filter((b) => containsWord(text, b));
}

/** Le pays, lu sur l'extension du domaine ou sur l'adresse publiée. */
const TLD_COUNTRY: Record<string, string> = {
  es: 'Espagne', pt: 'Portugal', nl: 'Pays-Bas', be: 'Belgique', de: 'Allemagne',
  tr: 'Turquie', ro: 'Roumanie', cz: 'Tchéquie', hu: 'Hongrie', gr: 'Grèce',
  mx: 'Mexique', ma: 'Maroc', in: 'Inde', br: 'Brésil', uk: 'Royaume-Uni',
  ch: 'Suisse', at: 'Autriche', se: 'Suède', dk: 'Danemark', fi: 'Finlande',
  no: 'Norvège', ie: 'Irlande', fr: 'France', it: 'Italie', pl: 'Pologne',
};

/**
 * Le nom, ou le domaine.
 *
 * « About » a été retenu comme raison sociale : c'était le titre de la page
 * lue. Un titre trop court, trop générique ou trop long ne nomme personne, et
 * le domaine officiel reprend alors la main.
 */
const PAGE_WORDS = ['about', 'home', 'contact', 'inicio', 'accueil', 'welcome',
  'products', 'services', 'company', 'empresa', 'chi siamo', 'quienes somos'];

function companyNameOf(raw: string, domain: string): string {
  const head = raw.split(/[|–—:]/)[0]!.trim();
  const folded = fold(head);
  const looksLikeTitle = head.length < 4 || head.split(/\s+/).length > 6
    || PAGE_WORDS.some((w) => folded === w || folded.startsWith(`${w} `));
  if (!looksLikeTitle) return head.slice(0, 60);
  const root = domain.replace(/^www\./, '').split('.')[0]!;
  return root.charAt(0).toUpperCase() + root.slice(1);
}

function countryOf(domain: string, pages: readonly ContactPage[]): string {
  const tld = domain.split('.').pop() ?? '';
  if (TLD_COUNTRY[tld]) return TLD_COUNTRY[tld];
  const text = fold(pages.map((p) => strip(p.html)).join(' '));
  // Un indicatif téléphonique publié tranche mieux qu'un nom de pays cité au
  // détour d'une phrase — celui-ci peut désigner un client, pas le siège.
  const DIAL: Record<string, string> = {
    '+34': 'Espagne', '+351': 'Portugal', '+31': 'Pays-Bas', '+32': 'Belgique',
    '+49': 'Allemagne', '+90': 'Turquie', '+40': 'Roumanie', '+420': 'Tchéquie',
    '+36': 'Hongrie', '+30': 'Grèce', '+52': 'Mexique', '+212': 'Maroc',
    '+91': 'Inde', '+55': 'Brésil', '+44': 'Royaume-Uni', '+41': 'Suisse',
    '+43': 'Autriche', '+45': 'Danemark', '+46': 'Suède', '+33': 'France',
  };
  const dial = Object.entries(DIAL).find(([code]) => text.includes(code));
  if (dial) return dial[1];
  // « +1 » est trop court pour servir d'indice : on lit l'adresse a la place.
  if (['united states', ' usa', 'u.s.a'].some((k) => text.includes(k))) return 'Etats-Unis';
  if (['canada', 'ontario', 'quebec'].some((k) => text.includes(k))) return 'Canada';
  const named = Object.entries(TLD_COUNTRY).find(([, name]) => text.includes(fold(name)));
  return named ? `${named[1]} (déduit du texte du site)` : 'non déterminé';
}

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());
const fabric = createSearchFabric(config.search, {
  need: { countries: ['FR'], languages: ['en'], commercial: true },
});
if (!fabric) {
  console.error('Aucun moteur de recherche : cet aperçu en dépend.');
  process.exit(1);
}

/**
 * Les requêtes visent un **profil**, pas un pays.
 *
 * Chacune décrit ce qu'ACRN cherche — un revendeur de machines de contrôle ou
 * de conditionnement, servant la cosmétique, la pharmacie ou l'agroalimentaire.
 * Le pays n'y est qu'un moyen de diversifier les résultats.
 */
const QUERIES = [
  'authorised distributor packaging testing equipment cosmetics pharma',
  'official distributor packaging machines pharmaceutical Spain',
  'distributor packaging quality control instruments Netherlands brands',
  'distribuidor oficial maquinaria envasado control calidad cosmetica',
  'distributore esclusivo macchine confezionamento controllo qualita',
  'yetkili distributor ambalaj makineleri kalite kontrol',
  'distributor leak testing seal integrity packaging equipment Europe',
  'authorized distributor torque tester packaging closures laboratory',
  'distributor packaging laboratory instruments Portugal brands represent',
  'distributor packaging test equipment Romania Czech brands',
  'distributor packaging machines Morocco Tunisia cosmetics food',
  'distributor quality control packaging equipment Mexico brands',
  'distributor packaging testing instruments Greece Hungary',
  'distributor packaging inspection equipment Germany represent brands',
  'distributor packaging machines India cosmetics pharmaceutical brands',
  // Les requêtes ci-dessus ramènent surtout des fabricants : sur soixante
  // sociétés lues, trois seulement se déclaraient distributeur. « distributor »
  // est un mot que le fabricant écrit aussi, pour en recruter.
  //
  // Ces requêtes-ci cherchent la phrase que seul un revendeur écrit — celle par
  // laquelle il présente les marques d'autrui comme son catalogue.
  '"marcas que representamos" maquinaria envasado laboratorio',
  '"empresas que representamos" equipos laboratorio farmaceutico',
  '"le marche che rappresentiamo" macchine confezionamento laboratorio',
  '"nous representons" machines emballage laboratoire pharmaceutique',
  '"wij vertegenwoordigen" verpakkingsmachines laboratorium',
  '"wir vertreten" Verpackungsmaschinen Labor Pharma Vertrieb',
  '"representamos as marcas" equipamentos embalagem laboratorio Portugal',
  '"temsilcisi" ambalaj makineleri laboratuvar kalite kontrol',
  '"our represented brands" packaging laboratory equipment pharma',
  '"sole agent" packaging testing instruments pharmaceutical cosmetics',
  'distribuidor equipos laboratorio control calidad envase Mexico marcas',
  'reprezentant exclusiv echipamente ambalare laborator farmaceutic',
]

interface Candidate {
  name: string;
  domain: string;
  website: string;
  country: string;
  score: number;
  components: Array<{ label: string; weight: number; points: number; basis: string | null; sourceUrl: string | null }>;
  markets: string[];
  competing: string[];
  adjacent: string[];
  facts: Hit[];
  pages: ContactPage[];
  contact: ResolvedContact | null;
  sources: string[];
}

const THRESHOLD = Number(flag('min') ?? 70);
/**
 * Combien de sociétés on accepte de lire avant de renoncer.
 *
 * Le seuil de 70 cumule sept critères : il faut en évaluer beaucoup pour en
 * retenir trois. Huit était un plafond hérité d'un essai, pas une décision.
 */
const MAX_EVALUATED = Number(flag('evaluate') ?? 40);
const candidates: Candidate[] = [];
let evaluated = 0;
const qualifies = (c: Candidate) => c.score >= THRESHOLD && c.facts.length >= 2 && c.contact !== null;
const enough = () => candidates.filter(qualifies).length >= 3;
const seenDomains = new Set<string>(['acrn.fr', 'mecmesin.com']);

for (const query of QUERIES) {
  if (enough() || evaluated >= MAX_EVALUATED) break;
  let results;
  try {
    results = await fabric.search({ query, language: 'en', count: 10 }, { logger, timeoutMs: 20_000 });
  } catch {
    continue;
  }

  for (const result of results.results ?? []) {
    if (enough() || evaluated >= MAX_EVALUATED) break;
    let domain: string;
    try {
      domain = new URL(result.url).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    if (seenDomains.has(domain)) continue;
    seenDomains.add(domain);

    const page = classifyPageType({ url: result.url, domain, title: result.title, snippet: result.snippet });
    if (!page.ownerIsCandidate) continue;
    const identity = resolveCompanyIdentity({
      searchTitle: result.title ?? '', url: result.url, domain, page,
    });
    if (!identity.identity) continue;

    // Lecture du site — une seule passe sert à tout : preuves, marques, contact.
    const queue = [
      ...contactPagesFor(identity.identity.officialWebsite, domain),
      `https://${domain}/en/`, `https://${domain}/about`, `https://${domain}/about-us`,
      `https://${domain}/products`, `https://${domain}/services`, `https://${domain}/brands`,
    ];
    const visited = new Set<string>();
    const pages: ContactPage[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const batch = queue.filter((u) => !visited.has(u));
      for (const u of batch) visited.add(u);
      if (batch.length === 0) break;
      const fetched = await fetchRawPages(batch, {
        logger, timeoutMs: 10_000, maxPages: Math.max(0, 8 - pages.length),
      });
      pages.push(...fetched.pages);
      if (pass === 0) {
        const home = fetched.pages[0];
        if (home) for (const link of contactLinksIn(home.html, home.url, domain)) {
          if (!visited.has(link)) queue.push(link);
        }
      }
    }
    if (pages.length < 2) continue;
    evaluated += 1;

    // La porte d'entrée, avant tout calcul : un distributeur le déclare.
    const claims = markerCoverage(pages, DISTRIBUTOR_CLAIMS);
    if (claims.length === 0) {
      console.error(`  ---  ${domain.padEnd(34)}ne se déclare pas distributeur`);
      continue;
    }
    // Le mot « distributeur » vu du mauvais côté : un fabricant qui en cherche.
    const manufacturerSide = markerCoverage(pages, MANUFACTURER_SIDE);
    if (manufacturerSide.length > 0 && claims.length < 2) {
      console.error(`  ---  ${domain.padEnd(34)}fabricant qui recrute : « ${manufacturerSide[0]} »`);
      continue;
    }
    const disqualifying = markerCoverage(pages, NOT_A_DISTRIBUTOR);
    if (disqualifying.length > 0) {
      console.error(`  ---  ${domain.padEnd(34)}métier : ${disqualifying[0]}`);
      continue;
    }

    const components: Candidate['components'] = [];
    let total = 0;
    for (const dimension of DIMENSIONS) {
      const coverage = markerCoverage(pages, dimension.markers);
      // La couverture décide de la part acquise : un site qui nomme quatre
      // marchés d'ACRN vaut plus qu'un site qui en nomme un.
      const ratio = Math.min(1, coverage.length / (dimension.key === 'acrnMarkets' ? 4 : 2));
      const hit = ratio > 0 ? sentencesFor(pages, dimension.markers, 1)[0] ?? null : null;
      const points = Math.round(dimension.weight * ratio * 10) / 10;
      total += points;
      components.push({
        label: dimension.label, weight: dimension.weight, points,
        basis: hit ? hit.quote : (coverage.length > 0 ? `marqueurs : ${coverage.slice(0, 4).join(', ')}` : null),
        sourceUrl: hit?.sourceUrl ?? null,
      });
    }

    // Compatibilité concurrentielle : dix points si rien ne concurrence ACRN,
    // quatre si une marque concurrente est présente — jamais zéro, parce que
    // le brief demande d'analyser plutôt que d'exclure.
    const competing = [
      ...brandsFound(pages, COMPETING_BRANDS),
      ...markerCoverage(pages, COMPETING_CATEGORIES),
    ];
    const adjacent = brandsFound(pages, ADJACENT_BRANDS);
    const compatibility = competing.length === 0 ? 10 : adjacent.length > 0 ? 5 : 4;
    total += compatibility;
    components.push({
      label: 'Compatibilité concurrentielle', weight: 10, points: compatibility,
      basis: competing.length === 0
        ? 'aucune marque directement concurrente d’ACRN relevée sur le site'
        : `marques concurrentes relevées : ${competing.join(', ')}`,
      sourceUrl: null,
    });

    const contacts = resolveContacts({ officialDomain: domain, pages });
    const written = [...contacts.publicEmails, ...(contacts.contactFormUrl ? [contacts.contactFormUrl] : [])]
      .filter((c) => c.suitability !== 'BLOCKED');

    const facts = sentencesFor(pages, [...DIMENSIONS[0]!.markers, ...DIMENSIONS[1]!.markers], 3);
    const markets = markerCoverage(pages, DIMENSIONS[1]!.markers);

    candidates.push({
      name: companyNameOf(identity.identity.companyName, domain),
      domain,
      website: identity.identity.officialWebsite,
      country: countryOf(domain, pages),
      score: Math.round(total * 10) / 10,
      components, markets, competing, adjacent, facts, pages,
      contact: written[0] ?? null,
      sources: [...new Set(pages.map((p) => p.url))].slice(0, 4),
    });
    console.error(`  ${String(Math.round(total)).padStart(3)}  ${domain}`);
  }
}

const retained = candidates
  .filter((c) => c.score >= THRESHOLD && c.facts.length >= 2 && c.contact !== null)
  .sort((a, b) => b.score - a.score)
  .slice(0, 3);

const lines: string[] = [];
const say = (t = '') => { lines.push(t); console.log(t); };

say(`ACRN FREE PREVIEW — ${retained.length} distributeur(s) retenu(s)`);
say(`${evaluated} société(s) lue(s) · ${candidates.length} se déclarent distributeur`);
say(`Seuil ${THRESHOLD}/100 · score spécifique au brief ACRN`);
say('');

let n = 0;
for (const c of retained) {
  n += 1;
  say('═'.repeat(76));
  say(`PROSPECT ${n}`);
  say(`Company                ${c.name}`);
  say(`Country                ${c.country}`);
  say(`Website                ${c.website}`);
  say(`ACRN Fit Score         ${c.score} / 100`);
  say('Why it fits');
  for (const comp of c.components.filter((x) => x.points > 0).sort((a, b) => b.points - a.points)) {
    say(`  ${String(comp.points).padStart(5)} / ${String(comp.weight).padEnd(3)} ${comp.label}`);
    if (comp.basis) say(`         « ${comp.basis.slice(0, 150)} »`);
  }
  say(`Markets served         ${c.markets.slice(0, 8).join(', ') || '— non observé'}`);
  const commercial = c.components.find((x) => x.label.includes('commerciale'));
  const service = c.components.find((x) => x.label.includes('service'));
  say(`Commercial capability  ${commercial?.basis?.slice(0, 160) ?? '— non observé'}`);
  say(`Technical/service      ${service?.basis?.slice(0, 160) ?? '— non observé'}`);
  // Dire « aucune marque » quand le site annonce « six sociétés représentées »
  // est faux : la marque existe, elle n'est simplement pas nommée en ligne.
  const REPRESENTS = ['represented companies', 'companies we represent',
    'empresas que representamos', 'marcas que representamos', 'representamos',
    'we represent', 'rappresentiamo', 'nous representons'];
  const declaresBrands = markerCoverage(c.pages, REPRESENTS);
  say(`Products/brands        ${[...c.adjacent, ...c.competing].join(', ')
    || (declaresBrands.length > 0
      ? `déclare représenter des marques tierces (« ${declaresBrands[0]} ») sans les nommer en ligne — à demander`
      : '— aucune marque tierce identifiée')}`);
  say(`Competition analysis   ${c.competing.length === 0
    ? 'Aucune marque directement concurrente d’ACRN (couple, force, étanchéité) relevée.'
    : `Distribue ${c.competing.join(', ')} — à examiner : recouvrement possible avec la gamme ACRN.`}`);
  say(`Public contact         ${c.contact ? `${c.contact.type} — ${c.contact.value}` : 'aucun canal écrit relevé'}`);
  say('Sources');
  for (const s of c.sources) say(`  ${s}`);
  say('Observed facts');
  for (const f of c.facts.slice(0, 3)) say(`  « ${f.quote} »\n    ${f.sourceUrl}`);
  say('');
}

if (retained.length < 3) {
  say('─'.repeat(76));
  say(`Seulement ${retained.length} dossier(s) franchissent ${THRESHOLD}/100.`);
  say('Aucun nom n’a été ajouté pour compléter : un exemple faux coûte la vente.');
  say('');
  say('Candidats évalués et écartés, avec leur score :');
  for (const c of candidates.filter((x) => !retained.includes(x)).sort((a, b) => b.score - a.score).slice(0, 10)) {
    const why = c.score < THRESHOLD ? `score ${c.score}` : c.facts.length < 2 ? 'moins de 2 faits' : 'aucun canal écrit';
    say(`  ${String(c.score).padStart(5)}  ${c.domain.padEnd(34)}${why}`);
  }
}

say('MESSAGES SENT: 0');
writeFileSync(flag('out') ?? 'out/acrn-preview.txt', lines.join('\n'), 'utf8');
