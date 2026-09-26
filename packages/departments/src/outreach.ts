/**
 * Les brouillons d'approche, et ce qui les empêche de mentir.
 *
 * Un message de prospection personnalisé repose sur une phrase : « j'ai vu
 * que… ». Cette phrase est la plus efficace du message, et la seule qui puisse
 * ruiner l'envoi — si ce qu'on prétend avoir vu n'y est pas, le destinataire
 * comprend en dix secondes que la personnalisation est fabriquée, et il a
 * raison de ne plus rien lire.
 *
 * D'où la règle unique de ce module : **un message ne se construit qu'autour
 * d'un fait sourcé**. Pas de fait constaté avec une adresse consultable, pas de
 * message. Le prospect reste dans la liste, sans brouillon, et c'est un
 * meilleur résultat qu'un brouillon plausible.
 *
 * Rien n'est envoyé ici. Ce module produit du texte ; l'envoi est un geste
 * humain, et il le reste.
 *
 * Le ton, la longueur, l'ouverture et la question finale suivent
 * `docs/SALES_HUMANIZATION_POLICY.md` — source de verite unique. Les regles
 * verifiables sont appliquees par `checkHumanization` ; ce fichier ne les
 * recopie pas.
 */

import { greetingFor } from './humanization.ts';
import { readNormalizedClaim } from './verbatim-selection.ts';

/** Le saut de ligne, nomme pour survivre a tout outillage de patch. */
const SAUT = String.fromCharCode(10);

export interface OutreachFact {
  /** L'identifiant de la preuve, pour remonter à la source. */
  evidenceId: string;
  /** Ce qui a été constaté, tel quel. */
  claim: string;
  /** L'adresse où c'est lisible. Obligatoire — c'est ce qui fait la différence. */
  sourceUrl: string;
  nature: 'observed' | 'reported' | 'inferred';
  /**
   * La citation a-t-elle été relue à sa source, mot pour mot ?
   *
   * Vrai pour une preuve du pipeline verbatim : le modèle a rendu un numéro de
   * passage, et le texte a été relu à ce numéro. Faux pour une reformulation de
   * la qualification, même marquée « observed » — c'est le modèle qui l'a dite
   * observée, personne ne l'a relue.
   *
   * Seule une citation relue peut parler au client.
   */
  verbatim?: boolean;
  /**
   * Ce que le modèle a compris du passage. USAGE INTERNE SEULEMENT.
   *
   * Sert à classer, à noter, à comprendre. Ne sert JAMAIS à formuler une
   * affirmation dans un message : sur asytec.fr, « la soudure TIG incarne
   * l'apogée de la technique dans la production des capots de véhicules » est
   * devenu « ASYTEC produit des capots de véhicules » — plausible, non prouvé,
   * et le message l'aurait affirmé. Ce qui part au client vient de `claim`.
   */
  normalizedClaim?: string | null;
}

/** Une preuve telle qu'elle est rangée en base. */
export interface StoredEvidence {
  id: string;
  field: string;
  claim: string;
  sourceUrl: string | null;
  nature: 'observed' | 'reported' | 'inferred';
  basis?: string | null;
}

/**
 * Cette preuve peut-elle porter un message commercial ?
 *
 * Une raison sociale ne dit pas ce qu'une entreprise vend, et une adresse
 * encore moins. Sur igus.fr le seul élément vérifié à 100 % était
 * `identite:entite_juridique` = « IGUS SAS » : le courriel aurait annoncé
 * « j'ai relevé ceci sur votre site : IGUS SAS ».
 *
 * La règle vivait en quatre exemplaires — audit, éligibilité, vue
 * d'approbation, et le lot. Elle vit ici, et les quatre l'appellent.
 */
export function isCommercialEvidence(e: { field: string }): boolean {
  return !e.field.startsWith('identite:') && !e.field.startsWith('contact');
}

/**
 * Une preuve stockée, telle que le générateur doit la recevoir.
 *
 * L'interprétation est écrite dans `basis`, préfixée, au moment de
 * l'enrichissement verbatim — et elle n'était relue nulle part. Le lot
 * reconstruisait ses faits sans elle, le compositeur ne trouvait aucune
 * observation lisible, et refusait chaque brouillon. La donnée était là,
 * personne ne la lisait.
 *
 * Un seul lecteur, ici, pour tous les chemins : `readNormalizedClaim`. Un
 * second analyseur finirait par diverger du premier, et ce serait celui qui
 * écrit les messages.
 */
export function outreachFactFrom(e: StoredEvidence): OutreachFact {
  const interpretation = readNormalizedClaim(e.basis);
  return {
    evidenceId: e.id,
    claim: e.claim,
    sourceUrl: e.sourceUrl ?? '',
    nature: e.nature,
    // Seul le pipeline verbatim relit la citation à sa source. Le champ le dit.
    verbatim: e.field.startsWith('verbatim:'),
    ...(interpretation === null ? {} : { normalizedClaim: interpretation }),
  };
}

export interface OutreachContact {
  name: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  contactPage: string | null;
  sourceUrl: string | null;
  confidence: number;
  /** Vrai quand une personne est nommée, faux pour un standard. */
  named: boolean;
}

export interface OutreachDraft {
  company: string;
  website: string | null;
  whyThisCompany: string;
  /** Le fait sur lequel repose la personnalisation. Jamais absent. */
  personalizationFact: OutreachFact;
  contact: OutreachContact | null;
  messageShort: string;
  messageEmail: string;
  /** L'objet, court et tire du contexte reel. */
  subject: string;
  /** L'adresse citée, répétée ici pour que la relecture l'ait sous les yeux. */
  sourceUsedForPersonalization: string;
  /** L'extrait exact de la source sur lequel repose la phrase d'ouverture. */
  evidenceExcerpt: string;
  /** La phrase d'ouverture telle que le client la lira. Dérivée de l'extrait, jamais de l'interprétation. */
  customerFacingObservation: string;
  /** L'échantillon d'entreprises cibles montré dans le message, s'il en a un. */
  recommendations: TargetRecommendation[];
}

/**
 * Une entreprise cible proposée en échantillon dans un premier contact.
 *
 * La raison d'adéquation n'est pas écrite par un modèle : c'est un morceau
 * contigu d'une citation stockée (`evidenceQuote`), lisible à `sourceUrl`.
 * Une raison qu'aucune citation ne porte est une intention inventée.
 */
export interface TargetRecommendation {
  company: string;
  domain: string;
  fitReason: string;
  sourceUrl: string;
  evidenceQuote: string;
}

export const MIN_RECOMMENDATIONS = 2;
export const MAX_RECOMMENDATIONS = 3;

export interface RecommendationCheck {
  ok: boolean;
  /** Les 2 à 3 recommandations retenues, uniques par domaine, dans l'ordre reçu. */
  accepted: TargetRecommendation[];
  reason: string;
}

/**
 * L'échantillon est-il montrable ? Fermé par défaut : une seule recommandation
 * sans source, sans citation ou dont la raison dépasse la citation fait
 * refuser tout l'échantillon — on ne trie pas le vrai du faux dans un message.
 */
export function validateRecommendations(
  recs: readonly TargetRecommendation[],
  ownDomain: string | null,
): RecommendationCheck {
  const refuse = (reason: string): RecommendationCheck => ({ ok: false, accepted: [], reason });
  const own = (ownDomain ?? '').trim().toLowerCase().replace(/^www\./, '');
  const seen = new Set<string>();
  const accepted: TargetRecommendation[] = [];
  for (const r of recs) {
    const domain = r.domain.trim().toLowerCase().replace(/^www\./, '');
    if (!r.company.trim() || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return refuse(`recommandation sans entreprise ou domaine valide (${r.domain})`);
    let url: URL;
    try { url = new URL(r.sourceUrl); } catch { return refuse(`provenance illisible pour ${domain}`); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return refuse(`provenance non web pour ${domain}`);
    const reason = normaliseEspaces(r.fitReason);
    if (compteMots(reason) < 3) return refuse(`raison d’adéquation vide ou trop courte pour ${domain}`);
    if (!normaliseEspaces(r.evidenceQuote).toLowerCase().includes(reason.toLowerCase())) {
      return refuse(`raison non portée par la citation stockée pour ${domain} : intention non sourcée`);
    }
    if (domain === own || seen.has(domain)) continue;
    seen.add(domain);
    if (accepted.length < MAX_RECOMMENDATIONS) accepted.push({ ...r, domain, fitReason: reason });
  }
  if (accepted.length < MIN_RECOMMENDATIONS) {
    return refuse(`${accepted.length} recommandation(s) unique(s) : il en faut au moins ${MIN_RECOMMENDATIONS}`);
  }
  return { ok: true, accepted, reason: `${accepted.length} recommandations sourcées` };
}

export type OutreachRefusal =
  /** Aucun fait constaté et sourcé : impossible de personnaliser honnêtement. */
  | 'NO_SOURCED_FACT'
  /** L'entreprise n'a pas de nom exploitable. */
  | 'NO_COMPANY'
  /** L'échantillon demandé n'a pas 2 à 3 recommandations sourcées. */
  | 'INSUFFICIENT_RECOMMENDATIONS';

export interface OutreachOutcome {
  draft: OutreachDraft | null;
  refusal: OutreachRefusal | null;
  reason: string;
}

/**
 * Le fait sur lequel bâtir la personnalisation.
 *
 * Choisi, jamais résumé : le message citera ce que la source dit, pas une
 * paraphrase qui pourrait glisser. Priorité aux constats — une déduction, si
 * juste soit-elle, n'est pas quelque chose qu'on « a vu ».
 */
export function pickPersonalizationFact(facts: readonly OutreachFact[]): OutreachFact | null {
  const usable = facts.filter((f) => f.nature !== 'inferred' && f.sourceUrl.trim().length > 0);
  if (usable.length === 0) return null;

  /*
   * Le fait le plus VENDEUR, pas le plus long.
   *
   * Le tri par longueur a fait ecrire a K2TEC « A l'origine, K2TEC est d'abord
   * specialise dans la fabrication de filtres… » -- un paragraphe d'histoire --
   * alors que la meme page publiait « Nous sommes a la recherche de
   * distributeurs ! ». Le second est le signal d'achat ; le premier est du
   * decor.
   */
  const signalDachat = (f: OutreachFact): number =>
    /recherch|cherch|recrut|devenir (?:distributeur|revendeur|partenaire)|rejoign/i
      .test(`${f.normalizedClaim ?? ''} ${f.claim}`) ? 1 : 0;
  // L'interprétation sert ici, à classer. C'est son seul usage dans ce fichier.
  const relu = (f: OutreachFact): number => (f.verbatim ? 1 : 0);

  const classes = [...usable].sort((a, b) =>
    signalDachat(b) - signalDachat(a)
    || relu(b) - relu(a)
    || b.claim.length - a.claim.length);

  /*
   * Le meilleur candidat SÛR, pas le meilleur candidat.
   *
   * Le classement et le compositeur ne se parlaient pas. Sur asytec.fr, une
   * ancienne reformulation — « Asytec s'adresse à des entreprises **cherch**ant
   * un sous-traitant » — gagnait sur le signal d'achat alors qu'elle n'a jamais
   * été relue à sa source ; le compositeur refusait ensuite, et huit citations
   * parfaitement utilisables partaient avec le dossier.
   *
   * L'ordre ne change pas. On descend la liste jusqu'au premier fait dont une
   * phrase client peut s'écrire à partir de ses mots exacts.
   */
  const sur = classes.find((f) => customerFacingObservation(f).outreachSafe);
  if (sur) return sur;

  /*
   * Aucun n'est composable : on rend quand même le mieux classé, pour que le
   * refus vienne du compositeur et garde son motif. Deux refus différents pour
   * la même cause rendraient le journal illisible.
   */
  return classes[0]!;
}

/**
 * Compose les deux brouillons.
 *
 * Le ton est délibérément sobre. Un message de prospection qui en fait trop se
 * reconnaît immédiatement, et notre argument est précisément l'inverse :
 * chaque affirmation est vérifiable. Le message doit ressembler à ce qu'il
 * vend.
 *
 * Aucun superlatif, aucune promesse de résultat, aucune urgence fabriquée. Le
 * prix et le délai sont dits, la sortie est offerte.
 */
/** La page d'où vient le fait, nommée comme un humain la nommerait. */
export function pageLabel(sourceUrl: string): string {
  let chemin = '';
  try { chemin = new URL(sourceUrl).pathname.toLowerCase(); } catch { chemin = sourceUrl.toLowerCase(); }
  if (/distributeur|revendeur|partenaire|reseau/.test(chemin)) return 'page distributeurs';
  if (/contact/.test(chemin)) return 'page contact';
  if (/propos|qui-sommes|about|entreprise|societe/.test(chemin)) return 'page de présentation';
  if (/produit|gamme|catalogue|solution/.test(chemin)) return 'catalogue';
  return 'site';
}

/**
 * Ce que le fait établit, tourné pour s'insérer après « J'ai vu sur votre X ».
 *
 * L'interprétation d'abord : c'est une phrase française, faite pour être lue.
 * À défaut, la citation, réduite à sa première phrase — un paragraphe entier
 * recopié se lit comme une machine.
 */
/**
 * Ce que le prospect a réellement écrit, et ce qu'on a le droit d'en dire.
 *
 * Deux textes vivent dans un fait. `claim` est la phrase publiée, relue à sa
 * source. `normalizedClaim` est ce que le modèle en a compris — utile pour
 * classer, jamais pour parler au client. Sur asytec.fr la page dit que la
 * soudure TIG « incarne l'apogée de la technique dans la production des capots
 * de véhicules » ; le modèle en a tiré « ASYTEC produit des capots de
 * véhicules ». La source ne le dit pas. Le message l'aurait affirmé.
 *
 * Ce qui part au client vient donc de `claim`, et de lui seul : la première
 * phrase, contiguë, telle quelle, dans un habillage déterministe. Aucun modèle
 * n'intervient ici, et aucun second modèle ne « vérifie » le premier : la
 * sûreté est une propriété du texte, pas une opinion.
 */
export interface CustomerFacingObservation {
  /** L'extrait exact, contigu, tel qu'il figure dans la source. */
  excerpt: string;
  /** La phrase prête à suivre « J'ai vu sur votre page X ». Vide si non sûre. */
  observation: string;
  /** Vrai seulement quand l'extrait est une phrase lisible, relue à sa source. */
  outreachSafe: boolean;
  /** Pourquoi ce fait ne peut pas parler au client. */
  reason: string | null;
}

/** Les bornes d'un extrait citable : assez pour une phrase, pas un paragraphe. */
const EXTRAIT_MIN_MOTS = 5;
const EXTRAIT_MAX_MOTS = 30;

/**
 * Les mots qui signalent une proposition complète.
 *
 * Un titre de catalogue — « INJECTION PLASTIQUE SOUS-TRAITANCE MÉTAL »,
 * « Distribution de colis, consigne de matériels informatiques » — n'en
 * contient aucun. Liste explicite, testée : un pronom, une copule, ou un
 * verbe CONJUGUÉ du discours commercial. Des formes entières, jamais des
 * racines — « distribu… » attrapait le nom « distribution », et le fragment
 * passait pour une phrase. Ce n'est pas une grammaire, c'est une porte.
 */
const MARQUE_DE_PROPOSITION = new RegExp(
  '\\b(?:nous|vous|notre|nos|votre|vos|je|on|il|elle|ils|elles'
  + '|est|sont|sommes|êtes|a|ont|avons|avez'
  + '|propose|proposons|fabrique|fabriquons|recherche|recherchons|cherche|cherchons'
  + '|dispose|disposons|assure|assurons|r[ée]alise|r[ée]alisons|con[çc]oit|concevons'
  + '|d[ée]veloppe|d[ée]veloppons|accompagne|accompagnons|int[èe]gre|int[ée]grons'
  + '|offre|offrons|livre|livrons|vend|vendons|distribue|distribuons|exporte|exportons'
  + '|produisons|garantit|garantissons|ma[îi]trise|ma[îi]trisons|permet|permettent'
  + '|r[ée]pond|r[ée]pondons|utilise|utilisons|travaille|travaillons|installe|installons'
  + '|recrute|recrutons|incarne|d[ée]couvrez|retrouvez|contactez|devenez|rejoignez|souhaitez)\\b',
  'i',
);

const compteMots = (t: string): number => t.trim().split(/\s+/).filter(Boolean).length;

/** Espace avant virgule, doubles espaces : le nettoyage qui ne change aucun mot. */
function normaliseEspaces(t: string): string {
  return t.replace(/\s+/g, ' ').replace(/\s+([,;:!?.])/g, '$1').trim();
}

/** La première phrase, coupée à la ponctuation forte, sans point final ni guillemets. */
function premierePhrase(t: string): string {
  const phrases = normaliseEspaces(t).split(/(?<=[.!?…])\s+/);
  return (phrases[0] ?? '')
    .replace(/[.!?…\s]+$/, '')
    .replace(/^[«"“\s]+|[»"”\s]+$/g, '')
    .trim();
}

/**
 * Un titre collé à son paragraphe.
 *
 * Relevé sur asytec.fr : « La Soudure TIG sur Inox La soudure TIG sur inox,
 * alliée à… » — le titre de section et la première phrase, sans séparateur.
 * Une phrase qui commence en répétant ses propres premiers mots n'en est pas
 * une.
 */
function commenceEnSeRepetant(t: string): boolean {
  const m = t.toLowerCase().replace(/[,;:]/g, '').split(/\s+/);
  if (m.length < 6) return false;
  const tete = m.slice(0, 3).join(' ');
  return m.slice(1).join(' ').includes(tete);
}

function ratioMajuscules(t: string): number {
  const lettres = t.replace(/[^\p{L}]/gu, '');
  if (lettres.length === 0) return 0;
  return lettres.replace(/[^\p{Lu}]/gu, '').length / lettres.length;
}

/**
 * Les habillages autorisés : la source dit « nous », le message dit « vous ».
 *
 * Chaque motif exige le début exact de la phrase et ne touche qu'au verbe
 * conjugué ; le complément passe tel quel. « Nous sommes à la recherche de
 * distributeurs ! » devient « vous indiquez être à la recherche de
 * distributeurs » — le sens porteur est dans leurs mots, pas dans les nôtres.
 *
 * Quatre tournures, pas une de plus. Au-delà on écrirait une grammaire, et une
 * grammaire finit toujours par inventer. Tout le reste est cité entre
 * guillemets.
 */
const HABILLAGES: ReadonlyArray<{ motif: RegExp; tournure: (reste: string) => string }> = [
  { motif: /^nous sommes (à la recherche d(?:e |[’']).+)$/i, tournure: (r) => `vous indiquez être ${r}` },
  { motif: /^nous recherchons (.+)$/i, tournure: (r) => `vous indiquez rechercher ${r}` },
  { motif: /^nous cherchons (.+)$/i, tournure: (r) => `vous indiquez chercher ${r}` },
  { motif: /^nous recrutons (.+)$/i, tournure: (r) => `vous indiquez recruter ${r}` },
];

/**
 * « que » ou « qu’ », selon ce qui suit.
 *
 * « que ASYTEC produit… » : le générateur écrivait cela, et un lecteur
 * français le voit à la première ligne. La règle est mécanique — voyelle ou h
 * initial — et s'arrête là : le h aspiré n'est pas traité, il est rare dans
 * les raisons sociales et le deviner coûterait un dictionnaire. La casse du
 * mot suivant n'est jamais touchée.
 */
const VOYELLE_OU_H = /^[aàâäeéèêëiîïoôöuùûüyh]/i;

export function elide(suite: string): string {
  return VOYELLE_OU_H.test(suite) ? `qu’${suite}` : `que ${suite}`;
}

/**
 * L'observation que le client lira, ou la raison de son absence.
 *
 * Cinq portes, toutes déterministes, toutes venues d'un cas réel : la citation
 * doit avoir été relue à sa source ; l'extrait doit faire une phrase et non un
 * titre ni un paragraphe ; il ne doit pas être en capitales ; il ne doit pas
 * commencer par se répéter ; il doit contenir une proposition. Le premier refus
 * l'emporte, et il est nommé.
 */
export function customerFacingObservation(
  fact: { claim: string; verbatim?: boolean },
): CustomerFacingObservation {
  const excerpt = premierePhrase(fact.claim);
  const refus = (reason: string): CustomerFacingObservation =>
    ({ excerpt, observation: '', outreachSafe: false, reason });

  if (!fact.verbatim) return refus('citation non relue à sa source : une reformulation, pas une preuve');
  const n = compteMots(excerpt);
  if (n < EXTRAIT_MIN_MOTS) return refus(`extrait trop court (${n} mots) : un titre, pas une phrase`);
  if (n > EXTRAIT_MAX_MOTS) return refus(`extrait trop long (${n} mots) : un paragraphe, pas une phrase`);
  if (ratioMajuscules(excerpt) >= 0.5) return refus('extrait en capitales : un titre de catalogue');
  if (commenceEnSeRepetant(excerpt)) return refus('titre de section collé à son paragraphe');
  if (!MARQUE_DE_PROPOSITION.test(excerpt)) return refus('aucune proposition complète : un fragment');

  for (const h of HABILLAGES) {
    const m = h.motif.exec(excerpt);
    if (m) return { excerpt, observation: `${elide(h.tournure(m[1]!))}.`, outreachSafe: true, reason: null };
  }
  return { excerpt, observation: `${elide(`vous écrivez « ${excerpt} »`)}.`, outreachSafe: true, reason: null };
}

/** La phrase client, ou `null` quand le fait ne peut pas parler au client. */
export function observationPhrase(fact: { claim: string; verbatim?: boolean }): string | null {
  const o = customerFacingObservation(fact);
  return o.outreachSafe ? o.observation : null;
}

/**
 * L'entreprise dit-elle chercher quelqu'un ?
 *
 * Décidé sur leurs mots et sur leur adresse — « /devenir-distributeur » est
 * une page qu'ils ont publiée pour recruter. Jamais sur l'interprétation.
 */
export function saysTheyAreLooking(excerpt: string, sourceUrl: string): boolean {
  if (/recherch|cherch|recrut|rejoign|devenir (?:distributeur|revendeur|partenaire)/i.test(excerpt)) return true;
  let chemin = '';
  try { chemin = new URL(sourceUrl).pathname.toLowerCase(); } catch { chemin = sourceUrl.toLowerCase(); }
  return /devenir|recrut|rejoign/.test(chemin);
}

/**
 * Le mot qui désigne ce qu'ils cherchent, tiré de ce qu'ils publient.
 *
 * Ne jamais promettre un type de cible que la source ne soutient pas :
 * annoncer des « distributeurs » à qui cherche des clients finaux est une
 * promesse creuse, et elle se voit à la première réponse. L'adresse de la page
 * compte aussi : elle est publiée par eux.
 */
export function targetWord(source: { excerpt: string; sourceUrl: string }): string {
  let chemin = '';
  try { chemin = new URL(source.sourceUrl).pathname.toLowerCase(); } catch { chemin = source.sourceUrl.toLowerCase(); }
  const t = `${source.excerpt} ${chemin}`.toLowerCase();
  if (/distributeur|distribu/.test(t)) return 'distributeurs';
  if (/revendeur/.test(t)) return 'revendeurs';
  if (/intégrateur|integrateur/.test(t)) return 'intégrateurs';
  if (/partenaire/.test(t)) return 'partenaires';
  if (/sous-trait/.test(t)) return 'donneurs d’ordres';
  return 'clients potentiels';
}

/**
 * La question finale, liée au contexte.
 *
 * Une seule, simple, et qui donne une raison de répondre. Elle ne présuppose
 * rien que la source n'établisse : « vous cherchez surtout des distributeurs
 * spécialisés… » n'est posée qu'à qui dit en chercher. Jamais « n'hésitez pas
 * à me contacter », jamais la porte de sortie comme seul appel.
 */
export function closingQuestion(
  excerpt: string,
  cible: string,
  chercheDeja: boolean,
): string {
  const t = excerpt.toLowerCase();
  if (/export|international|étranger|etranger|monde|pays/.test(t)) {
    return 'Vous ciblez plutôt la France ou l’export en ce moment ?';
  }
  if (/région|region|département|departement|local|proximité/.test(t)) {
    return 'Il y a une zone que vous souhaitez développer en priorité ?';
  }
  if (chercheDeja) return `Vous cherchez surtout des ${cible} spécialisés ou plus généralistes ?`;
  return 'Est-ce le genre de recherche qui pourrait vous être utile en ce moment ?';
}

/**
 * L'objet : court, humain, tiré du contexte — et jamais d'une interprétation.
 *
 * « Recherche de distributeurs » n'est écrit qu'à qui publie chercher des
 * distributeurs. Le suffixe « — étude de prospection B2B » a été retiré : il
 * transformait chaque objet en étiquette de campagne.
 */
export function subjectLine(
  company: string,
  cible: string,
  chercheDeja: boolean,
): string {
  const Cible = cible.charAt(0).toUpperCase() + cible.slice(1);
  if (chercheDeja) return `Recherche de ${cible}`;
  const avecNom = `${Cible} pour ${company}`;
  // 45 et non 60 : « Clients potentiels pour Fabricant Distributeur Automatique »
  // tient en 56 caracteres et ne se lit pas comme un objet ecrit par quelqu'un.
  return avecNom.length <= 45 ? avecNom : Cible;
}

export function buildOutreachDraft(input: {
  company: string;
  website: string | null;
  facts: readonly OutreachFact[];
  contact: OutreachContact | null;
  whyThisCompany: string;
  /**
   * Le nom qui signe. Absent, le message s'arrête sur la formule de politesse.
   *
   * Vide par défaut à dessein : un courriel non signé se remarque, mais un nom
   * inventé se remarque bien davantage. La valeur vient de la configuration du
   * déploiement, jamais d'ici.
   */
  senderName?: string;
  /** L'offre, pour que le texte reste cohérent si le prix change. */
  offer: {
    priceEur: number;
    deliveryHours: number;
    /**
     * Le nombre de prospects offerts avant tout paiement.
     *
     * C'est l'argument central de l'offre actuelle : le destinataire juge sur
     * piece avant de sortir un euro. Optionnel pour ne pas casser les appels
     * anterieurs, qui gardent alors la formulation d'origine.
     */
    freePreviewCount?: number;
    /** Une prestation recurrente est possible, chiffree sur le volume reel. */
    recurringAvailable?: boolean;
  };
  /**
   * L'échantillon de cibles à montrer. Absent : message d'origine. Présent :
   * 2 à 3 recommandations valides, sinon aucun brouillon.
   */
  recommendations?: readonly TargetRecommendation[];
}): OutreachOutcome {
  if (!input.company.trim()) {
    return { draft: null, refusal: 'NO_COMPANY', reason: 'aucun nom d’entreprise.' };
  }
  const sample = input.recommendations === undefined
    ? null
    : validateRecommendations(input.recommendations, input.website?.replace(/^https?:\/\//i, '').split('/')[0] ?? null);
  if (sample && !sample.ok) {
    return { draft: null, refusal: 'INSUFFICIENT_RECOMMENDATIONS', reason: sample.reason };
  }

  const fact = pickPersonalizationFact(input.facts);
  if (!fact) {
    return {
      draft: null,
      refusal: 'NO_SOURCED_FACT',
      reason:
        'aucun fait constaté et sourcé : une personnalisation inventée se repère en dix ' +
        'secondes et disqualifie le reste du message.',
    };
  }

  /*
   * La salutation suit la politique, pas la simple presence d'un nom.
   *
   * `named` disait seulement qu'une personne etait nommee quelque part. Cinq
   * conditions decident vraiment, dont la coherence entre la personne et
   * l'adresse : Pascal Sartori est dirigeant de K2TEC, mais l'adresse retenue
   * est `contact@k2tec.com`, un guichet partage.
   */
  const greeting = greetingFor(
    input.contact
      ? {
          name: input.contact.name,
          role: input.contact.role,
          observed: input.contact.named,
          email: input.contact.email,
        }
      : null,
  );

  const sender = input.senderName?.trim() ?? '';
  const freeCount = input.offer.freePreviewCount ?? 3;

  /*
   * L'observation, dans leurs mots.
   *
   * Tout ce que le client lira sur lui-même vient de l'extrait exact de la
   * source — l'objet, la cible, la question finale compris. L'interprétation
   * du modèle n'entre pas ici. Si aucun fait ne peut être cité tel quel, il
   * n'y a pas de brouillon : un dossier ne se sauve pas avec une phrase que
   * la source ne soutient pas.
   */
  const cf = customerFacingObservation(fact);
  if (!cf.outreachSafe) {
    return {
      draft: null,
      refusal: 'NO_SOURCED_FACT',
      reason: `aucun fait ne peut être cité au client tel qu’il est publié : ${cf.reason}`,
    };
  }
  const observation = cf.observation;
  const label = pageLabel(fact.sourceUrl);
  const chercheDeja = saysTheyAreLooking(cf.excerpt, fact.sourceUrl);
  const cible = targetWord({ excerpt: cf.excerpt, sourceUrl: fact.sourceUrl });

  const quoiJeFais = chercheDeja
    ? `Je travaille justement sur ce type de recherche : j'identifie des entreprises `
      + `correspondant à un profil précis et je vérifie chacune avant de vous la proposer.`
    : `Je recherche des ${cible} pour des fabricants et des équipementiers : j'identifie `
      + `des entreprises correspondant au profil visé et je vérifie chacune avant de vous `
      + `la proposer.`;

  const apercu = `Je peux vous en préparer ${freeCount} gratuitement, simplement pour que `
    + `vous jugiez si le résultat est pertinent.`;

  // L'échantillon : leurs mots, leur adresse. Rien qui ne soit dans la citation.
  const echantillon = sample
    ? ['', `Pour exemple, ${sample.accepted.length} entreprises relevées :`,
      ...sample.accepted.map((r) => `- ${r.company} (${r.domain}) : « ${r.fitReason} » — ${r.sourceUrl}`)]
    : [];

  const corps = [
    greeting,
    '',
    `J'ai vu sur votre ${label} ${observation}`,
    '',
    quoiJeFais,
    ...echantillon,
    '',
    apercu,
    '',
    closingQuestion(cf.excerpt, cible, chercheDeja),
  ].join(SAUT);

  const signature = sender ? `${SAUT}${SAUT}Bien à vous,${SAUT}${sender}` : '';
  const messageEmail = `${corps}${signature}`;

  // La version courte : la même observation, la même question, sans le milieu.
  const messageShort = [greeting, '', `J'ai vu sur votre ${label} ${observation}`, '',
    apercu, '', closingQuestion(cf.excerpt, cible, chercheDeja)].join(SAUT) + signature;

  const subject = subjectLine(input.company, cible, chercheDeja);

  return {
    draft: {
      company: input.company,
      website: input.website,
      whyThisCompany: input.whyThisCompany,
      personalizationFact: fact,
      contact: input.contact,
      messageShort,
      messageEmail,
      subject,
      sourceUsedForPersonalization: fact.sourceUrl,
      evidenceExcerpt: cf.excerpt,
      customerFacingObservation: observation,
      recommendations: sample?.accepted ?? [],
    },
    refusal: null,
    reason: 'personnalisation appuyée sur un fait constaté et sourcé.',
  };
}

/**
 * Le message cite-t-il bien un fait réel ?
 *
 * Vérifié après composition, et non pendant : c'est une propriété du texte
 * produit, et une garde qui ne regarde que les intentions ne garde rien. Un
 * test s'en sert pour interdire toute personnalisation orpheline.
 */
export function personalizationIsGrounded(draft: OutreachDraft): boolean {
  const fait = draft.personalizationFact;
  if (fait.nature === 'inferred') return false;
  if (!/^https?:\/\//i.test(fait.sourceUrl)) return false;

  /*
   * Trois ancrages, dans l'ordre : le fait peut parler au client ; l'extrait
   * est bien un morceau contigu de la citation relue ; et les deux messages
   * contiennent la phrase composée à partir de cet extrait. Une phrase qui
   * tiendrait de l'interprétation échouerait au deuxième.
   */
  const cf = customerFacingObservation(fait);
  if (!cf.outreachSafe) return false;
  if (!normaliseEspaces(fait.claim).includes(cf.excerpt)) return false;
  const noyau = cf.observation.replace(/^qu(?:e\s+|’)/i, '').replace(/\.$/, '').trim();
  if (noyau.length < 8) return false;
  return draft.messageShort.includes(noyau) && draft.messageEmail.includes(noyau);
}

/**
 * Raccourcit une affirmation sans la déformer.
 *
 * Coupe à la fin d'une phrase quand c'est possible, jamais au milieu d'un mot —
 * une citation tronquée à la syllabe donne l'impression d'un copier-coller
 * automatique, ce qu'elle est, et ce qu'il faut éviter de montrer.
 */
export function trimSentence(text: string, max = 220): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' ; '));
  if (lastStop > max * 0.5) return cut.slice(0, lastStop + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : max)}…`;
}

// ─── Les états d'un prospect ────────────────────────────────────────────────

export type ProspectState =
  | 'DISCOVERED'
  | 'QUALIFIED'
  | 'READY_FOR_REVIEW'
  | 'APPROVED_TO_CONTACT'
  | 'REJECTED'
  | 'CONTACTED'
  | 'REPLIED'
  | 'INTERESTED'
  | 'ORDERED'
  | 'PAID'
  | 'LOST';

/**
 * Les transitions permises.
 *
 * `READY_FOR_REVIEW → APPROVED_TO_CONTACT` est la seule qu'aucun automatisme
 * ne peut franchir, et c'est le point de tout ce module : un message part vers
 * une entreprise réelle, sous notre nom. Personne d'autre qu'un humain ne peut
 * en décider.
 */
const PROSPECT_TRANSITIONS: Readonly<Record<ProspectState, readonly ProspectState[]>> = {
  DISCOVERED: ['QUALIFIED', 'REJECTED'],
  QUALIFIED: ['READY_FOR_REVIEW', 'REJECTED'],
  READY_FOR_REVIEW: ['APPROVED_TO_CONTACT', 'REJECTED'],
  APPROVED_TO_CONTACT: ['CONTACTED', 'REJECTED'],
  CONTACTED: ['REPLIED', 'LOST'],
  REPLIED: ['INTERESTED', 'LOST'],
  INTERESTED: ['ORDERED', 'LOST'],
  ORDERED: ['PAID', 'LOST'],
  PAID: [],
  REJECTED: ['DISCOVERED'],
  LOST: [],
};

export function canTransitionProspect(from: ProspectState, to: ProspectState): boolean {
  return PROSPECT_TRANSITIONS[from].includes(to);
}

/** La seule transition réservée à un humain. */
export function requiresHumanApproval(from: ProspectState, to: ProspectState): boolean {
  return from === 'READY_FOR_REVIEW' && to === 'APPROVED_TO_CONTACT';
}
