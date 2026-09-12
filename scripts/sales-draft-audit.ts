/**
 * Pourquoi un prospect qualifié n'a pas produit de brouillon.
 *
 * Un lot peut retenir trois PRIORITY, en enrichir deux jusqu'à leurs deux faits
 * sourcés, et n'écrire aucun message. Le rapport de lot dit alors
 * « DRAFTS = 0 » sans dire ce qui a bloqué, et l'absence de cause pousse à
 * soupçonner la garde la plus visible — le seuil, l'exigence de faits — alors
 * que le blocage vient souvent d'ailleurs.
 *
 * Ce script rejoue le chemin, garde par garde, dans l'ordre exact où le lot les
 * franchit. Il ne décide rien et n'écrit rien : il lit la base et nomme le
 * PREMIER verrou qui se ferme. La distinction compte, parce que corriger le
 * deuxième verrou pendant que le premier tient ne change rien, et fait croire
 * que la correction a échoué.
 *
 * Les gardes elles-mêmes ne sont pas réimplémentées : `checkPriorityEligibility`
 * et `buildOutreachDraft` sont appelées, pas recopiées. Un audit qui redéfinit
 * la règle qu'il vérifie finit par valider sa propre version.
 *
 *   npm run sales:draft-audit                    dernier lot
 *   npm run sales:draft-audit -- --batch=<id>    un lot précis
 */
import { loadConfig, loadAtlasEnv, createLogger } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  checkPriorityEligibility, SALES_TIER_THRESHOLDS, buildOutreachDraft,
  pickPersonalizationFact, nameMatchesDomain,
  type OutreachFact,
} from '../packages/departments/src/index.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m',
};

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const config = loadConfig(process.cwd());
const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(config.paths.databaseFile, logger);

const batchId = arg('batch') ?? repos.sales.latestBatchId();
if (!batchId) {
  console.error('  aucun lot en base.');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const sentToday = repos.salesLoop.sentSince(`${today}T00:00:00.000Z`);
const remainingToday = Math.max(0, config.sales.maxNewOutreachPerDay - sentToday);

const all = repos.sales.forBatch(batchId);
const qualifies = all.filter((p) => p.state !== 'DISCOVERED' && p.state !== 'REJECTED');

/**
 * Les candidats au brouillon, désignés par le score et non par le palier.
 *
 * Le palier est réécrit en base quand le contrôle d'éligibilité rétrograde un
 * dossier : après un lot, les PRIORITY bloqués sont devenus GOOD_FIT. Auditer
 * sur le palier ne montrerait donc plus personne, et conclurait « aucun
 * PRIORITY » là où il y en a eu trois. Le score, lui, ne bouge pas.
 */
const candidats = qualifies
  .filter((p) => (p.score ?? 0) >= SALES_TIER_THRESHOLDS.priority)
  .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

console.log(`\n  ${c.bold}${c.cyan}AUDIT DU CHEMIN VERS LE BROUILLON${c.reset}`);
console.log(`  ${c.dim}lot ${batchId} · ${all.length} découverte(s) · ${qualifies.length} qualifiée(s) · ` +
  `${candidats.length} au-dessus du seuil PRIORITY (${SALES_TIER_THRESHOLDS.priority})${c.reset}`);
console.log(`  ${c.dim}lecture seule : aucune décision, aucune écriture, aucun envoi${c.reset}\n`);

const ligne = (k: string, v: string, ok?: boolean) => {
  const mark = ok === undefined ? ' ' : ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
  console.log(`    ${mark} ${k.padEnd(24)}${v}`);
};

let brouillonsPossibles = 0;

for (const p of candidats) {
  const domain = p.domain ?? '(sans domaine)';
  console.log(`  ${c.bold}${p.companyName}${c.reset}  ${c.dim}${domain}${c.reset}`);

  /** Le premier verrou fermé, et lui seul. Les suivants sont informatifs. */
  const verrous: string[] = [];
  /**
   * Le meme motif peut venir de deux endroits : ce script le releve, et
   * `checkPriorityEligibility` le releve aussi. Le lister deux fois ferait
   * croire a deux verrous distincts la ou il n'y en a qu'un.
   */
  const bloque = (raison: string) => {
    if (!verrous.includes(raison)) verrous.push(raison);
  };

  // ── 1. QUALIFIED ────────────────────────────────────────────────────────
  const score = p.score ?? 0;
  const scoreOk = score >= SALES_TIER_THRESHOLDS.priority;
  ligne('score', `${score}/100 (seuil ${SALES_TIER_THRESHOLDS.priority})`, scoreOk);
  if (!scoreOk) bloque(`score ${score} sous le seuil ${SALES_TIER_THRESHOLDS.priority}`);

  // ── 2. CONTACT RESOLUTION ───────────────────────────────────────────────
  const canal = p.contactEmail ? 'EMAIL' : p.contactPhone ? 'PHONE' : p.contactPage ? 'FORM' : null;
  const adresse = p.contactEmail ?? p.contactPhone ?? p.contactPage ?? null;
  const observe = Boolean(p.contactObserved);
  ligne('contact channel', canal ?? 'aucun', canal !== null);
  ligne('contact address', adresse ?? 'aucune', adresse !== null);
  ligne('contact observed', observe ? 'oui — relevé sur une page' : 'non', observe);
  if (!canal || !adresse) bloque('aucun canal de contact public observé');
  else if (!observe) bloque('adresse non relevée sur une page : elle serait devinée');

  // ── 3. ENRICHMENT ───────────────────────────────────────────────────────
  const evidence = repos.sales.evidenceFor(p.id);
  // Une preuve d'identite n'est pas un fait commercial.
  const observed = evidence.filter((e) => e.nature === 'observed' && e.sourceUrl && !e.field.startsWith('identite:'));
  const sourced = evidence.filter((e) => Boolean(e.sourceUrl));
  ligne('facts found', String(evidence.length), evidence.length > 0);
  ligne('facts valid', `${observed.length} constaté(s) et sourcé(s) — 2 exigés`, observed.length >= 2);
  ligne('facts sources', observed.length === 0 ? 'aucune' :
    [...new Set(observed.map((e) => {
      try { return new URL(e.sourceUrl!).host; } catch { return e.sourceUrl!; }
    }))].join(', '));
  if (observed.length < 2) bloque(`${observed.length} fait(s) observé(s) — deux au minimum`);

  // ── 4. REGISTRE ─────────────────────────────────────────────────────────
  const registre = repos.sales.ledgerFor(domain);
  const dejaContacte = registre?.kind === 'CONTACTED';
  const interdit = registre?.kind === 'DO_NOT_CONTACT';
  const doublon = all.filter((x) => x.domain === domain).length > 1;
  ligne('duplicate', doublon ? 'OUI — plusieurs fois dans ce lot' : 'non', !doublon);
  ligne('already contacted', dejaContacte ? `OUI — ${registre?.recordedAt?.slice(0, 10)}` : 'non', !dejaContacte);
  ligne('do not contact', interdit ? 'OUI' : 'non', !interdit);
  if (doublon) bloque('domaine présent plusieurs fois dans le lot');
  if (dejaContacte) bloque('déjà au registre comme CONTACTED');
  if (interdit) bloque('registre : DO_NOT_CONTACT');

  // ── 5. PLAFONDS ─────────────────────────────────────────────────────────
  ligne('daily limit', `${sentToday}/${config.sales.maxNewOutreachPerDay} — ${remainingToday} restant(s)`, remainingToday > 0);
  ligne('budget', `${config.sales.maxBudgetUsd.toFixed(2)} $ par cycle`);
  // Le plafond quotidien borne l'ENVOI, pas la rédaction : un brouillon écrit
  // aujourd'hui peut partir demain. Il est affiché, jamais compté comme verrou.

  // ── 6. DRAFT ELIGIBILITY ────────────────────────────────────────────────
  const identity = p.identityConfidence != null && p.domain
    ? {
        companyName: p.companyName,
        canonicalDomain: p.domain,
        officialWebsite: p.website ?? `https://${p.domain}`,
        country: p.country,
        identityConfidence: p.identityConfidence,
        identitySources: p.identitySources ?? [],
      }
    : null;

  const check = checkPriorityEligibility({
    identity,
    pageType: (p.pageType as 'OFFICIAL_COMPANY_SITE') ?? 'UNKNOWN',
    icp: 'MATCH',
    observedFacts: observed.length,
    score,
    scoreThreshold: SALES_TIER_THRESHOLDS.priority,
    hasSourcedPersonalization: observed.length > 0,
  });

  ligne('identity confidence', `${p.identityConfidence ?? 'N/A'} — ${(p.identitySources ?? []).join(', ') || 'aucune source'}`,
    (p.identityConfidence ?? 0) >= 0.75 || nameMatchesDomain(p.companyName, p.domain ?? ''));
  ligne('name matches domain', nameMatchesDomain(p.companyName, p.domain ?? '') ? 'oui' : 'non',
    nameMatchesDomain(p.companyName, p.domain ?? ''));
  ligne('draft eligibility', check.eligible ? 'ÉLIGIBLE' : check.blockers.join(' · '), check.eligible);
  for (const b of check.blockers) bloque(b);

  // ── 7. DRAFT ────────────────────────────────────────────────────────────
  const facts: OutreachFact[] = evidence
    .filter((e) => e.sourceUrl)
    .map((e) => ({ evidenceId: e.id, claim: e.claim, sourceUrl: e.sourceUrl!, nature: e.nature }));
  const perso = pickPersonalizationFact(facts);
  ligne('personalization fact', perso ? `« ${perso.claim.slice(0, 54)}… »` : 'aucun fait citable', perso !== null);
  if (!perso) bloque('aucun fait constaté et sourcé pour personnaliser');

  // La rédaction elle-même, à blanc : elle ne touche à rien et dit si le texte
  // sortirait. C'est la seule façon de savoir si un verrou reste plus loin.
  const essai = buildOutreachDraft({
    company: p.companyName,
    website: p.website,
    facts,
    contact: adresse
      ? {
          name: p.contactName, role: p.contactRole,
          email: p.contactEmail, phone: p.contactPhone,
          contactPage: p.contactPage, sourceUrl: p.contactSourceUrl,
          confidence: p.contactConfidence ?? 0.5,
          named: Boolean(p.contactName?.trim()),
        }
      : null,
    whyThisCompany: p.whyFit ?? '',
    senderName: config.sales.senderName,
    offer: { priceEur: 49, deliveryHours: 24 },
  });
  ligne('draft composable', essai.draft ? 'oui' : essai.reason.slice(0, 60), essai.draft !== null);
  if (!essai.draft) bloque(`rédaction refusée : ${essai.reason}`);

  // ── 8. ÉTAT ATTEINT ─────────────────────────────────────────────────────
  ligne('state', p.state, p.state === 'READY_FOR_REVIEW');
  ligne('tier (en base)', p.tier ?? 'aucun');

  const premier = verrous[0] ?? null;
  if (premier === null) {
    brouillonsPossibles += 1;
    console.log(`    ${c.green}${c.bold}AUCUN VERROU — un brouillon peut être écrit.${c.reset}\n`);
  } else {
    console.log(`    ${c.red}${c.bold}PREMIER VERROU${c.reset} ${c.red}${premier}${c.reset}`);
    if (verrous.length > 1) {
      console.log(`    ${c.dim}et ensuite : ${verrous.slice(1).join(' · ')}${c.reset}`);
    }
    console.log();
  }
}

console.log(`  ${c.bold}${candidats.length} candidat(s) · ${brouillonsPossibles} pourrait/pourraient produire un brouillon${c.reset}`);
console.log(`  ${c.dim}MESSAGES SENT : ${repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z')} — inchangé, ce script n'envoie rien${c.reset}\n`);

repos.close();
