/**
 * Le benchmark suédois, rejouable sans réseau.
 *
 * Huit sociétés observées lors du lot VPS de vingt candidats, réduites à ce
 * qui a décidé de leur sort : quelques phrases, un pied de page, un JSON-LD.
 * Aucun contenu tiers n'est recopié ; les noms sont dérivés (« -lik »), les
 * numéros et adresses sont synthétiques. Ce que chaque fixture garde, c'est
 * la FORME du piège réel — le thème parasite, les agents étrangers, le
 * sélecteur de pays, l'adresse chinoise en pied de page.
 *
 * Chaque cas porte ce qu'on attend de lui, et le test rejoue tout le lot :
 * identité, siège, présence, preuve, critères, note, tri, comptage.
 */

export interface BenchmarkCase {
  domain: string;
  title: string;
  /** Les pages servies, adresse exacte → HTML. */
  pages: Record<string, string>;
  expect: {
    stage: 'RETAINED' | 'REVIEW_REQUIRED' | 'EXCLUDED';
    name: string;
    country: string | null;
    countryBasis?: string;
    presence: 'ESTABLISHED' | 'LIKELY' | 'WEAK' | 'NONE';
    fit: 'IN_SCOPE' | 'OUT_OF_SCOPE' | 'NEEDS_VERIFICATION';
    evidence?: 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT';
    triage: 'AUTO_APPROVED' | 'HUMAN_REVIEW' | 'AUTO_EXCLUDED';
    category?: string | null;
    /** Vrai quand la qualification (appel modèle) doit avoir eu lieu. */
    llmCalled: boolean;
    /** La note attendue, quand elle est déterminée par la fixture. */
    total?: number;
    contradictionEmpty?: boolean;
    foreignSignal?: RegExp;
  };
}

const SV_DISTRIB = 'är distributör av förpackningsmaskiner och kontrollutrustning';

export const BENCHMARK: BenchmarkCase[] = [
  {
    domain: 'angloscand-lik.se', title: 'Angloscand-lik',
    pages: {
      'https://angloscand-lik.se/': `<html><head>
        <title>Industrial packaging machines - Cold Seal from Angloscand-lik</title>
        <meta property="og:site_name" content="Angloscand-lik" />
        <script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"seodr. theme"},{"@type":"WebSite","name":"Angloscand-lik"}]}</script>
        </head><body><p>Angloscand-lik ${SV_DISTRIB} för läkemedel och kosmetik.</p><p>Vi installerar och servar alla maskiner.</p>
        <a href="/contact/">Contact</a></body></html>`,
      'https://angloscand-lik.se/contact/': `<html><head><title>Contact</title></head><body>
        <p>Managing Director +46(0)70 000 00 00 · <a href="mailto:info@angloscand-lik.se">info@angloscand-lik.se</a></p>
        <p>Agents: +47 900 00 000 · +358 9 000 0000 · +324 000 00 00 · +49 170 000 0000</p>
        <h2>HEADQUARTERS Sweden</h2><p>Hamngatan 1<br>133 33 Saltsjöbaden<br>Sweden</p>
        <footer>Org.nr: 556000-0001</footer></body></html>`,
    },
    expect: {
      stage: 'RETAINED', name: 'Angloscand-lik', country: 'Suède', countryBasis: 'OFFICIAL_ID', presence: 'ESTABLISHED',
      fit: 'IN_SCOPE', evidence: 'COMPLETE', triage: 'AUTO_APPROVED', llmCalled: true, contradictionEmpty: true, foreignSignal: /Finlande|Norvège|Belgique|Allemagne/, total: 100,
    },
  },
  {
    domain: 'ppsnordic-lik.se', title: 'PPS Nordic-lik',
    pages: {
      'https://ppsnordic-lik.se/': `<html><head><title>PPS Nordic-lik</title></head><body>
        <p>PPS Nordic-lik ${SV_DISTRIB} för livsmedel och läkemedel.</p><p>Vi installerar och servar utrustningen.</p>
        <p>Besöksadress: Industrigatan 4, 211 24 Malmö · <a href="mailto:info@ppsnordic-lik.se">info@ppsnordic-lik.se</a></p>
        <p>Partner i Danmark: +45 32 00 00 00</p></body></html>`,
    },
    expect: {
      stage: 'RETAINED', name: 'PPS Nordic-lik', country: 'Suède', countryBasis: 'POSTAL_ADDRESS', presence: 'ESTABLISHED',
      fit: 'IN_SCOPE', evidence: 'COMPLETE', triage: 'AUTO_APPROVED', llmCalled: true, contradictionEmpty: true, foreignSignal: /Danemark/,
    },
  },
  {
    domain: 'cyklop-lik.com', title: 'Cyklop-lik',
    pages: {
      'https://cyklop-lik.com/': `<html lang="en"><head><title>Cyklop-lik | Packaging Systems</title>
        <link rel="alternate" hreflang="sv-se" href="https://cyklop-lik.com/sv-se/"></head><body>
        <p>info@cyklop-lik.com +49 2236 000 000</p>
        <div data-country-code="se" data-country-email="info@cyklop-lik.se" data-country-phone="+46 8 500 000 00"></div>
        <p>Cyklop-lik ${SV_DISTRIB} för läkemedel.</p><a href="/contact">Contact</a></body></html>`,
      'https://cyklop-lik.com/contact': `<html lang="en"><head><title>Contact | Cyklop-lik</title></head><body>
        <p>+49 2236 000 000 · Cyklop-lik GmbH, Cologne, Germany — headquarters.</p>
        <p>Locations: France Norway Sweden Denmark Germany</p></body></html>`,
    },
    expect: {
      stage: 'REVIEW_REQUIRED', name: 'Cyklop-lik', country: 'Allemagne', countryBasis: 'CORROBORATION', presence: 'LIKELY',
      fit: 'NEEDS_VERIFICATION', evidence: 'PARTIAL', triage: 'HUMAN_REVIEW', category: null, llmCalled: true,
    },
  },
  {
    // Le piège réel de fpack.se : le JSON-LD et le H1 portent l'accroche SEO ;
    // seuls og:site_name et le titre nomment la marque.
    domain: 'fpack-lik.se', title: 'Fpack-lik',
    pages: {
      'https://fpack-lik.se/': `<html><head><title>Förpackningsmaskiner för dina behov - Fpack-lik</title>
        <meta property="og:site_name" content="Fpack-lik" />
        <script type="application/ld+json">{"@type":"Organization","name":"Förpackningsmaskiner för dina behov","address":{"addressCountry":"SE"}}</script></head><body>
        <h1>Förpackningsmaskiner för dina behov</h1>
        <p>Fpack-lik ${SV_DISTRIB} för kosmetik och läkemedel i Sverige.</p><p>Vi installerar och servar alla maskiner vi levererar.</p>
        <p>Org.nr 556000-0002 · Göteborg · <a href="mailto:info@fpack-lik.se">info@fpack-lik.se</a> · +46 31 000 00 00</p></body></html>`,
    },
    expect: {
      stage: 'RETAINED', name: 'Fpack-lik', country: 'Suède', countryBasis: 'OFFICIAL_ID', presence: 'ESTABLISHED',
      fit: 'IN_SCOPE', evidence: 'COMPLETE', triage: 'AUTO_APPROVED', llmCalled: true, contradictionEmpty: true, total: 100,
    },
  },
  {
    // Sert la pharma, mais rien ne dit qu'elle vend des machines : le critère requis reste à confirmer.
    domain: 'pharmaprocess-lik.se', title: 'Pharmaprocess-lik',
    pages: {
      'https://pharmaprocess-lik.se/': `<html><head><title>Pharmaprocess-lik</title></head><body>
        <p>Pharmaprocess-lik erbjuder validering och kvalificering av kontrollutrustning för läkemedel.</p>
        <p>Org.nr 556000-0003 · Uppsala · <a href="mailto:info@pharmaprocess-lik.se">info@pharmaprocess-lik.se</a></p></body></html>`,
    },
    expect: {
      stage: 'REVIEW_REQUIRED', name: 'Pharmaprocess-lik', country: 'Suède', countryBasis: 'OFFICIAL_ID', presence: 'ESTABLISHED',
      fit: 'IN_SCOPE', evidence: 'PARTIAL', triage: 'HUMAN_REVIEW', llmCalled: true,
    },
  },
  {
    // Une seule page lisible, sans aucun terme du brief ni pays : à regarder à la main, sans appel modèle.
    domain: 'levo-lik.se', title: 'Levo-lik',
    pages: {
      'https://levo-lik.se/': `<html><head><title>Levo-lik</title></head><body>
        <p>Levo-lik erbjuder tjänster och lösningar för svenska företag inom flera branscher, med fokus på kvalitet och långsiktiga relationer.</p>
        <p>Kontakta oss gärna för mer information om vad vi kan göra för er verksamhet och hur vi arbetar tillsammans med våra kunder.</p></body></html>`,
    },
    expect: {
      stage: 'REVIEW_REQUIRED', name: 'Levo-lik', country: null, presence: 'WEAK',
      fit: 'NEEDS_VERIFICATION', triage: 'HUMAN_REVIEW', category: 'LOW_RELEVANCE', llmCalled: false,
    },
  },
  {
    // Le généraliste : tout pour l'industrie, dont des machines d'emballage. Le client préfère un spécialiste.
    domain: 'abb-lik.se', title: 'ABB-lik',
    pages: {
      'https://abb-lik.se/': `<html><head><title>ABB-lik</title></head><body>
        <p>ABB-lik säljer allt inom industri: robotar, pumpar, förpackningsmaskiner, kontrollutrustning, belysning och kraftsystem för läkemedel och livsmedel.</p>
        <p>Organisationsnummer: 556000-0004 · Västerås · +46 21 000 00 00</p></body></html>`,
    },
    expect: {
      stage: 'REVIEW_REQUIRED', name: 'ABB-lik', country: 'Suède', countryBasis: 'OFFICIAL_ID', presence: 'ESTABLISHED',
      fit: 'IN_SCOPE', triage: 'HUMAN_REVIEW', category: 'TOO_GENERAL', llmCalled: true,
    },
  },
  {
    // Weibang / yanbanmachine.com : chinoise par concordance — un +86 et
    // « China » sur la page contact — avec un seul signal suédois, une version
    // linguistique. Ce n'est qu'une présomption : revue P3, sans appel modèle,
    // sans note, « Écarter sauf preuve contraire », et la raison nomme le
    // signal en mots — jamais « [object Object] ».
    domain: 'yanbanmachine-lik.com', title: 'Weibang-lik',
    pages: {
      'https://yanbanmachine-lik.com/': `<html><head><title>Weibang-lik</title>
        <link rel="alternate" hreflang="sv" href="https://yanbanmachine-lik.com/sv/"></head><body>
        <p>Weibang-lik tillverkar förpackningsmaskiner och kontrollutrustning för export.</p><a href="/contact/">Contact</a></body></html>`,
      'https://yanbanmachine-lik.com/contact/': `<html><head><title>Contact</title></head><body>
        <p>Weibang-lik Machinery Co., Ruian, Zhejiang, China · Tel +86 577 6000 0000 · <a href="mailto:sales@yanbanmachine-lik.com">sales@yanbanmachine-lik.com</a></p></body></html>`,
    },
    expect: {
      stage: 'REVIEW_REQUIRED', name: 'Weibang-lik', country: 'Chine', countryBasis: 'CORROBORATION', presence: 'WEAK',
      fit: 'OUT_OF_SCOPE', triage: 'HUMAN_REVIEW', category: 'WRONG_COUNTRY', llmCalled: false,
    },
  },
  {
    // Le fabricant étranger : adresse chinoise publiée. Écarté seul, sans appel modèle.
    domain: 'hlunpack-lik.com', title: 'HLunPACK-lik',
    pages: {
      'https://hlunpack-lik.com/': `<html><head><title>HLunPACK-lik Machinery</title></head><body>
        <p>HLunPACK-lik manufactures förpackningsmaskiner for export worldwide.</p>
        <p>Address: No. 88 Industrial Road, Ruian, Zhejiang, China · Tel +86 577 0000 0000</p></body></html>`,
    },
    expect: {
      stage: 'EXCLUDED', name: 'HLunPACK-lik Machinery', country: 'Chine', countryBasis: 'POSTAL_ADDRESS', presence: 'NONE',
      fit: 'OUT_OF_SCOPE', triage: 'AUTO_EXCLUDED', category: 'WRONG_COUNTRY', llmCalled: false,
    },
  },
];

/** L'annuaire que le filtre écarte avant toute lecture — le vingt-et-unième du lot réel. */
export const DIRECTORY_RESULT = { domain: 'europages.se', title: 'Annuaire' };

export const BENCHMARK_PAGES: Record<string, string> = Object.assign({}, ...BENCHMARK.map((c) => c.pages));
