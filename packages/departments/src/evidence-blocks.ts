/**
 * La preuve d'un fait est un passage de la page, désigné, pas récrit.
 *
 * Vingt-cinq entreprises découvertes, huit au rang PRIORITY, trois sans le
 * moindre verrou d'éligibilité — et zéro brouillon. Chaque « fait commercial »
 * enregistré était une reformulation du modèle : « Entreprise industrielle avec
 * usines de production », « Asytec propose du sous-traitance industrielle
 * low-cost ». Justes sur le fond, introuvables sur la page. La vérification les
 * rejetait à 50-75 % de recouvrement, et il ne restait rien à citer.
 *
 * Le contrôle avait raison ; c'est l'entrée qui était mauvaise. Demander à un
 * modèle de recopier fidèlement une phrase revient à espérer qu'il ne la
 * reformule pas, ce qu'il fait pourtant toujours un peu — et « un peu » suffit
 * à casser une citation.
 *
 * Ce module retire donc la citation des mains du modèle :
 *
 *   1. la page est nettoyée, ses entités décodées, découpée en blocs numérotés ;
 *   2. les blocs sont montrés au modèle ;
 *   3. le modèle rend un NUMÉRO de bloc et son interprétation ;
 *   4. ATLAS relit le bloc à ce numéro — le texte exact, jamais celui du modèle.
 *
 * Ce qu'un modèle ne peut pas écrire, il ne peut pas l'inventer. Un numéro hors
 * liste est refusé ; il n'existe aucun chemin par lequel un texte libre devient
 * une citation.
 *
 * L'interprétation reste utile — c'est elle qui alimente le score et qui se lit
 * dans un message. Elle est simplement séparée de la preuve, et ne prétend
 * jamais être une citation.
 */
import { decodeEntities } from './claim-verification.ts';

/** Ce qu'une preuve établit. Seul `COMMERCIAL_FACT` autorise un brouillon. */
export type EvidenceType = 'COMMERCIAL_FACT' | 'IDENTITY' | 'CONTACT' | 'OTHER';

/** Un passage réel de la page, tel qu'il y figure. */
export interface SourceBlock {
  /** Le numéro montré au modèle. Stable pour une page donnée. */
  id: number;
  /** Le texte exact, entités décodées, espaces normalisés. */
  text: string;
}

/** Une preuve complète : ce que la page dit, et ce qu'on en comprend. */
export interface SourcedEvidence {
  /** L'interprétation, utilisable par le score et par le message. */
  normalizedClaim: string;
  /** Le passage exact de la page. Jamais écrit par un modèle. */
  evidenceQuote: string;
  sourceUrl: string;
  sourcePageTitle: string | null;
  evidenceType: EvidenceType;
  /** Le bloc d'où la citation provient, pour qu'elle se rejoue. */
  blockId: number;
}

/**
 * Les blocs trop courts ne prouvent rien.
 *
 * « Contact », « Nos produits », « En savoir plus » sont du mobilier de page.
 * Les citer donnerait des messages qui annoncent une preuve et n'en montrent
 * aucune.
 */
const LONGUEUR_MINIMALE = 40;
/** Au-delà, ce n'est plus une citation mais un paragraphe entier. */
const LONGUEUR_MAXIMALE = 320;

/** Le texte lisible d'une page : balises retirées, entités décodées. */
export function cleanedText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      // Les frontières de bloc deviennent des séparateurs : sans elles, la fin
      // d'un titre se colle au début du paragraphe suivant et la « citation »
      // ne se retrouve nulle part.
      .replace(/<\/(?:p|div|li|h[1-6]|section|article|td|tr|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Le titre déclaré de la page, s'il y en a un. */
export function pageTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]{1,200}?)<\/title>/i.exec(html);
  const t = m?.[1] ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
  return t === '' ? null : t;
}

/** Réduit un texte à sa forme comparable. */
const aplatir = (s: string): string =>
  decodeEntities(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * La page, découpée en passages citables et numérotés.
 *
 * Le découpage suit les frontières réelles du document — paragraphes, listes,
 * titres — puis les phrases quand un bloc dépasse la longueur d'une citation.
 * Les doublons exacts sont écartés : un menu répété en pied de page produirait
 * autrement dix blocs identiques, et deux « faits » tirés du même texte.
 */
export function splitIntoBlocks(html: string): SourceBlock[] {
  const brut = cleanedText(html);
  const morceaux: string[] = [];

  for (const ligne of brut.split('\n')) {
    const t = ligne.trim();
    if (t.length < LONGUEUR_MINIMALE) continue;
    if (t.length <= LONGUEUR_MAXIMALE) { morceaux.push(t); continue; }
    // Trop long : on redécoupe à la phrase, en gardant la ponctuation.
    let courant = '';
    for (const phrase of t.split(/(?<=[.!?…])\s+/)) {
      if ((courant + ' ' + phrase).trim().length > LONGUEUR_MAXIMALE && courant !== '') {
        morceaux.push(courant.trim());
        courant = phrase;
      } else {
        courant = `${courant} ${phrase}`.trim();
      }
    }
    if (courant.trim().length >= LONGUEUR_MINIMALE) morceaux.push(courant.trim());
  }

  const vus = new Set<string>();
  const blocs: SourceBlock[] = [];
  for (const m of morceaux) {
    const cle = aplatir(m);
    if (cle === '' || vus.has(cle)) continue;
    vus.add(cle);
    blocs.push({ id: blocs.length + 1, text: m.slice(0, LONGUEUR_MAXIMALE) });
  }
  return blocs;
}

/** Ce que le modèle a le droit de rendre : un numéro et une interprétation. */
export interface BlockSelection {
  evidenceBlockId: number;
  normalizedClaim: string;
  evidenceType: EvidenceType;
}

export interface SelectionOutcome {
  evidence: SourcedEvidence | null;
  reason: string;
}

/**
 * Transforme une sélection du modèle en preuve, ou la refuse.
 *
 * Le numéro doit désigner un bloc existant de CETTE page. Un numéro inventé,
 * hors liste ou emprunté à une autre page n'ouvre aucune porte : la citation
 * n'est jamais construite à partir de ce que le modèle a écrit, seulement à
 * partir de ce que la page contient au numéro demandé.
 */
export function resolveSelection(
  selection: BlockSelection,
  blocks: readonly SourceBlock[],
  source: { url: string; title: string | null },
): SelectionOutcome {
  const bloc = blocks.find((b) => b.id === selection.evidenceBlockId);
  if (!bloc) {
    return {
      evidence: null,
      reason: `bloc ${selection.evidenceBlockId} inexistant sur ${source.url} `
        + `(${blocks.length} bloc(s) proposés) — aucune citation ne sera fabriquée`,
    };
  }
  const claim = selection.normalizedClaim.trim();
  if (claim === '') {
    return { evidence: null, reason: 'interprétation vide : le fait ne se lit pas' };
  }
  return {
    evidence: {
      normalizedClaim: claim,
      // Le texte du bloc, pas celui du modele. C'est tout l'objet du module.
      evidenceQuote: bloc.text,
      sourceUrl: source.url,
      sourcePageTitle: source.title,
      evidenceType: selection.evidenceType,
      blockId: bloc.id,
    },
    reason: `bloc ${bloc.id} de ${source.url}`,
  };
}

/**
 * Une citation qui vient d'un bloc est vérifiée par construction.
 *
 * Le seuil de 80 % sert à juger un texte libre confronté à sa source. Une
 * citation tirée d'un bloc n'est pas un texte libre : elle EST le bloc, et le
 * comparer à lui-même n'apprendrait rien. La vérification consiste donc à
 * relire la page et à constater que le passage y figure encore.
 *
 * Ce n'est pas une dérogation : rien de généré ne passe par ici. Un texte que
 * la page ne contient pas échoue, quelle que soit sa provenance déclarée.
 */
export function quoteExistsInSource(quote: string, sourceText: string): boolean {
  const q = aplatir(quote);
  if (q.length < LONGUEUR_MINIMALE / 2) return false;
  return ` ${aplatir(sourceText)} `.includes(` ${q} `) || aplatir(sourceText).includes(q);
}

/**
 * Deux formulations du même passage ne font pas deux faits.
 *
 * Beaucoup de sites répètent une accroche en haut de page, dans une section et
 * en pied. Les compter séparément donnerait « deux faits sourcés » sur une
 * seule information, et l'exigence de deux faits ne vaudrait plus rien.
 */
export function areNearDuplicates(a: string, b: string, seuil = 0.7): boolean {
  const mots = (s: string) => new Set(aplatir(s).split(' ').filter((w) => w.length >= 4));
  const A = mots(a);
  const B = mots(b);
  if (A.size === 0 || B.size === 0) return false;
  let communs = 0;
  for (const w of A) if (B.has(w)) communs += 1;
  return communs / Math.min(A.size, B.size) >= seuil;
}

/**
 * Les faits commerciaux réellement distincts.
 *
 * `IDENTITY` et `CONTACT` n'en sont pas : une raison sociale établit qui édite
 * le domaine, une adresse dit où écrire. Ni l'une ni l'autre ne dit ce que
 * l'entreprise fait, et c'est cela qu'un message doit citer.
 */
export function distinctCommercialFacts(
  evidence: readonly SourcedEvidence[],
): SourcedEvidence[] {
  const gardes: SourcedEvidence[] = [];
  for (const e of evidence) {
    if (e.evidenceType !== 'COMMERCIAL_FACT') continue;
    const doublon = gardes.some(
      (g) => (g.sourceUrl === e.sourceUrl && g.blockId === e.blockId)
        || areNearDuplicates(g.evidenceQuote, e.evidenceQuote)
        || areNearDuplicates(g.normalizedClaim, e.normalizedClaim),
    );
    if (!doublon) gardes.push(e);
  }
  return gardes;
}

/** Le nombre exigé pour qu'un brouillon existe. Inchangé. */
export const MIN_COMMERCIAL_FACTS = 2;

export function hasEnoughCommercialFacts(evidence: readonly SourcedEvidence[]): boolean {
  return distinctCommercialFacts(evidence).length >= MIN_COMMERCIAL_FACTS;
}
