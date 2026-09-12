/**
 * La journée commerciale d'ATLAS, en une commande.
 *
 *   npm run revenue:run                 cycle réel, arrêt avant tout envoi
 *   npm run revenue:run -- --dry-run    contrôles seuls : rien n'est écrit
 *   npm run revenue:run -- --budget=0.12
 *
 * Ce script n'invente aucune règle. Il appelle les pièces existantes —
 * `sales-inbox-sync`, `sales-batch`, `buildWarRoom`, `buildApprovals`, la
 * sonde SearXNG — dans l'ordre où elles doivent se dérouler, et refuse
 * d'avancer quand une dépendance n'a pas répondu. Les décisions elles-mêmes
 * vivent dans `revenue-mode.ts`, sans base ni réseau, pour qu'elles puissent
 * être vérifiées par des tests plutôt que constatées après coup.
 *
 * Deux étapes seulement écrivent : la synchronisation de la boîte et le lot de
 * prospection. Les deux sont lancées comme des processus séparés, avec leurs
 * propres gardes intactes — les réimplémenter ici reviendrait à en créer une
 * seconde version, plus permissive, qu'on croirait identique.
 *
 * AUCUNE ÉTAPE N'ENVOIE. La séquence s'arrête sur `STOP BEFORE SEND`, et
 * l'écart de `MESSAGES SENT` est mesuré de bout en bout pour le prouver.
 */
import { spawnSync } from 'node:child_process';
import { loadConfig, loadAtlasEnv, createLogger } from '../packages/core/src/index.ts';
import { createRepositories, type Repositories } from '../packages/data/src/index.ts';
import { SearxngSearchProvider } from '../packages/intelligence/src/search/searxng.ts';
import {
  REVENUE_STEPS, decideSearchGate, decideBudgetGate, prioritizeInbox,
  classifyDraft, revenueMomentum, topActions, whyNotACompanyName,
  classifyContactIntent, outreachSuitability,
  type SearchProbe, type DraftClass, type DraftFacts,
} from '../packages/departments/src/index.ts';
import {
  buildWarRoom, buildApprovals, buildCosts, buildProspecting, buildCompanies,
} from '../packages/server/src/http/command-center.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m',
};

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const DRY = process.argv.includes('--dry-run');
const BUDGET = Number(arg('budget') ?? 0.12);

const config = loadConfig(process.cwd());
const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(config.paths.databaseFile, logger);

/** Le témoin qui prouve qu'aucun envoi n'a eu lieu, mesuré aux deux bouts. */
const SENT_BEFORE = repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z');

const titre = (s: string) => console.log(`\n  ${c.bold}${c.cyan}${s}${c.reset}`);
const etape = (n: number, id: string, etat: string, detail: string) => {
  const couleur = etat === 'OK' ? c.green : etat === 'SKIP' ? c.dim : etat === 'WARN' ? c.amber : c.red;
  console.log(`  ${c.dim}${String(n).padStart(2)}${c.reset} ${couleur}${etat.padEnd(5)}${c.reset} ${id.padEnd(22)}${c.dim}${detail}${c.reset}`);
};

/** Lance une commande existante sans toucher à ses gardes. */
/** Les lignes d'une sortie, quel que soit le style de fin de ligne. */
const decoupeLignes = (texte: string): string[] =>
  texte.trimEnd().split(String.fromCharCode(10))
    .map((l) => l.replace(String.fromCharCode(13), ''))
    .filter((l) => l.trim() !== '');

function lancer(script: string, args: string[]): { ok: boolean; sortie: string } {
  const r = spawnSync('npx', ['tsx', script, ...args], {
    encoding: 'utf8', shell: process.platform === 'win32',
    env: { ...process.env }, timeout: 900_000,
  });
  return { ok: r.status === 0, sortie: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

console.log(`\n  ${c.bold}ATLAS REVENUE MODE${c.reset}  ${c.dim}${DRY ? 'DRY RUN — aucune écriture, aucun modèle, aucun réseau commercial' : 'cycle réel — arrêt avant tout envoi'}${c.reset}`);
console.log(`  ${c.dim}${REVENUE_STEPS.length} étapes · budget de cycle ${BUDGET.toFixed(2)} $ · messages envoyés avant : ${SENT_BEFORE}${c.reset}\n`);

const bloqueurs: string[] = [];

// ── 1. Boîte de réception ───────────────────────────────────────────────────
if (DRY) {
  etape(1, 'INBOX_SYNC', 'SKIP', 'dry run : la boîte n’est pas relue');
} else {
  const r = lancer('scripts/sales-inbox-sync.ts', ['--allow-production']);
  const nouvelles = /HUMAN REPLIES\s+(\d+)/.exec(r.sortie)?.[1] ?? '?';
  if (!r.ok) bloqueurs.push('boîte Gmail illisible');
  etape(1, 'INBOX_SYNC', r.ok ? 'OK' : 'FAIL', r.ok ? `${nouvelles} réponse(s) humaine(s) sur cette passe` : 'la synchronisation a échoué');
}

// ── 2 à 5. L'état commercial, et ce qui attend ──────────────────────────────
const war = buildWarRoom(repos, config);
etape(2, 'WAR_ROOM', 'OK', `${war.ledgerTotal} entreprise(s) au registre · ${war.metrics.messagesSent} message(s) envoyé(s)`);

const signaux = buildApprovals(repos); // reconstruit plus bas ; ici pour le compte
void signaux;

/*
 * L'etat vient du dossier, jamais d'une supposition. Poser `REPLIED` pour
 * toute entreprise ayant repondu rangeait ACRN parmi les decisions en attente
 * alors que l'entonnoir n'en comptait aucune : deux lignes du meme rapport se
 * contredisaient, et la fausse etait la plus visible.
 */
const etats = new Map(buildCompanies(repos, config).companies.map((x) => [x.domain, x.state]));
const repondu = war.repliedCompanies.map((r) => ({
  domain: r.domain,
  company: r.name,
  state: etats.get(r.domain) ?? 'CONTACTED',
  humanReplied: true,
  lastHumanReplyAt: r.at,
}));
/** Les états chauds viennent de l'entonnoir, pas d'une déduction. */
const chauds = war.funnel.filter((f) => ['INTERESTED', 'MEETING_REQUESTED'].includes(f.state))
  .reduce((s, f) => s + f.count, 0);
const priorites = prioritizeInbox(repondu);
etape(3, 'HUMAN_REPLIES', priorites.length > 0 ? 'WARN' : 'OK',
  priorites.length > 0 ? `${priorites.length} — À LIRE AVANT TOUT LE RESTE` : 'aucune réponse humaine en attente');

/* Ce que la priorisation a reellement classe, pas un etat lu a part. */
const aDecider = priorites.filter((p) => p.priority === 'ACTION_REQUIRED').length;
etape(4, 'ACTION_REQUIRED', aDecider > 0 ? 'WARN' : 'OK', `${aDecider} dossier(s) attendent une décision`);
etape(5, 'FOLLOW_UPS_DUE', war.metrics.followUpsDue > 0 ? 'WARN' : 'OK',
  war.followUps.map((f) => f.name).join(', ') || 'aucune');

// ── 6 et 7. La recherche, interrogée pour de vrai ───────────────────────────
const sondes: SearchProbe[] = [];
const url = config.search.searxngBaseUrl.trim();
if (url) {
  try {
    const provider = new SearxngSearchProvider({ baseUrl: url, engines: config.search.searxngEngines });
    // Une requete reelle, pas un ping : un service qui repond sur /healthz
    // sans rien savoir chercher a deja fait lancer un cycle pour rien.
    const res = await provider.search(
      { query: 'fabricant industriel france', count: 3 },
      { logger, timeoutMs: 15_000 },
    );
    /*
     * `outcome`, pas l'absence d'exception.
     *
     * Ce fournisseur ne leve jamais : il rend `{ results: [], outcome:
     * 'unavailable' }` quand le service ne repond pas. En deduisant « a
     * repondu » de « n'a pas leve », la sonde annoncait « searxng joignable
     * mais 0 resultat » sur un conteneur arrete. La porte bloquait bien -- la
     * raison affichee envoyait chercher au mauvais endroit.
     */
    const injoignable = res.outcome === 'unavailable' || res.outcome === 'http-error'
      || res.outcome === 'timeout' || res.outcome === 'rate-limited';
    sondes.push({
      engine: 'searxng',
      responded: !injoignable,
      results: res.results.length,
      error: injoignable ? `${res.outcome} — ${res.detail}`.slice(0, 90) : null,
    });
  } catch (err) {
    sondes.push({
      engine: 'searxng', responded: false, results: 0,
      error: err instanceof Error ? err.message.slice(0, 60) : String(err),
    });
  }
} else {
  sondes.push({ engine: 'searxng', responded: false, results: 0, error: 'aucune adresse configurée' });
}

const porte = decideSearchGate(sondes);
etape(6, 'HEALTH_SEARCH_FABRIC', porte.verdict === 'SEARCH_BLOCKED' ? 'FAIL' : 'OK',
  `${sondes.length} moteur(s) déclaré(s)`);
etape(7, 'HEALTH_SEARXNG', porte.verdict === 'HEALTHY' ? 'OK' : porte.verdict === 'DEGRADED' ? 'WARN' : 'FAIL',
  porte.reason);
if (porte.verdict === 'SEARCH_BLOCKED') bloqueurs.push(`SEARCH BLOCKED — ${porte.reason}`);

// ── 8. Le budget ────────────────────────────────────────────────────────────
const couts = buildCosts(repos, config);
const budget = decideBudgetGate({
  cycleCapUsd: BUDGET,
  todayUsd: couts.windows.today.costUsd,
  monthUsd: couts.windows.month.costUsd,
  unknownCostCalls: couts.windows.today.unknownCostCalls,
});
etape(8, 'BUDGET', budget.allowed ? 'OK' : 'FAIL', budget.reason);
if (!budget.allowed) bloqueurs.push(`BUDGET — ${budget.reason}`);

const eur = (v: number | null) => (v === null ? 'N/A' : `${v.toFixed(4)} $`);
console.log(`     ${c.dim}MODEL BUDGET = ${BUDGET.toFixed(2)} $ · TODAY SPEND = ${eur(couts.windows.today.costUsd)}`
  + ` · MONTH SPEND = ${eur(couts.windows.month.costUsd)} · UNKNOWN COST CALLS = ${couts.windows.today.unknownCostCalls}${c.reset}`);

// ── 9 et 10. Quota et registre ──────────────────────────────────────────────
etape(9, 'DAILY_QUOTA', war.metrics.dailyRemaining > 0 ? 'OK' : 'WARN',
  `${war.metrics.sentToday}/${war.metrics.dailyCap} — ${war.metrics.dailyRemaining} restant(s)`);
const interdits = repos.sales.ledgerDomains().filter((d) => d.kind === 'DO_NOT_CONTACT').length;
etape(10, 'REGISTRY_GUARDS', 'OK',
  `${war.ledgerTotal} au registre · ${interdits} DO_NOT_CONTACT · anti-doublon par clé d'idempotence`);

// ── 11 à 17. Le cycle ───────────────────────────────────────────────────────
const INTERNES = ['QUALIFICATION', 'CONTACT_RESOLUTION', 'IDENTITY_VERIFICATION',
  'ENRICHMENT', 'DRAFT_GENERATION', 'READY_FOR_REVIEW'] as const;

let cycleLance = false;
let raisonInternes = 'aucun cycle lancé';

if (bloqueurs.length > 0) {
  etape(11, 'PROSPECTING_CYCLE', 'SKIP', `non lancé : ${bloqueurs[0]}`);
} else if (DRY) {
  etape(11, 'PROSPECTING_CYCLE', 'SKIP',
    `dry run : un cycle réel coûterait au plus ${BUDGET.toFixed(2)} $ et écrirait de nouveaux prospects`);
} else {
  const r = lancer('scripts/sales-batch.ts', ['--go', `--budget=${BUDGET}`]);
  const lu = (re: RegExp) => re.exec(r.sortie)?.[1] ?? null;

  /*
   * Un lot qui ne produit aucun brouillon n'est pas un lot en panne.
   *
   * `sales-batch` sort avec le code 1 dans les deux cas : quand il s'effondre,
   * et quand il se termine proprement sans brouillon eligible. Confondre les
   * deux faisait annoncer REVENUE MOMENTUM = BLOCKED sur un cycle qui avait
   * lu ses pages, verifie quatre identites et conclu normalement -- et le
   * rapport reclamait alors de « debloquer » quelque chose qui fonctionnait.
   *
   * Le marqueur d'aboutissement est la ligne de synthese que seul un lot mene
   * a son terme imprime.
   */
  const abouti = /READY_FOR_REVIEW_CREATED/.test(r.sortie);
  cycleLance = abouti;
  const crees = Number(lu(/READY_FOR_REVIEW_CREATED:\s*(\d+)/) ?? '0');

  if (abouti) {
    raisonInternes = 'exécuté dans le lot';
    etape(11, 'PROSPECTING_CYCLE', crees > 0 ? 'OK' : 'WARN',
      `découverts ${lu(/DISCOVERED:?\s+(\d+)/) ?? '?'} · faits valides ${lu(/FACTS_VALID:\s*(\d+)/) ?? '?'}`
      + ` · brouillons créés ${crees}`);
  } else {
    etape(11, 'PROSPECTING_CYCLE', 'FAIL', 'le lot ne s’est pas terminé');
    bloqueurs.push('le cycle de prospection ne s’est pas terminé');
    raisonInternes = 'lot interrompu';
    /*
     * La sortie du lot, montrée telle quelle.
     *
     * L'avaler rendait « le lot a échoué » sans dire pourquoi : trois prospects
     * écrits, dix centimes dépensés, et aucun moyen de savoir où la chaîne
     * s'était rompue sans relancer -- donc sans repayer.
     */
    const lignes = decoupeLignes(r.sortie);
    console.log(`     ${c.red}sortie du lot, dix dernières lignes :${c.reset}`);
    for (const ligne of lignes.slice(-10)) console.log(`     ${c.dim}${ligne.slice(0, 160)}${c.reset}`);
  }
}

for (const [i, id] of INTERNES.entries()) {
  etape(12 + i, id, cycleLance ? 'OK' : 'SKIP', raisonInternes);
}

// ── 18. La file d'approbation, reconstruite ─────────────────────────────────
const approb = buildApprovals(repos);
const classes = new Map<DraftClass, number>();
const detail: Array<{ company: string; klass: DraftClass; reasons: string[]; actionType: string }> = [];

for (const item of approb.pending) {
  const p = item.prospectId ? repos.sales.get(item.prospectId) : null;
  const cible = item.channelTarget ?? '';
  const intent = cible ? classifyContactIntent({ value: cible, kind: 'EMAIL', sourceUrl: p?.contactSourceUrl ?? '' }) : 'GENERAL';
  const faits: DraftFacts = {
    company: item.company,
    actionType: item.actionType,
    hasTarget: cible !== '',
    contactObserved: p?.contactObserved ?? false,
    suitabilityLow: outreachSuitability(intent, Boolean(p?.contactRole)) === 'LOW',
    personalIntent: intent === 'PERSONAL',
    identityConfidence: p?.identityConfidence ?? null,
    sourcedFacts: item.facts.length,
    everyFactSourced: item.facts.every((f) => f.sourceUrl.trim() !== ''),
    alreadySent: repos.salesLoop.lastSentTo(item.domain) !== null,
    doNotContact: repos.sales.ledgerFor(item.domain)?.kind === 'DO_NOT_CONTACT',
    quotaRemaining: war.metrics.dailyRemaining,
    missingSubject: (item.subject ?? '').trim() === '',
    crossDomain: item.recipientDomainMatch === 'CROSS_DOMAIN',
    nameLooksLikePageTitle: whyNotACompanyName(item.company) !== null,
  };
  const v = classifyDraft(faits);
  classes.set(v.klass, (classes.get(v.klass) ?? 0) + 1);
  detail.push({ company: item.company, klass: v.klass, reasons: v.reasons, actionType: item.actionType });
}

const n = (k: DraftClass) => classes.get(k) ?? 0;
etape(18, 'REBUILD_APPROVALS', 'OK',
  `${approb.pending.length} en attente · ${approb.excluded.length} écarté(s)`);

/*
 * Les couts, relus apres le cycle.
 *
 * `buildCosts` a deja servi a la porte budgetaire, AVANT toute depense : le
 * reutiliser ici afficherait le cout d'avant le cycle sous le titre « ce que
 * ce cycle a coute ». Deux lectures, deux moments, deux usages.
 */
const coutsApres = buildCosts(repos, config);

// ── 19. La synthèse ─────────────────────────────────────────────────────────
const prospection = buildProspecting(repos, config);
const lot = repos.sales.latestBatchId();
const prospects = lot ? repos.sales.forBatch(lot) : [];
const qualifies = prospects.filter((p) => (p.score ?? 0) > 0);
const prioritaires = prospects.filter((p) => (p.score ?? 0) >= 70);
/*
 * Le lot ecrit le contact sur le prospect, pas dans `sales_contact_channels`.
 * Compter cette table rendait « Contactable: 0 » sur sept prospects qui
 * portaient tous une adresse relevee -- un zero parfaitement plausible et faux.
 */
const contactables = prospects.filter((p) => p.contactEmail ?? p.contactPhone ?? p.contactPage);
const identifies = prospects.filter((p) => p.identityConfidence !== null);
const avecFaits = prospects.filter((p) =>
  repos.sales.evidenceFor(p.id).filter((e) => e.sourceUrl && !e.field.startsWith('identite:')).length >= 2);
const prets = prospects.filter((p) => p.state === 'READY_FOR_REVIEW');
void prospection;

const elan = revenueMomentum({
  blockers: bloqueurs,
  positiveReplies: war.metrics.positiveReplies,
  hotReplies: chauds,
  actionRequired: aDecider,
  sendable: n('SENDABLE'),
  readyForReview: approb.pending.length,
  paidClients: war.metrics.paidClients,
});

const actions = topActions({
  blockers: bloqueurs,
  positiveReplies: war.metrics.positiveReplies,
  hotReplies: chauds,
  actionRequired: aDecider,
  sendable: n('SENDABLE'),
  readyForReview: approb.pending.length,
  paidClients: war.metrics.paidClients,
  followUpsDue: war.metrics.followUpsDue,
  needsSmallEdit: n('NEEDS_SMALL_EDIT'),
  manualChannel: n('MANUAL_CHANNEL'),
  quotaRemaining: war.metrics.dailyRemaining,
});

etape(19, 'REVENUE_SUMMARY', 'OK', 'ci-dessous');

const SENT_AFTER = repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z');
etape(20, 'STOP_BEFORE_SEND', SENT_AFTER === SENT_BEFORE ? 'OK' : 'FAIL',
  `messages envoyés ${SENT_BEFORE} → ${SENT_AFTER}`);

// ── La synthèse, courte ─────────────────────────────────────────────────────
const couleurElan = elan.momentum === 'HOT' ? c.green
  : elan.momentum === 'ACTIVE' ? c.cyan
    : elan.momentum === 'BLOCKED' ? c.red : c.amber;

titre('ATLAS REVENUE MODE');
console.log(`  ${couleurElan}${c.bold}REVENUE MOMENTUM = ${elan.momentum}${c.reset}  ${c.dim}${elan.reason}${c.reset}\n`);

const l = (k: string, v: string | number) => console.log(`    ${k.padEnd(26)}${v}`);

console.log(`  ${c.bold}INBOX${c.reset}`);
l('Human replies:', war.metrics.everReplied);
l('Positive replies:', war.metrics.positiveReplies);
l('Action required:', aDecider);
if (priorites.length > 0) {
  for (const p of priorites.slice(0, 3)) {
    console.log(`      ${c.amber}${p.priority}${c.reset}  ${p.company} — ${(p.lastHumanReplyAt ?? '').slice(0, 10)}`);
  }
}

console.log(`\n  ${c.bold}PIPELINE${c.reset}  ${c.dim}${lot ?? 'aucun lot'}${c.reset}`);
l('Discovered:', prospects.length);
l('Qualified:', qualifies.length);
l('Priority:', prioritaires.length);
l('Contactable:', contactables.length);
l('Identity verified:', identifies.length);
l('Facts >= 2:', avecFaits.length);
l('Drafts:', prets.length);
l('Ready for review:', approb.pending.length);
l('Sendable:', n('SENDABLE'));

console.log(`\n  ${c.bold}APPROVALS${c.reset}`);
for (const k of ['EMAIL', 'PHONE', 'FORM', 'MANUAL', 'UNAVAILABLE'] as const) {
  l(`${k}:`, approb.pending.filter((p) => p.actionType === k).length);
}
l('CROSS_DOMAIN:', approb.pending.filter((p) => p.recipientDomainMatch === 'CROSS_DOMAIN').length);
l('excluded:', approb.excluded.length);
l('SENDABLE:', n('SENDABLE'));
l('NEEDS_SMALL_EDIT:', n('NEEDS_SMALL_EDIT'));
l('MANUAL_CHANNEL:', n('MANUAL_CHANNEL'));
l('BLOCKED:', n('BLOCKED'));

console.log(`\n  ${c.bold}OUTREACH${c.reset}`);
l('Messages sent today:', war.metrics.sentToday);
l('Daily quota remaining:', war.metrics.dailyRemaining);
l('Follow-ups due:', war.metrics.followUpsDue);

console.log(`\n  ${c.bold}COST${c.reset}`);
/* La difference entre les deux lectures : ce que CE cycle a reellement coute. */
const avant = couts.windows.today.costUsd ?? 0;
const apres = coutsApres.windows.today.costUsd;
const coutCycle = DRY || !cycleLance || apres === null ? null : apres - avant;
l('Cycle cost:', DRY ? '0.0000 $ (dry run)' : coutCycle === null ? 'N/A' : `${coutCycle.toFixed(4)} $`);
l('Cost today:', eur(coutsApres.windows.today.costUsd));
l('Unknown cost calls:', coutsApres.windows.today.unknownCostCalls);
/*
 * Diviser la depense du jour par toute la file melait deux fenetres : des
 * brouillons ecrits hier, un cout paye aujourd'hui. Le rapport n'a de sens que
 * sur le lot que ce cycle vient de produire.
 */
l('Cost per READY_FOR_REVIEW:',
  !cycleLance || prets.length === 0 || coutCycle === null
    ? `N/A${cycleLance ? '' : ' (aucun cycle abouti)'}`
    : `${(coutCycle / prets.length).toFixed(4)} $ sur ${prets.length} du lot`);

console.log(`\n  ${c.bold}REVENUE${c.reset}`);
l('Paid clients:', war.metrics.paidClients);
l('Revenue EUR:', war.metrics.revenueEur.toFixed(2));

console.log(`\n  ${c.bold}TOP ACTIONS${c.reset}`);
actions.forEach((a, i) => console.log(`    ${i + 1}. ${a}`));

console.log(`\n  ${c.dim}MESSAGES SENT BEFORE ${SENT_BEFORE} · AFTER ${SENT_AFTER}` +
  ` — aucune étape de ce mode n'envoie de courriel.${c.reset}\n`);

repos.close();
process.exit(bloqueurs.length > 0 ? 1 : 0);
