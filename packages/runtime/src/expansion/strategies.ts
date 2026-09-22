import type { ExpansionIcp, Hypothesis, RelationshipType, SeedProfile, Strategy, StrategyKey } from './types.ts';
import { flatten } from './normalize.ts';

/**
 * Les cinq stratégies v0, et le point d'extension pour les suivantes.
 *
 * Chacune ne fait qu'une chose : dire *où* chercher et *ce que* cela
 * prouverait. Elle ne cherche pas, ne lit pas, ne note pas — le moteur s'en
 * charge, sous ses plafonds. Ajouter une stratégie, c'est ajouter une entrée
 * ici : un `plan()` qui rend des hypothèses, et la liste des relations qu'elle
 * sait établir.
 *
 * Les requêtes suivent la langue du marché de la graine (français, suédois,
 * allemand, anglais) : « distributeur » ne trouve rien à Göteborg.
 */

type Lang = 'fr' | 'sv' | 'de' | 'en';

const LANG_OF_COUNTRY: Record<string, Lang> = {
  France: 'fr', Belgique: 'fr', Suisse: 'fr', Luxembourg: 'fr', Canada: 'fr', Maroc: 'fr', Tunisie: 'fr',
  Suède: 'sv', Allemagne: 'de', Autriche: 'de',
};

export function languageFor(country: string | null, icp: ExpansionIcp): Lang {
  if (country && LANG_OF_COUNTRY[country]) return LANG_OF_COUNTRY[country]!;
  const first = icp.countries[0];
  if (first && LANG_OF_COUNTRY[first]) return LANG_OF_COUNTRY[first]!;
  return 'en';
}

/** Les mots de métier retenus pour une requête : trois au plus, les plus longs d'abord. */
function terms(seed: SeedProfile, max = 3): string {
  return seed.keywords.slice(0, max).join(' ');
}

/** Le pays où chercher : celui de la graine s'il est dans le profil, sinon le premier du profil. */
function marketOf(seed: SeedProfile, icp: ExpansionIcp): string | null {
  if (seed.entity.country && (icp.countries.length === 0 || icp.countries.includes(seed.entity.country))) return seed.entity.country;
  return icp.countries[0] ?? seed.entity.country ?? null;
}

const T = {
  distributors: { fr: 'distributeurs', sv: 'återförsäljare', de: 'händler', en: 'distributors' },
  competitors: { fr: 'concurrents', sv: 'konkurrenter', de: 'wettbewerber', en: 'competitors' },
  alternative: { fr: 'alternative à', sv: 'alternativ till', de: 'alternative zu', en: 'alternative to' },
  manufacturer: { fr: 'fabricant', sv: 'tillverkare', de: 'hersteller', en: 'manufacturer' },
  company: { fr: 'entreprise', sv: 'företag', de: 'unternehmen', en: 'company' },
  exhibitors: { fr: 'salon exposants', sv: 'mässa utställare', de: 'messe aussteller', en: 'trade show exhibitors' },
  exhibitorList: { fr: 'liste des exposants', sv: 'utställarlista', de: 'ausstellerverzeichnis', en: 'exhibitor list' },
  federation: { fr: 'fédération', sv: 'branschorganisation', de: 'verband', en: 'industry association' },
  members: { fr: 'membres', sv: 'medlemmar', de: 'mitglieder', en: 'members' },
} as const;

const tr = (key: keyof typeof T, lang: Lang) => T[key][lang];

// ─── Ce qu'une page d'un site prouve ────────────────────────────────────────

/** Les pages d'un site d'entreprise qui nomment d'autres entreprises, et la relation que chacune établit. */
export const SITE_PAGES: ReadonlyArray<{ match: RegExp; relationship: RelationshipType; label: string }> = [
  { match: /distributeur|distributor|distribut|revendeur|reseller|où[- ]acheter|ou[- ]acheter|where[- ]to[- ]buy|points?[- ]de[- ]vente|aterforsaljare|återförsäljare|händler|haendler|vertrieb|dealer/i, relationship: 'DISTRIBUTOR', label: 'page distributeurs / revendeurs' },
  { match: /int[ée]grateur|integrator|installateur|installer|installat/i, relationship: 'INTEGRATOR', label: 'page intégrateurs / installateurs' },
  { match: /partenaire|partner|samarbetspartner/i, relationship: 'VISIBLE_PARTNER', label: 'page partenaires' },
  { match: /marques|brands|fabrikat|varumark|varumärk|marken|nos[- ]fournisseurs|suppliers|leverantor|leverantör/i, relationship: 'VISIBLE_BRAND', label: 'page marques / fournisseurs' },
  { match: /r[ée]f[ée]rences|references|nos[- ]clients|clients|customers|kunder|kunden|case[- ]stud|t[ée]moignages|realisations|réalisations/i, relationship: 'LIKELY_CUSTOMER', label: 'page références / clients' },
  { match: /groupe|group|filiales|subsidiar|dotterbolag|tochter/i, relationship: 'GROUP_MEMBER', label: 'page groupe / filiales' },
];

// ─── Les stratégies ──────────────────────────────────────────────────────────

/** 2. Partenaires / distributeurs : ce que le site de la graine dit lui-même, puis ce que ses distributeurs disent d'elle. */
export const partnerStrategy: Strategy = {
  key: 'PARTNER',
  label: 'partenaires et distributeurs',
  relationships: ['DISTRIBUTOR', 'RESELLER', 'INTEGRATOR', 'VISIBLE_PARTNER', 'VISIBLE_BRAND', 'LIKELY_CUSTOMER', 'GROUP_MEMBER'],
  plan(seed, icp) {
    const lang = languageFor(seed.entity.country, icp);
    const out: Hypothesis[] = [];
    if (seed.entity.domain) {
      out.push({
        kind: 'READ_SITE', entity: seed.entity, pages: [...SITE_PAGES], maxPages: 4,
        rationale: `le site de ${seed.entity.name} nomme ses distributeurs, partenaires et marques`,
      });
    }
    out.push({
      kind: 'SEARCH_COMPANIES', query: `"${seed.entity.name}" ${tr('distributors', lang)}`, country: marketOf(seed, icp),
      relationship: 'DISTRIBUTOR', baseConfidence: 0.45,
      rationale: `un distributeur annonce sur son propre site qu'il distribue ${seed.entity.name}`,
    });
    return out;
  },
};

/** 1. Concurrents : les pages qui nomment la graine comme concurrent ou alternative. */
export const competitorStrategy: Strategy = {
  key: 'COMPETITOR',
  label: 'concurrents',
  relationships: ['COMPETITOR', 'SIMILAR_COMPANY'],
  plan(seed, icp) {
    const lang = languageFor(seed.entity.country, icp);
    const market = marketOf(seed, icp);
    return [
      { kind: 'SEARCH_COMPANIES', query: `"${seed.entity.name}" ${tr('competitors', lang)}`, country: market, relationship: 'COMPETITOR', baseConfidence: 0.5, rationale: `pages qui nomment les concurrents de ${seed.entity.name}` },
      { kind: 'SEARCH_COMPANIES', query: `${tr('alternative', lang)} ${seed.entity.name}`, country: market, relationship: 'COMPETITOR', baseConfidence: 0.45, rationale: `pages qui présentent une alternative à ${seed.entity.name}` },
    ];
  },
};

/** 5. Semblables : même activité, même marché — la relation la moins sûre, à confirmer. */
export const similarStrategy: Strategy = {
  key: 'SIMILAR',
  label: 'entreprises semblables',
  relationships: ['SIMILAR_COMPANY'],
  plan(seed, icp) {
    const lang = languageFor(seed.entity.country, icp);
    const market = marketOf(seed, icp);
    if (seed.keywords.length === 0) return [];
    // Courtes : deux mots de métier et un mot de rôle. Le pays passe par le
    // paramètre de recherche, jamais par un mot de plus — une requête trop
    // précise rend vide, et un vide fait basculer le moteur pour deux minutes.
    return [
      { kind: 'SEARCH_COMPANIES', query: `${terms(seed, 2)} ${tr('manufacturer', lang)}`, country: market, relationship: 'SIMILAR_COMPANY', baseConfidence: 0.4, rationale: `fabricants de ${terms(seed, 2)} sur le marché de ${seed.entity.name}` },
      { kind: 'SEARCH_COMPANIES', query: `${terms(seed, 1)} ${tr('company', lang)}`, country: market, relationship: 'SIMILAR_COMPANY', baseConfidence: 0.35, rationale: `entreprises de ${terms(seed, 1)}` },
    ];
  },
};

/** 3. Salons : l'événement du métier publie ses exposants. */
export const tradeShowStrategy: Strategy = {
  key: 'TRADE_SHOW',
  label: 'salons professionnels',
  relationships: ['TRADE_SHOW_EXHIBITOR'],
  plan(seed, icp) {
    const lang = languageFor(seed.entity.country, icp);
    const market = marketOf(seed, icp);
    if (seed.keywords.length === 0) return [];
    return [{
      kind: 'SEARCH_LISTINGS', query: `${terms(seed, 1)} ${tr('exhibitors', lang)}`, country: market, listingKind: 'EVENT',
      listingSite: /salon|expo|messe|fair|show|exhibition|m[aä]ssa|convention|congr[eè]s|forum|summit/i,
      memberPage: /exposant|exhibitor|utst[aä]llare|aussteller|participants?|liste|list|catalog|katalog|annuaire/i,
      relationship: 'TRADE_SHOW_EXHIBITOR', maxSites: 2,
      rationale: `les exposants d'un salon de ${terms(seed, 2)}`,
    }];
  },
};

/** 4. Fédérations : l'organisation professionnelle publie ses membres. */
export const associationStrategy: Strategy = {
  key: 'ASSOCIATION',
  label: 'fédérations et associations',
  relationships: ['ASSOCIATION_MEMBER'],
  plan(seed, icp) {
    const lang = languageFor(seed.entity.country, icp);
    const market = marketOf(seed, icp);
    if (seed.keywords.length === 0) return [];
    return [{
      kind: 'SEARCH_LISTINGS', query: `${tr('federation', lang)} ${terms(seed, 1)} ${tr('members', lang)}`, country: market, listingKind: 'ASSOCIATION',
      listingSite: /f[eé]d[eé]ration|syndicat|association|union|verband|f[oö]rbund|branschorganisation|guild|conf[eé]d[eé]ration|chambre|club|cluster|p[oô]le/i,
      memberPage: /membres|adh[eé]rents|members|medlemmar|mitglieder|annuaire|directory|liste|list|entreprises|companies/i,
      relationship: 'ASSOCIATION_MEMBER', maxSites: 2,
      rationale: `les membres d'une fédération de ${terms(seed, 2)}`,
    }];
  },
};

export const STRATEGIES: Readonly<Record<StrategyKey, Strategy>> = {
  PARTNER: partnerStrategy,
  COMPETITOR: competitorStrategy,
  TRADE_SHOW: tradeShowStrategy,
  ASSOCIATION: associationStrategy,
  SIMILAR: similarStrategy,
};

/** L'ordre d'exécution : les preuves fortes et gratuites d'abord, les requêtes ensuite. */
export const DEFAULT_STRATEGY_ORDER: readonly StrategyKey[] = ['PARTNER', 'ASSOCIATION', 'TRADE_SHOW', 'COMPETITOR', 'SIMILAR'];

export function strategiesFor(keys: readonly StrategyKey[] | undefined): Strategy[] {
  const wanted = keys && keys.length > 0 ? keys : DEFAULT_STRATEGY_ORDER;
  return DEFAULT_STRATEGY_ORDER.filter((k) => wanted.includes(k)).map((k) => STRATEGIES[k]);
}

// ─── Les mots de métier d'une graine ────────────────────────────────────────

const STOP = new Set(('le la les un une des du de et ou en au aux pour par sur dans avec sans vos nos notre votre leur leurs ce cet cette ces qui que quoi dont où '
  + 'the a an and or of for to in on at by with from your our their this that these those is are be we you it as not '
  + 'och eller för att med från till på av är vi ni de den det som en ett '
  + 'und oder für mit von zu auf im in der die das des dem ein eine wir sie ist sind '
  + 'accueil home site web page bienvenue welcome contact entreprise company société societe groupe group solutions solution produits products produit product services service '
  + 'depuis since ans years leader expert experts qualité quality france french français francaise européen europe international monde world spécialiste specialiste specialist '
  + 'fabricant fabrication manufacturer maker constructeur conception design vente sales sur mesure sur-mesure professionnel professionnels pro tout tous toute toutes').split(/\s+/));

/**
 * Les mots de métier, sans modèle : les noms de plus de quatre lettres du
 * titre et de la description, hors mots outils et hors mots trop généraux
 * pour désigner un métier (« solutions », « qualité »). Les plus fréquents
 * d'abord, puis les plus longs — un mot rare et long dit plus qu'un mot
 * court et commun.
 */
export function keywordsFrom(parts: Array<string | null | undefined>, max = 6): string[] {
  const counts = new Map<string, number>();
  for (const part of parts) {
    if (!part) continue;
    for (const raw of flatten(part).replace(/[^a-z0-9àâäéèêëïîôöùûüç' -]/g, ' ').split(/[\s'’]+/)) {
      const w = raw.replace(/^-+|-+$/g, '');
      if (w.length < 5 || STOP.has(w) || /^\d+$/.test(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([w]) => w);
}
