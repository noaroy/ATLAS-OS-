/**
 * Rejouer l'enrichissement, l'identité et la rédaction sur un prospect déjà
 * découvert — sans recherche, sans appel de modèle, sans envoi.
 *
 * Un lot ne repasse jamais deux fois sur les mêmes entreprises : le registre
 * les écarte comme déjà connues, ce qui est voulu. Mais quand une garde se
 * débloque après coup — parce qu'on sait désormais lire une preuve qu'on ne
 * savait pas lire — les dossiers arrêtés par cette garde restent arrêtés, et
 * rien ne les reprend.
 *
 * Ce script les reprend. Il ne redécouvre rien, ne requalifie rien, ne renote
 * rien : il relit les pages du site, cherche la preuve d'identité, et laisse
 * les gardes existantes trancher. Le score, le seuil et l'exigence de deux
 * faits sont exactement ceux du lot d'origine.
 *
 * L'entité juridique sert de preuve, jamais de nom : un courriel citant un fait
 * sur une marque tout en s'adressant à sa maison mère est exact sur le papier
 * et incompréhensible pour celui qui le reçoit.
 *
 *   npm run sales:reprocess -- --domain=<domaine>          simulation
 *   npm run sales:reprocess -- --domain=<domaine> --write   écrit le brouillon
 */
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { fetchRawPages } from '../packages/intelligence/src/contact-fetch.ts';
import {
  checkPriorityEligibility, SALES_TIER_THRESHOLDS, buildOutreachDraft,
  collectSourcedFacts, contactPagesFor, contactLinksIn,
  extractLegalIdentity, legalPagesFor, legalLinksIn, confidenceFromLegal,
  isOfficialPage,
  type ContactPage, type OutreachFact,
} from '../packages/departments/src/index.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m',
};

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const WRITE = process.argv.includes('--write');
const domain = arg('domain');
if (!domain) {
  console.error('  --domain=<domaine> est obligatoire.');
  process.exit(2);
}

const config = loadConfig(process.cwd());
const system = createSystem(config);
const { repos } = system;

const avant = repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z');
console.log(`\n  ${c.bold}${c.cyan}REPRISE D'UN DOSSIER${c.reset}  ${c.dim}${domain}${c.reset}`);
console.log(`  ${c.dim}${WRITE ? 'ÉCRITURE' : 'simulation — --write pour écrire'} · aucun appel de modèle · aucun envoi${c.reset}`);
console.log(`  ${c.dim}messages envoyés avant : ${avant}${c.reset}\n`);

const prospect = repos.sales
  .batchIds()
  .flatMap((b) => repos.sales.forBatch(b))
  .find((p) => p.domain === domain);

if (!prospect) {
  console.error(`  aucun prospect pour ${domain}.`);
  await system.shutdown('inconnu');
  process.exit(1);
}

const line = (k: string, v: string, ok?: boolean) => {
  const mark = ok === undefined ? ' ' : ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
  console.log(`    ${mark} ${k.padEnd(22)}${v}`);
};

console.log(`  ${c.bold}${prospect.companyName}${c.reset}  ${c.dim}${prospect.domain} · score ${prospect.score} · ${prospect.state}${c.reset}\n`);

// ── 1. Les pages du site, relues une fois ─────────────────────────────────
const queue = contactPagesFor(prospect.website, domain);
const seen = new Set<string>();
const pages: ContactPage[] = [];
for (let pass = 0; pass < 2; pass++) {
  const batch = queue.filter((u) => !seen.has(u));
  for (const u of batch) seen.add(u);
  if (batch.length === 0) break;
  const got = await fetchRawPages(batch, {
    logger: system.logger, timeoutMs: 12_000,
    maxPages: Math.max(0, config.sales.maxPagesPerDomain - pages.length),
  });
  pages.push(...got.pages);
  if (pass === 0 && got.pages[0]) {
    for (const l of contactLinksIn(got.pages[0].html, got.pages[0].url, domain)) {
      if (!seen.has(l)) queue.push(l);
    }
  }
}
line('pages relues', String(pages.length));

// ── 2. Les faits, complétés si besoin ─────────────────────────────────────
const commercial = (e: { field: string }) => !e.field.startsWith('identite:');
const dejaObserves = repos.sales
  .evidenceFor(prospect.id)
  .filter((e) => e.nature === 'observed' && e.sourceUrl && commercial(e)).length;

const enrichi = await collectSourcedFacts({
  website: prospect.website, domain,
  maxPages: config.sales.maxPagesPerPriorityDomain,
  targetFacts: Math.max(0, 2 - dejaObserves),
  seedPages: pages,
  deadline: Date.now() + 90_000,
  fetchPages: async (urls, maxPages) =>
    fetchRawPages(urls, { logger: system.logger, timeoutMs: 12_000, maxPages }),
});

const dejaEcrites = new Set(repos.sales.evidenceFor(prospect.id).map((e) => e.claim.trim()));
let ajoutes = 0;
if (WRITE) {
  for (const f of enrichi.facts) {
    if (dejaEcrites.has(f.claim.trim())) continue;
    repos.sales.addEvidence({
      prospectId: prospect.id, field: `signal:${f.kind.toLowerCase()}`, claim: f.claim,
      nature: 'observed', sourceUrl: f.sourceUrl,
      basis: `Relevé sur ${f.sourceUrl} — motif « ${f.marker} ».`, confidence: 0.8,
    });
    ajoutes += 1;
  }
}
/*
 * La raison sociale prouve QUI edite le domaine ; elle ne dit rien de ce que
 * l'entreprise fait. La compter parmi les deux faits exiges laisserait un
 * message se personnaliser a moitie avec le nom de son destinataire.
 */
const faits = repos.sales
  .evidenceFor(prospect.id)
  .filter((e) => e.nature === 'observed' && e.sourceUrl && commercial(e));
line('FACTS', `${faits.length} constaté(s) et sourcé(s)` + (ajoutes ? ` (+${ajoutes})` : ''), faits.length >= 2);
line('pages enrichissement', `${enrichi.pagesReused} reprises · +${enrichi.pagesFetchedExtra} · ${enrichi.earlyStopReason}`);

// ── 3. L'identité, corroborée par les mentions légales ────────────────────
const accueil = pages[0];
const candidates = [
  ...(accueil ? legalLinksIn(accueil.html, accueil.url, domain) : []),
  ...legalPagesFor(prospect.website, domain),
].filter((u) => !seen.has(u));

let legale = extractLegalIdentity(pages, domain);
if (!legale && candidates.length > 0) {
  const got = await fetchRawPages(candidates, {
    logger: system.logger, timeoutMs: 12_000, maxPages: 1,
  });
  legale = extractLegalIdentity(got.pages, domain);
}

if (legale) {
  const niveau = confidenceFromLegal(legale);
  line('entité juridique', `« ${legale.legalName} »${legale.legalForm ? ' ' + legale.legalForm : ''}`, true);
  line('immatriculation', legale.registration ?? 'aucune');
  line('confiance', `${prospect.identityConfidence} → ${niveau}`, niveau >= 0.75);
  line('source', legale.sourceUrl);
  if (WRITE) {
    const verdict = repos.sales.confirmIdentity(prospect.id, {
      legalName: legale.legalName, confidence: niveau,
      source: `mentions legales (${legale.sourceUrl})`,
    });
    line('enregistrée', verdict.reason, verdict.applied);
    repos.sales.addEvidence({
      prospectId: prospect.id, field: 'identite:entite_juridique',
      claim: `${legale.legalName}${legale.legalForm ? ' ' + legale.legalForm : ''}`
        + (legale.registration ? ` — ${legale.registration}` : ''),
      nature: 'observed', sourceUrl: legale.sourceUrl,
      basis: legale.basis, confidence: niveau,
    });
  }
} else {
  line('entité juridique', 'aucune preuve trouvée', false);
}

/**
 * Le nom commercial est-il relié au domaine par le site lui-même ?
 *
 * La condition posée par le propriétaire : la marque ne reste le nom de la
 * rédaction que si des sources du site l'attachent explicitement au domaine.
 * Faute de quoi on écrirait à une entreprise sous un nom qu'elle ne reconnaît
 * pas comme le sien — le défaut que la garde d'identité existe pour empêcher.
 */
// Les accents se replient, ils ne se suppriment pas : « Cybermeca » sans
// repli devenait « cybermca », qui ne correspond a aucune URL du site.
const applatir = (t: string) =>
  t.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const marque = applatir(prospect.companyName);
const attaches = repos.sales
  .evidenceFor(prospect.id)
  .filter((e) => e.sourceUrl && isOfficialPage(e.sourceUrl, domain))
  .filter((e) => applatir(e.sourceUrl!).includes(marque));
line(
  'marque ↔ domaine',
  attaches.length > 0
    ? `${attaches.length} source(s) du site portent « ${prospect.companyName} »`
    : 'aucune source du site ne relie la marque au domaine',
  attaches.length > 0,
);
for (const a of attaches.slice(0, 2)) console.log(`       ${c.dim}${a.sourceUrl}${c.reset}`);

// ── 4. La garde, inchangée ────────────────────────────────────────────────
const frais = repos.sales.get(prospect.id)!;
/**
 * En simulation, rien n'a ete ecrit — mais la garde doit etre evaluee sur ce
 * que l'ecriture produirait, sinon la simulation annonce un blocage qui
 * n'existera pas et personne ne lance l'ecriture.
 */
const confiance = Math.max(
  frais.identityConfidence ?? 0,
  legale ? confidenceFromLegal(legale) : 0,
);
const check = checkPriorityEligibility({
  identity: frais.domain
    ? {
        companyName: frais.companyName, canonicalDomain: frais.domain,
        officialWebsite: frais.website ?? `https://${frais.domain}`, country: frais.country,
        identityConfidence: confiance, identitySources: frais.identitySources ?? [],
      }
    : null,
  pageType: (frais.pageType as 'OFFICIAL_COMPANY_SITE') ?? 'UNKNOWN',
  icp: 'MATCH',
  observedFacts: faits.length,
  score: frais.score ?? 0,
  scoreThreshold: SALES_TIER_THRESHOLDS.priority,
  hasSourcedPersonalization: faits.length > 0,
});
const canal = frais.contactObserved && Boolean(frais.contactEmail || frais.contactPage || frais.contactPhone);
line('IDENTITY', check.blockers.some((b) => /identit|nom et domaine/.test(b)) ? 'NON VÉRIFIÉE' : 'VERIFIED',
  !check.blockers.some((b) => /identit|nom et domaine/.test(b)));
line('canal de contact', frais.contactEmail ?? frais.contactPhone ?? frais.contactPage ?? 'aucun', canal);
line('ÉLIGIBILITÉ', check.eligible && canal ? 'ÉLIGIBLE' : check.blockers.join(' · ') || 'canal manquant',
  check.eligible && canal);

if (!check.eligible || !canal) {
  console.log(`\n  ${c.red}Reste bloqué.${c.reset} Aucune garde n'a été touchée.\n`);
  await system.shutdown('bloqué');
  process.exit(0);
}

// ── 5. Le brouillon ───────────────────────────────────────────────────────
const facts: OutreachFact[] = repos.sales
  .evidenceFor(prospect.id)
  .filter((e) => e.sourceUrl && e.field !== 'identite:entite_juridique')
  .map((e) => ({ evidenceId: e.id, claim: e.claim, sourceUrl: e.sourceUrl!, nature: e.nature }));

const outcome = buildOutreachDraft({
  company: frais.companyName,
  website: frais.website,
  facts,
  contact: {
    name: frais.contactName, role: frais.contactRole,
    email: frais.contactEmail, phone: frais.contactPhone,
    contactPage: frais.contactPage, sourceUrl: frais.contactSourceUrl,
    confidence: frais.contactConfidence ?? 0.5,
    named: Boolean(frais.contactName?.trim()),
  },
  whyThisCompany: frais.whyFit ?? '',
  senderName: config.sales.senderName,
  offer: { priceEur: 49, deliveryHours: 24 },
});

if (!outcome.draft) {
  console.log(`\n  ${c.red}Rédaction refusée${c.reset} — ${outcome.reason}\n`);
  await system.shutdown('refus');
  process.exit(0);
}

console.log(`\n  ${c.bold}${c.green}BROUILLON${c.reset}  ${c.dim}destinataire ${frais.contactEmail ?? frais.contactPhone}${c.reset}`);
console.log(`  ${c.dim}fait cité : « ${outcome.draft.personalizationFact.claim.slice(0, 90)} »${c.reset}`);
console.log(`  ${c.dim}source    : ${outcome.draft.sourceUsedForPersonalization}${c.reset}\n`);
console.log('  ┌' + '─'.repeat(76));
for (const l of outcome.draft.messageEmail.split('\n')) console.log('  │ ' + l);
console.log('  └' + '─'.repeat(76));

if (WRITE) {
  repos.sales.setOutreach(prospect.id, {
    personalizationFactId: outcome.draft.personalizationFact.evidenceId,
    messageShort: outcome.draft.messageShort,
    messageEmail: outcome.draft.messageEmail,
    sourceUrl: outcome.draft.sourceUsedForPersonalization,
  });
  /*
   * Un dossier deja pret le reste : la machine a etats refuse la transition
   * d'un etat vers lui-meme, et c'est voulu — une transition est un evenement,
   * pas une confirmation. Le corps vient d'etre reecrit, ce qui suffit.
   */
  if (frais.state !== 'READY_FOR_REVIEW') {
    repos.sales.setState(prospect.id, 'READY_FOR_REVIEW');
  }
  console.log(`\n  ${c.green}✓${c.reset} état → READY_FOR_REVIEW`);
} else {
  console.log(`\n  ${c.amber}Simulation.${c.reset} Relancez avec --write pour enregistrer le brouillon.`);
}

console.log(`\n  ${c.dim}messages envoyés après : ${repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z')} — aucun envoi${c.reset}\n`);
await system.shutdown('terminé');
