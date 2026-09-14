/**
 * Relier la boîte de réception aux conversations commerciales.
 *
 * Lecture seule, de bout en bout : le fournisseur n'expose aucun envoi, la
 * classification est déterministe, et rien n'est écrit dans la messagerie.
 *
 * Trois garanties comptent ici, et chacune existe parce que son absence
 * produirait une erreur silencieuse :
 *
 *   · un message déjà lu n'est jamais réimporté — sinon une entreprise aurait
 *     répondu deux fois, au moment précis où l'on commence à s'y fier ;
 *   · une réponse qu'on ne sait pas rattacher n'est attribuée à personne —
 *     une réponse mal rattachée fait relancer quelqu'un qui avait dit non ;
 *   · aucun état commercial n'est déduit — `INTERESTED`, `WON`, `LOST`
 *     restent posés par un humain.
 *
 *   npm run sales:inbox-sync              boîte Gmail réelle
 *   npm run sales:inbox-sync -- --fixture fixtures/inbox.json
 */
import { readFileSync } from 'node:fs';
import { createLogger, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  GmailInboxProvider,
  MAX_MESSAGES_PER_SYNC,
  FixtureInboxProvider,
  type MailInboxProvider,
  type MailMessage,
} from '../packages/intelligence/src/index.ts';
import { syncSalesInbox, INBOX_FIRST_PASS_DAYS } from '../packages/runtime/src/index.ts';

// Avant toute lecture de process.env : sans cet appel, `.env.local` n'existe
// pas pour ce processus et la configuration parait absente sans qu'aucune
// erreur ne le dise.
loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m',
};

const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const has = (name: string) => process.argv.includes(`--${name}`);

const logger = createLogger({ level: 'error', pretty: false });
const fixturePath = flag('fixture');
const dbPath = process.env.ATLAS_DB_PATH ?? 'data/atlas.db';

/**
 * Une boîte figée n'écrit pas dans la base de production.
 *
 * La première répétition à blanc a inscrit trois événements de démonstration
 * dans la vraie base : la boîte commerciale a affiché un rebond, une absence
 * et une réponse qui n'avaient jamais eu lieu. Les données étaient fausses au
 * moment précis où l'on commence à s'y fier — exactement ce que tout ce module
 * cherche à éviter.
 *
 * Le refus est donc dans le chemin par défaut, pas dans la vigilance de celui
 * qui lance la commande.
 */
if (fixturePath && !process.env.ATLAS_DB_PATH && !has('allow-production')) {
  console.error('');
  console.error(`  Refus : une boîte figée écrirait dans « ${dbPath} », la base de production.`);
  console.error('  Des événements de démonstration y deviendraient des faits commerciaux.');
  console.error('');
  console.error('  Pointez ailleurs :');
  console.error('    ATLAS_DB_PATH=/tmp/atlas-demo.db npm run sales:inbox-sync -- --fixture=…');
  console.error('');
  console.error('  Ou, si c’est vraiment voulu : --allow-production');
  console.error('');
  process.exit(2);
}

const repos = createRepositories(dbPath, logger);
const provider: MailInboxProvider = fixturePath
  ? new FixtureInboxProvider(JSON.parse(readFileSync(fixturePath, 'utf8')) as MailMessage[])
  : new GmailInboxProvider({ logger });

const status = provider.status();
console.log(`\n  ${c.bold}SALES INBOX SYNC${c.reset}  ${c.dim}lecture seule · aucun message envoyé${c.reset}`);
console.log(`  fournisseur : ${provider.id} · ${status.code} · ${status.detail}`);
console.log(`  portées     : ${status.scopes.join(', ')}\n`);

if (!status.configured) {
  // Une messagerie non configurée n'est pas une panne : c'est l'état par
  // défaut d'une machine neuve. On le dit, on explique quoi renseigner, et
  // on s'arrête sans rien casser.
  console.log(`  ${c.amber}${status.code}${c.reset} — la synchronisation n'a pas eu lieu.`);
  console.log('  Renseignez dans l’environnement, jamais dans le dépôt :');
  console.log('    GMAIL_CLIENT_ID · GMAIL_CLIENT_SECRET · GMAIL_REFRESH_TOKEN · GMAIL_USER');
  console.log('  Le consentement doit porter la seule portée gmail.readonly.\n');
  console.log('  Pour répéter à blanc : npm run sales:inbox-sync -- --fixture=<fichier.json>\n');
  console.log('  MESSAGES SENT: 0\n');
  repos.close();
  process.exit(0);
}

/**
 * Le cœur vit dans `syncSalesInbox` (runtime) : le daemon l'exécute à cadence
 * fixe avec exactement les mêmes garanties. Ce script ne garde que ce qui
 * s'imprime.
 */
const boiteSurveillee = process.env.GMAIL_USER?.trim() ?? status.detail.replace(/^bo[iî]te\s+/i, '').trim();
const report = await syncSalesInbox(repos, provider, {
  mailbox: boiteSurveillee || 'inconnue',
  since: flag('since'),
  max: Number(flag('max') ?? MAX_MESSAGES_PER_SYNC),
});

if (!report.ran) {
  console.log(`  ${c.amber}${report.skipped}${c.reset}\n`);
  if (report.skipped?.startsWith('aucune conversation')) {
    console.log(`  Lancez d'abord : npm run sales:inbox -- sync\n`);
  }
  console.log('  MESSAGES SENT: 0\n');
  repos.close();
  process.exit(0);
}

console.log(
  `  reprise     : ${report.checkpoint ? `depuis ${(report.since ?? '').slice(0, 16).replace('T', ' ')} `
    + `(curseur ${report.checkpoint.slice(0, 16).replace('T', ' ')}, recouvrement 6 h)`
    : `aucun curseur — premier passage, ${INBOX_FIRST_PASS_DAYS} derniers jours`}\n`,
);

for (const line of report.lines) {
  if (line.kind === 'UNMATCHED') {
    console.log(
      `  ${c.dim}non rattaché${c.reset} ${(line.subject ?? '(sans objet)').slice(0, 34).padEnd(36)}` +
        `${c.dim}${line.detail.slice(0, 60)}${c.reset}`,
    );
  } else if (line.kind === 'IMPORTED') {
    const colour =
      line.classification === 'BOUNCED' ? c.red
      : line.classification === 'REPLIED' ? c.green
      : c.amber;
    console.log(
      `  ${colour}${(line.classification ?? '').padEnd(13)}${c.reset}` +
        `${(line.companyName ?? '').slice(0, 22).padEnd(24)}` +
        `${c.dim}${line.detail} · ${(line.subject ?? '').slice(0, 40)}${c.reset}`,
    );
  }
}

console.log('');
const { scanned, outbound: sortants, matched, newEvents, duplicates, unmatched, byClassification: classes } = report;
const byClassification = new Map(Object.entries(classes));
console.log(`  EMAILS SCANNED       ${scanned}`);
console.log(`  NOS PROPRES ENVOIS   ${sortants}  ${c.dim}(ecartes : jamais des reponses)${c.reset}`);
console.log(`  MATCHED TO OUTREACH  ${matched}`);
console.log(`  NEW EVENTS           ${newEvents}`);
console.log(`  DUPLICATES SKIPPED   ${duplicates}`);
console.log(`  UNMATCHED            ${unmatched}`);
console.log(`  BOUNCES              ${byClassification.get('BOUNCED') ?? 0}`);
console.log(`  AUTO REPLIES         ${byClassification.get('AUTO_REPLY') ?? 0}`);
console.log(`  HUMAN REPLIES        ${byClassification.get('REPLIED') ?? 0}`);
const review = byClassification.get('NEEDS_REVIEW') ?? 0;
if (review > 0 || unmatched > 0) {
  console.log(`  ${c.amber}À LIRE               ${review + unmatched}${c.reset}  ${c.dim}(non classés ou non rattachés)${c.reset}`);
}
console.log('');
console.log('  MESSAGES SENT: 0');
console.log('');
if (has('verbose')) console.log(`  ${c.dim}npm run sales:inbox pour la boîte commerciale.${c.reset}\n`);

repos.close();
