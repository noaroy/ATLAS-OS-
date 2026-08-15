import type { DiscoveryQuery } from '../discovery/types.ts';

/**
 * Transformer une intention métier en quelques recherches courtes.
 *
 * LIVE #005 a produit une requête unique portant deux rôles, onze mots-clés,
 * cinq secteurs et quatre exclusions. Aucun moteur ne répond à cela, et aucun
 * modèle n'y parvenait non plus : trois tentatives, trois délais dépassés.
 *
 * Un moteur de recherche répond bien à trois ou quatre mots. Le planificateur
 * fabrique donc des requêtes de cette taille : **un angle, un rôle, quelques
 * termes**. Plusieurs recherches courtes qui aboutissent valent mieux qu'une
 * exhaustive qui expire.
 *
 * Entièrement déterministe. Aucun appel au modèle : le brief contient déjà les
 * rôles, le pays et les secteurs — les recombiner est un travail de chaînes de
 * caractères, pas de raisonnement. C'est reproductible, gratuit et instantané.
 */

export interface PlannedQuery {
  /** La requête telle qu'elle partira au moteur. */
  query: string;
  /** Le rôle que cet angle vise en priorité. */
  role: string;
  /** Ce que cet angle cherche à couvrir — lisible dans un rapport. */
  angle: string;
  country: string | null;
  language: string | null;
}

export interface PlannerOptions {
  /** Nombre maximal de requêtes. Quatre suffisent pour deux candidats. */
  maxQueries: number;
}

/**
 * Vocabulaire de recherche par marché.
 *
 * Chercher « distributeur de machines d'emballage » sur le marché allemand
 * rend surtout des pages françaises. Les termes locaux sont ce qui sépare une
 * recherche générique d'une recherche qui trouve les bons acteurs — et ils ne
 * s'inventent pas au moment de la requête.
 */
const MARKET_LANGUAGES: Record<string, { code: string; country: string }> = {
  allemagne: { code: 'de', country: 'DE' },
  germany: { code: 'de', country: 'DE' },
  deutschland: { code: 'de', country: 'DE' },
  autriche: { code: 'de', country: 'AT' },
  suisse: { code: 'de', country: 'CH' },
  france: { code: 'fr', country: 'FR' },
  italie: { code: 'it', country: 'IT' },
  espagne: { code: 'es', country: 'ES' },
  'pays-bas': { code: 'nl', country: 'NL' },
  belgique: { code: 'nl', country: 'BE' },
  pologne: { code: 'pl', country: 'PL' },
  'royaume-uni': { code: 'en', country: 'GB' },
  'états-unis': { code: 'en', country: 'US' },
};

/**
 * Comment nommer un rôle dans la langue du marché.
 *
 * Générique par construction : un département qui déclare un nouveau rôle sans
 * traduction retombe sur son libellé, ce qui donne une recherche moins précise
 * mais jamais fausse.
 */
const ROLE_TERMS: Record<string, Record<string, string[]>> = {
  distributor: {
    de: ['Händler', 'Vertriebspartner'],
    fr: ['distributeur', 'revendeur'],
    en: ['distributor', 'reseller'],
  },
  integrator: {
    de: ['Systemintegrator', 'Anlagenbau'],
    fr: ['intégrateur', 'ensemblier'],
    en: ['system integrator', 'systems integration'],
  },
  supplier: { de: ['Zulieferer'], fr: ['fournisseur'], en: ['supplier'] },
  oem: { de: ['OEM Partner'], fr: ['partenaire OEM'], en: ['OEM partner'] },
  reseller: { de: ['Wiederverkäufer'], fr: ['revendeur'], en: ['reseller'] },
  'commercial-partner': {
    de: ['Vertriebspartner'],
    fr: ['partenaire commercial'],
    en: ['sales partner'],
  },
};

/**
 * Fabrique les recherches à lancer.
 *
 * Une requête par (rôle × angle), dans l'ordre où elles ont le plus de chances
 * d'aboutir : le rôle principal d'abord, l'angle le plus spécifique ensuite.
 * Coupé net à `maxQueries` — chercher plus large ne rend pas les deux meilleurs
 * candidats, cela remplit seulement le contexte.
 */
export function planQueries(query: DiscoveryQuery, options: PlannerOptions): PlannedQuery[] {
  const market = marketFor(query.countries[0] ?? null);
  const roles = query.targetTypes.map((t) => t.key);
  const planned: PlannedQuery[] = [];

  // Les angles : d'abord les mots-clés fournis par le brief, puis les secteurs.
  // Le brief est plus précis qu'une déduction, donc il passe en premier.
  const angles = [...take(query.keywords, 2), ...take(query.industries, 2)];
  if (angles.length === 0) angles.push('');

  for (const role of roles) {
    for (const angle of angles) {
      if (planned.length >= options.maxQueries) break;

      const terms = [
        ...roleTerms(role, market.language).slice(0, 1),
        ...shortWords(angle, 2),
        market.label,
      ].filter(Boolean);

      const text = dedupeWords(terms).join(' ').trim();
      if (!text || planned.some((p) => p.query === text)) continue;

      planned.push({
        query: text,
        role,
        angle: angle || 'général',
        country: market.country,
        language: market.language,
      });
    }
  }

  // Un dernier filet : aucune requête construite (rôles inconnus, brief creux)
  // vaut mieux qu'une requête vide envoyée au moteur.
  if (planned.length === 0 && market.label) {
    planned.push({
      query: `${roles[0] ?? 'partner'} ${market.label}`.trim(),
      role: roles[0] ?? 'partner',
      angle: 'repli',
      country: market.country,
      language: market.language,
    });
  }

  return planned.slice(0, options.maxQueries);
}

/** Le marché : sa langue de recherche, son code pays, son nom local. */
function marketFor(country: string | null): {
  language: string;
  country: string | null;
  label: string;
} {
  if (!country) return { language: 'en', country: null, label: '' };
  const key = country.trim().toLowerCase();
  const known = MARKET_LANGUAGES[key];
  if (!known) return { language: 'en', country: null, label: country.trim() };

  // Le nom local plutôt que le nom français : « Deutschland » trouve des pages
  // allemandes, « Allemagne » trouve des pages qui parlent de l'Allemagne.
  const local: Record<string, string> = {
    DE: 'Deutschland',
    AT: 'Österreich',
    CH: 'Schweiz',
    FR: 'France',
    IT: 'Italia',
    ES: 'España',
    NL: 'Nederland',
    BE: 'België',
    PL: 'Polska',
    GB: 'United Kingdom',
    US: 'United States',
  };
  return {
    language: known.code,
    country: known.country,
    label: local[known.country] ?? country.trim(),
  };
}

function roleTerms(role: string, language: string): string[] {
  const byLanguage = ROLE_TERMS[role];
  if (!byLanguage) return [role.replace(/-/g, ' ')];
  return byLanguage[language] ?? byLanguage.en ?? [role.replace(/-/g, ' ')];
}

const take = (values: string[], n: number): string[] => values.filter(Boolean).slice(0, n);

/**
 * Réduit une expression à ses mots porteurs.
 *
 * « Machines d'emballage industrielles » devient « Machines emballage » : les
 * mots vides et les qualificatifs dilueraient la requête sans la préciser.
 */
function shortWords(text: string, n: number): string[] {
  if (!text) return [];
  const stop = new Set([
    'de',
    'des',
    'du',
    'la',
    'le',
    'les',
    'et',
    'ou',
    'pour',
    'aux',
    'en',
    'a',
    'à',
    'd',
    'l',
    'the',
    'of',
    'and',
    'for',
    'in',
    'die',
    'der',
    'das',
    'und',
    'für',
  ]);
  return text
    .split(/[\s'’,/()-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !stop.has(w.toLowerCase()))
    .slice(0, n);
}

/** Un même mot répété n'ajoute rien et gaspille la longueur utile. */
function dedupeWords(words: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words) {
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}
