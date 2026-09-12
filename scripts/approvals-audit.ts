/**
 * Classer ce qui attend une décision, et ce qui n'en attend plus.
 *
 * Vingt-et-un prospects portaient l'état `READY_FOR_REVIEW` sans apparaître
 * nulle part : l'écran d'approbation ne lisait qu'un des deux magasins de
 * brouillons. Les rendre visibles d'un coup ferait remonter des dossiers déjà
 * envoyés, abandonnés ou clos — c'est-à-dire proposer une seconde fois des
 * décisions déjà prises.
 *
 * Ce script montre le tri avant qu'il ne devienne un écran. Il appelle
 * `buildApprovals`, la fonction que l'interface utilise : un audit qui
 * réimplémenterait la règle finirait par valider sa propre version, et c'est
 * exactement ainsi qu'un tableau de bord se met à mentir.
 *
 * Lecture seule, sans exception. Aucune écriture, aucun envoi.
 *
 *   npm run approvals:audit
 */
import { loadConfig, loadAtlasEnv, createLogger } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { buildApprovals } from '../packages/server/src/http/command-center.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m',
};

const config = loadConfig(process.cwd());
const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(config.paths.databaseFile, logger);

/** Empreinte de la base avant lecture : un audit ne doit rien changer. */
const compter = () => ({
  prospects: repos.sales.batchIds().flatMap((b) => repos.sales.forBatch(b)).length,
  drafts: ['READY_FOR_APPROVAL', 'APPROVED_TO_SEND', 'REJECTED', 'SENT', 'ABANDONED']
    .reduce((n, s) => n + repos.salesLoop.draftsInState(s).length, 0),
  sent: repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z'),
});
const avant = compter();

const bruts = repos.sales
  .batchIds()
  .flatMap((b) => repos.sales.forBatch(b))
  .filter((p) => p.state === 'READY_FOR_REVIEW');

const vue = buildApprovals(repos);

console.log(`\n  ${c.bold}${c.cyan}FILE D'APPROBATION${c.reset}`);
console.log(`  ${c.dim}lecture seule · aucune écriture · aucun envoi${c.reset}\n`);

console.log(`  ${c.bold}READY_FOR_REVIEW bruts${c.reset}  ${bruts.length}`);
console.log(`  ${c.bold}actionnables${c.reset}            ${vue.pending.length}` +
  `  ${c.dim}(${vue.bySource.OUTREACH_DRAFT} outreach_drafts · ${vue.bySource.SALES_PROSPECT} sales_prospects)${c.reset}`);
console.log(`  ${c.bold}écartés${c.reset}                 ${vue.excluded.length}\n`);

if (vue.pending.length > 0) {
  console.log(`  ${c.bold}${c.green}EN ATTENTE DE DÉCISION${c.reset}`);
  for (const item of vue.pending) {
    console.log(`    ${c.green}●${c.reset} ${item.company.slice(0, 34).padEnd(36)}${c.dim}${item.domain}${c.reset}`);
    console.log(`        source        ${item.source}`);
    console.log(`        UI STATUS     ${item.uiStatus}`);
    console.log(`        SOURCE STATE  ${item.sourceState}`);
    console.log(`        destinataire  ${item.recipient ?? '—'}`);
    console.log(`        gardes        ${item.guards.join(' · ')}`);
    console.log(`        faits         ${item.facts.length} sourcé(s)`);
    console.log(`        approuvable   ${item.canApprove ? 'oui' : 'non — ' + vue.actionEndpoint}`);
  }
  console.log();
}

console.log(`  ${c.bold}${c.amber}ÉCARTÉS DE LA FILE ACTIVE${c.reset} ${c.dim}(conservés à l'historique)${c.reset}`);
const parMotif = new Map<string, typeof vue.excluded>();
for (const e of vue.excluded) {
  const cle = e.reason.replace(/\d{4}-\d{2}-\d{2}/, 'AAAA-MM-JJ').replace(/^\d+ /, 'N ');
  const liste = parMotif.get(cle) ?? [];
  liste.push(e);
  parMotif.set(cle, liste);
}
for (const [motif, liste] of [...parMotif.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`    ${c.red}✗${c.reset} ${String(liste.length).padStart(2)} · ${motif}`);
  for (const e of liste) {
    console.log(`        ${c.dim}${e.company.slice(0, 40).padEnd(42)}${e.domain} · ${e.source}${c.reset}`);
  }
}

// ── Cyberméca, nommément ──────────────────────────────────────────────────
console.log(`\n  ${c.bold}CYBERMÉCA${c.reset}`);
const cyber = vue.pending.find((p) => p.domain === 'groupe-ledoux.com');
const cyberExclu = vue.excluded.find((p) => p.domain === 'groupe-ledoux.com');
if (cyber) {
  console.log(`    ${c.green}VISIBLE${c.reset} · source ${cyber.source} · état réel ${cyber.sourceState}`);
  console.log(`    ${c.dim}${cyber.company} · ${cyber.recipient} · ${cyber.guards.join(' · ')}${c.reset}`);
} else if (cyberExclu) {
  console.log(`    ${c.red}ÉCARTÉ${c.reset} — ${cyberExclu.reason}`);
} else {
  console.log(`    ${c.red}ABSENT des deux listes${c.reset}`);
}

// ── L'audit n'a rien touché ───────────────────────────────────────────────
const apres = compter();
const intact =
  avant.prospects === apres.prospects &&
  avant.drafts === apres.drafts &&
  avant.sent === apres.sent;
console.log(`\n  ${intact ? c.green + 'DB WRITES = 0' : c.red + 'LA BASE A CHANGÉ'}${c.reset}` +
  `  ${c.dim}${apres.prospects} prospects · ${apres.drafts} brouillons · ${apres.sent} envois${c.reset}`);
console.log(`  ${c.dim}MESSAGES SENT : ${apres.sent}${c.reset}\n`);

repos.close();
