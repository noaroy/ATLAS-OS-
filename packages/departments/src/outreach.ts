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
   * Ce que le passage etablit, en une phrase.
   *
   * La citation exacte prouve ; l'interpretation se lit. Coller la citation
   * telle quelle dans un courriel donne « j'ai releve ceci, publie sur votre
   * site : ... » suivi d'un paragraphe entier -- exactement la forme mecanique
   * que la politique interdit. L'interpretation, elle, s'insere dans une phrase
   * francaise.
   *
   * Toujours adossee a `claim`, jamais a sa place : la preuve reste stockee et
   * visible dans Approvals.
   */
  normalizedClaim?: string | null;
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
  const lisible = (f: OutreachFact): number => ((f.normalizedClaim ?? '').trim() !== '' ? 1 : 0);

  return [...usable].sort((a, b) =>
    signalDachat(b) - signalDachat(a)
    || lisible(b) - lisible(a)
    || b.claim.length - a.claim.length)[0]!;
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
 * Les mots qu'on peut mettre en minuscule après « que ».
 *
 * Un nom propre, lui, doit garder sa majuscule : forcer la minuscule donnait
 * « que harmony Béton est fabricant » et « que k2tec est spécialisé ». Seuls
 * les mots-outils s'abaissent sans dommage.
 */
const ABAISSABLES = new Set([
  'vous', 'votre', 'vos', 'nous', 'notre', 'nos', 'le', 'la', 'les', 'un', 'une',
  'des', 'ce', 'cet', 'cette', 'il', 'elle', 'ils', 'elles', 'leur', 'leurs',
  'depuis', 'chaque', 'plusieurs', 'tous', 'toute', 'toutes',
]);

/**
 * Les entrées en matière qui ne s'enchaînent pas après « que ».
 *
 * « À l'origine, K2TEC est… » devient « que a l'origine, K2TEC est… » — la
 * liaison est fausse. On les retire plutôt que de tordre la phrase.
 */
const ADVERBIALES = /^(?:à l['’]origine|a l['’]origine|aujourd['’]hui|depuis \d{4}|désormais|actuellement|historiquement)\s*,\s*/i;

/**
 * Ce que le fait établit, tourné pour s'insérer après « J'ai vu sur votre X ».
 *
 * Seule l'interprétation sert : c'est une phrase française, écrite pour être
 * lue. La citation exacte, elle, est souvent un fragment de catalogue —
 * « distribution de colis, consigne de matériels informatiques… » — qui ne
 * s'enchaîne après aucun connecteur. Relevé sur logiprox.com.
 *
 * Sans interprétation, cette fonction rend `null` : mieux vaut aucun brouillon
 * qu'une phrase bancale, qui se remarque plus qu'un silence.
 */
export function observationPhrase(fact: { claim: string; normalizedClaim?: string | null }): string | null {
  const brut = (fact.normalizedClaim ?? '').trim();
  if (brut === '') return null;

  const nettoye = brut
    .replace(ADVERBIALES, '')
    .replace(/^(?:l['’]entreprise|la société|la societe)\s+/i, '')
    .replace(/\s*[.;]\s*$/, '')
    .trim();
  if (nettoye.length < 8) return null;

  const premier = nettoye.split(/\s+/)[0] ?? '';
  const abaisse = ABAISSABLES.has(premier.toLowerCase())
    ? `${nettoye.charAt(0).toLowerCase()}${nettoye.slice(1)}`
    : nettoye;
  return `que ${abaisse}.`;
}

function premierePhrase(t: string): string {
  const phrases = t.trim().split(/(?<=[.!?])\s+/);
  return (phrases[0] ?? t).slice(0, 180);
}

/**
 * Le mot qui désigne ce qu'ils cherchent, tiré de ce qu'ils publient.
 *
 * Ne jamais promettre un type de cible que les faits ne soutiennent pas :
 * annoncer des « distributeurs » à qui cherche des clients finaux est une
 * promesse creuse, et elle se voit à la première réponse.
 */
export function targetWord(fact: { claim: string; normalizedClaim?: string | null }): string {
  const t = `${fact.normalizedClaim ?? ''} ${fact.claim}`.toLowerCase();
  if (/distributeur/.test(t)) return 'distributeurs';
  if (/revendeur/.test(t)) return 'revendeurs';
  if (/intégrateur|integrateur/.test(t)) return 'intégrateurs';
  if (/partenaire/.test(t)) return 'partenaires';
  if (/sous-trait/.test(t)) return 'donneurs d’ordres';
  return 'clients potentiels';
}

/**
 * La question finale, liée au contexte.
 *
 * Une seule, simple, et qui donne une raison de répondre. Jamais
 * « n'hésitez pas à me contacter », jamais la porte de sortie comme seul appel.
 */
export function closingQuestion(
  fact: { claim: string; normalizedClaim?: string | null },
  cible: string,
): string {
  const t = `${fact.normalizedClaim ?? ''} ${fact.claim}`.toLowerCase();
  if (/export|international|étranger|etranger|monde|pays/.test(t)) {
    return 'Vous ciblez plutôt la France ou l’export en ce moment ?';
  }
  if (/région|region|départment|departement|local|proximité/.test(t)) {
    return 'Il y a une zone que vous souhaitez développer en priorité ?';
  }
  return `Vous cherchez surtout des ${cible} spécialisés ou plus généralistes ?`;
}

/**
 * L'objet : court, humain, tiré du contexte.
 *
 * Le suffixe « — étude de prospection B2B » a été retiré : il transformait
 * chaque objet en étiquette de campagne, et se reconnaissait d'une boîte à
 * l'autre.
 */
export function subjectLine(
  company: string,
  fact: { claim: string; normalizedClaim?: string | null },
  cible: string,
): string {
  const t = `${fact.normalizedClaim ?? ''} ${fact.claim}`.toLowerCase();
  const Cible = cible.charAt(0).toUpperCase() + cible.slice(1);
  if (/recherch|cherch|recrut/.test(t)) return `Recherche de ${cible}`;
  const avecNom = `${Cible} pour ${company}`;
  // 45 et non 60 : « Clients potentiels pour Fabricant Distributeur Automatique »
  // tient en 56 caracteres et ne se lit pas comme un objet ecrit par quelqu'un.
  return avecNom.length <= 45 ? avecNom : `Recherche de ${cible}`;
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
   * L'observation, ecrite comme une phrase et non comme une citation collee.
   *
   * L'interpretation du fait s'insere dans « J'ai vu sur votre page X que… ».
   * A defaut, on reprend la citation, mais raccourcie a sa premiere phrase :
   * un paragraphe entier recopie se lit comme une machine.
   */
  const observation = observationPhrase(fact);
  if (observation === null) {
    return {
      draft: null,
      refusal: 'NO_SOURCED_FACT',
      reason:
        'aucun fait ne porte d’interprétation lisible : coller une citation brute donnerait '
        + 'une phrase bancale, qui se remarque davantage qu’un silence.',
    };
  }
  const label = pageLabel(fact.sourceUrl);
  const cible = targetWord(fact);
  const chercheDeja = /recherch|cherch|recrut|devenir (?:distributeur|revendeur|partenaire)/i
    .test(`${fact.normalizedClaim ?? ''} ${fact.claim}`);

  const quoiJeFais = chercheDeja
    ? `Je travaille justement sur ce type de recherche : j'identifie des entreprises `
      + `correspondant à un profil précis et je vérifie chacune avant de vous la proposer.`
    : `Je recherche des ${cible} pour des fabricants et des équipementiers : j'identifie `
      + `des entreprises correspondant au profil visé et je vérifie chacune avant de vous `
      + `la proposer.`;

  const apercu = `Je peux vous en préparer ${freeCount} gratuitement, simplement pour que `
    + `vous jugiez si le résultat est pertinent.`;

  const corps = [
    greeting,
    '',
    `J'ai vu sur votre ${label} ${observation}`,
    '',
    quoiJeFais,
    '',
    apercu,
    '',
    closingQuestion(fact, cible),
  ].join(SAUT);

  const signature = sender ? `${SAUT}${SAUT}Bien à vous,${SAUT}${sender}` : '';
  const messageEmail = `${corps}${signature}`;

  // La version courte : la même observation, la même question, sans le milieu.
  const messageShort = [greeting, '', `J'ai vu sur votre ${label} ${observation}`, '',
    apercu, '', closingQuestion(fact, cible)].join(SAUT) + signature;

  const subject = subjectLine(input.company, fact, cible);

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
   * Le message porte desormais l'interpretation, pas la citation brute.
   *
   * Coller la phrase exacte donnait « j'ai releve ceci, publie sur votre
   * site : » suivi d'un paragraphe entier. L'ancrage se verifie donc sur ce que
   * le message contient reellement -- l'observation composee a partir du fait --
   * et la citation exacte reste stockee, visible dans Approvals.
   */
  const observation = observationPhrase(fait);
  if (observation === null) return false;
  const noyau = observation.replace(/^que\s+/i, '').replace(/\.$/, '').trim();
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
