import { findGrowthSignals, type GrowthSignalKind } from './growth-signals.ts';
import { isOfficialPage } from './contact-resolver.ts';

/**
 * Aller chercher, sur le site d'un prospect, les deux faits qui manquent.
 *
 * Le lot du 26/08/2026 a qualifié huit entreprises, en a retenu une seule en
 * PRIORITY — Groupe RG, 71,6/100 — et n'a produit aucun brouillon. La garde qui
 * a bloqué exige deux faits constatés et sourcés. Elle a bien fonctionné : il
 * n'y en avait aucun.
 *
 * La cause n'était pas la garde, ni le seuil, ni la profondeur de collecte.
 * Elle était dans ce que le lot faisait des pages qu'il lisait déjà : l'étape
 * « Contacts » récupérait jusqu'à huit pages du site officiel, y cherchait une
 * adresse, puis jetait le HTML. Les seuls faits enregistrés venaient du modèle
 * de qualification, dont la source est un extrait de moteur de recherche —
 * donc hors du domaine officiel, donc rétrogradée en « rapporté » par la garde
 * de provenance. Zéro fait observé, avec les pages sous la main.
 *
 * Ce module lit ces pages. Il ne demande rien à un modèle : un fait rendu par
 * un modèle est plausible, et une phrase plausible dans un courriel réel se
 * paie au premier destinataire qui vérifie. Les motifs cherchés sont ceux de
 * `findGrowthSignals`, déjà éprouvés, déjà testés, déjà responsables d'avoir
 * écarté des pieds de page et des bandeaux de cookies.
 *
 * Deux règles gouvernent la collecte :
 *
 *   · Elle s'arrête dès qu'elle a ce qu'elle est venue chercher. Deux faits de
 *     natures distinctes suffisent à personnaliser un message ; la troisième
 *     page lue après coup ne sert plus qu'à dépenser du temps.
 *   · Un fait vient de la page où il a été lu, et porte son adresse. Une
 *     citation dont on ne sait plus d'où elle vient n'est pas vérifiable, et ce
 *     qui n'est pas vérifiable n'a rien à faire dans un message qui prétend
 *     l'être.
 */

/** Ce qu'une page a livré : la phrase, sa nature, et où la relire. */
export interface SourcedFact {
  kind: GrowthSignalKind;
  claim: string;
  sourceUrl: string;
  /** Le motif qui l'a fait remarquer, pour qu'un humain puisse contester. */
  marker: string;
}

/**
 * Pourquoi la collecte s'est arrêtée.
 *
 * Publié tel quel : « deux faits trouvés » et « plus rien à lire » produisent
 * le même compte de pages et n'ont pas le même sens. Confondre les deux
 * ferait chercher une panne de réseau là où le site n'écrit simplement rien
 * de citable.
 */
export type EnrichmentStop =
  /** Le but est atteint : la collecte s'arrête d'elle-même. */
  | 'ENOUGH_FACTS'
  /** Le plafond de pages est atteint avant le second fait. */
  | 'PAGE_BUDGET_REACHED'
  /** Le site n'a plus de page candidate à lire. */
  | 'NO_MORE_PAGES'
  /** Trop d'adresses tentées pour trop peu de pages : le site est un labyrinthe. */
  | 'FETCH_BUDGET_REACHED'
  /** La montre a parlé avant le plafond de pages. */
  | 'TIME_BUDGET_REACHED'
  /** Aucun site officiel exploitable : rien n'a été tenté. */
  | 'NO_OFFICIAL_SITE';

export interface EnrichmentOutcome {
  facts: SourcedFact[];
  /** `facts.length`, publié séparément parce que c'est la mesure qu'on lit. */
  factsFound: number;
  /**
   * Toutes les pages consultees pour ce prospect : reprises + nouvelles.
   *
   * C'est ce chiffre que le plafond borne, et c'est lui qui repond a « combien
   * de pages ce site a-t-il coute ». Il ne repond pas a « combien l'etape
   * d'enrichissement a-t-elle demande » — les deux ont ete confondus dans un
   * rapport ou « PAGES_VISITED = 0 » decrivait un prospect dont quatre pages
   * avaient bien ete lues, simplement pas par cette etape.
   */
  pagesVisited: number;
  /**
   * Pages deja chargees ailleurs et relues ici sans nouvelle requete.
   *
   * L'etape des contacts lit deja le site ; l'enrichissement commence par ces
   * pages. Elles ont ete consultees, elles n'ont rien coute de plus.
   */
  pagesReused: number;
  /** Pages que cette etape a reellement demandees au reseau. */
  pagesFetchedExtra: number;
  /** Adresses tentées sans succès : un 404 se paie aussi. */
  fetchFailures: number;
  earlyStopReason: EnrichmentStop;
  /** Les adresses consultées, dans l'ordre. */
  visitedUrls: string[];
}

interface PageLike {
  url: string;
  html: string;
}

/**
 * Les pages qui parlent de l'entreprise, dans l'ordre de rendement.
 *
 * L'ordre n'est pas décoratif : la collecte s'arrête au deuxième fait, donc
 * les premières adresses de cette liste décident de ce qu'on lira. « Qui
 * sommes-nous » et « savoir-faire » portent l'ancienneté, l'effectif et les
 * métiers ; « références » et « secteurs » nomment les marchés servis. Les
 * mentions légales n'y figurent pas : elles n'ont jamais rien dit d'un besoin
 * commercial, et `findGrowthSignals` les rejetterait de toute façon.
 */
export const ENRICHMENT_PATHS: readonly string[] = [
  '/a-propos', '/a-propos-de-nous', '/qui-sommes-nous', '/qui-sommes-nous.html',
  '/entreprise', '/notre-entreprise', '/societe', '/presentation', '/notre-histoire',
  '/savoir-faire', '/nos-savoir-faire', '/expertise', '/nos-expertises',
  '/metiers', '/nos-metiers', '/activites', '/nos-activites',
  '/references', '/nos-references', '/realisations', '/nos-realisations',
  '/secteurs', '/nos-secteurs', '/secteurs-d-activite', '/marches', '/nos-marches',
  '/clients', '/nos-clients', '/produits', '/nos-produits', '/services', '/nos-services',
  '/certifications', '/qualite', '/nos-certifications',
  '/actualites', '/actualite', '/news', '/blog',
  '/distributeurs', '/devenir-distributeur', '/partenaires', '/reseau',
  '/export', '/international',
  '/recrutement', '/carrieres', '/nous-rejoindre', '/offres-emploi',
  '/about', '/about-us', '/company', '/our-company',
];

/** Les adresses à lire pour une entreprise, page d'accueil en tête. */
export function enrichmentPagesFor(
  officialWebsite: string | null,
  domain: string | null,
): string[] {
  const base = officialWebsite?.trim() || (domain ? `https://${domain}` : null);
  if (!base) return [];
  let origin: string;
  try {
    origin = new URL(base.startsWith('http') ? base : `https://${base}`).origin;
  } catch {
    return [];
  }
  return [`${origin}/`, ...ENRICHMENT_PATHS.map((path) => `${origin}${path}`)];
}

/**
 * Les liens d'une page qui mènent à une page de présentation.
 *
 * Beaucoup de sites ne suivent aucune convention : la page « savoir-faire »
 * vit en `/fr/notre-metier` ou `/expertise-2`. Suivre les liens coûte une
 * requête et évite de conclure « rien à citer » quand le lien était au menu.
 */
const TELLING_LINK =
  /(a-propos|apropos|qui-sommes|about|entreprise|societe|histoire|savoir-faire|savoirfaire|expertise|metier|activite|reference|realisation|secteur|marche|certification|qualite|actualite|news|produit|service|client|partenaire|distributeur|export|international|recrutement|carriere)/i;

export function enrichmentLinksIn(
  html: string,
  pageUrl: string,
  officialDomain: string,
  max = 8,
): string[] {
  const found = new Set<string>();
  const anchor = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,140}?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null) {
    const href = match[1]!;
    const text = match[2]!.replace(/<[^>]+>/g, ' ');
    if (!TELLING_LINK.test(href) && !TELLING_LINK.test(text)) continue;
    let absolute: string;
    try {
      absolute = new URL(href, pageUrl).href;
    } catch {
      continue;
    }
    if (!absolute.startsWith('https://')) continue;
    if (!isOfficialPage(absolute, officialDomain)) continue;
    found.add(absolute.split('#')[0]!);
    if (found.size >= max) break;
  }
  return [...found];
}

/** Deux citations qui disent la même chose ne font pas deux faits. */
const normalise = (claim: string): string =>
  claim.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export interface EnrichmentInput {
  website: string | null;
  domain: string;
  /** Plafond de pages pour ce domaine, celles déjà lues comprises. */
  maxPages: number;
  /** Combien de faits distincts suffisent. Deux, sauf raison contraire. */
  targetFacts?: number;
  /** Pages déjà récupérées ailleurs : gratuites, on commence par elles. */
  seedPages?: readonly PageLike[];
  /** Instant au-delà duquel on ne lance plus de requête. */
  deadline?: number;
  /** La récupération, injectée : le module se teste alors sans réseau. */
  fetchPages: (
    urls: readonly string[],
    maxPages: number,
  ) => Promise<{ pages: readonly PageLike[]; failures?: readonly { url: string }[] }>;
}

/**
 * Lire jusqu'à deux faits distincts, puis s'arrêter.
 *
 * L'arrêt anticipé est la seule raison pour laquelle on peut se permettre
 * quinze pages : le plafond décrit le pire cas, pas le cas courant. Un site
 * qui dit ce qu'il fait dès sa page d'accueil coûte une page, et le plafond
 * n'aura jamais servi.
 *
 * Les pages déjà en main sont examinées avant toute requête. C'est ce qui rend
 * l'enrichissement souvent gratuit : l'étape des contacts a déjà lu l'accueil
 * et la page « qui sommes-nous », et les faits y sont fréquemment.
 */
export async function collectSourcedFacts(input: EnrichmentInput): Promise<EnrichmentOutcome> {
  const target = input.targetFacts ?? 2;
  const facts: SourcedFact[] = [];
  const kinds = new Set<GrowthSignalKind>();
  const claims = new Set<string>();
  const visited: string[] = [];
  /** Les adresses déjà demandées — celles qu'on ne redemandera pas. */
  const requested = new Set<string>();
  /** Les pages déjà lues, identifiées par l'adresse finale après redirection. */
  const read = new Set<string>();
  let fetched = 0;
  let failures = 0;
  let attempts = 0;

  /**
   * Retenir ce qui est nouveau, et rien d'autre.
   *
   * Deux gardes valent d'être dites. La provenance : un fait n'est accepté que
   * s'il a été lu sur le domaine officiel — la fonction reçoit ses pages d'un
   * appelant, et un appelant peut se tromper de liste. La distinction : deux
   * faits doivent être de natures différentes, sinon « depuis 1976 » et
   * « 40 ans d'expérience » comptent pour deux et n'en font qu'un.
   */
  const harvest = (pages: readonly PageLike[]): void => {
    const official = pages.filter((page) => isOfficialPage(page.url, input.domain));
    for (const signal of findGrowthSignals(official)) {
      if (facts.length >= target) break;
      if (kinds.has(signal.kind)) continue;
      const key = normalise(signal.quote);
      if (key.length === 0 || claims.has(key)) continue;
      kinds.add(signal.kind);
      claims.add(key);
      facts.push({
        kind: signal.kind,
        claim: signal.quote,
        sourceUrl: signal.sourceUrl,
        marker: signal.marker,
      });
    }
  };

  // ── Ce qu'on a déjà lu, avant de lire quoi que ce soit de plus ───────────
  for (const page of input.seedPages ?? []) {
    if (read.has(page.url)) continue;
    read.add(page.url);
    requested.add(page.url);
    visited.push(page.url);
  }
  harvest(input.seedPages ?? []);

  const done = (reason: EnrichmentStop): EnrichmentOutcome => ({
    facts,
    factsFound: facts.length,
    pagesVisited: visited.length,
    pagesReused: visited.length - fetched,
    pagesFetchedExtra: fetched,
    fetchFailures: failures,
    earlyStopReason: reason,
    visitedUrls: visited,
  });

  if (facts.length >= target) return done('ENOUGH_FACTS');

  const queue = enrichmentPagesFor(input.website, input.domain).filter((u) => !requested.has(u));
  if (queue.length === 0 && (input.seedPages ?? []).length === 0) return done('NO_OFFICIAL_SITE');

  /**
   * Combien d'adresses on accepte de tenter pour obtenir ces pages.
   *
   * Une adresse morte ne consomme pas le plafond de pages : elle n'a rien fait
   * lire. Elle coûte pourtant une requête, et la liste de chemins conventionnels
   * en contient une cinquantaine. Sans ce second plafond, un site qui répond 404
   * partout se paierait cinquante requêtes pour zéro page.
   */
  const maxAttempts = input.maxPages * 3;
  let homepageRead = false;

  // Une adresse à la fois, et c'est l'adresse demandée qui est retenue comme
  // tentée — pas celle que le serveur renvoie.
  //
  // La première version marquait l'adresse finale. Sur un site qui redirige
  // `/a-propos`, `/entreprise` et `/presentation` vers `/qui-sommes-nous/`, la
  // file gardait les trois pour éligibles : le même document a été demandé
  // quatorze fois, et le plafond de quinze pages s'est épuisé sur une seule
  // page. Le compteur affichait « 15 pages consultées » — pour une.
  while (facts.length < target) {
    if (visited.length >= input.maxPages) return done('PAGE_BUDGET_REACHED');
    if (attempts >= maxAttempts) return done('FETCH_BUDGET_REACHED');
    if (input.deadline !== undefined && Date.now() >= input.deadline) {
      return done('TIME_BUDGET_REACHED');
    }

    const next = queue.find((u) => !requested.has(u));
    if (next === undefined) return done('NO_MORE_PAGES');
    requested.add(next);
    attempts += 1;

    const outcome = await input.fetchPages([next], 1);
    const page = outcome.pages[0];
    if (!page) {
      failures += 1;
      continue;
    }

    // Une redirection ramène une page déjà lue. La requête a coûté ; la page,
    // elle, n'apporte rien de neuf et ne doit pas consommer le plafond.
    requested.add(page.url);
    if (read.has(page.url)) continue;
    read.add(page.url);
    visited.push(page.url);
    fetched += 1;
    harvest([page]);

    // L'accueil porte les liens vers les pages que les conventions ratent.
    //
    // Ces liens passent devant les chemins restants, et le sens compte : une
    // adresse que le site publie existe, alors qu'un chemin conventionnel est
    // une supposition. Placés en queue de file, ils n'étaient jamais atteints
    // — cinquante suppositions mortes passaient d'abord.
    if (!homepageRead) {
      homepageRead = true;
      const found = enrichmentLinksIn(page.html, page.url, input.domain)
        .filter((link) => !requested.has(link) && !queue.includes(link));
      queue.unshift(...found);
    }
  }

  return done('ENOUGH_FACTS');
}
