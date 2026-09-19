/**
 * L'état de la vente, en un écran.
 *
 * Un tableau de bord commercial se juge à une seule chose : est-ce qu'il dit
 * quoi faire maintenant. Les compteurs qui ne débouchent sur aucune action —
 * nombre de sociétés lues, taux d'ouverture — flattent sans informer, et
 * finissent par masquer les deux lignes qui comptent : qui attend une réponse
 * de moi, et qui attend que je l'approuve.
 *
 * Aucune recherche, aucun modèle, aucun envoi. Tout est relu depuis la base.
 *
 *   npm run sales:war-room
 */
import { createLogger, loadConfig } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  deriveConversationState,
  shouldNotify,
  evaluateFollowUp,
  replyHistory,
  type ConversationEvent,
  type ConversationStatus,
} from '../packages/departments/src/index.ts';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());
const repos = createRepositories(config.paths.databaseFile, logger);
const today = flag('today') ?? new Date().toISOString().slice(0, 10);

const heading = (title: string) => {
  console.log(`\n  ${c.bold}${title}${c.reset}`);
};
const line = (label: string, value: string | number, note = '') =>
  console.log(`    ${String(label).padEnd(26)}${String(value).padStart(5)}  ${c.dim}${note}${c.reset}`);

console.log(`\n  ${c.bold}${c.cyan}SALES WAR ROOM${c.reset}  ${c.dim}au ${today}${c.reset}`);


// ─── Ce qui attend une décision ─────────────────────────────────────────────

const drafts = repos.salesLoop.draftsInState('READY_FOR_APPROVAL');
heading(`À RELIRE — ${drafts.length}`);
if (drafts.length === 0) console.log(`    ${c.dim}rien en attente.${c.reset}`);
for (const d of drafts.slice(0, 12)) {
  console.log(
    `    ${c.amber}${(d.companyName ?? d.domain).slice(0, 28).padEnd(30)}${c.reset}` +
      `${String(d.conversionScore ?? '—').padStart(4)}/100  ${d.recipient.padEnd(32)}${c.dim}${d.id}${c.reset}`,
  );
}

// ─── Les conversations, et ce qu'il en revient ──────────────────────────────

const boite = process.env.GMAIL_USER?.trim() ?? '';
const conversations = repos.conversations.all();

/**
 * Les dossiers du tableau : le registre fait foi, la conversation est un plus.
 *
 * Le War Room parcourait les conversations. Deux entreprises marquees
 * CONTACTEES n'en avaient aucune — le contact avait ete pris par formulaire web,
 * sans fil de courriel — et elles etaient donc absentes de l'entonnoir, absentes
 * des relances, absentes de tout. Elles n'apparaissaient nulle part comme
 * oubliees : elles n'apparaissaient pas.
 *
 * Le registre est la seule liste qui sache qui a ete contacte. Une conversation
 * dit ce qui s'est echange ensuite ; son absence est une information — personne
 * n'a repondu, et il n'y a meme pas de fil — pas un motif de disparaitre.
 */
interface Dossier {
  domain: string;
  companyName: string;
  conversationId: string | null;
  contactedOn: string;
}

const parDomaine = new Map(conversations.map((cv) => [cv.canonicalDomain, cv]));
const dossiers: Dossier[] = repos.sales.ledgerDomains()
  .filter((d) => d.kind === 'CONTACTED')
  .map((inscrit) => {
    const cv = parDomaine.get(inscrit.domain);
    return {
      domain: inscrit.domain,
      companyName: cv?.companyName ?? inscrit.domain,
      conversationId: cv?.id ?? null,
      contactedOn: (cv?.firstContactAt ?? inscrit.recordedAt).slice(0, 10),
    };
  });
const stateOf = (id: string | null) => {
  const events = (id ? repos.conversations.eventsFor(id) : []).map((e) => ({
    kind: e.kind,
    classification: e.classification,
    occurredAt: e.occurredAt,
    returnDate: e.returnDate,
    humanReviewed: e.humanReviewed,
    declaredStatus: (e.declaredStatus as ConversationStatus | null) ?? null,
  })) as ConversationEvent[];
  return { state: deriveConversationState(events, { today }), events };
};

const byStatus = new Map<ConversationStatus, string[]>();
const needAttention: Array<{ company: string; status: ConversationStatus; action: string }> = [];

for (const dossier of dossiers) {
  const { state, events } = stateOf(dossier.conversationId);
  byStatus.set(state.status, [...(byStatus.get(state.status) ?? []), dossier.companyName]);

  const last = events.at(-1);
  const notification = shouldNotify({
    status: state.status,
    classification: last?.classification ?? 'NEEDS_REVIEW',
    confidence: 0.9,
    subject: null,
    bodyExcerpt: null,
  });
  if (notification.decision === 'NOTIFY') {
    needAttention.push({
      company: dossier.companyName,
      status: state.status,
      action: notification.recommendedNextAction,
    });
  }
}

/**
 * L'entonnoir, bâti sur le registre plutôt que sur les transitions de boucle.
 *
 * Il lisait `stateCounts()` — la table des transitions commerciales — pendant
 * que l'audit lisait le registre. Deux machines à états, deux totaux : une
 * entreprise inscrite au registre sans transition de boucle n'apparaissait
 * nulle part, et une entreprise passée en `FOLLOW_UP_SCHEDULED` sortait du
 * décompte faute de ligne pour l'accueillir. Le tableau annonçait treize
 * entreprises là où le registre en comptait quatorze, sans que rien ne dise
 * laquelle manquait.
 *
 * La liste est donc exhaustive par construction : les états connus dans un ordre
 * lisible, puis tout état inattendu ajouté à la fin. La somme est affichée et
 * comparée au registre — un entonnoir dont le total ne retombe pas sur ses
 * pieds ne se lit plus, il se devine.
 */
const ORDRE_ENTONNOIR: ReadonlyArray<[ConversationStatus, string, string]> = [
  ['CONTACTED', 'contacté', 'message parti, rien reçu'],
  ['AUTO_REPLY', 'réponse automatique', 'une machine a répondu'],
  ['BOUNCED', 'non délivré', 'adresse à revoir'],
  ['NEEDS_REVIEW', 'à qualifier', 'une personne doit lire'],
  ['REPLIED', 'a répondu', 'attend une décision de votre part'],
  ['NEEDS_INFO', 'demande des précisions', ''],
  ['INTERESTED', 'intéressé', ''],
  ['MEETING_REQUESTED', 'rendez-vous demandé', ''],
  ['FOLLOW_UP_SCHEDULED', 'relance programmée', 'nous avons répondu, la balle est chez eux'],
  ['FOLLOW_UP_REQUIRED', 'relance à préparer', ''],
  ['NOT_INTERESTED', 'refus explicite', 'plus rien ne part'],
  ['WON', 'gagné', ''],
  ['LOST', 'perdu', ''],
];

heading('ENTONNOIR');
let totalEntonnoir = 0;
for (const [etat, libelle, note] of ORDRE_ENTONNOIR) {
  const n = byStatus.get(etat)?.length ?? 0;
  totalEntonnoir += n;
  line(libelle, n, note);
}

// Tout état qui n'aurait pas sa ligne : mieux vaut une ligne inattendue qu'une
// entreprise qui disparaît.
for (const [etat, noms] of byStatus) {
  if (ORDRE_ENTONNOIR.some(([connu]) => connu === etat)) continue;
  totalEntonnoir += noms.length;
  line(`${etat} (non prévu)`, noms.length, noms.join(', '));
}

const inscrites = dossiers.length;
line(
  'total',
  totalEntonnoir,
  totalEntonnoir === inscrites
    ? `registre : ${inscrites} entreprise(s) contactée(s)`
    : `${c.red}écart avec le registre (${inscrites})${c.reset}`,
);

// Les états de la boucle commerciale, qui précèdent le contact : ils vivent sur
// un autre axe et ne se mélangent pas au décompte ci-dessus.
const states = repos.salesLoop.stateCounts();
const at = (state: string) => states[state] ?? 0;
if (at('QUALIFYING') + at('READY_FOR_APPROVAL') + at('APPROVED_TO_SEND') > 0) {
  console.log(`    ${c.dim}avant contact : qualification ${at('QUALIFYING')} · `
    + `à relire ${at('READY_FOR_APPROVAL')} · approuvé non parti ${at('APPROVED_TO_SEND')}${c.reset}`);
}

heading(`RÉPONSES QUI APPELLENT UNE DÉCISION — ${needAttention.length}`);
if (needAttention.length === 0) console.log(`    ${c.dim}aucune. Rien à décider dans l'immédiat.${c.reset}`);
for (const item of needAttention) {
  console.log(`    ${c.green}${item.company.slice(0, 28).padEnd(30)}${c.reset}${item.status.padEnd(20)}${c.dim}${item.action}${c.reset}`);
}

// ─── Relances dues ──────────────────────────────────────────────────────────

const due: string[] = [];
for (const dossier of dossiers) {
  const { state } = stateOf(dossier.conversationId);
  const histoire = replyHistory(
    dossier.conversationId ? repos.conversations.eventsFor(dossier.conversationId) : [],
    boite,
  );
  // L'echeance court depuis la derniere activite reelle, pas depuis le premier
  // contact : relancer quelqu'un deux jours apres lui avoir envoye ce qu'il
  // attendait est la meilleure facon de perdre une affaire en cours.
  // Nos propres envois comptent autant que leurs messages : sans eux, une
  // entreprise a qui l'on vient d'ecrire apparait « a relancer » le jour meme.
  const activite = [
    histoire.lastHumanReplyAt,
    histoire.lastAutoReplyAt,
    repos.salesLoop.lastSentTo(dossier.domain),
  ]
    .filter((d): d is string => d !== null)
    .reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);
  const decision = evaluateFollowUp({
    domain: dossier.domain,
    status: state.status,
    contactedOn: dossier.contactedOn,
    lastActivityOn: activite ? activite.slice(0, 10) : null,
    followUpsSent: repos.salesLoop.followUpsFor(dossier.domain),
    doNotContact: repos.sales.ledgerFor(dossier.domain)?.kind === 'DO_NOT_CONTACT',
    afterBusinessDays: config.sales.followUpAfterDays,
    today,
  });
  if (decision.verdict === 'DUE') due.push(`${dossier.companyName} — ${decision.reason}`);
}
heading(`RELANCES DUES — ${due.length}`);
if (due.length === 0) console.log(`    ${c.dim}aucune échéance atteinte.${c.reset}`);
for (const d of due) console.log(`    ${c.amber}${d}${c.reset}`);

// --- Chiffres ---------------------------------------------------------------
//
// Une metrique sans source fiable s'affiche N/A. C'est la seule facon de garder
// les autres croyables : un tableau de bord qui comble ses trous avec des zeros
// plausibles cesse d'etre lisible le jour ou l'un d'eux compte vraiment.

const sentTotal = repos.salesLoop.sentSince('2000-01-01');
const sentToday = repos.salesLoop.sentSince(`${today}T00:00:00.000Z`);
const contacted = repos.sales.ledgerDomains().filter((d) => d.kind === 'CONTACTED').length;
const count = (s: ConversationStatus) => byStatus.get(s)?.length ?? 0;
/**
 * Le taux de reponse est historique, jamais deduit de l'etat courant.
 *
 * ACRN avait repondu deux fois ; l'apercu gratuit parti, son etat est devenu
 * « en attente du client » — et l'entreprise a cesse de compter comme ayant
 * repondu. Le tableau annoncait 0 % sur treize entreprises alors qu'une vraie
 * conversation etait engagee. Une entreprise qui a repondu une fois reste une
 * entreprise qui a repondu, quoi qu'on fasse ensuite.
 */
const ontRepondu = dossiers.filter((d) => d.conversationId !== null
  && replyHistory(repos.conversations.eventsFor(d.conversationId), boite).everHumanReplied);
const replied = ontRepondu.length;
const positive = count('INTERESTED') + count('MEETING_REQUESTED') + count('WON');
const pct = (n: number, d: number) => (d === 0 ? 'N/A' : `${Math.round((n / d) * 100)} %`);

const orders = repos.orders.listOrders(200);
const paidOrders = orders.filter((o) => o.paymentStatus === 'CONFIRMED');
const revenueCents = paidOrders.reduce((sum, o) => sum + (o.priceCents ?? 0), 0);

heading('ETAT DE LA BOUCLE');
line('new qualified', at('QUALIFYING'));
line('ready for approval', drafts.length, 'attend votre relecture');
// L'horodatage est celui de la consignation, pas de l'envoi : les messages
// manuels du 19-20 aout ont ete consignes plus tard. Dire « consignes »
// plutot que « envoyes aujourd'hui » evite de faire lire une campagne du
// jour la ou il n'y en a pas eu.
line('sent', sentTotal, `dont ${sentToday} consigne(s) le ${today}`);
line('waiting reply', at('CONTACTED') + at('WAITING_REPLY'));
line('interested', count('INTERESTED'));
line('action required', needAttention.length);
line('follow-ups due', due.length);

heading('COMMERCIAL');
line('entreprises contactees', contacted);
line('response rate', pct(replied, contacted),
  `${replied} entreprise(s) ayant repondu : ${ontRepondu.map((cv) => cv.companyName).join(', ') || 'aucune'}`);
line('positive response rate', pct(positive, contacted), `${positive} positive(s)`);
line('paid clients', paidOrders.length);
line(
  'revenue',
  revenueCents === 0 ? '0 EUR' : `${(revenueCents / 100).toFixed(2)} EUR`,
  paidOrders.length === 0 ? 'aucune commande reglee' : 'commandes CONFIRMED',
);
// Les apercus gratuits sont produits et transmis a la main : rien en base ne
// permet de les compter sans se tromper.
line('free previews', 'N/A', 'livres a la main, non traces en base');

heading('COUTS');
// La boucle n'appelle aucun modele : ce zero se verifie en lisant le code, ce
// n'est pas une valeur par defaut.
line('llm cost (boucle)', '0.00 $', 'la boucle ne fait aucun appel modele');
// Le cout par requete est configure, mais aucune requete n'est persistee avec
// son cout : un total serait une extrapolation.
line('search cost', 'N/A', 'requetes non persistees avec leur cout');

heading('VERROUS');
console.log(
  `    approbation humaine : ${
    config.sales.humanApprovalRequired ? `${c.green}exigee${c.reset}` : `${c.red}DESACTIVEE${c.reset}`
  }`,
);
console.log(`    seuil de conversion : ${config.sales.minConversionScore}/100`);
console.log(
  `    plafond quotidien   : ${config.sales.maxNewOutreachPerDay}` +
    ` (${Math.max(0, config.sales.maxNewOutreachPerDay - sentToday)} restant)`,
);
console.log('    1 contact par entreprise, relance unique');
console.log(`\n  ${c.dim}MESSAGES SENT: ${sentTotal}${c.reset}\n`);
repos.close();
