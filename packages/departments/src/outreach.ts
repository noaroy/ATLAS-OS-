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
 */

export interface OutreachFact {
  /** L'identifiant de la preuve, pour remonter à la source. */
  evidenceId: string;
  /** Ce qui a été constaté, tel quel. */
  claim: string;
  /** L'adresse où c'est lisible. Obligatoire — c'est ce qui fait la différence. */
  sourceUrl: string;
  nature: 'observed' | 'reported' | 'inferred';
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
  /** L'adresse citée, répétée ici pour que la relecture l'ait sous les yeux. */
  sourceUsedForPersonalization: string;
}

export type OutreachRefusal =
  /** Aucun fait constaté et sourcé : impossible de personnaliser honnêtement. */
  | 'NO_SOURCED_FACT'
  /** L'entreprise n'a pas de nom exploitable. */
  | 'NO_COMPANY';

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
  // Le fait le plus spécifique : le plus long est un proxy grossier mais
  // honnête, et il évite de bâtir un message sur « société active ».
  return [...usable].sort((a, b) => b.claim.length - a.claim.length)[0]!;
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
export function buildOutreachDraft(input: {
  company: string;
  website: string | null;
  facts: readonly OutreachFact[];
  contact: OutreachContact | null;
  whyThisCompany: string;
  /** L'offre, pour que le texte reste cohérent si le prix change. */
  offer: { priceEur: number; deliveryHours: number };
}): OutreachOutcome {
  if (!input.company.trim()) {
    return { draft: null, refusal: 'NO_COMPANY', reason: 'aucun nom d’entreprise.' };
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

  const greeting = input.contact?.named ? `Bonjour ${input.contact.name}` : 'Bonjour';
  const observed = trimSentence(fact.claim);

  const messageShort =
    `${greeting},\n\n` +
    `En regardant ${input.company}, j’ai relevé ceci sur votre site : ${observed}\n\n` +
    `Je réalise des études de prospection B2B : j’identifie des entreprises cibles sur un ` +
    `marché donné, je les qualifie une par une, et chaque affirmation du rapport renvoie à ` +
    `l’adresse où je l’ai lue. Pas un export d’annuaire.\n\n` +
    `${input.offer.priceEur} € une fois, livré sous ${input.offer.deliveryHours} h. ` +
    `Je peux vous envoyer un extrait réel pour que vous jugiez le format — dites-moi ` +
    `simplement si ça vous intéresse.`;

  const messageEmail =
    `${greeting},\n\n` +
    `J’ai regardé ${input.company}${input.website ? ` (${input.website})` : ''} et j’ai relevé ` +
    `ceci, publié sur votre site : ${observed}\n` +
    `Source : ${fact.sourceUrl}\n\n` +
    `Je réalise des études de prospection B2B. Concrètement : vous me dites ce que vous ` +
    `vendez et à qui, j’identifie des entreprises cibles sur le marché visé, je les qualifie ` +
    `une par une — et chaque affirmation du rapport renvoie à l’URL où je l’ai lue. Vous ` +
    `pouvez tout vérifier en un clic.\n\n` +
    `Ce que ce n’est pas : un export d’annuaire ni une liste achetée.\n\n` +
    `${input.offer.priceEur} €, paiement unique, livré sous ${input.offer.deliveryHours} h en ` +
    `page à lire et en tableau à importer. Avant tout paiement, je vous dis ce que votre ` +
    `marché permet réellement — si c’est trop peu, je vous le dis et on s’arrête là.\n\n` +
    `Si vous voulez juger sur pièce, je vous envoie un extrait réel d’une étude déjà ` +
    `produite. Répondez-moi simplement « extrait » et je vous l’adresse.\n\n` +
    `Bien à vous,`;

  return {
    draft: {
      company: input.company,
      website: input.website,
      whyThisCompany: input.whyThisCompany,
      personalizationFact: fact,
      contact: input.contact,
      messageShort,
      messageEmail,
      sourceUsedForPersonalization: fact.sourceUrl,
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
  const excerpt = trimSentence(draft.personalizationFact.claim);
  if (!excerpt) return false;
  if (draft.personalizationFact.nature === 'inferred') return false;
  if (!/^https?:\/\//i.test(draft.personalizationFact.sourceUrl)) return false;
  return draft.messageShort.includes(excerpt) && draft.messageEmail.includes(excerpt);
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
