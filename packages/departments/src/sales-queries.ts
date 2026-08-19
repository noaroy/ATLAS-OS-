/**
 * Les requêtes de prospection, engendrées par règles.
 *
 * Le premier lot cherchait le besoin directement — « nous recherchons des
 * distributeurs ». C'était la formulation la plus proche de ce qui nous
 * intéresse, et c'est précisément pour cela qu'elle a échoué : elle ramène des
 * pages « devenir revendeur », dont le titre n'est jamais une raison sociale.
 * Sur l'unique résultat obtenu, le pipeline a retenu « Nous recherchons des
 * distributeurs » comme nom d'entreprise.
 *
 * L'ordre est donc inversé. On cherche d'abord des **entreprises** — un métier,
 * un secteur, un pays — et c'est la qualification qui juge ensuite si le besoin
 * existe. Un moteur sait trouver des fabricants ; il ne sait pas trouver des
 * intentions.
 *
 * Les formulations sont **produites par combinaison**, jamais par un modèle.
 * Confier les requêtes à un modèle reviendrait à s'en remettre à son idée du
 * marché plutôt qu'à la nôtre — et à payer pour cela.
 */

/** Les briques dont les requêtes sont assemblées. */
export interface QueryVocabulary {
  /** Ce que fait l'entreprise. */
  activities: string[];
  /** Ce qu'elle produit ou vend. */
  offerings: string[];
  /** Le territoire. */
  regions: string[];
  /**
   * Ce qui oriente vers un site officiel plutôt qu'un annuaire.
   *
   * Les pages « produits », « entreprise » ou « distributeurs » n'existent que
   * sur le site d'une société ; un annuaire n'en a pas.
   */
  siteHints: string[];
}

export const SALES_QUERY_VOCABULARY: QueryVocabulary = {
  activities: [
    'fabricant',
    'constructeur',
    'équipementier',
    'concepteur',
  ],
  offerings: [
    'équipement industriel',
    'machines spéciales',
    'solutions techniques B2B',
    'automatisation industrielle',
    'équipements professionnels',
    'sous-ensembles industriels',
  ],
  regions: ['France', 'français'],
  siteHints: [
    'nos produits',
    'notre entreprise',
    'nos solutions',
    'distributeurs',
    'export',
  ],
};

export interface QueryPlan {
  query: string;
  /** À quelle famille elle appartient — pour lire les résultats par famille. */
  family: string;
  /** Ce qu'elle cherche, en clair. */
  intent: string;
}

/**
 * Compose les requêtes du lot.
 *
 * Trois familles, chacune répondant à une question différente :
 *
 *   `metier`      qui fabrique ce genre de chose, en France ?
 *   `site`        les mêmes, mais sur une page qui n'existe que sur un site
 *                 officiel — « nos produits », « notre entreprise »
 *   `expansion`   ceux qui parlent d'export ou de distribution, en dernier
 *
 * L'ordre compte : les deux premières familles ramènent des entreprises, la
 * troisième ramène des intentions. Placer celle-ci en dernier fait que le lot
 * se remplit d'abord de sociétés réelles, et que le budget de qualification
 * leur revient.
 *
 * Déterministe : mêmes entrées, mêmes requêtes, dans le même ordre. Un lot se
 * rejoue à l'identique, et deux lots se comparent.
 *
 * `wave` fait tourner le vocabulaire. Le lot 005 a découvert pourquoi il le
 * faut : la déduplication inter-lots venait d'être posée, et comme les mêmes
 * deux requêtes partaient à chaque fois, dix-neuf des vingt résultats étaient
 * déjà connus. Un plan figé fonctionne une fois, puis épuise son terrain sans
 * le dire — le lot rend zéro et rien n'indique que la cause est la requête.
 *
 * La rotation reste une règle, pas une improvisation : à `wave` égal, le plan
 * est identique, et deux lots restent comparables.
 */
export function planQueries(
  vocabulary: QueryVocabulary = SALES_QUERY_VOCABULARY,
  limit = 8,
  wave = 0,
): QueryPlan[] {
  const plans: QueryPlan[] = [];
  const activities = rotate(vocabulary.activities, wave);
  const offerings = rotate(vocabulary.offerings, wave);
  const [activity = 'fabricant', ...otherActivities] = activities;
  const region = vocabulary.regions[wave % Math.max(1, vocabulary.regions.length)] ?? 'France';

  // ── Famille « métier » : qui fabrique quoi, et où ────────────────────────
  for (const offering of offerings) {
    plans.push({
      query: `${activity} ${offering} ${region} PME`,
      family: 'metier',
      intent: `entreprises qui produisent : ${offering}`,
    });
  }

  // ── Famille « site » : les mêmes, sur une page d'entreprise ──────────────
  //
  // « nos produits » ou « notre entreprise » ne se trouvent que sur le site
  // d'une société. C'est le filtre le plus efficace contre les annuaires, et il
  // ne coûte rien : il est dans la requête.
  for (const [i, offering] of offerings.entries()) {
    const hint = vocabulary.siteHints[(i + wave) % vocabulary.siteHints.length]!;
    plans.push({
      query: `${activity} ${offering} ${region} "${hint}"`,
      family: 'site',
      intent: `sites officiels : ${offering}, page « ${hint} »`,
    });
  }

  // ── Famille « expansion » : ceux qui s'étendent, en dernier ──────────────
  for (const other of otherActivities.slice(0, 2)) {
    plans.push({
      query: `${other} ${region} export développement commercial distributeurs`,
      family: 'expansion',
      intent: `${other}s en développement export`,
    });
  }

  return plans.slice(0, limit);
}

/** Décale une liste sans la modifier. Rotation, pas mélange : reproductible. */
function rotate<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) return [];
  const shift = ((by % items.length) + items.length) % items.length;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

/**
 * Le résultat pointe-t-il vers un site officiel d'entreprise ?
 *
 * Gratuit, et appliqué avant tout appel : un article de presse, une offre
 * d'emploi ou une fiche d'annuaire coûteraient le même prix à analyser qu'une
 * vraie entreprise, pour un résultat connu d'avance.
 *
 * Le chemin de l'URL suffit le plus souvent. `/actualites/`, `/emploi/`,
 * `/blog/` ou `/article/` désignent du contenu *sur* des entreprises ; une
 * société parle d'elle à la racine, dans `/produits`, `/entreprise`, `/export`.
 */
export function looksLikeCompanySite(url: string): { ok: boolean; reason: string } {
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return { ok: false, reason: 'adresse illisible.' };
  }

  const CONTENT_PATHS = [
    '/actualite', '/actualites', '/news', '/blog', '/article', '/articles',
    '/presse', '/emploi', '/emplois', '/jobs', '/recrutement', '/carriere',
    '/forum', '/annuaire', '/entreprises/', '/societe/', '/fiche',
    '/produit-', '/categorie/', '/search', '/recherche', '/tag/',
  ];
  const hit = CONTENT_PATHS.find((p) => path.startsWith(p) || path.includes(p));
  if (hit) {
    return {
      ok: false,
      reason: `chemin « ${hit} » : contenu *sur* des entreprises, pas le site de l'une d'elles.`,
    };
  }

  // Une page trop profonde est presque toujours un article ou une fiche.
  const depth = path.split('/').filter(Boolean).length;
  if (depth > 4) {
    return { ok: false, reason: `chemin à ${depth} niveaux : trop profond pour une page d'entreprise.` };
  }

  return { ok: true, reason: 'chemin compatible avec un site officiel.' };
}
