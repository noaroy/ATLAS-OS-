import { normaliseDomain } from '../identity.ts';
import type { SearchResult } from './types.ts';

/**
 * Ce qui peut être décidé sans modèle doit l'être sans modèle.
 *
 * Entre le moteur de recherche et Claude, il y a un travail entièrement
 * mécanique : reconnaître qu'un domaine revient trois fois, écarter un
 * annuaire, préférer une page d'accueil à une page produit. Faire porter cela
 * par un modèle coûte cher et n'améliore rien — c'était l'erreur de fond de
 * l'ancienne architecture, où le modèle recevait tout et devait tout trancher.
 *
 * Le filtrage réduit typiquement quinze à vingt résultats bruts à quatre ou six
 * candidats. Claude n'en voit que la sortie.
 */

export interface SearchCandidate {
  /** Le domaine enregistrable, qui sert d'identité. */
  domain: string;
  /** L'URL la plus représentative de cette organisation. */
  primaryUrl: string;
  /** Nom probable, lu dans les titres. Le modèle le confirmera. */
  likelyName: string;
  /** Tous les résultats appartenant à ce domaine — la provenance complète. */
  results: SearchResult[];
  /** Meilleur rang obtenu, tous moteurs confondus. */
  bestRank: number;
  /** Combien de requêtes distinctes ont fait remonter ce domaine. */
  queryHits: number;
}

export interface FilterOptions {
  /** Ce que le brief disqualifie explicitement. */
  exclusions: string[];
  /** Nombre maximal de candidats transmis au modèle. */
  maxCandidates: number;
}

export interface FilterReport {
  candidates: SearchCandidate[];
  /** Combien de résultats bruts sont entrés. */
  seen: number;
  /** Regroupés parce qu'ils partageaient un domaine. */
  grouped: number;
  /** Écartés, avec la raison — un filtre muet est indébogable. */
  rejected: Array<{ url: string; reason: string }>;
}

/**
 * Hôtes qui ne sont jamais un candidat.
 *
 * Un annuaire est une *source*, pas une entreprise à contacter. Les laisser
 * passer ferait apparaître « Europages » en tête d'une shortlist commerciale —
 * ce qui est exactement le genre de résultat qui décrédibilise un livrable.
 */
/**
 * Un hôte de la liste, à sa frontière — jamais en sous-chaîne.
 *
 * `domain.includes('x.com')` écartait « nordix.com », « onyx.com »,
 * « matrix.com » comme un réseau social ; `'reco.se'` écartait « greco.se ».
 * Un motif se terminant par un point (« amazon. ») est un préfixe de label :
 * il vaut pour « amazon.se » et « amazon.co.uk », pas pour « amazonas.se ».
 */
export function isNeverCandidate(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '');
  return NEVER_A_CANDIDATE.some((host) => host.endsWith('.')
    ? d.startsWith(host) || d.includes(`.${host}`)
    : d === host || d.endsWith(`.${host}`));
}

const NEVER_A_CANDIDATE = [
  'wikipedia.org',
  'wikimedia.org',
  'linkedin.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'youtube.com',
  'pinterest.com',
  'amazon.',
  'ebay.',
  'alibaba.com',
  'europages.',
  'kompass.com',
  'wlw.de',
  'industrystock.',
  'exportpages.',
  'yellowpages.',
  'gelbeseiten.de',
  // Suède et voisins : annuaires, registres et comparateurs. eniro.se a été lu
  // et qualifié par le modèle sur le premier lot réel — un annuaire payé.
  'eniro.se',
  'hitta.se',
  'allabolag.se',
  'ratsit.se',
  'bolagsfakta.se',
  'merinfo.se',
  'proff.se',
  'proff.no',
  'proff.dk',
  'gulasidorna.se',
  'foretagsfakta.se',
  'bizzdo.se',
  'kompass.se',
  'wer-liefert-was.',
  'europages.se',
  // Diffuseurs de communiqués : la page parle d'une société, mais n'est pas la sienne.
  // mynewsdesk.com et via.tt.se ont été lus, qualifiés et payés sur un lot réel.
  'mynewsdesk.com',
  'via.tt.se',
  'cision.com',
  'prnewswire.com',
  'businesswire.com',
  'globenewswire.com',
  'newsroom.',
  'pressmachine.',
  'issuu.com',
  'yumpu.com',
  'scribd.com',
  'slideshare.net',
  // Avis, emplois, petites annonces : trustpilot.com et arbetsformedlingen.se
  // ont été lus sur un lot réel — un site d'avis et l'agence pour l'emploi.
  'trustpilot.com',
  'reco.se',
  'yelp.',
  'arbetsformedlingen.se',
  'platsbanken.',
  'blocket.se',
  'tradera.com',
  'indeed.',
  'glassdoor.',
  'stepstone.',
  'xing.com',
  'crunchbase.com',
  'bloomberg.com',
  'reuters.com',
  'researchgate.net',
  'scribd.com',
  'slideshare.net',
  'pdfcoffee.com',
];

/** Chemins qui signalent une page sans intérêt pour identifier une entreprise. */
const LOW_VALUE_PATH = /\/(blog|news|presse|press|karriere|careers|jobs|datenschutz|privacy|impressum|agb|terms|cart|login|search)\b/i;

/**
 * Regroupe, écarte et classe — sans jamais appeler un modèle.
 */
export function filterResults(results: SearchResult[], options: FilterOptions): FilterReport {
  const rejected: FilterReport['rejected'] = [];
  const byDomain = new Map<string, SearchCandidate>();
  let grouped = 0;

  // ── Les exclusions, prises comme des expressions et non comme des sacs de mots
  //
  // Découper « fabricants directs de machines d'emballage » en mots isolés
  // produisait les termes « fabricants », « directs », « machines »,
  // « emballage » — chacun devenant un motif de rejet à lui seul. L'exclusion
  // finissait par écarter tout ce qui parlait du sujet : dix résultats bruts,
  // dix rejets, zéro candidat, pour 0,03 $ de mission. Découper une exclusion
  // en mots en inverse le sens.
  //
  // Une expression longue relève du jugement, pas du filtrage littéral : elle
  // est laissée à l'étape de qualification, où un modèle lit vraiment. Ce
  // filtre-ci reste ce qu'il doit être — grossier, gratuit, et sans opinion.
  const exclusionTerms = options.exclusions
    .map((phrase) => phrase.toLowerCase().trim())
    .filter((phrase) => phrase.length > 3 && phrase.split(/\s+/).length <= 3);

  for (const result of results) {
    const domain = normaliseDomain(result.url);
    if (!domain) {
      // `normaliseDomain` rend `null` dans deux cas très différents : une URL
      // qu'on ne sait pas lire, et un hôte de plateforme — une page LinkedIn
      // identifie une page, pas une organisation. Les confondre rendrait le
      // journal du filtre trompeur.
      rejected.push({
        url: result.url,
        reason: parses(result.url)
          ? 'plateforme ou hôte générique : identifie une page, pas une organisation'
          : 'URL illisible',
      });
      continue;
    }

    if (isNeverCandidate(domain)) {
      rejected.push({ url: result.url, reason: 'annuaire, réseau social ou agrégateur' });
      continue;
    }

    // Les exclusions du brief s'appliquent sur ce que le moteur a rendu — un
    // filtre grossier, assumé : il ne s'agit pas de qualifier, seulement
    // d'éviter de payer un modèle pour lire une évidence.
    const haystack = `${result.title} ${result.snippet}`.toLowerCase();
    const hit = exclusionTerms.find((term) => haystack.includes(term));
    if (hit) {
      rejected.push({ url: result.url, reason: `exclusion du brief : « ${hit} »` });
      continue;
    }

    const existing = byDomain.get(domain);
    if (existing) {
      existing.results.push(result);
      existing.bestRank = Math.min(existing.bestRank, result.rank);
      if (!existing.results.some((r) => r.query === result.query && r !== result)) {
        existing.queryHits = new Set(existing.results.map((r) => r.query)).size;
      }
      // Une page d'accueil identifie mieux une organisation qu'une page profonde.
      if (isBetterPrimary(result.url, existing.primaryUrl)) {
        existing.primaryUrl = result.url;
        existing.likelyName = nameFrom(result.title, existing.likelyName);
      }
      grouped++;
      continue;
    }

    byDomain.set(domain, {
      domain,
      primaryUrl: result.url,
      likelyName: nameFrom(result.title, domain),
      results: [result],
      bestRank: result.rank,
      queryHits: 1,
    });
  }

  // Le classement : d'abord ce que plusieurs requêtes ont trouvé — une
  // corroboration entre angles distincts vaut mieux qu'un premier rang isolé —
  // puis le meilleur rang.
  const candidates = [...byDomain.values()]
    .sort((a, b) => b.queryHits - a.queryHits || a.bestRank - b.bestRank)
    .slice(0, options.maxCandidates);

  return { candidates, seen: results.length, grouped, rejected };
}

/**
 * Les pages à récupérer pour un candidat.
 *
 * La page la plus représentative d'abord, puis une page susceptible de dire ce
 * que l'entreprise fait vraiment. Deux au maximum : on cherche à identifier une
 * organisation, pas à l'auditer.
 */
export function fetchTargetsFor(candidate: SearchCandidate, max: number): string[] {
  if (max <= 0) return [];

  const urls = [candidate.primaryUrl];
  const others = candidate.results
    .map((r) => r.url)
    .filter((url) => url !== candidate.primaryUrl && !LOW_VALUE_PATH.test(url));

  // Une page « produits » ou « partenaires » en dit plus qu'une deuxième page
  // d'accueil localisée.
  const informative = others.find((url) =>
    /\/(produkte|products|solutions|loesungen|lösungen|leistungen|services|partner|vertrieb|unternehmen|about|company)\b/i.test(
      url,
    ),
  );
  if (informative) urls.push(informative);
  else if (others[0]) urls.push(others[0]);

  return [...new Set(urls)].slice(0, max);
}

/** L'URL est-elle simplement lisible ? */
function parses(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** Une racine de site identifie mieux qu'une page profonde. */
function isBetterPrimary(candidate: string, current: string): boolean {
  if (LOW_VALUE_PATH.test(candidate)) return false;
  const depth = (url: string): number => {
    try {
      return new URL(url).pathname.split('/').filter(Boolean).length;
    } catch {
      return 99;
    }
  };
  return depth(candidate) < depth(current);
}

/**
 * Le nom probable, lu dans le titre du résultat.
 *
 * Approximatif et assumé comme tel : les titres portent des séparateurs et des
 * accroches marketing. Le modèle confirmera à partir de la page — ici on ne
 * cherche qu'une étiquette lisible pour le filtrage.
 */
function nameFrom(title: string, fallback: string): string {
  const head = title.split(/[|–—:·]/)[0]?.trim();
  if (head && head.length >= 3 && head.length <= 80) return head;
  return fallback;
}
