import { canRunProvider, AUTONOMY_LEVELS, type AtlasConfig, type Logger } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import {
  collectNeedsYou, todaySnapshot, inspectRepo, detectClaudeCode, detectClaudeCodeAuth,
  DEFAULT_WORKER_TYPES,
} from '@atlas/runtime';
import {
  deriveConversationState, replyHistory, evaluateFollowUp,
  classifyActionChannel, classifyRecipientString, actionLabelFor,
  classifyRecipientDomain, classifyContactIntent, outreachSuitability,
  countryFit, looksMultinational, ATLAS_SALES_ICP, isTechnicalEntity,
  type ActionChannel, type DomainMatch,
  type ConversationEvent, type ConversationStatus,
} from '@atlas/departments';
import { GmailInboxProvider, GmailOutboundProvider } from '@atlas/intelligence';
import { pricingFor, currentPricingConfig } from '@atlas/llm';

/**
 * Ce que le centre de commande affiche, lu là où la vérité se trouve déjà.
 *
 * Aucune donnée n'est stockée ici et aucun registre n'est dupliqué : chaque
 * chiffre vient d'une lecture des dépôts existants, au moment où on le demande.
 * C'est la seule façon de garantir que l'écran et les commandes en ligne disent
 * la même chose — deux agrégations parallèles finissent toujours par diverger,
 * et c'est précisément ce qui a produit un tableau annonçant sept réponses
 * quand il n'y en avait aucune.
 *
 * Trois règles gouvernent tout ce fichier :
 *
 *   · Ce qui n'a pas de source rend `null`. L'affichage écrira N/A. Un zéro à
 *     la place d'une absence de mesure se lit « rien » là où il faut lire « je
 *     ne sais pas », et c'est la seule erreur de tableau de bord qui se propage
 *     sans bruit.
 *   · Aucun secret ne sort d'ici. Ni clé, ni jeton, ni valeur de `.env` — les
 *     fournisseurs sont décrits par leur état de connexion, jamais par leurs
 *     identifiants.
 *   · Le registre global fait autorité pour tout ce qui touche au commercial.
 *     Une entreprise contactée doit apparaître quoi qu'il arrive : c'est
 *     l'absence de cette règle qui avait rendu deux entreprises invisibles.
 */

const iso = (): string => new Date().toISOString();

/** Ce qu'ATLAS sait d'un dossier commercial, registre et conversation réunis. */
interface Dossier {
  domain: string;
  companyName: string;
  conversationId: string | null;
  contactedOn: string;
  state: ConversationStatus;
  everReplied: boolean;
  lastHumanReplyAt: string | null;
  lastAutoReplyAt: string | null;
  lastOutboundAt: string | null;
  followUpsSent: number;
  followUpDue: boolean;
  followUpReason: string;
}

function dossiers(repos: Repositories, config: AtlasConfig, today: string): Dossier[] {
  const mailbox = process.env.GMAIL_USER?.trim() ?? '';
  const conversations = new Map(
    repos.conversations.all().map((cv) => [cv.canonicalDomain, cv]),
  );

  return repos.sales.ledgerDomains()
    // Un dossier est une entreprise réelle : le self-test Gmail n'en est pas un.
    .filter((entry) => entry.kind === 'CONTACTED' && !isTechnicalEntity(entry))
    .map((entry) => {
      const conversation = conversations.get(entry.domain);
      const events = conversation ? repos.conversations.eventsFor(conversation.id) : [];
      const histoire = replyHistory(events, mailbox);

      const state = deriveConversationState(
        events.map((e) => ({
          kind: e.kind, classification: e.classification, occurredAt: e.occurredAt,
          returnDate: e.returnDate, humanReviewed: e.humanReviewed,
          declaredStatus: e.declaredStatus,
        })) as ConversationEvent[],
        { today, ledgerFollowUpAt: repos.conversations.ledgerFollowUpFor(entry.domain) },
      );

      const lastOutboundAt = repos.salesLoop.lastSentTo(entry.domain);
      const activite = [histoire.lastHumanReplyAt, histoire.lastAutoReplyAt, lastOutboundAt]
        .filter((d): d is string => d !== null)
        .reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);

      const contactedOn = (conversation?.firstContactAt ?? entry.recordedAt).slice(0, 10);
      const followUpsSent = repos.salesLoop.followUpsFor(entry.domain);
      const decision = evaluateFollowUp({
        domain: entry.domain,
        status: state.status,
        contactedOn,
        lastActivityOn: activite ? activite.slice(0, 10) : null,
        followUpsSent,
        doNotContact: false,
        afterBusinessDays: config.sales.followUpAfterDays,
        today,
      });

      return {
        domain: entry.domain,
        companyName: conversation?.companyName ?? entry.domain,
        conversationId: conversation?.id ?? null,
        contactedOn,
        state: state.status,
        everReplied: histoire.everHumanReplied,
        lastHumanReplyAt: histoire.lastHumanReplyAt,
        lastAutoReplyAt: histoire.lastAutoReplyAt,
        lastOutboundAt,
        followUpsSent,
        followUpDue: decision.verdict === 'DUE',
        followUpReason: decision.reason,
      };
    });
}

// ─── WAR ROOM ───────────────────────────────────────────────────────────────

/**
 * L'ordre de l'entonnoir, exhaustif par construction.
 *
 * Tout état non listé s'ajoute quand même côté client. Un entonnoir dont le
 * total ne retombe pas sur celui du registre ne se lit plus, il se devine — et
 * c'est ainsi qu'une entreprise disparaît sans que personne le remarque.
 */
export const FUNNEL_ORDER: readonly ConversationStatus[] = [
  'CONTACTED', 'AUTO_REPLY', 'BOUNCED', 'NEEDS_REVIEW', 'REPLIED',
  'NEEDS_INFO', 'INTERESTED', 'MEETING_REQUESTED',
  'FOLLOW_UP_SCHEDULED', 'FOLLOW_UP_REQUIRED', 'NOT_INTERESTED', 'WON', 'LOST',
];

export function buildWarRoom(repos: Repositories, config: AtlasConfig, today = iso().slice(0, 10)) {
  const list = dossiers(repos, config, today);
  const snapshot = todaySnapshot(repos, today);

  const funnel = new Map<string, number>();
  for (const d of list) funnel.set(d.state, (funnel.get(d.state) ?? 0) + 1);

  const ledgerTotal = list.length;
  const funnelTotal = [...funnel.values()].reduce((s, n) => s + n, 0);
  const orders = repos.orders.listOrders(200);
  const paid = orders.filter((o) => o.paymentStatus === 'CONFIRMED');
  const ontRepondu = list.filter((d) => d.everReplied);
  const sentToday = repos.salesLoop.sentSince(`${today}T00:00:00.000Z`);

  return {
    generatedAt: iso(),
    ledgerTotal,
    funnelTotal,
    // L'écart doit se voir, pas se corriger en silence.
    consistent: funnelTotal === ledgerTotal,
    funnel: [
      ...FUNNEL_ORDER.map((state) => ({ state, count: funnel.get(state) ?? 0 })),
      ...[...funnel.keys()]
        .filter((s) => !FUNNEL_ORDER.includes(s as ConversationStatus))
        .map((state) => ({ state, count: funnel.get(state) ?? 0, unexpected: true })),
    ],
    metrics: {
      contacted: ledgerTotal,
      everReplied: ontRepondu.length,
      replyRate: ledgerTotal === 0 ? null : ontRepondu.length / ledgerTotal,
      positiveReplies: list.filter((d) => ['INTERESTED', 'MEETING_REQUESTED', 'WON'].includes(d.state)).length,
      paidClients: paid.length,
      revenueEur: paid.reduce((s, o) => s + (o.priceCents ?? 0), 0) / 100,
      followUpsDue: list.filter((d) => d.followUpDue).length,
      messagesSent: repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z'),
      sentToday,
      dailyCap: config.sales.maxNewOutreachPerDay,
      dailyRemaining: Math.max(0, config.sales.maxNewOutreachPerDay - sentToday),
      // Les aperçus gratuits sont transmis à la main : rien en base ne permet
      // de les compter, et un zéro se lirait « aucun ».
      freePreviews: null as number | null,
      aiCostToday: snapshot.aiCostUsd,
      aiCostUnknownCalls: snapshot.aiCostUnknownCalls,
    },
    repliedCompanies: ontRepondu.map((d) => ({ domain: d.domain, name: d.companyName, at: d.lastHumanReplyAt })),
    followUps: list.filter((d) => d.followUpDue)
      .map((d) => ({ domain: d.domain, name: d.companyName, reason: d.followUpReason })),
  };
}

// ─── ENTREPRISES ────────────────────────────────────────────────────────────

export function buildCompanies(repos: Repositories, config: AtlasConfig, today = iso().slice(0, 10)) {
  return {
    generatedAt: iso(),
    companies: dossiers(repos, config, today).map((d) => ({
      domain: d.domain,
      name: d.companyName,
      state: d.state,
      contactedOn: d.contactedOn,
      lastOutboundAt: d.lastOutboundAt,
      lastHumanReplyAt: d.lastHumanReplyAt,
      lastAutoReplyAt: d.lastAutoReplyAt,
      followUpsSent: d.followUpsSent,
      followUpDue: d.followUpDue,
      followUpReason: d.followUpReason,
      hasConversation: d.conversationId !== null,
    })),
  };
}

/** Le dossier complet d'une entreprise : l'historique, jamais réécrit. */
export function buildCompanyDetail(repos: Repositories, domain: string) {
  const entry = repos.sales.ledgerFor(domain);
  if (!entry) return null;
  const conversation = repos.conversations.byDomain(domain);
  const events = conversation ? repos.conversations.eventsFor(conversation.id) : [];

  return {
    generatedAt: iso(),
    domain,
    name: conversation?.companyName ?? domain,
    ledger: { kind: entry.kind, note: entry.note, recordedBy: entry.recordedBy, recordedAt: entry.recordedAt },
    history: repos.sales.ledgerHistory(domain),
    events: events.map((e) => ({
      at: e.occurredAt,
      kind: e.kind,
      classification: e.classification,
      // L'expéditeur est une donnée du message, pas un secret ; le corps est
      // tronqué parce qu'un écran n'a pas à porter un courriel entier.
      sender: e.sender,
      subject: e.rawSubject,
      excerpt: e.bodyExcerpt?.slice(0, 400) ?? null,
      humanReviewed: e.humanReviewed,
      declaredStatus: e.declaredStatus,
      source: e.source,
    })),
    followUpsSent: repos.salesLoop.followUpsFor(domain),
    lastOutboundAt: repos.salesLoop.lastSentTo(domain),
  };
}

// ─── APPROBATIONS ───────────────────────────────────────────────────────────

/**
 * Ce qui attend une décision humaine — depuis les deux magasins de brouillons.
 *
 * ATLAS écrit ses brouillons à deux endroits, pour des raisons historiques :
 * la boucle d'outreach dans `outreach_drafts`, le lot de prospection dans
 * `sales_prospects` avec l'état `READY_FOR_REVIEW`. L'écran ne lisait que le
 * premier. Conséquence mesurée le 27/08/2026 : vingt-et-un dossiers prêts à
 * relire n'apparaissaient nulle part, dont certains depuis des semaines — et
 * les neuf brouillons que l'écran savait lire étaient tous déjà envoyés.
 *
 * Ce constructeur lit les deux et n'écrit rien. Aucune donnée n'est déplacée,
 * copiée ni convertie : réconcilier les deux magasins toucherait au chemin qui
 * mène à l'envoi, et ce chemin ne se modifie pas pour rendre un écran complet.
 *
 * La file active ne contient que ce sur quoi une décision a encore un sens. Un
 * dossier historiquement prêt mais devenu inactionnable — déjà envoyé,
 * abandonné, rejeté, hors registre, ou remplacé par une version plus récente —
 * sort de la file et garde sa place dans l'historique, avec son motif. Faire
 * réapparaître un vieux brouillon déjà traité serait le plus sûr moyen de le
 * faire partir deux fois.
 */

/** D'où vient un brouillon. Jamais devinée : la file mélange deux magasins. */
export type ApprovalSource = 'OUTREACH_DRAFT' | 'SALES_PROSPECT';

export interface ApprovalItem {
  id: string;
  source: ApprovalSource;
  prospectId: string | null;
  company: string;
  domain: string;
  recipient: string | null;
  subject: string | null;
  body: string;
  createdAt: string;
  createdBy: string | null;
  score: number | null;
  facts: Array<{ quote: string; sourceUrl: string }>;
  guards: string[];
  /**
   * Par quel canal la décision peut réellement être exécutée.
   *
   * Calculé pour l'écran, jamais persisté. Quatre des dix dossiers en attente
   * n'ont qu'un numéro : proposer « envoyer » sur les dix mentirait sur quatre.
   */
  actionType: ActionChannel;
  /** Ce qui serait réellement utilisé.  quand rien n'est exploitable. */
  channelTarget: string | null;
  /** Le geste possible, dit tel qu'il est — aucun n'est automatisé. */
  actionLabel: string;
  channelReason: string;
  /**
   * Le destinataire est-il sur le domaine du prospect ?
   *
   * Signalé, jamais bloquant : maison mère, filiale, domaine national et marque
   * de groupe produisent tous ce cas, et il est le plus souvent légitime.
   */
  recipientDomainMatch: DomainMatch;
  recipientDomain: string | null;
  /** La source qui nomme l'autre domaine, quand une preuve existe. */
  relatedDomainEvidence: string | null;
  domainReason: string;
  /**
   * L'état réel en base, jamais réécrit pour l'affichage.
   *
   * `READY_FOR_REVIEW` et `READY_FOR_APPROVAL` sont deux états persistants
   * distincts, dans deux tables distinctes. Les confondre pour uniformiser
   * l'écran ferait mentir toute requête ultérieure.
   */
  sourceState: string;
  /** Le libellé montré à l'opérateur : une traduction, pas une valeur stockée. */
  uiStatus: 'READY FOR APPROVAL';
  /** Faux tant qu'aucun endpoint de mutation sécurisé n'existe. */
  canApprove: boolean;
}

export interface ApprovalExclusion {
  id: string;
  source: ApprovalSource;
  company: string;
  domain: string;
  /** L'etat reel en base, jamais reecrit : l'exclusion est une lecture. */
  sourceState: string;
  reason: string;
  /**
   * La preuve qui fonde l'exclusion, quand il y en a une.
   *
   * Un dossier ecarte sans preuve citable ne se conteste pas : celui qui relit
   * doit pouvoir aller voir la page qui a tranche.
   */
  evidence?: string;
  /** Quand le dossier a ete constitue — pour le retrouver dans l'historique. */
  recordedAt?: string;
}

export function buildApprovals(repos: Repositories) {
  const mailbox = process.env.GMAIL_USER?.trim() ?? '';
  const today = iso().slice(0, 10);
  const actifs: ApprovalItem[] = [];
  const exclus: ApprovalExclusion[] = [];

  /** Les états de conversation qui ferment un dossier. */
  const CLOS = new Set(['WON', 'LOST', 'NOT_INTERESTED']);
  /*
   * Un brouillon abandonne ne peut pas entrer dans cette file : il porte l'etat
   * ABANDONNE, et `draftsInState` ne rend que les READY_FOR_APPROVAL. C'est le
   * filtre d'etat qui protege, pas une verification supplementaire.
   *
   * La verification supplementaire avait d'ailleurs ete ecrite, puis retiree :
   * elle comparait l'identifiant d'un brouillon a une cle d'idempotence
   * d'envoi. Deux espaces de cles differents, donc une garde qui ne pouvait
   * jamais se declencher — et qui donnait l'impression que le cas etait couvert.
   */

  /**
   * Pourquoi ce domaine ne peut plus recevoir de décision.
   *
   * Rend `null` quand rien ne s'y oppose. Les motifs sont ordonnés du plus
   * définitif au plus circonstanciel : un envoi déjà parti prime sur une
   * réponse à lire.
   */
  const bloqueSur = (domain: string, purpose: string): string | null => {
    const registre = repos.sales.ledgerFor(domain);
    if (registre?.kind === 'DO_NOT_CONTACT') return 'registre : DO_NOT_CONTACT';

    if (purpose === 'FOLLOW_UP') {
      const relances = repos.salesLoop.followUpsFor(domain);
      if (relances > 0) return `${relances} relance(s) deja partie(s)`;
    } else {
      const parti = repos.salesLoop.lastSentTo(domain);
      if (parti !== null) return `message deja envoye le ${parti.slice(0, 10)}`;
    }

    const conversation = repos.conversations.byDomain(domain);
    if (conversation) {
      const events = repos.conversations.eventsFor(conversation.id);
      const etat = deriveConversationState(
        events.map((e) => ({
          kind: e.kind, classification: e.classification, occurredAt: e.occurredAt,
          returnDate: e.returnDate, humanReviewed: e.humanReviewed,
          declaredStatus: e.declaredStatus,
        })) as ConversationEvent[],
        { today, ledgerFollowUpAt: repos.conversations.ledgerFollowUpFor(domain) },
      );
      if (CLOS.has(etat.status)) return `dossier clos : ${etat.status}`;
      const histoire = replyHistory(events, mailbox);
      if (histoire.everHumanReplied) {
        return `reponse humaine le ${histoire.lastHumanReplyAt?.slice(0, 10)} — a lire avant`;
      }
    }
    return null;
  };

  // ── A. Les brouillons de la boucle d'outreach ───────────────────────────
  for (const d of repos.salesLoop.draftsInState('READY_FOR_APPROVAL')) {
    const motif = bloqueSur(d.domain, d.purpose);
    if (motif) {
      exclus.push({
        id: d.id, source: 'OUTREACH_DRAFT', company: d.companyName,
        domain: d.domain, sourceState: d.state, reason: motif,
      });
      continue;
    }
    const canal = classifyRecipientString(d.recipient);
    const domaineDest = classifyRecipientDomain({
      email: canal.channel === 'EMAIL' ? canal.target : null,
      prospectDomain: d.domain,
      evidence: d.sources.map((f) => ({ claim: f.quote, sourceUrl: f.sourceUrl })),
    });
    actifs.push({
      id: d.id,
      source: 'OUTREACH_DRAFT',
      prospectId: null,
      company: d.companyName,
      domain: d.domain,
      recipient: d.recipient,
      subject: d.subject,
      body: d.body,
      createdAt: d.createdAt,
      createdBy: d.createdBy,
      score: d.conversionScore,
      facts: d.sources,
      guards: [`intention ${d.purpose}`],
      actionType: canal.channel,
      channelTarget: canal.target,
      actionLabel: actionLabelFor(canal.channel),
      channelReason: canal.reason,
      recipientDomainMatch: domaineDest.match,
      recipientDomain: domaineDest.recipientDomain,
      relatedDomainEvidence: domaineDest.relatedDomainEvidence,
      domainReason: domaineDest.reason,
      sourceState: d.state,
      uiStatus: 'READY FOR APPROVAL',
      canApprove: false,
    });
  }

  // ── B. Les prospects du lot, prêts à relire ─────────────────────────────
  //
  // Le domaine sert de clé de rapprochement entre les deux magasins : c'est le
  // seul identifiant qu'ils partagent réellement. Comparer les textes serait
  // approximatif, et une approximation qui masque un brouillon est pire qu'un
  // doublon visible.
  const dejaAffiches = new Set(actifs.map((a) => a.domain));
  const prospects = repos.sales
    .batchIds()
    .flatMap((b) => repos.sales.forBatch(b))
    .filter((p) => p.state === 'READY_FOR_REVIEW' && (p.messageEmail ?? '').trim().length > 0);

  const parDomaine = new Map<string, typeof prospects>();
  for (const p of prospects) {
    const liste = parDomaine.get(p.domain ?? '') ?? [];
    liste.push(p);
    parDomaine.set(p.domain ?? '', liste);
  }

  for (const [domain, liste] of parDomaine) {
    // Un même domaine repris dans plusieurs lots : seul le plus récent est
    // actionnable, les précédents sont remplacés.
    const tries = [...liste].sort((a, b) => (a.discoveredAt < b.discoveredAt ? 1 : -1));
    const recent = tries[0]!;

    for (const ancien of tries.slice(1)) {
      exclus.push({
        id: ancien.id, source: 'SALES_PROSPECT', company: ancien.companyName,
        domain, sourceState: ancien.state,
        reason: `remplace par une version plus recente (${recent.discoveredAt.slice(0, 10)})`,
      });
    }

    if (dejaAffiches.has(domain)) {
      exclus.push({
        id: recent.id, source: 'SALES_PROSPECT', company: recent.companyName,
        domain, sourceState: recent.state,
        reason: 'deja present via outreach_drafts — affiche une seule fois',
      });
      continue;
    }

    const motif = bloqueSur(domain, 'FIRST_TOUCH');
    if (motif) {
      exclus.push({
        id: recent.id, source: 'SALES_PROSPECT', company: recent.companyName,
        domain, sourceState: recent.state, reason: motif,
      });
      continue;
    }

    /*
     * Un dossier devenu hors cible ne reste pas dans la file active.
     *
     * Trois dossiers ont ete produits quand le pays valait « France » pour tout
     * le monde : Zhejiang NPC Machinery (Chine), Diversitech Equipment & Sales
     * (Canada) et Getinge (groupe multinational). Le defaut est corrige en
     * amont, mais les lignes deja ecrites restent -- la file se construit sur
     * l'etat `READY_FOR_REVIEW`, qui ne dit rien du profil.
     *
     * Ce filtre est une LECTURE : il n'ecrit rien, ne change aucun etat, ne
     * touche a aucune preuve. Le prospect reste en base avec son etat d'origine,
     * et l'exclusion porte sa raison, sa preuve et sa date.
     *
     * Deux mecanismes existants, aucun nouveau :
     *
     *   · `countryFit` sur un pays PROUVE hors profil. Un pays inconnu n'exclut
     *     jamais a lui seul -- beaucoup de PME francaises ne publient aucune
     *     adresse, et les ecarter serait le defaut symetrique de celui qu'on
     *     vient de corriger.
     *   · `looksMultinational` sur les adresses relevees. Les chemins `/int/`,
     *     `/global/`, `/corporate/` n'existent que sur les sites qui servent
     *     plusieurs pays ; c'est un fait observable, pas une estimation
     *     d'effectif, et il suffit pour un profil qui vise 250 personnes au plus.
     */
    const paysVerdict = countryFit(recent.country, ATLAS_SALES_ICP.countries);
    const urlsObservees = [
      recent.website, recent.contactSourceUrl, recent.contactPage,
      ...repos.sales.evidenceFor(recent.id).map((e) => e.sourceUrl),
    ];
    const multinationale = looksMultinational(urlsObservees);

    if (paysVerdict.fit === 'OUT_OF_SCOPE' || multinationale) {
      const preuve = paysVerdict.fit === 'OUT_OF_SCOPE'
        ? (recent.identitySources ?? []).find((x) => x.startsWith('pays ')) ?? paysVerdict.reason
        : urlsObservees.find((u) => u != null && /\/(?:int|global|corporate|worldwide|ww)\//.test(u)) ?? '';
      exclus.push({
        id: recent.id, source: 'SALES_PROSPECT', company: recent.companyName,
        domain, sourceState: recent.state,
        reason: paysVerdict.fit === 'OUT_OF_SCOPE'
          ? `hors ICP — ${paysVerdict.reason}`
          : `hors ICP — site multi-pays : au-dela des ${ATLAS_SALES_ICP.companySize.maxEmployees ?? 250} personnes du profil`,
        evidence: preuve,
        recordedAt: recent.discoveredAt,
      });
      continue;
    }

    const verdict = classifyActionChannel({
      email: recent.contactEmail,
      phone: recent.contactPhone,
      formUrl: recent.contactPage,
      recordedMethod: recent.contactMethod,
      observed: recent.contactObserved,
    });
    const canal = recent.contactEmail ?? recent.contactPhone ?? recent.contactPage ?? null;
    if (!canal || !recent.contactObserved) {
      exclus.push({
        id: recent.id, source: 'SALES_PROSPECT', company: recent.companyName,
        domain, sourceState: recent.state,
        reason: canal ? 'canal non releve sur une page' : 'aucun canal de contact',
      });
      continue;
    }

    // Les faits cités, sans les preuves d'identité : une raison sociale établit
    // qui édite le domaine, elle ne dit rien de ce que l'entreprise fait.
    const facts = repos.sales
      .evidenceFor(recent.id)
      .filter((e) => e.sourceUrl && !e.field.startsWith('identite:'))
      .map((e) => ({ quote: e.claim, sourceUrl: e.sourceUrl! }));

    /*
     * Une adresse personnelle ne rejoint pas la file d'envoi.
     *
     * Releve sur Fujielectric : `nadia.dasilva@fujielectric.fr`, une personne
     * nommee sans fonction publiee, trouvee dans les mentions legales. Le lot
     * l'avait retenue parce qu'il prenait la premiere adresse publique au lieu
     * du contact selectionne ; le defaut est corrige en amont, mais l'ecran doit
     * aussi refuser les dossiers deja enregistres.
     */
    if (verdict.channel === 'EMAIL' && verdict.target) {
      const intent = classifyContactIntent({
        value: verdict.target, kind: 'EMAIL', sourceUrl: recent.contactSourceUrl ?? '',
      });
      const suit = outreachSuitability(intent, Boolean(recent.contactRole));
      if (intent === 'PERSONAL' || suit === 'LOW') {
        exclus.push({
          id: recent.id, source: 'SALES_PROSPECT', company: recent.companyName,
          domain, sourceState: recent.state,
          reason: `canal ${intent} / ${suit} — aucun démarchage sur cette adresse`,
        });
        continue;
      }
    }

    const domaine2 = classifyRecipientDomain({
      email: verdict.channel === 'EMAIL' ? verdict.target : null,
      prospectDomain: domain,
      evidence: repos.sales
        .evidenceFor(recent.id)
        .map((e) => ({ claim: e.claim, sourceUrl: e.sourceUrl })),
    });

    actifs.push({
      id: recent.id,
      source: 'SALES_PROSPECT',
      prospectId: recent.id,
      company: recent.companyName,
      domain,
      recipient: canal,
      // Lu en base depuis la migration 32. Rendre `null` en dur faisait
      // disparaitre un objet reellement ecrit, et laissait croire qu'aucun
      // brouillon de lot n'en portait jamais.
      subject: recent.messageSubject,
      body: recent.messageEmail ?? '',
      createdAt: recent.discoveredAt,
      createdBy: null,
      score: recent.score,
      facts,
      guards: [
        `score ${recent.score ?? 'N/A'}/100`,
        `identite ${recent.identityConfidence ?? 'N/A'}`,
        `${facts.length} fait(s) source(s)`,
      ],
      actionType: verdict.channel,
      channelTarget: verdict.target,
      actionLabel: actionLabelFor(verdict.channel),
      channelReason: verdict.reason,
      recipientDomainMatch: domaine2.match,
      recipientDomain: domaine2.recipientDomain,
      relatedDomainEvidence: domaine2.relatedDomainEvidence,
      domainReason: domaine2.reason,
      sourceState: recent.state,
      uiStatus: 'READY FOR APPROVAL',
      canApprove: false,
    });
  }

  actifs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return {
    generatedAt: iso(),
    // L'approbation humaine n'est jamais contournable depuis l'écran : cette
    // valeur est lue, jamais proposée à la modification.
    humanApprovalRequired: true,
    /**
     * Faux tant qu'aucun endpoint de mutation sécurisé n'existe. L'écran le dit
     * plutôt que de masquer les boutons : un bouton absent laisse croire à un
     * oubli, un bouton grisé avec son motif dit où en est le système.
     */
    canApprove: false,
    actionEndpoint: 'ACTION ENDPOINT UNAVAILABLE',
    byDomainMatch: {
      MATCH: actifs.filter((a) => a.actionType === 'EMAIL' && a.recipientDomainMatch === 'MATCH').length,
      CROSS_DOMAIN: actifs.filter((a) => a.recipientDomainMatch === 'CROSS_DOMAIN').length,
      UNKNOWN: actifs.filter((a) => a.actionType === 'EMAIL' && a.recipientDomainMatch === 'UNKNOWN').length,
    },
    byChannel: {
      EMAIL: actifs.filter((a) => a.actionType === 'EMAIL').length,
      FORM: actifs.filter((a) => a.actionType === 'FORM').length,
      PHONE: actifs.filter((a) => a.actionType === 'PHONE').length,
      MANUAL: actifs.filter((a) => a.actionType === 'MANUAL').length,
      UNAVAILABLE: actifs.filter((a) => a.actionType === 'UNAVAILABLE').length,
    },
    bySource: {
      OUTREACH_DRAFT: actifs.filter((a) => a.source === 'OUTREACH_DRAFT').length,
      SALES_PROSPECT: actifs.filter((a) => a.source === 'SALES_PROSPECT').length,
    },
    pending: actifs,
    /** Ce qui a été écarté, et pourquoi. L'historique reste consultable. */
    excluded: exclus,
  };
}

// ─── AGENTS ─────────────────────────────────────────────────────────────────

export function buildAgents(repos: Repositories, config: AtlasConfig, today = iso().slice(0, 10)) {
  const running = repos.tasks.list({ status: 'RUNNING', limit: 50 });
  const waiting = repos.tasks.list({ status: 'WAITING_HUMAN', limit: 50 });
  const queued = repos.tasks.list({ status: 'QUEUED', limit: 50 });
  const now = Date.now();

  const worker = (name: string, workerType: string | null, provider: string | null) => {
    const mine = workerType ? running.filter((t) => t.workerType === workerType) : running;
    const health = provider ? repos.tasks.providerHealth(provider) : null;
    const quota = health ? canRunProvider(health, now) : null;
    const last = provider ? repos.tasks.lastAiCall(provider) : null;
    const current = mine[0];

    return {
      name,
      workerType,
      provider,
      status: mine.length > 0 ? 'RUNNING'
        : quota && !quota.allowed ? 'BLOCKED'
          : 'IDLE',
      currentTask: current?.taskType ?? null,
      startedAt: current?.startedAt ?? null,
      runningMs: current?.startedAt ? now - Date.parse(current.startedAt) : null,
      attempts: current?.attemptCount ?? null,
      quota: health?.state ?? 'UNKNOWN',
      lastResult: last ? { outcome: last.outcome, at: last.occurredAt } : null,
    };
  };

  const claudeCode = detectClaudeCode(config.engineering.claudeCodeBin);

  return {
    generatedAt: iso(),
    workers: [
      worker('Hermes', null, null),
      worker('OpenAI', 'OPENAI', 'OPENAI'),
      worker('Claude (API)', 'CLAUDE', 'ANTHROPIC'),
      {
        ...worker('Claude Code', 'CLAUDE_CODE', 'ANTHROPIC'),
        // Le seul worker qui puisse être absent : c'est un binaire, pas une API.
        status: running.some((t) => t.workerType === 'CLAUDE_CODE') ? 'RUNNING'
          : claudeCode.available ? 'IDLE' : 'UNAVAILABLE',
        detail: claudeCode.available ? claudeCode.detail : 'binaire non installé',
      },
      worker('Déterministe', 'DETERMINISTIC', null),
    ],
    queue: {
      byStatus: repos.tasks.countByStatus(),
      running: running.length,
      queued: queued.length,
      waitingHuman: waiting.length,
      servedTypes: [...DEFAULT_WORKER_TYPES],
    },
    waiting: waiting.map((t) => ({
      taskId: t.taskId, taskType: t.taskType, department: t.department,
      reason: t.errorMessage ?? 'décision requise', errorCode: t.errorCode,
    })),
    needsYou: collectNeedsYou({ repos, today })
      .map(({ kind, what, why, recommendation, action }) => ({ kind, what, why, recommendation, action })),
  };
}

// ─── ORGANISATION ───────────────────────────────────────────────────────────

export function buildOrganization(repos: Repositories) {
  const departments = repos.departments.list();
  const agents = repos.agents.list();

  /**
   * Le rattachement passe par le bâtiment, pas par une clé de département.
   *
   * C'est ainsi que le modèle du village le décrit, et le recopier autrement
   * ici créerait une seconde vérité qui divergerait au premier déménagement.
   */
  const resume = (a: (typeof agents)[number]) => ({
    key: a.key,
    name: a.name,
    role: a.role,
    tier: a.tier,
    status: a.state.status,
    activity: a.state.currentActivity,
    lastActiveAt: a.state.lastActiveAt,
    model: a.model,
    enabled: a.enabled,
  });
  const batis = new Set(departments.map((d) => d.building));

  return {
    generatedAt: iso(),
    hermes: { role: 'orchestrateur', departments: departments.length, agents: agents.length },
    // La hiérarchie vient de la base : si le système évolue, l'écran suit.
    departments: departments.map((d) => ({
      key: d.key,
      name: d.name,
      tagline: d.tagline,
      building: d.building,
      /**
       * Les équipes viennent du playbook, pas d'une liste écrite à la main.
       *
       * Chaque étape déclare l'équipe qui la tient et l'agent qui l'exécute :
       * la hiérarchie est donc déjà décrite, et la recopier ici créerait une
       * seconde vérité qui divergerait au premier changement de plan.
       */
      teams: [...new Map(
        d.playbook.map((stage) => [stage.teamKey, {
          key: stage.teamKey,
          stages: d.playbook.filter((s) => s.teamKey === stage.teamKey)
            .map((s) => ({ ref: s.ref, title: s.title, agentKey: s.agentKey, action: s.action })),
        }]),
      ).values()],
      agents: agents.filter((a) => a.building === d.building).map(resume),
    })),
    unassigned: agents.filter((a) => !batis.has(a.building)).map(resume),
  };
}

// ─── FABRIQUE IA ────────────────────────────────────────────────────────────

/**
 * Les fournisseurs, décrits par leur état de connexion et rien d'autre.
 *
 * Aucune clé, aucun jeton, aucune valeur d'environnement ne traverse cette
 * fonction. Un fournisseur est « disponible » ou non ; comment il s'authentifie
 * se dit en un mot, jamais avec le secret lui-même.
 */
export function buildAiFabric(repos: Repositories, config: AtlasConfig) {
  const since = '1970-01-01T00:00:00.000Z';
  const claudeCode = detectClaudeCode(config.engineering.claudeCodeBin);
  const claudeCodeAuth = detectClaudeCodeAuth(claudeCode);

  const usage = (provider: string) => {
    const u = repos.tasks.aiUsageSince(since, provider);
    const last = repos.tasks.lastAiCall(provider);
    return {
      calls: u.calls,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      costUsd: u.calls === 0 ? null : u.knownCostUsd,
      unknownCostCalls: u.unknownCostCalls,
      lastUsedAt: last?.occurredAt ?? null,
      lastOutcome: last?.outcome ?? null,
    };
  };

  const anthropicKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  const openaiKey = Boolean(process.env.OPENAI_API_KEY?.trim());

  return {
    generatedAt: iso(),
    aiLive: config.ai.live,
    providers: [
      {
        id: 'ANTHROPIC',
        label: 'Claude (API)',
        available: anthropicKey,
        // Le mot « présente », jamais la valeur.
        auth: anthropicKey ? 'clé d’API présente' : 'aucune clé configurée',
        model: config.ai.anthropicEngineeringModel,
        priced: pricingFor(config.ai.anthropicEngineeringModel) !== null,
        health: repos.tasks.providerHealth('ANTHROPIC')?.state ?? 'UNKNOWN',
        usage: usage('ANTHROPIC'),
      },
      {
        id: 'OPENAI',
        label: 'OpenAI / ChatGPT',
        available: openaiKey,
        auth: openaiKey ? 'clé d’API présente' : 'API key not configured',
        model: config.ai.openaiReviewModel,
        priced: pricingFor(config.ai.openaiReviewModel) !== null,
        health: repos.tasks.providerHealth('OPENAI')?.state ?? 'UNKNOWN',
        usage: usage('OPENAI'),
      },
    ],
    claudeCode: {
      available: claudeCode.available,
      detail: claudeCode.detail,
      auth: claudeCodeAuth.state,
      authDetail: claudeCodeAuth.detail,
      /**
       * Le solde d'un abonnement n'est exposé par aucune API officielle.
       * L'inventer serait pire que de l'ignorer : une jauge fausse se lit
       * comme une jauge vraie.
       */
      remainingCredits: null as number | null,
      remainingCreditsNote: claudeCodeAuth.state === 'READY'
        ? 'Subscription authenticated — exact remaining credits unavailable'
        : 'authentification non constatée',
    },
    pricing: {
      configuredFile: currentPricingConfig().path,
      rejected: currentPricingConfig().rejected,
      declared: [...currentPricingConfig().entries.keys()],
    },
    routing: {
      // Le routage est déterministe et déjà en service : on l'expose, on ne
      // l'invente pas. Une capacité absente se dit absente.
      servedWorkerTypes: [...DEFAULT_WORKER_TYPES],
      multiProvider: anthropicKey && openaiKey,
      multiProviderNote: anthropicKey && openaiKey
        ? 'chaînes multi-fournisseurs possibles'
        : 'un seul fournisseur configuré : aucune chaîne multi-modèle ne peut avoir lieu',
    },
  };
}

// ─── COÛTS ──────────────────────────────────────────────────────────────────

/**
 * La dépense, lue dans les deux registres qui la portent.
 *
 * `ai_calls` reçoit les appels des workers, `llm_calls` ceux du pipeline de
 * prospection. N'en lire qu'un affichait « N/A » pendant que des milliers de
 * centimes avaient réellement été dépensés — un tableau de bord de coût qui
 * sous-déclare est pire qu'absent : il rassure.
 */
export function buildCosts(repos: Repositories, config: AtlasConfig, now = new Date()) {
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const startOfDay = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const startOfMonth = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;

  const window = (since: string) => {
    const workers = repos.tasks.aiUsageSince(since);
    const missions = repos.llmCalls.usageSince(since);
    const calls = workers.calls + missions.calls;
    const unknown = workers.unknownCostCalls + missions.unknownCostCalls;
    return {
      calls,
      inputTokens: workers.inputTokens + missions.inputTokens,
      outputTokens: workers.outputTokens + missions.outputTokens,
      // Une absence de mesure n'est pas une mesure nulle.
      costUsd: calls === 0 ? null : workers.knownCostUsd + missions.knownCostUsd,
      unknownCostCalls: unknown,
    };
  };

  const total = window('1970-01-01T00:00:00.000Z');

  return {
    generatedAt: iso(),
    windows: {
      today: window(startOfDay),
      last24h: window(at(86_400_000)),
      last7d: window(at(7 * 86_400_000)),
      month: window(startOfMonth),
      total,
    },
    byProvider: ['ANTHROPIC', 'OPENAI'].map((provider) => {
      const workers = repos.tasks.aiUsageSince('1970-01-01T00:00:00.000Z', provider);
      // Les deux registres, additionnés. Ne lire que celui des workers a déjà
      // fait afficher « N/A » sur près de sept dollars réellement dépensés.
      const missions = repos.llmCalls
        .breakdownSince('1970-01-01T00:00:00.000Z', 'provider')
        .filter((row) => row.label.toUpperCase() === provider);
      const calls = workers.calls + missions.reduce((a, r) => a + r.calls, 0);
      return {
        provider,
        calls,
        costUsd:
          calls === 0
            ? null
            : workers.knownCostUsd + missions.reduce((a, r) => a + r.knownCostUsd, 0),
        unknownCostCalls:
          workers.unknownCostCalls + missions.reduce((a, r) => a + r.unknownCostCalls, 0),
      };
    }),
    /**
     * Les ventilations fines, sur l'historique complet.
     *
     * Chacune porte son propre compte d'appels au tarif inconnu : agréger sans
     * le dire ferait passer une dépense non mesurée pour une dépense nulle,
     * exactement là où l'on cherche à savoir où part l'argent.
     */
    byModel: repos.llmCalls.breakdownSince('1970-01-01T00:00:00.000Z', 'model'),
    byAgent: repos.llmCalls.breakdownSince('1970-01-01T00:00:00.000Z', 'agent'),
    byMission: repos.llmCalls.breakdownSince('1970-01-01T00:00:00.000Z', 'mission').slice(0, 25),
    byPurpose: repos.llmCalls.breakdownSince('1970-01-01T00:00:00.000Z', 'purpose'),
    byDepartment: repos.tasks.aiBreakdownSince('1970-01-01T00:00:00.000Z', 'department'),
    workerByModel: repos.tasks.aiBreakdownSince('1970-01-01T00:00:00.000Z', 'model'),
    /** Ce que la prospection a coûté : les appels dont l'intention le dit. */
    salesLoop: (() => {
      const rows = repos.llmCalls
        .breakdownSince('1970-01-01T00:00:00.000Z', 'purpose')
        .filter((row) => /sales|prospect|outreach|qualification/i.test(row.label));
      const calls = rows.reduce((a, r) => a + r.calls, 0);
      return {
        calls,
        costUsd: calls === 0 ? null : rows.reduce((a, r) => a + r.knownCostUsd, 0),
        unknownCostCalls: rows.reduce((a, r) => a + r.unknownCostCalls, 0),
        purposes: rows.map((r) => r.label),
      };
    })(),
    budgets: {
      dailyMode: config.ai.dailyBudgetMode,
      monthlyMode: config.ai.monthlyBudgetMode,
      maxChainCostUsd: config.ai.maxChainCostUsd,
      maxMissionCostUsd: config.budget.maxMissionCostUsd,
      salesBudgetUsd: config.sales.maxBudgetUsd,
      unknownCostPolicy: config.ai.unknownCostPolicy,
      // Un plafond illimité n'a pas de reste : le dire vaut mieux qu'un chiffre.
      remainingToday: config.ai.dailyBudgetMode === 'UNLIMITED' ? null : undefined,
    },
    /**
     * Un appel sans tarif connu est compté à part, jamais à zéro. C'est ce
     * comptage qui alimente `COST_UNKNOWN_BLOCKED` : le masquer reviendrait à
     * désarmer le garde-fou depuis l'écran.
     */
    unknownPriceCalls: total.unknownCostCalls,
  };
}

// ─── SANTÉ DU SYSTÈME ───────────────────────────────────────────────────────

export type HealthState = 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'BLOCKED' | 'UNKNOWN';

export async function buildSystemHealth(
  repos: Repositories,
  config: AtlasConfig,
  logger: Logger,
) {
  const inbox = new GmailInboxProvider({ logger }).status();
  const outbound = new GmailOutboundProvider({});
  try {
    await outbound.verifyScopes();
  } catch { /* un jeton illisible se rapporte plus bas, il n'interrompt rien */ }
  const send = outbound.status();

  const searxngUrl = config.search.searxngBaseUrl?.trim() ?? null;
  let searxng: HealthState = 'UNKNOWN';
  let searxngDetail = 'aucune instance configurée';
  if (searxngUrl) {
    try {
      const response = await fetch(`${searxngUrl}/healthz`, {
        signal: AbortSignal.timeout(4000),
      });
      searxng = response.ok ? 'HEALTHY' : 'DEGRADED';
      searxngDetail = `${searxngUrl} — HTTP ${response.status}`;
    } catch {
      searxng = 'OFFLINE';
      searxngDetail = `${searxngUrl} — injoignable`;
    }
  }

  const claudeCode = detectClaudeCode(config.engineering.claudeCodeBin);
  const run = repos.tasks.lastDaemonRun();
  const backups = repos.ops.listBackups(50);

  let repoDetail = 'N/A';
  try {
    const state = inspectRepo(process.cwd());
    repoDetail = state.clean ? 'propre' : `${state.dirtyFiles.length} fichier(s) non commité(s)`;
  } catch { repoDetail = 'pas un dépôt git'; }

  const components: Array<{ id: string; label: string; state: HealthState; detail: string }> = [
    { id: 'database', label: 'DATABASE', state: 'HEALTHY',
      detail: `${Object.values(repos.tasks.countByStatus()).reduce((s, n) => s + n, 0)} tâche(s)` },
    { id: 'gmail_read', label: 'GMAIL READ', state: inbox.configured ? 'HEALTHY' : 'OFFLINE', detail: inbox.detail },
    // BLOCKED dit vrai : rien ne part. Mais une porte fermée sur une
    // autorisation complète n'est pas une portée manquante — le détail le dit.
    { id: 'gmail_send', label: 'GMAIL SEND', state: send.configured ? 'HEALTHY' : 'BLOCKED',
      detail: send.code === 'OUTBOUND_DISABLED' && outbound.authorization().authReady
        ? `${send.detail} Autorisation d’envoi complète (gmail.send constatée) : seul l’interrupteur ferme.`
        : send.detail },
    { id: 'searxng', label: 'SEARXNG', state: searxng, detail: searxngDetail },
    { id: 'claude', label: 'CLAUDE', state: claudeCode.available ? 'HEALTHY' : 'OFFLINE',
      detail: claudeCode.available ? claudeCode.detail : 'binaire non installé' },
    { id: 'openai', label: 'OPENAI', state: process.env.OPENAI_API_KEY?.trim() ? 'HEALTHY' : 'OFFLINE',
      detail: process.env.OPENAI_API_KEY?.trim() ? 'clé présente' : 'API key not configured' },
    { id: 'queue', label: 'QUEUE', state: 'HEALTHY', detail: `${repos.tasks.list({ status: 'QUEUED', limit: 1 }).length > 0 ? 'travail en attente' : 'vide'}` },
    { id: 'scheduler', label: 'SCHEDULER', state: run ? (run.stoppedAt ? 'OFFLINE' : 'HEALTHY') : 'UNKNOWN',
      detail: run ? (run.stoppedAt ? `arrêté ${run.stoppedAt.slice(0, 16).replace('T', ' ')}` : 'en cours') : 'jamais lancé' },
    { id: 'backups', label: 'BACKUPS', state: backups.length > 0 ? 'HEALTHY' : 'UNKNOWN',
      detail: backups.length > 0 ? `${backups.length} copie(s)` : 'aucune copie consignée' },
    { id: 'repo', label: 'DÉPÔT', state: 'HEALTHY', detail: repoDetail },
    { id: 'api', label: 'API', state: 'HEALTHY', detail: 'répond' },
  ];

  const worst: HealthState = components.some((c) => c.state === 'OFFLINE') ? 'DEGRADED'
    : components.some((c) => c.state === 'BLOCKED') ? 'DEGRADED'
      : components.some((c) => c.state === 'UNKNOWN') ? 'DEGRADED' : 'HEALTHY';

  return {
    generatedAt: iso(),
    overall: worst,
    autonomy: AUTONOMY_LEVELS[1],
    aiLive: config.ai.live,
    components,
  };
}

// ─── BOUCLE DE PROSPECTION ──────────────────────────────────────────────────

/**
 * Les étapes de la boucle, dans l'ordre où elles s'enchaînent réellement.
 *
 * La liste décrit le pipeline existant ; elle ne le pilote pas. Chaque étape
 * rend ce que la base en sait — un compte, une date, un coût — et `UNKNOWN`
 * quand rien ne permet de répondre. Une étape affichée « prête » alors qu'aucune
 * mesure ne l'atteste serait une décoration, et une décoration sur un tableau
 * de bord finit par être lue comme une mesure.
 */
export const LOOP_STAGES = [
  { id: 'DISCOVER', label: 'Discover' },
  { id: 'SEARCH', label: 'Search Fabric' },
  { id: 'ENTITY_RESOLUTION', label: 'Entity Resolution' },
  { id: 'ICP_FILTER', label: 'ICP Filter' },
  { id: 'QUALIFICATION', label: 'Qualification' },
  { id: 'CONTACT_RESOLUTION', label: 'Contact Resolution' },
  { id: 'DUPLICATE_CHECK', label: 'Duplicate Check' },
  { id: 'DRAFT', label: 'Draft' },
  { id: 'READY_FOR_APPROVAL', label: 'Ready for Approval' },
  { id: 'SEND', label: 'Send' },
  { id: 'WAIT_FOR_REPLY', label: 'Wait for Reply' },
  { id: 'FOLLOW_UP', label: 'Follow-up' },
  { id: 'CLOSED', label: 'Won / Lost' },
] as const;

export function buildProspecting(repos: Repositories, config: AtlasConfig, today = iso().slice(0, 10)) {
  const list = dossiers(repos, config, today);
  const batches = repos.sales.batchIds();
  const latest = repos.sales.latestBatchId();
  const prospects = latest ? repos.sales.forBatch(latest) : [];

  /**
   * Le coût du dernier lot, lu dans le registre des appels de modèle.
   *
   * Les batches ne portent pas leur coût : il est consigné par appel. On borne
   * donc la fenêtre au premier prospect du lot — approximation assumée et dite,
   * plutôt qu'un chiffre exact qui n'existe pas.
   */
  const debut = prospects.length > 0
    ? prospects.map((p) => p.discoveredAt).reduce((a, b) => (a <= b ? a : b))
    : null;
  const usage = debut ? repos.llmCalls.usageSince(debut) : null;

  const qualifies = prospects.filter((p) => (p.score ?? 0) > 0);
  const contactables = prospects.filter((p) => repos.sales.channelsFor(p.id).length > 0);
  const drafts = repos.salesLoop.draftsInState('READY_FOR_APPROVAL');

  const count = (id: string): number | null => {
    switch (id) {
      case 'DISCOVER': return prospects.length;
      case 'SEARCH': return prospects.length === 0 ? null : prospects.length;
      case 'ENTITY_RESOLUTION': return prospects.length;
      case 'ICP_FILTER': return qualifies.length;
      case 'QUALIFICATION': return qualifies.length;
      case 'CONTACT_RESOLUTION': return contactables.length;
      /**
       * Aucune mesure par cycle n'existe pour cette étape.
       *
       * Le nombre de domaines déjà connus — cent soixante-douze — est un total
       * à vie. Posé au milieu d'un pipeline dont chaque autre case compte le
       * lot courant, il se lisait « cent soixante-douze doublons ce cycle ».
       * Le total garde sa place ailleurs, nommé pour ce qu'il est.
       */
      case 'DUPLICATE_CHECK': return null;
      case 'DRAFT': return drafts.length;
      case 'READY_FOR_APPROVAL': return drafts.length;
      case 'SEND': return repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z');
      case 'WAIT_FOR_REPLY': return list.filter((d) => !d.everReplied && d.state === 'CONTACTED').length;
      case 'FOLLOW_UP': return list.filter((d) => d.followUpDue).length;
      case 'CLOSED': return list.filter((d) => d.state === 'WON' || d.state === 'LOST').length;
      default: return null;
    }
  };

  return {
    generatedAt: iso(),
    // Aucun cycle n'est « en cours » tant qu'aucune tâche ne tourne : le dire
    // vaut mieux qu'une animation qui laisserait croire à une activité.
    running: repos.tasks.list({ status: 'RUNNING', limit: 5 }).length > 0,
    cycles: batches.length,
    latestBatch: latest,
    latestBatchStartedAt: debut,
    stages: LOOP_STAGES.map((stage) => ({
      id: stage.id,
      label: stage.label,
      count: count(stage.id),
    })),
    lastCycle: latest === null ? null : {
      batchId: latest,
      discovered: prospects.length,
      qualified: qualifies.length,
      contactable: contactables.length,
      drafts: drafts.length,
      modelCalls: usage?.calls ?? null,
      costUsd: usage && usage.calls > 0 ? usage.knownCostUsd : null,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
    },
    /**
     * Le registre global, nommé pour ce qu'il est : un total à vie.
     *
     * C'est contre lui que la déduplication travaille, et c'est pour cela qu'il
     * mérite d'être affiché — mais à côté du pipeline, pas dedans.
     */
    registryDomains: repos.sales.knownDomains().size,
    guards: {
      humanApprovalRequired: config.sales.humanApprovalRequired,
      minConversionScore: config.sales.minConversionScore,
      maxNewOutreachPerDay: config.sales.maxNewOutreachPerDay,
      budgetUsd: config.sales.maxBudgetUsd,
    },
  };
}

// ─── BOÎTE DE RÉCEPTION ─────────────────────────────────────────────────────

/**
 * Les messages liés à la prospection, et eux seuls.
 *
 * Une boîte personnelle contient surtout autre chose : des lettres
 * d'information, des factures, du démarchage. Les mêler aux réponses de
 * prospects rendrait la vue illisible le jour où elle compte. Le reste existe
 * et reste consultable, dans une catégorie à part.
 */
export function buildInbox(repos: Repositories, limit = 200) {
  const conversations = repos.conversations.all();
  const messages: Array<{
    at: string; domain: string; company: string; classification: string;
    subject: string | null; sender: string | null; excerpt: string | null;
    humanReviewed: boolean;
  }> = [];

  for (const cv of conversations) {
    for (const e of repos.conversations.eventsFor(cv.id)) {
      if (e.kind === 'CORRECTION') continue;
      messages.push({
        at: e.occurredAt,
        domain: cv.canonicalDomain,
        company: cv.companyName,
        classification: e.classification,
        subject: e.rawSubject,
        sender: e.sender,
        excerpt: e.bodyExcerpt?.slice(0, 240) ?? null,
        humanReviewed: e.humanReviewed,
      });
    }
  }
  messages.sort((a, b) => (a.at < b.at ? 1 : -1));

  const of = (...kinds: string[]) => messages.filter((m) => kinds.includes(m.classification));

  return {
    generatedAt: iso(),
    total: messages.length,
    categories: {
      humanReplies: of('REPLIED').slice(0, limit),
      autoReplies: of('AUTO_REPLY').slice(0, limit),
      bounces: of('BOUNCED').slice(0, limit),
      needsAction: of('NEEDS_REVIEW', 'NEEDS_INFO').slice(0, limit),
    },
    /**
     * Les messages sans rattachement vivent dans le journal d'import, pas ici :
     * les remonter dans la vue principale la noierait sous la publicité. Aucun
     * compteur n'est exposé pour l'instant — `null` le dit, plutôt qu'un zéro
     * qui se lirait « aucun message non rattaché ».
     */
    unmatched: null as number | null,
  };
}

// ─── SEARCH FABRIC ──────────────────────────────────────────────────────────

/**
 * Les moteurs de recherche, et ce qu'ils ont réellement fait.
 *
 * Deux sources, et la distinction compte assez pour être écrite à l'écran.
 *
 * L'état vient du Fabric vivant du serveur : quels moteurs sont enregistrés,
 * lequel serait choisi maintenant, lequel est écarté et pourquoi. C'est de la
 * configuration observée, pas de l'historique — les compteurs d'un Fabric
 * meurent avec le processus qui l'a créé.
 *
 * Les volumes viennent de `tool_calls`, qui survit au redémarrage et enregistre
 * ce que *tous* les processus ont appelé — y compris un lot de prospection
 * lancé en ligne de commande, dont le serveur n'a jamais rien su.
 *
 * Mélanger les deux donnerait un tableau qui semble complet et ne l'est pas.
 */
export function buildSearchFabric(
  repos: Repositories,
  config: AtlasConfig,
  fabric: { statuses: () => unknown[]; plan: () => unknown; availability: () => unknown } | null,
) {
  const day = `${iso().slice(0, 10)}T00:00:00.000Z`;
  const usage = repos.toolCalls.usageSince('1970-01-01T00:00:00.000Z');
  const today = repos.toolCalls.usageSince(day);

  /**
   * Ce qui touche réellement le web.
   *
   * Le nom de l'outil ne suffit pas à le dire : `memory_search` en porte le mot
   * et n'interroge que la base locale. Filtré au nom, il gonflait le compte de
   * requêtes de soixante-quatorze appels à deux millisecondes — un chiffre
   * plausible, faux, et qui faisait passer la recherche web pour instantanée.
   *
   * La catégorie et le drapeau `external` le disent, eux : seul un appel sorti
   * d'ATLAS compte.
   */
  const onWeb = (r: { category: string | null; external: number }) =>
    r.category === 'research' && r.external > 0;
  const searchLike = (tool: string) => /discover|search|serp|query/i.test(tool);
  const fetchLike = (tool: string) => !searchLike(tool);
  const sum = (rows: typeof usage, keep: (t: string) => boolean) =>
    rows.filter((r) => onWeb(r) && keep(r.tool)).reduce(
      (a, r) => ({
        calls: a.calls + r.calls,
        failures: a.failures + r.failures,
        // Moyenne pondérée : la moyenne des moyennes ment dès que les volumes
        // diffèrent, et ils diffèrent toujours.
        weighted: a.weighted + r.avgDurationMs * r.calls,
        lastAt: !r.lastAt ? a.lastAt : a.lastAt && a.lastAt > r.lastAt ? a.lastAt : r.lastAt,
      }),
      { calls: 0, failures: 0, weighted: 0, lastAt: null as string | null },
    );

  const queries = sum(usage, searchLike);
  const pages = sum(usage, fetchLike);
  const queriesToday = sum(today, searchLike);

  type Status = {
    id: string; name: string; health: string; available: boolean;
    availabilityReason?: string | null;
    metrics?: { calls?: number; failures?: number; averageLatencyMs?: number; lastSuccessAt?: string | null };
    circuit?: { state?: string } | null;
    priority?: number;
  };
  const statuses = (fabric?.statuses() ?? []) as Status[];
  const plan = fabric?.plan() as
    | { order?: Array<{ record?: { id?: string }; excluded?: string | null }>; blocked?: boolean; blockedReason?: string | null }
    | undefined;

  const order = (plan?.order ?? [])
    .map((c) => c.record?.id)
    .filter((id): id is string => typeof id === 'string');

  return {
    generatedAt: iso(),
    /** Sans moteur configuré, rien n'est « en panne » : rien n'est branché. */
    configured: fabric !== null,
    mode: config.search.provider,
    fallbackEnabled: config.search.fallbackEnabled,
    blocked: plan?.blocked === true,
    blockedReason: plan?.blockedReason ?? null,
    /** L'ordre de bascule tel qu'il serait appliqué maintenant. */
    routingOrder: order,
    /** Le moteur qui répondrait en premier, et son remplaçant. */
    primary: order[0] ?? null,
    fallback: order[1] ?? null,
    engines: statuses.map((s) => ({
      id: s.id,
      name: s.name,
      health: (s.health ?? 'unknown').toUpperCase() as 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN',
      available: s.available === true,
      reason: s.availabilityReason ?? null,
      circuit: s.circuit?.state ?? null,
      inRoutingOrder: order.includes(s.id),
      /**
       * Les compteurs du processus courant. Redémarré, il repart de zéro —
       * ce que le libellé doit dire, faute de quoi « 0 appel » se lit
       * « ce moteur ne sert jamais ».
       */
      sessionCalls: s.metrics?.calls ?? null,
      sessionFailures: s.metrics?.failures ?? null,
      sessionLatencyMs: s.metrics?.averageLatencyMs ?? null,
      lastSuccessAt: s.metrics?.lastSuccessAt ?? null,
    })),
    /** Ce que la base retient, tous processus et tous redémarrages confondus. */
    ledger: {
      queries: queries.calls,
      queryFailures: queries.failures,
      queriesToday: queriesToday.calls,
      avgQueryMs: queries.calls === 0 ? null : Math.round(queries.weighted / queries.calls),
      pagesVisited: pages.calls,
      pageFailures: pages.failures,
      avgPageMs: pages.calls === 0 ? null : Math.round(pages.weighted / pages.calls),
      lastActivityAt: queries.lastAt ?? pages.lastAt,
      /** Aucun compteur ne mesure les entités extraites : `null`, pas zéro. */
      entities: null as number | null,
    },
    byTool: usage.filter(onWeb),
    recentFailures: repos.toolCalls.failuresSince('1970-01-01T00:00:00.000Z', 8),
  };
}

// ─── CHAÎNE MULTI-MODÈLE ────────────────────────────────────────────────────

/**
 * Les missions où plusieurs modèles sont réellement intervenus.
 *
 * Constaté, jamais mis en scène. Une conversation entre deux modèles est facile
 * à dessiner et n'existe pas ici : ce que la base contient, ce sont des appels
 * facturés, avec leur fournisseur, leur modèle et leur intention. Quand une
 * mission n'en compte qu'un, elle n'apparaît pas — plutôt que d'inventer un
 * second intervenant pour remplir le schéma.
 */
export function buildMultiModelTrace(repos: Repositories, limit = 12) {
  const missions = repos.llmCalls.multiModelMissions(limit);

  return {
    generatedAt: iso(),
    missions: missions.map((m) => {
      const mission = repos.missions.get(m.missionId);
      return {
        missionId: m.missionId,
        title: mission?.title ?? null,
        status: mission?.status ?? null,
        providers: m.providers,
        models: m.models,
        startedAt: m.startedAt,
        lastAt: m.lastAt,
        steps: m.steps.map((s) => ({
          provider: s.provider,
          model: s.model,
          agentKey: s.agentKey,
          purpose: s.purpose,
          calls: s.calls,
          failures: s.failures,
          costUsd: s.calls === 0 ? null : s.knownCostUsd,
          unknownCostCalls: s.unknownCostCalls,
          firstAt: s.firstAt,
          lastAt: s.lastAt,
        })),
      };
    }),
    /**
     * Zéro mission multi-modèle est un fait, pas une panne : tant qu'un seul
     * fournisseur répond, une chaîne à deux ne peut pas exister.
     */
    note:
      missions.length === 0
        ? 'Aucune mission n’a fait intervenir deux modèles distincts. Une chaîne multi-modèle suppose deux fournisseurs joignables.'
        : null,
  };
}

// ─── OUTREACH ───────────────────────────────────────────────────────────────

/**
 * Ce qui est parti, et ce qui attend de partir.
 *
 * Le registre des envois fait foi. Une réservation sans événement `SENT` n'est
 * pas un envoi : c'est une place prise dont on ne sait pas encore l'issue, et
 * quatre d'entre elles ont un jour bloqué autant de relances approuvées. Elles
 * apparaissent donc, séparément, avec leur état — plutôt que d'être comptées
 * comme des envois ou passées sous silence.
 */
export function buildOutreach(repos: Repositories, config: AtlasConfig, today = iso().slice(0, 10)) {
  const log = repos.salesLoop.sentLog(150);
  const sent = log.filter((row) => row.phase === 'SENT');
  const pending = log.filter((row) => row.phase === null);
  const sentToday = repos.salesLoop.sentSince(`${today}T00:00:00.000Z`);
  const drafts = repos.salesLoop.draftsInState('READY_FOR_APPROVAL');
  const approved = repos.salesLoop.draftsInState('APPROVED_TO_SEND');

  const byPurpose = new Map<string, number>();
  for (const row of sent) byPurpose.set(row.purpose, (byPurpose.get(row.purpose) ?? 0) + 1);

  return {
    generatedAt: iso(),
    metrics: {
      messagesSent: repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z'),
      sentToday,
      dailyCap: config.sales.maxNewOutreachPerDay,
      dailyRemaining: Math.max(0, config.sales.maxNewOutreachPerDay - sentToday),
      readyForApproval: drafts.length,
      approvedNotSent: approved.length,
      /** Places prises sans issue consignée : à décider par une personne. */
      reservedWithoutOutcome: pending.length,
    },
    byPurpose: [...byPurpose.entries()].map(([purpose, count]) => ({ purpose, count })),
    sent: sent.slice(0, 60).map((row) => ({
      domain: row.domain,
      recipient: row.recipient,
      subject: row.subject,
      purpose: row.purpose,
      at: row.occurredAt,
      by: row.claimedBy,
      messageId: row.externalMessageId,
    })),
    reserved: pending.slice(0, 30).map((row) => ({
      domain: row.domain,
      recipient: row.recipient,
      subject: row.subject,
      purpose: row.purpose,
      claimedAt: row.claimedAt,
      claimedBy: row.claimedBy,
      key: row.idempotencyKey.slice(0, 16),
    })),
    abandonments: repos.salesLoop.abandonments().slice(0, 20),
  };
}

// ─── RELANCES ───────────────────────────────────────────────────────────────

/**
 * Les relances dues, et celles qui ne le sont pas encore.
 *
 * La décision vient de `evaluateFollowUp`, la même fonction que la ligne de
 * commande interroge. Recalculer une échéance ici produirait un second avis sur
 * la même question, et deux avis finissent toujours par diverger.
 */
export function buildFollowUps(repos: Repositories, config: AtlasConfig, today = iso().slice(0, 10)) {
  const list = dossiers(repos, config, today);
  const due = list.filter((d) => d.followUpDue);
  const waiting = list.filter((d) => !d.followUpDue && !d.everReplied);

  return {
    generatedAt: iso(),
    afterBusinessDays: config.sales.followUpAfterDays,
    metrics: {
      due: due.length,
      waiting: waiting.length,
      replied: list.filter((d) => d.everReplied).length,
      contacted: list.length,
    },
    due: due.map((d) => ({
      domain: d.domain,
      name: d.companyName,
      state: d.state,
      contactedOn: d.contactedOn,
      lastOutboundAt: d.lastOutboundAt,
      followUpsSent: d.followUpsSent,
      reason: d.followUpReason,
    })),
    waiting: waiting.map((d) => ({
      domain: d.domain,
      name: d.companyName,
      state: d.state,
      contactedOn: d.contactedOn,
      followUpsSent: d.followUpsSent,
      reason: d.followUpReason,
    })),
  };
}

// ─── ANALYTIQUE ─────────────────────────────────────────────────────────────

/**
 * Les tendances, lues sur les deux registres de dépense et sur les envois.
 *
 * Rien n'est extrapolé, rien n'est lissé. Un jour sans appel n'apparaît pas
 * comme un zéro : il n'apparaît pas, ce qui est la seule façon honnête de
 * représenter une absence de mesure sur un graphique.
 */
export function buildAnalytics(repos: Repositories, config: AtlasConfig, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const today = now.toISOString().slice(0, 10);

  const missionDays = repos.llmCalls.dailySince(since);
  const workerDays = repos.tasks.aiDailySince(since);
  const days = new Map<string, { calls: number; knownCostUsd: number; unknownCostCalls: number }>();
  for (const row of [...missionDays, ...workerDays]) {
    const entry = days.get(row.day) ?? { calls: 0, knownCostUsd: 0, unknownCostCalls: 0 };
    entry.calls += row.calls;
    entry.knownCostUsd += row.knownCostUsd;
    entry.unknownCostCalls += row.unknownCostCalls;
    days.set(row.day, entry);
  }

  const war = buildWarRoom(repos, config, today);
  const sends = new Map(repos.salesLoop.sentByDay(since).map((r) => [r.day, r.sent]));

  return {
    generatedAt: iso(),
    windowDays: 30,
    daily: [...days.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, entry]) => ({
        day,
        calls: entry.calls,
        costUsd: entry.calls === 0 ? null : entry.knownCostUsd,
        unknownCostCalls: entry.unknownCostCalls,
        sent: sends.get(day) ?? 0,
      })),
    funnel: war.funnel,
    conversion: {
      contacted: war.metrics.contacted,
      replied: war.metrics.everReplied,
      replyRate: war.metrics.replyRate,
      positive: war.metrics.positiveReplies,
      positiveRate:
        war.metrics.contacted === 0 ? null : war.metrics.positiveReplies / war.metrics.contacted,
      paidClients: war.metrics.paidClients,
      revenueEur: war.metrics.revenueEur,
      /** Le coût d'acquisition n'a de sens qu'avec au moins un client payant. */
      costPerClientUsd:
        war.metrics.paidClients === 0
          ? null
          : (buildCosts(repos, config, now).windows.total.costUsd ?? 0) / war.metrics.paidClients,
    },
    costByProvider: repos.llmCalls.breakdownSince('1970-01-01T00:00:00.000Z', 'provider'),
    costByModel: repos.llmCalls.breakdownSince('1970-01-01T00:00:00.000Z', 'model'),
    costByAgent: repos.llmCalls.breakdownSince('1970-01-01T00:00:00.000Z', 'agent'),
    costByPurpose: repos.llmCalls.breakdownSince('1970-01-01T00:00:00.000Z', 'purpose'),
    workerByModel: repos.tasks.aiBreakdownSince('1970-01-01T00:00:00.000Z', 'model'),
    workerByDepartment: repos.tasks.aiBreakdownSince('1970-01-01T00:00:00.000Z', 'department'),
  };
}
