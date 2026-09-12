/**
 * Lire un site comme un commercial pressé : l'accueil, puis seulement ce qui
 * manque.
 *
 * Le premier lot suédois réel a coûté 265 requêtes pour 69 pages lues : le
 * pipeline devinait vingt-cinq chemins de contact — français, anglais,
 * allemand — sur des sites qui n'en ont qu'un, et payait un 404 pour chacun,
 * jusqu'à deux secondes et demie pièce. Or l'accueil de chacun de ces sites
 * publiait le lien vers sa vraie page de contact. Ce module lit ce lien.
 *
 * Tout ici est déterministe et gratuit : classer des liens, compter des mots
 * du brief, relever un numéro d'organisation. Ce qui en sort réduit ce qu'on
 * demande au réseau et au modèle — jamais ce qu'on exige des preuves.
 */
import type { ClientBrief } from './client-brief.ts';
import { allCriteria } from './client-brief.ts';
import type { BlockCatalogue } from './verbatim-selection.ts';
import { cleanedText, pageTitle } from './evidence-blocks.ts';
import { swedishPostalAddresses } from './nordic-address.ts';
import type { ResolvedContact } from './contact-resolver.ts';

const aplatir = (s: string): string =>
  s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Le même repli, caractère par caractère : la chaîne rendue a exactement la
 * longueur de l'entrée, si bien qu'un index trouvé dedans désigne le même
 * endroit dans le texte d'origine. « ö » → « o », « é » → « e », un ligature
 * → sa première lettre.
 */
const aplatirAligne = (s: string): string => {
  let out = '';
  for (const c of s) {
    const base = c.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    out += (base.length > 0 ? base[0]! : c).toLowerCase();
  }
  return out;
};

// ─── Les liens d'un site, classés ───────────────────────────────────────────

export type SitePageKind = 'IDENTITY' | 'PRODUCTS' | 'BRANDS' | 'SERVICE' | 'OTHER';

export interface SiteLink {
  url: string;
  text: string;
  kind: SitePageKind;
}

/*
 * Les mots qui, dans un chemin ou un libellé de lien, désignent chaque genre
 * de page. Suédois, anglais, français, allemand : les langues des marchés
 * que le planificateur connaît.
 */
const KINDS: ReadonlyArray<{ kind: SitePageKind; motif: RegExp }> = [
  { kind: 'IDENTITY', motif: /kontakt|contact|om[- ]?oss|about|impressum|imprint|mentions|legal|foretag|företag|company|qui[- ]sommes|a[- ]propos|hitta[- ]oss|besok|besök/i },
  { kind: 'BRANDS', motif: /varumark|varumärk|brands?\b|marques?\b|marken\b|partners?\b|partner\b|leverantor|leverantör|agentur|representer|representerar|fabrikat/i },
  { kind: 'PRODUCTS', motif: /produkt|product|sortiment|maskin|machine|losning|lösning|solution|utrustning|equipment|katalog|catalog|system|tjanst|tjänst|utbud|erbjud|vad[- ]vi[- ]gor|vad[- ]vi[- ]gör|what[- ]we[- ]do|produits|nos[- ]solutions/i },
  { kind: 'SERVICE', motif: /service|underhall|underhåll|installation|kalibrer|calibrat|maintenance|support|reservdel|spare|after[- ]?sales|eftermarknad/i },
];

const HORS_SUJET = /\.(pdf|jpe?g|png|gif|svg|zip|docx?|xlsx?|mp4)(\?|$)|mailto:|tel:|javascript:|#|\/(?:wp-content|wp-json|feed|tag|category|author|login|logga-in|cart|varukorg|checkout|kassa|search|sok|sök)\b|\/(?:en|de|fr|fi|no|da|nb)\/|[?&](?:lang|locale)=|cookie|integritet|privacy|gdpr|nyhet|news|blogg?|press|karriar|karriär|career|jobb|lediga/i;

/**
 * Les liens internes d'une page, classés par ce qu'ils promettent.
 *
 * Un lien vers une autre langue, un PDF, un panier ou une page carrière est
 * écarté : ce n'est pas là qu'une société dit ce qu'elle vend ni où elle est.
 */
export function siteLinks(html: string, pageUrl: string, domain: string): SiteLink[] {
  const out: SiteLink[] = [];
  const vus = new Set<string>();
  const racine = aplatir(domain.replace(/^www\./, ''));
  const anchor = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) !== null) {
    const href = m[1]!.trim();
    const text = cleanedText(m[2]!).replace(/\s+/g, ' ').trim().slice(0, 80);
    let absolute: URL;
    try { absolute = new URL(href, pageUrl); } catch { continue; }
    if (absolute.protocol !== 'https:' && absolute.protocol !== 'http:') continue;
    const hote = aplatir(absolute.hostname.replace(/^www\./, ''));
    if (hote !== racine && !hote.endsWith(`.${racine}`)) continue;
    const chemin = absolute.pathname.replace(/\/+$/, '');
    if (chemin === '' || HORS_SUJET.test(absolute.href)) continue;
    const cle = `${hote}${chemin.toLowerCase()}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    const sujet = `${chemin} ${text}`;
    const kind = KINDS.find((k) => k.motif.test(sujet))?.kind ?? 'OTHER';
    absolute.protocol = 'https:';
    absolute.hash = '';
    out.push({ url: absolute.href, text, kind });
  }
  return out;
}

/** Ce qu'on sait déjà avant de choisir les pages suivantes. */
export interface PagePlanInput {
  links: readonly SiteLink[];
  /** Le pays est-il déjà prouvé sur ce qui a été lu ? */
  countryKnown: boolean;
  /** Combien de termes du brief l'accueil porte déjà. */
  relevanceHits: number;
  /** Le nombre total de pages que ce candidat peut coûter, accueil compris. */
  maxPages: number;
  /** Les chemins d'identité du marché, si les liens n'en donnent aucun. */
  fallbackIdentityPaths: readonly string[];
  origin: string;
}

/**
 * Les pages à lire après l'accueil, dans l'ordre, et pourquoi chacune.
 *
 * Une page d'identité d'abord si le pays n'est pas prouvé ; une page produits
 * ensuite, pour les critères ; marques et service si la place reste. Quand
 * l'accueil porte déjà le pays, l'identité descend d'un rang — et ne
 * disparaît pas, parce que c'est là que vit le courriel. Aucun chemin n'est
 * deviné tant que le site en publie un.
 */
export function planPages(input: PagePlanInput): Array<{ url: string; kind: SitePageKind; why: string }> {
  const budget = Math.max(0, input.maxPages - 1);
  if (budget === 0) return [];
  const par = (kind: SitePageKind) => input.links.filter((l) => l.kind === kind);
  const choix: Array<{ url: string; kind: SitePageKind; why: string }> = [];
  const pris = new Set<string>();
  const prendre = (l: SiteLink | undefined, why: string) => {
    if (!l || pris.has(l.url) || choix.length >= budget) return;
    pris.add(l.url);
    choix.push({ url: l.url, kind: l.kind, why });
  };
  // Le lien « kontakt » avant « om oss » : c'est lui qui porte l'adresse.
  const identite = [...par('IDENTITY')].sort((a, b) => scoreIdentite(b) - scoreIdentite(a));
  const produits = par('PRODUCTS');
  const marques = par('BRANDS');
  const service = par('SERVICE');

  if (!input.countryKnown) prendre(identite[0], 'pays à prouver');
  prendre(produits[0], 'critères produits');
  if (input.countryKnown) prendre(identite[0], 'coordonnées');
  prendre(marques[0], 'marques et partenaires');
  // Un accueil pauvre en termes du brief mérite une seconde page produits
  // avant une page service : c'est là que la pertinence se joue.
  if (input.relevanceHits < 2) prendre(produits[1], 'accueil peu explicite');
  prendre(service[0], 'service');
  prendre(identite[1], 'seconde page d’identité');
  /*
   * Un site dont aucun lien ne se classe — « Priser », « Referenser » — a
   * quand même des pages : deux d'entre elles valent mieux qu'un chemin
   * deviné, et qu'un verdict rendu sur le seul accueil.
   */
  if (choix.length < 2) for (const l of par('OTHER').slice(0, 2)) prendre(l, 'page du site, sans classement');

  if (choix.length === 0 || (!input.countryKnown && identite.length === 0)) {
    for (const chemin of input.fallbackIdentityPaths) {
      if (choix.length >= budget) break;
      const url = `${input.origin}${chemin}`;
      if (pris.has(url)) continue;
      pris.add(url);
      choix.push({ url, kind: 'IDENTITY', why: 'chemin conventionnel du marché' });
    }
  }
  return choix.slice(0, budget);
}

function scoreIdentite(l: SiteLink): number {
  const s = `${l.url} ${l.text}`;
  if (/kontakt|contact/i.test(s)) return 3;
  if (/impressum|mentions|legal/i.test(s)) return 2;
  return 1;
}

// ─── La pertinence, comptée avant de payer ──────────────────────────────────

/*
 * Les mots de rôle, dans les langues du marché : un candidat qui n'en porte
 * aucun, ni aucun mot-clé produit ni secteur, ne dit rien de ce que le brief
 * cherche. Le planificateur en a une table plus riche, mais il vit dans une
 * couche que ce module ne peut pas importer ; celle-ci est volontairement
 * large — un terme de trop coûte un appel modèle, un terme de moins coûte
 * une société.
 */
const ROLE_TERMS = [...new Set([
  'distribut', 'återförsälj', 'reseller', 'revendeur', 'grossist', 'wholesale',
  'leverantör', 'supplier', 'fournisseur', 'agent', 'representant', 'partner',
  'integrat', 'oem', 'fabrikant', 'tillverk', 'manufactur', 'fabricant', 'hersteller', 'händler',
  'vertrieb', 'säljer', 'försäljning', 'vi erbjuder', 'we offer', 'we supply',
  // Repliés une fois pour toutes : « leverantör » et « leverantor » sont le
  // même terme, et comptaient deux fois dans la pertinence.
].map((t) => t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()))];

export interface RelevancePrecheck {
  /** Les termes du brief trouvés, distincts. */
  hits: string[];
  /** Ceux des mots-clés produit, séparément : c'est le signal le plus fort. */
  productHits: string[];
  roleHits: string[];
  industryHits: string[];
  /** Un fragment de page pour chaque terme produit trouvé, relisible. */
  quotes: Array<{ term: string; quote: string; url: string }>;
}

/** Un mot-clé réduit à sa racine : « förpackningsmaskiner » → « förpackningsmaskin ». */
export function stemOf(term: string): string {
  const t = aplatir(term.trim());
  if (t.length <= 5) return t;
  return t.replace(/(?:erna|arna|orna|erne|ers|ars|ing|er|ar|or|en|et|es|s)$/, '');
}

/**
 * Combien de termes du brief ces pages portent — et lesquels, avec un
 * passage pour chacun.
 */
export function relevancePrecheck(
  pages: ReadonlyArray<{ url: string; html: string }>,
  brief: Pick<ClientBrief, 'productKeywords' | 'industries' | 'requiredCriteria' | 'preferredCriteria'>,
): RelevancePrecheck {
  const textes = pages.map((p) => {
    const text = cleanedText(p.html).replace(/\s+/g, ' ');
    return { url: p.url, text, plat: aplatirAligne(text) };
  });
  const chercher = (termes: readonly string[]): Array<{ term: string; quote: string; url: string }> => {
    const out: Array<{ term: string; quote: string; url: string }> = [];
    const vus = new Set<string>();
    for (const terme of termes) {
      const racine = stemOf(terme);
      if (racine.length < 3 || vus.has(racine)) continue;
      vus.add(racine);
      // Un mot entier au début : « maskin » ne se lit pas dans « asmaskin » —
      // mais « påsmaskiner/förpackningsmaskiner » se lit après la barre.
      const motif = new RegExp(`(?<![a-z0-9])${racine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      for (const t of textes) {
        const m = motif.exec(t.plat);
        if (!m) continue;
        out.push({ term: terme, quote: t.text.slice(Math.max(0, m.index - 60), m.index + 100).trim(), url: t.url });
        break;
      }
    }
    return out;
  };
  const produits = chercher(brief.productKeywords);
  const secteurs = chercher(brief.industries);
  // Les indices des critères sont des mots que le client attend sur la page.
  const indices = [...brief.requiredCriteria, ...brief.preferredCriteria]
    .flatMap((c) => (c.hint ?? '').split(/[,;·]/).map((x) => x.trim()).filter((x) => x.length >= 4));
  const indicesTrouves = chercher(indices);
  const roles = chercher(ROLE_TERMS);
  const hits = [...new Set([...produits, ...secteurs, ...indicesTrouves, ...roles].map((x) => x.term))];
  return {
    hits,
    productHits: produits.map((x) => x.term),
    roleHits: roles.map((x) => x.term),
    industryHits: secteurs.map((x) => x.term),
    quotes: [...produits, ...secteurs].slice(0, 6),
  };
}

// ─── Les faits relevés sans modèle ──────────────────────────────────────────

export interface SiteFacts {
  title: string | null;
  orgNr: string | null;
  vat: string | null;
  postalAddress: string | null;
  phones: string[];
  emails: string[];
  /** Les termes du brief vus, pour dire au modèle ce qui est déjà su. */
  briefTermsSeen: string[];
}

/**
 * Ce que les pages établissent sans qu'on ait besoin de les comprendre :
 * identifiant, adresse, coordonnées. C'est ce qui est donné au modèle en
 * tête, pour qu'il interprète au lieu de chercher.
 */
export function extractSiteFacts(
  pages: ReadonlyArray<{ url: string; html: string }>,
  contacts: Pick<ResolvedContact, 'type' | 'value'>[],
  precheck: RelevancePrecheck,
): SiteFacts {
  const texte = pages.map((p) => cleanedText(p.html).replace(/\s+/g, ' ')).join(' \n ');
  const accueil = pages[0] ? pageTitle(pages[0].html) : null;
  const org = /\b(?:organisationsnummer|organisationsnr|org\.?\s?nr\.?|orgnr)\b[^0-9]{0,24}([0-9]{6}-[0-9]{4})\b/i.exec(texte);
  const vat = /\b(SE\s?[0-9]{10}\s?01)\b/.exec(texte);
  const adresse = swedishPostalAddresses(texte)[0];
  return {
    title: accueil,
    orgNr: org?.[1] ?? null,
    vat: vat?.[1]?.replace(/\s+/g, '') ?? null,
    postalAddress: adresse?.extrait ?? null,
    phones: [...new Set(contacts.filter((c) => c.type === 'PHONE').map((c) => c.value))].slice(0, 2),
    emails: [...new Set(contacts.filter((c) => c.type === 'EMAIL').map((c) => c.value))].slice(0, 3),
    briefTermsSeen: precheck.hits.slice(0, 12),
  };
}

// ─── Les passages montrés au modèle ─────────────────────────────────────────

/*
 * Ce qu'un passage ne dit jamais d'utile : cookies, connexion, panier,
 * droits réservés. Les envoyer coûte des jetons et dilue le reste.
 */
// Les mots courts à la frontière du mot : « cart » écartait « carton sealing machines ».
const BRUIT = /cookie|integritet|\bprivacy\b|\bgdpr\b|personuppgift|logga in|\blog in\b|\bsign in\b|varukorg|\bcart\b|\bcheckout\b|\bkassa\b|alla rattigheter|alla rättigheter|all rights reserved|copyright|©|\bjavascript\b|webbplats anvander|webbplatsen anvander|denna webbplats|this website uses|nyhetsbrev|newsletter|prenumerera|\bsubscribe\b|läs mer\s*$|read more\s*$/i;

/**
 * Le catalogue réduit à ce qui peut fonder un critère : les passages qui
 * portent un terme du brief, ceux qui se présentent (« vi är », « we are »,
 * « about »), et le haut de l'accueil. Les numéros sont ceux du catalogue
 * entier : une relecture au numéro trouve exactement le même texte.
 */
export function selectBlocksForModel(
  catalogue: BlockCatalogue,
  brief: Pick<ClientBrief, 'productKeywords' | 'industries' | 'requiredCriteria' | 'preferredCriteria' | 'exclusionCriteria' | 'targetRoles' | 'competitorExclusions'>,
  options: { maxBlocks?: number; headBlocksPerPage?: number } = {},
): { text: string; kept: number; total: number } {
  const max = options.maxBlocks ?? 60;
  const tete = options.headBlocksPerPage ?? 6;
  const termes = [
    ...brief.productKeywords, ...brief.industries, ...brief.competitorExclusions,
    ...allCriteria(brief as ClientBrief).flatMap((c) => (c.hint ?? '').split(/[,;·]/)),
    ...ROLE_TERMS,
  ].map(stemOf).filter((t) => t.length >= 3);
  const presentation = /\b(vi ar|vi är|vi pa|vi på|vart foretag|vårt företag|foretaget|företaget|we are|our company|about us|om oss|nous sommes|notre societe|wir sind|grundades|grundat|founded|sedan 19|sedan 20|since 19|since 20)\b/i;

  const retenus: Array<{ numero: number; url: string; text: string; score: number }> = [];
  const parUrl = new Map<string, number>();
  for (const [numero, ref] of catalogue.index) {
    const bloc = catalogue.blocksByUrl.get(ref.url)?.find((b) => b.id === ref.blockId);
    if (!bloc) continue;
    if (BRUIT.test(bloc.text) && bloc.text.length < 160) continue;
    const plat = aplatir(bloc.text);
    const rang = (parUrl.get(ref.url) ?? 0) + 1;
    parUrl.set(ref.url, rang);
    let score = 0;
    for (const t of termes) if (plat.includes(t)) score += 2;
    if (presentation.test(bloc.text)) score += 2;
    if (rang <= tete) score += 1;
    if (score > 0) retenus.push({ numero, url: ref.url, text: bloc.text, score });
  }
  retenus.sort((a, b) => b.score - a.score || a.numero - b.numero);
  const gardes = retenus.slice(0, max).sort((a, b) => a.numero - b.numero);
  const lignes: string[] = [];
  let urlCourante = '';
  for (const g of gardes) {
    if (g.url !== urlCourante) { lignes.push(`\n## ${g.url}`); urlCourante = g.url; }
    lignes.push(`[${g.numero}] ${g.text}`);
  }
  return { text: lignes.join('\n'), kept: gardes.length, total: catalogue.size };
}

// ─── Le risque « généraliste », mesuré ──────────────────────────────────────

export interface GeneralistRisk {
  /** 0 = spécialiste net, 100 = catalogue tous azimuts. */
  score: number;
  /** Chaque signal, avec ce qui l'a produit. Un score sans signaux ne se lit pas. */
  signals: Array<{ signal: string; detail: string; weight: number }>;
}

const VOCABULAIRE_GENERALISTE = [
  'allt inom', 'allt for', 'allt för', 'brett sortiment', 'bredt sortiment', 'stort sortiment', 'ett av sveriges storsta',
  'ett av sveriges största', 'grossist', 'wholesale', 'one-stop', 'one stop', 'helhetsleverantor', 'helhetsleverantör',
  'over 10 000', 'över 10 000', 'over 20 000', 'över 20 000', 'over 50 000', 'över 50 000', 'tusentals produkter',
  'thousands of products', 'alla typer av', 'all types of', 'webshop', 'webbshop', 'e-handel', 'nathandel', 'näthandel',
  'byggvaror', 'kontorsmaterial', 'hushall', 'hushåll', 'tradgard', 'trädgård', 'fritid', 'presentartiklar',
];

/**
 * Plusieurs signaux, aucun décisif seul : le vocabulaire du catalogue, le
 * nombre de rayons dans la navigation, le nombre de marques, la part des
 * termes du brief dans ce que le site présente, et ce que le modèle a lu.
 * Sert à noter, classer et prioriser la revue. Jamais à écarter.
 */
export function generalistRisk(input: {
  pages: ReadonlyArray<{ url: string; html: string }>;
  links: readonly SiteLink[];
  precheck: RelevancePrecheck;
  modelVerdict: 'SPECIALIST' | 'GENERALIST' | 'TO_CONFIRM';
  modelNote?: string;
}): GeneralistRisk {
  const signals: GeneralistRisk['signals'] = [];
  const texte = aplatir(input.pages.map((p) => cleanedText(p.html)).join(' ').replace(/\s+/g, ' '));

  const vocab = VOCABULAIRE_GENERALISTE.filter((v) => texte.includes(aplatir(v)));
  if (vocab.length > 0) signals.push({ signal: 'vocabulaire de catalogue', detail: vocab.slice(0, 4).join(', '), weight: Math.min(30, 12 * vocab.length) });

  const rayons = input.links.filter((l) => l.kind === 'PRODUCTS').length;
  if (rayons >= 25) signals.push({ signal: 'navigation très large', detail: `${rayons} liens produits`, weight: 25 });
  else if (rayons >= 12) signals.push({ signal: 'navigation large', detail: `${rayons} liens produits`, weight: 12 });

  const marques = (texte.match(/\b(varumarke|varumärke|brands?|marques?)\b/g) ?? []).length;
  if (marques >= 8) signals.push({ signal: 'beaucoup de marques', detail: `${marques} mentions`, weight: 10 });

  if (input.precheck.productHits.length === 0) signals.push({ signal: 'aucun mot-clé produit du brief', detail: 'les pages ne nomment pas le domaine visé', weight: 20 });
  else if (input.precheck.productHits.length >= 2) signals.push({ signal: 'domaine visé nommé', detail: input.precheck.productHits.slice(0, 3).join(', '), weight: -20 });

  if (input.modelVerdict === 'GENERALIST') signals.push({ signal: 'lecture du modèle : généraliste', detail: input.modelNote ?? '', weight: 30 });
  if (input.modelVerdict === 'SPECIALIST') signals.push({ signal: 'lecture du modèle : spécialiste', detail: input.modelNote ?? '', weight: -25 });

  const brut = 30 + signals.reduce((s, x) => s + x.weight, 0);
  return { score: Math.max(0, Math.min(100, Math.round(brut))), signals };
}

// ─── Le classement des contacts ─────────────────────────────────────────────

export type ContactChannelConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export interface RankedContact {
  method: 'EMAIL' | 'FORM' | 'PHONE' | 'NONE';
  value: string | null;
  sourceUrl: string | null;
  intent: string | null;
  confidence: ContactChannelConfidence;
  /** Pour un courriel : porte-t-il le domaine du site ? `null` pour les autres canaux. */
  sameDomain: boolean | null;
  /** Pourquoi ce canal, en un mot lisible dans la fiche. */
  why: string;
  /** Ce qui a été écarté, et pourquoi — un silence ne s'audite pas. */
  rejected: string[];
}

/**
 * Le canal à présenter, dans l'ordre que le client attend : export ou
 * commercial, puis une personne dont la fonction est publiée, puis l'accueil,
 * puis un formulaire, puis un téléphone. Jamais RH, facturation, support,
 * ni une adresse hors du domaine sans le dire.
 */
export function rankContactChannels(input: {
  emails: readonly ResolvedContact[];
  phones: readonly ResolvedContact[];
  form: ResolvedContact | null;
  officialDomain: string;
  personName: string | null;
  personRole: string | null;
}): RankedContact {
  const rejected: string[] = [];
  const domaine = aplatir(input.officialDomain.replace(/^www\./, ''));
  const memeDomaine = (email: string) => {
    const h = aplatir(email.split('@')[1] ?? '');
    return h === domaine || h.endsWith(`.${domaine}`) || domaine.endsWith(`.${h}`);
  };
  const ORDRE: Record<string, number> = { EXPORT: 0, SALES: 1, GENERAL: 3, UNKNOWN: 5 };
  const candidats = [...input.emails]
    .filter((e) => {
      if (e.suitability === 'BLOCKED') { rejected.push(`${e.value} (${e.intent.toLowerCase()})`); return false; }
      if (e.intent === 'PERSONAL') { rejected.push(`${e.value} (personne sans fonction publiée)`); return false; }
      if (e.suitability === 'LOW' && e.intent !== 'UNKNOWN') { rejected.push(`${e.value} (peu adaptée)`); return false; }
      if (ORDRE[e.intent] === undefined) { rejected.push(`${e.value} (${e.intent.toLowerCase()})`); return false; }
      return true;
    })
    // Hors du domaine : derrière toute adresse du domaine — une boîte de groupe
    // n'est pas la porte de cette société, même si elle s'appelle « sales ».
    .map((e) => ({ e, rang: ORDRE[e.intent]! + (memeDomaine(e.value) ? 0 : 4) }))
    .sort((a, b) => a.rang - b.rang);
  const meilleur = candidats[0]?.e;
  if (meilleur) {
    const meme = memeDomaine(meilleur.value);
    const confidence: ContactChannelConfidence = !meme ? 'LOW'
      : meilleur.intent === 'SALES' || meilleur.intent === 'EXPORT' ? 'HIGH'
      : meilleur.intent === 'GENERAL' ? 'MEDIUM' : 'LOW';
    const why = !meme ? 'adresse publiée hors du domaine du site — à vérifier'
      : meilleur.intent === 'EXPORT' ? 'boîte export'
      : meilleur.intent === 'SALES' ? 'boîte commerciale'
      : meilleur.intent === 'GENERAL' ? 'accueil général' : 'boîte sans intention lisible';
    return { method: 'EMAIL', value: meilleur.value, sourceUrl: meilleur.sourceUrl, intent: meilleur.intent, confidence, sameDomain: meme, why, rejected };
  }
  if (input.form) {
    return { method: 'FORM', value: input.form.value, sourceUrl: input.form.sourceUrl, intent: input.form.intent, confidence: 'MEDIUM', sameDomain: null, why: 'formulaire de contact publié', rejected };
  }
  const tel = input.phones[0];
  if (tel) {
    return { method: 'PHONE', value: tel.value, sourceUrl: tel.sourceUrl, intent: tel.intent, confidence: 'LOW', sameDomain: null, why: 'téléphone seul', rejected };
  }
  return { method: 'NONE', value: null, sourceUrl: null, intent: null, confidence: 'NONE', sameDomain: null, why: 'aucune coordonnée commerciale publiée', rejected };
}
