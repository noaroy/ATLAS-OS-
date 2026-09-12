/**
 * L'ordre dans lequel une journée commerciale se déroule, et ce qui l'arrête.
 *
 * Toutes les pièces existent déjà : la synchronisation de la boîte, la salle
 * de guerre, la sonde SearXNG, le lot de prospection, la vue d'approbation.
 * Ce qui manquait était l'ordre — et surtout, ce qui doit interrompre la
 * séquence avant de dépenser quoi que ce soit.
 *
 * Ce module ne fait rien. Il décide. Il ne lit aucune base, n'ouvre aucune
 * connexion et n'appelle aucun modèle : il reçoit des constats et rend des
 * verdicts. C'est ce qui le rend testable sans messagerie ni moteur de
 * recherche, et c'est la seule raison pour laquelle ces règles ne sont pas
 * écrites directement dans le script.
 *
 * Deux principes traversent tout le fichier :
 *
 *   · Une réponse humaine passe avant la prospection. Toujours. Chercher de
 *     nouveaux prospects pendant qu'une entreprise attend une réponse est la
 *     façon la plus fiable de perdre la seule vente en cours.
 *   · Une dépendance qui n'a pas répondu n'est jamais dite disponible. Un
 *     moteur « configuré » n'est pas un moteur qui répond, et la nuance a
 *     déjà coûté deux cycles payés pour rien.
 */

// ─── LES ÉTAPES ─────────────────────────────────────────────────────────────

/**
 * La séquence, dans l'ordre exact où elle s'exécute.
 *
 * `gate` marque les étapes qui peuvent interrompre la suite. Les autres
 * observent. L'ordre est une donnée et non une suite d'appels en dur : c'est
 * la seule façon de vérifier par un test qu'une lecture précède une dépense.
 */
export const REVENUE_STEPS = [
  { id: 'INBOX_SYNC', label: 'synchronisation de la boîte', gate: false, writes: true },
  { id: 'WAR_ROOM', label: 'état commercial', gate: false, writes: false },
  { id: 'HUMAN_REPLIES', label: 'réponses humaines', gate: false, writes: false },
  { id: 'ACTION_REQUIRED', label: 'décisions en attente', gate: false, writes: false },
  { id: 'FOLLOW_UPS_DUE', label: 'relances dues', gate: false, writes: false },
  { id: 'HEALTH_SEARCH_FABRIC', label: 'tissu de recherche', gate: true, writes: false },
  { id: 'HEALTH_SEARXNG', label: 'SearXNG interrogé pour de vrai', gate: true, writes: false },
  { id: 'BUDGET', label: 'budget', gate: true, writes: false },
  { id: 'DAILY_QUOTA', label: 'quota du jour', gate: false, writes: false },
  { id: 'REGISTRY_GUARDS', label: 'registre, DO_NOT_CONTACT, anti-doublons', gate: false, writes: false },
  { id: 'PROSPECTING_CYCLE', label: 'un cycle de prospection réel', gate: false, writes: true },
  { id: 'QUALIFICATION', label: 'qualification', gate: false, writes: true },
  { id: 'CONTACT_RESOLUTION', label: 'résolution du contact', gate: false, writes: true },
  { id: 'IDENTITY_VERIFICATION', label: "vérification d'identité", gate: false, writes: true },
  { id: 'ENRICHMENT', label: 'enrichissement', gate: false, writes: true },
  { id: 'DRAFT_GENERATION', label: 'rédaction des brouillons', gate: false, writes: true },
  { id: 'READY_FOR_REVIEW', label: 'mise en attente de relecture', gate: false, writes: true },
  { id: 'REBUILD_APPROVALS', label: "reconstruction de la file d'approbation", gate: false, writes: false },
  { id: 'REVENUE_SUMMARY', label: 'synthèse', gate: false, writes: false },
  { id: 'STOP_BEFORE_SEND', label: 'arrêt avant tout envoi', gate: false, writes: false },
] as const;

export type RevenueStepId = (typeof REVENUE_STEPS)[number]['id'];

/** Les étapes 12 à 17 se déroulent à l'intérieur du lot, pas après lui. */
export const CYCLE_INNER_STEPS: RevenueStepId[] = [
  'QUALIFICATION', 'CONTACT_RESOLUTION', 'IDENTITY_VERIFICATION',
  'ENRICHMENT', 'DRAFT_GENERATION', 'READY_FOR_REVIEW',
];

/** Aucune étape n'envoie. La liste vide est le contrat, et il est testé. */
export const SENDING_STEPS: RevenueStepId[] = [];

// ─── LA RECHERCHE ───────────────────────────────────────────────────────────

export type SearchVerdict = 'HEALTHY' | 'DEGRADED' | 'SEARCH_BLOCKED';

export interface SearchProbe {
  /** Le nom du moteur interrogé. */
  engine: string;
  /** A-t-il répondu ? Pas « est-il configuré » — a-t-il répondu. */
  responded: boolean;
  /** Combien de résultats la requête réelle a rendus. */
  results: number;
  /** Ce qui a échoué, si quelque chose a échoué. */
  error?: string | null;
}

export interface SearchGate {
  verdict: SearchVerdict;
  /** Le moteur réellement utilisé pour la suite, ou null si aucun. */
  engineInUse: string | null;
  reason: string;
}

/**
 * Le moteur qui servira, décidé sur ce qui a répondu.
 *
 * Le premier moteur de la liste est le moteur souhaité ; les suivants sont les
 * secours déjà prévus par la configuration. Aucun n'est inventé ici : si la
 * liste ne contient qu'un moteur et qu'il est muet, la réponse est
 * `SEARCH_BLOCKED`, jamais un repli improvisé.
 *
 * Un moteur qui répond sans rendre un seul résultat n'est pas en bonne santé.
 * Il est joignable, ce qui n'est pas la même chose, et lancer un cycle dessus
 * paierait des appels de modèle pour une liste vide.
 */
export function decideSearchGate(probes: SearchProbe[]): SearchGate {
  if (probes.length === 0) {
    return { verdict: 'SEARCH_BLOCKED', engineInUse: null, reason: 'aucun moteur configuré' };
  }

  const vivants = probes.filter((p) => p.responded && p.results > 0);
  if (vivants.length === 0) {
    const muets = probes.map((p) => {
      if (!p.responded) return `${p.engine} muet${p.error ? ` (${p.error})` : ''}`;
      return `${p.engine} joignable mais 0 résultat`;
    });
    return { verdict: 'SEARCH_BLOCKED', engineInUse: null, reason: muets.join(' · ') };
  }

  const [premier] = probes;
  const principal = premier !== undefined && premier.responded && premier.results > 0;
  const retenu = vivants[0]!;

  if (principal) {
    return {
      verdict: 'HEALTHY',
      engineInUse: retenu.engine,
      reason: `${retenu.engine} a répondu ${retenu.results} résultat(s)`,
    };
  }
  return {
    verdict: 'DEGRADED',
    engineInUse: retenu.engine,
    reason:
      `${premier!.engine} indisponible — repli sur ${retenu.engine}, ` +
      `${retenu.results} résultat(s)`,
  };
}

// ─── LE BUDGET ──────────────────────────────────────────────────────────────

export interface BudgetSnapshot {
  /** Le plafond du cycle, en dollars. */
  cycleCapUsd: number;
  /**
   * Ce qui a été dépensé aujourd'hui, ou null si aucune mesure n'existe.
   *
   * `null` et `0` disent deux choses différentes et il ne faut jamais les
   * confondre : l'un dit « rien mesuré », l'autre « rien dépensé ».
   */
  todayUsd: number | null;
  monthUsd: number | null;
  /** Les appels dont le tarif est inconnu. Jamais réduits à zéro. */
  unknownCostCalls: number;
  /** Le plafond quotidien global, s'il en existe un. */
  dailyCapUsd?: number | null;
}

export interface BudgetGate {
  allowed: boolean;
  reason: string;
}

/**
 * Le cycle tient-il dans ce qui reste ?
 *
 * Les appels au tarif inconnu ne bloquent pas — ils sont signalés. Les
 * transformer en refus arrêterait ATLAS sur une lacune de mesure plutôt que
 * sur une dépense réelle, et les transformer en zéro ferait passer une
 * dépense non mesurée pour une dépense nulle. Ils sont donc dits, et comptés.
 */
export function decideBudgetGate(b: BudgetSnapshot): BudgetGate {
  if (b.cycleCapUsd <= 0) {
    return { allowed: false, reason: 'plafond de cycle nul : rien à dépenser' };
  }
  if (b.dailyCapUsd != null && b.todayUsd != null) {
    const reste = b.dailyCapUsd - b.todayUsd;
    if (reste < b.cycleCapUsd) {
      return {
        allowed: false,
        reason:
          `il reste ${reste.toFixed(4)} $ sous le plafond quotidien ` +
          `(${b.dailyCapUsd.toFixed(2)} $), moins que les ${b.cycleCapUsd.toFixed(2)} $ du cycle`,
      };
    }
  }
  return {
    allowed: true,
    reason: `plafond de cycle ${b.cycleCapUsd.toFixed(2)} $`,
  };
}

// ─── LA PRIORITÉ AUX RÉPONSES ───────────────────────────────────────────────

export type ReplyPriority = 'HOT_REPLY' | 'POSITIVE_REPLY' | 'ACTION_REQUIRED' | 'NEW_PROSPECTING';

export const REPLY_PRIORITY_ORDER: ReplyPriority[] = [
  'HOT_REPLY', 'POSITIVE_REPLY', 'ACTION_REQUIRED', 'NEW_PROSPECTING',
];

export interface InboxSignal {
  domain: string;
  company: string;
  /** L'état commercial du dossier, tel qu'il est en base. */
  state: string;
  /** Une personne a-t-elle écrit ? Une machine ne compte pas. */
  humanReplied: boolean;
  lastHumanReplyAt?: string | null;
}

/** L'entreprise a demandé à parler : rien ne passe avant. */
const ETATS_CHAUDS = ['MEETING_REQUESTED', 'WON'];
/** Un humain a qualifié le dossier d'intéressé. */
const ETATS_POSITIFS = ['INTERESTED'];

/**
 * Le rang d'une réponse, décidé sur l'état posé par un humain.
 *
 * Tout le reste — une réponse reçue dans un état neutre — tombe en
 * `ACTION_REQUIRED`, et c'est volontaire. La tentation serait d'appeler
 * « positive » toute réponse qui n'est pas un refus : ACRN a écrit « je
 * regarde et reviens la semaine prochaine », ce qui n'est pas une intention
 * d'achat. La compter comme positive faisait diverger deux lignes du même
 * rapport, et la ligne fausse était la plus encourageante.
 *
 * Une réponse qu'aucun humain n'a encore qualifiée attend précisément cela :
 * qu'un humain la lise.
 */
export function classifyReply(s: InboxSignal): ReplyPriority {
  if (!s.humanReplied) return 'NEW_PROSPECTING';
  if (ETATS_CHAUDS.includes(s.state)) return 'HOT_REPLY';
  if (ETATS_POSITIFS.includes(s.state)) return 'POSITIVE_REPLY';
  return 'ACTION_REQUIRED';
}

/**
 * Les signaux, remontés dans l'ordre où ils méritent d'être lus.
 *
 * Le tri est stable à l'intérieur d'un même rang, et le rang prime toujours
 * sur la fraîcheur : une demande de rendez-vous d'hier passe avant une réponse
 * neutre de ce matin.
 */
export function prioritizeInbox(signaux: InboxSignal[]): Array<InboxSignal & { priority: ReplyPriority }> {
  return signaux
    .map((s) => ({ ...s, priority: classifyReply(s) }))
    .filter((s) => s.priority !== 'NEW_PROSPECTING')
    .sort((a, b) => REPLY_PRIORITY_ORDER.indexOf(a.priority) - REPLY_PRIORITY_ORDER.indexOf(b.priority));
}

// ─── LE TRI DES BROUILLONS ──────────────────────────────────────────────────

export type DraftClass = 'SENDABLE' | 'NEEDS_SMALL_EDIT' | 'MANUAL_CHANNEL' | 'BLOCKED';

/**
 * Ce qu'il faut savoir d'un brouillon pour le classer.
 *
 * Volontairement structurel plutôt que lié au type de la vue d'approbation :
 * ce module vit sous la couche serveur et ne peut pas importer ce qu'elle
 * produit. Le script fait la correspondance, une fois, à un seul endroit.
 */
export interface DraftFacts {
  company: string;
  actionType: 'EMAIL' | 'FORM' | 'PHONE' | 'MANUAL' | 'UNAVAILABLE';
  hasTarget: boolean;
  contactObserved: boolean;
  suitabilityLow: boolean;
  personalIntent: boolean;
  identityConfidence: number | null;
  sourcedFacts: number;
  /** Chaque fait porte-t-il une URL ? Un fait sans source ne se vérifie pas. */
  everyFactSourced: boolean;
  alreadySent: boolean;
  doNotContact: boolean;
  quotaRemaining: number;
  /** Défauts de forme : ils n'interdisent rien, ils demandent une relecture. */
  missingSubject: boolean;
  crossDomain: boolean;
  nameLooksLikePageTitle: boolean;
}

export interface DraftVerdict {
  klass: DraftClass;
  reasons: string[];
}

/**
 * Le classement d'un brouillon, et pourquoi.
 *
 * L'ordre des questions est l'ordre des conséquences. Un canal qui n'est pas
 * un courriel ne devient jamais « prêt à envoyer », même parfait par ailleurs :
 * proposer un bouton d'envoi sur un numéro de téléphone est un mensonge
 * d'interface. Et un défaut de forme ne bloque pas — il se corrige en une
 * minute, sans rien réenrichir.
 */
export function classifyDraft(d: DraftFacts): DraftVerdict {
  const dur: string[] = [];
  const mou: string[] = [];

  if (d.doNotContact) dur.push('registre : DO_NOT_CONTACT');
  if (d.alreadySent) dur.push('un message est déjà parti vers cette entreprise');

  if (d.actionType !== 'EMAIL' || !d.hasTarget) {
    const raison = d.actionType === 'UNAVAILABLE'
      ? 'aucun canal exploitable relevé'
      : `canal ${d.actionType} : une action humaine, pas un envoi`;
    if (dur.length > 0) return { klass: 'BLOCKED', reasons: [...dur, raison] };
    return {
      klass: d.actionType === 'UNAVAILABLE' ? 'BLOCKED' : 'MANUAL_CHANNEL',
      reasons: [raison],
    };
  }

  if (!d.contactObserved) dur.push("l'adresse n'a été relevée sur aucune page : elle serait devinée");
  if (d.suitabilityLow) dur.push('canal impropre au démarchage');
  if (d.personalIntent) dur.push('adresse personnelle');
  if (d.sourcedFacts < 2) dur.push(`${d.sourcedFacts} fait(s) sourcé(s) — deux au minimum`);
  if (!d.everyFactSourced) dur.push('un fait au moins ne porte pas de source vérifiable');
  if (d.identityConfidence === null) dur.push("identité non vérifiée");
  if (d.quotaRemaining <= 0) dur.push('quota du jour épuisé');

  if (dur.length > 0) return { klass: 'BLOCKED', reasons: dur };

  if (d.identityConfidence !== null && d.identityConfidence < 0.75) {
    mou.push(`confiance d'identité ${d.identityConfidence.toFixed(2)} < 0,75`);
  }
  if (d.missingSubject) mou.push('objet absent');
  if (d.crossDomain) mou.push('destinataire hors du domaine du prospect');
  if (d.nameLooksLikePageTitle) mou.push("le nom stocké ressemble à un titre de page");

  if (mou.length > 0) return { klass: 'NEEDS_SMALL_EDIT', reasons: mou };
  return { klass: 'SENDABLE', reasons: ['toutes les gardes passent'] };
}

// ─── L'ÉLAN COMMERCIAL ──────────────────────────────────────────────────────

export type Momentum = 'HOT' | 'ACTIVE' | 'LOW' | 'BLOCKED';

export interface MomentumInput {
  /** Une dépendance critique empêche-t-elle de vendre ? */
  blockers: string[];
  positiveReplies: number;
  hotReplies: number;
  actionRequired: number;
  sendable: number;
  readyForReview: number;
  paidClients: number;
}

export interface MomentumVerdict {
  momentum: Momentum;
  reason: string;
}

/**
 * Où en est la vente, en un mot.
 *
 * Un blocage prime sur tout le reste, même sur une réponse chaude : si la
 * messagerie ne répond plus, un prospect intéressé ne peut pas être servi, et
 * afficher `HOT` laisserait croire que la journée avance.
 */
export function revenueMomentum(i: MomentumInput): MomentumVerdict {
  if (i.blockers.length > 0) {
    return { momentum: 'BLOCKED', reason: i.blockers.join(' · ') };
  }
  if (i.hotReplies > 0 || i.positiveReplies > 0 || i.paidClients > 0) {
    const quoi = i.hotReplies > 0
      ? `${i.hotReplies} réponse(s) chaude(s)`
      : i.positiveReplies > 0
        ? `${i.positiveReplies} réponse(s) positive(s)`
        : `${i.paidClients} client(s) payant(s)`;
    return { momentum: 'HOT', reason: quoi };
  }
  if (i.sendable > 0) {
    return { momentum: 'ACTIVE', reason: `${i.sendable} dossier(s) prêt(s) à partir` };
  }
  if (i.actionRequired > 0) {
    return { momentum: 'ACTIVE', reason: `${i.actionRequired} décision(s) en attente` };
  }
  return {
    momentum: 'LOW',
    reason: i.readyForReview > 0
      ? `${i.readyForReview} en relecture, aucun prêt à partir`
      : 'la boucle tourne sans rien produire de partant',
  };
}

// ─── LES TROIS PROCHAINES ACTIONS ───────────────────────────────────────────

export interface ActionsInput extends MomentumInput {
  followUpsDue: number;
  needsSmallEdit: number;
  manualChannel: number;
  quotaRemaining: number;
}

/**
 * Ce qu'il faut faire ensuite, au plus trois lignes.
 *
 * L'ordre suit l'argent : ce qui répond passe avant ce qui est prêt, qui passe
 * avant ce qui reste à écrire. Une liste plus longue n'aiderait pas — elle
 * rendrait à nouveau invisible la ligne qui compte.
 */
export function topActions(i: ActionsInput): string[] {
  const actions: string[] = [];
  const push = (s: string) => { if (actions.length < 3) actions.push(s); };

  for (const b of i.blockers) push(`débloquer : ${b}`);
  if (i.hotReplies > 0) push(`répondre aux ${i.hotReplies} demande(s) chaude(s) — priorité absolue`);
  if (i.positiveReplies > 0) push(`traiter ${i.positiveReplies} réponse(s) positive(s)`);
  if (i.actionRequired > 0) push(`décider sur ${i.actionRequired} dossier(s) en attente`);
  if (i.sendable > 0 && i.quotaRemaining > 0) {
    push(`relire et approuver ${Math.min(i.sendable, i.quotaRemaining)} dossier(s) prêt(s)`);
  }
  if (i.followUpsDue > 0) push(`${i.followUpsDue} relance(s) due(s)`);
  if (i.needsSmallEdit > 0) push(`corriger ${i.needsSmallEdit} brouillon(s) à retoucher`);
  if (i.manualChannel > 0) push(`${i.manualChannel} dossier(s) à traiter à la main`);
  if (actions.length === 0) push('lancer un nouveau cycle : rien n’attend de décision');
  return actions;
}
