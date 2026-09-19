/**
 * Envoyer des relances explicitement approuvées, une seule fois chacune.
 *
 * Le premier script d'ATLAS qui envoie réellement quelque chose. Tout ce qui
 * précède a été construit pour que ce moment soit sûr : le portail d'envoi, la
 * réservation anti-doublon, l'approbation obligatoire, la garde de direction.
 * Ils ne servent à rien s'ils ne sont pas franchis dans l'ordre, et cet ordre
 * est imposé par `runManualSendLot` (packages/runtime/src/manual-send.ts) —
 * le même code, éprouvé avec un transport factice avant que le vrai ne serve.
 *
 * Le contenu ne vient jamais d'ici. Il est lu dans un fichier fourni par le
 * propriétaire, et le script refuse de composer quoi que ce soit : un texte
 * qu'ATLAS écrirait ne serait pas celui qui a été approuvé.
 *
 * En `ATLAS_ENGINE_MODE=INTERNAL_TEST`, un envoi réel ne va qu'à GMAIL_USER :
 * un lot qui contient une autre adresse est refusé en entier, avant toute
 * lecture de boîte, réservation ou écriture (INTERNAL_TEST_RECIPIENT_BLOCKED).
 * Aucune liste d'exceptions, aucune variable de contournement.
 *
 *   npm run sales:send-approved -- --file=<lot.json>                simulation
 *   npm run sales:send-approved -- --file=<lot.json> --send         envoi réel, confirmé au clavier [o/N]
 *   npm run sales:send-approved -- --file=<lot.json> --send --yes   sans terminal : la confirmation est le drapeau lui-même
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { createLogger, loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { GmailInboxProvider, GmailOutboundProvider } from '../packages/intelligence/src/index.ts';
import { evaluateManualSendLot } from '../packages/departments/src/index.ts';
import { runManualSendLot, type ManualSendItem, type ManualSendResult } from '../packages/runtime/src/manual-send.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m',
};
const arg = (name: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const SEND = process.argv.includes('--send');
const YES = process.argv.includes('--yes');
const fichier = arg('file');

if (!fichier) {
  console.error('  --file=<lot.json> est obligatoire : le contenu ne s’invente pas ici.');
  process.exit(2);
}

const lot = JSON.parse(readFileSync(fichier, 'utf8')) as ManualSendItem[];
const config = loadConfig(process.cwd());
const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(config.paths.databaseFile, logger);
const boite = process.env.GMAIL_USER?.trim() ?? '';
const inbox = new GmailInboxProvider({ logger });
const expediteur = new GmailOutboundProvider({});
const EPOCH = '1970-01-01T00:00:00.000Z';
const avant = repos.salesLoop.sentSince(EPOCH);

const mode = config.sales.engineMode;
console.log(`\n  ${c.bold}${c.cyan}RELANCES APPROUVÉES${c.reset}`);
console.log(`  ${c.dim}${lot.length} message(s) · ${SEND ? 'ENVOI RÉEL' : 'simulation — --send pour envoyer'} · ATLAS_ENGINE_MODE=${mode}${c.reset}`);
console.log(`  ${c.dim}messages envoyés avant : ${avant}${c.reset}\n`);

const afficher = (r: ManualSendResult) => {
  const couleur = r.verdict === 'SENT' ? c.green : r.verdict === 'PRÊT' ? c.amber : c.red;
  console.log(`  ${couleur}${r.verdict.padEnd(8)}${c.reset} ${r.nom} — ${r.motif}`);
};

const terminer = (resultats: ManualSendResult[], code: number) => {
  const apres = repos.salesLoop.sentSince(EPOCH);
  console.log(`\n  ${c.bold}RÉSULTAT${c.reset}`);
  for (const r of resultats) {
    const couleur = r.verdict === 'SENT' ? c.green : r.verdict === 'PRÊT' ? c.amber : c.red;
    console.log(`    ${r.nom.padEnd(20)} ${couleur}${r.verdict.padEnd(8)}${c.reset}${c.dim}${r.motif}${c.reset}`);
  }
  console.log(`\n  MESSAGES SENT BEFORE  ${avant}`);
  console.log(`  MESSAGES SENT AFTER   ${apres}`);
  console.log(`  TOTAL NEW SENDS       ${apres - avant}\n`);
  repos.close();
  // Pas de process.exit ici : une connexion réseau encore ouverte ferait
  // tomber libuv sous Windows à la sortie forcée. Le code de sortie suffit.
  process.exitCode = code;
};

/*
 * ── La garde de lot, avant tout — même avant l'échange de jeton ────────────
 *
 * Pure et locale : la porte (ATLAS_OUTBOUND_ENABLED, lue par le transport),
 * puis, hors PRODUCTION, chaque destinataire contre GMAIL_USER. Un lot
 * refusé ici n'a déclenché aucun réseau, aucune réservation, aucune écriture.
 * `runManualSendLot` rejoue la même garde : deux gardes indépendantes.
 */
const autorisation = expediteur.authorization();
const garde = evaluateManualSendLot({
  send: SEND, engineMode: mode, outboundEnabled: autorisation.outboundEnabled,
  gmailUser: boite, recipients: lot.map((r) => r.recipient),
});
if (!garde.allowed) {
  console.log(`  ${c.red}LOT REFUSÉ${c.reset} — en entier, avant toute lecture, réservation ou écriture.`);
  for (const block of garde.blocks) {
    console.log(`    ${c.red}${block.code}${c.reset}  ${block.message}`);
    for (const destinataire of block.recipients) console.log(`      ${c.dim}· ${destinataire}${c.reset}`);
  }
  terminer(lot.map((r) => ({ nom: r.companyName, verdict: 'BLOCKED', motif: garde.blocks.map((b) => b.code).join(', ') })), 3);
} else {
  // En simulation, dire dès maintenant ce que --send refuserait : on apprend
  // la règle avant de la heurter, sans qu'elle bloque la simulation.
  if (!SEND) {
    const apercu = evaluateManualSendLot({ send: true, engineMode: mode, outboundEnabled: true, gmailUser: boite, recipients: lot.map((r) => r.recipient) });
    for (const block of apercu.blocks) {
      console.log(`  ${c.amber}NOTE${c.reset} avec --send, ${block.code} refuserait tout le lot : ${block.message}`);
      for (const destinataire of block.recipients) console.log(`      ${c.dim}· ${destinataire}${c.reset}`);
    }
    if (apercu.blocks.length > 0) console.log();
  }

  await expediteur.verifyScopes();

  /*
   * ── La confirmation humaine, avant le premier octet ─────────────────────
   *
   * `--send` dit l'intention ; ceci dit à qui, combien, dans quel mode, et
   * attend un « o ». Sans terminal, `--yes` tient lieu de confirmation — tapé
   * par une personne, jamais déduit. Aucun drapeau ne touche à la garde de
   * lot : elle a déjà tranché, plus haut.
   */
  let confirme = !SEND;
  if (SEND) {
    const destinations = [...new Set(lot.map((r) => r.recipient))];
    console.log(`  ${c.bold}CONFIRMATION${c.reset}`);
    console.log(`    destination : ${destinations.join(', ')}`);
    console.log(`    nombre      : ${lot.length}`);
    console.log(`    mode        : ${garde.selfTest ? `${mode} SELF-TEST — vers GMAIL_USER seulement` : mode}`);
    console.log(`    transport   : ${expediteur.status().code}`);
    if (YES) {
      confirme = true;
      console.log(`    ${c.dim}confirmé par --yes${c.reset}\n`);
    } else if (!process.stdin.isTTY) {
      console.log(`\n  ${c.red}CONFIRMATION IMPOSSIBLE${c.reset} — pas de terminal : relancer avec --yes pour confirmer explicitement.\n`);
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const reponse = (await rl.question(`    Confirmer l’envoi réel ? [o/N] `)).trim().toLowerCase();
      rl.close();
      confirme = reponse === 'o' || reponse === 'oui';
      console.log(confirme ? `    ${c.green}confirmé${c.reset}\n` : `    ${c.amber}annulé${c.reset}\n`);
    }
  }

  if (!confirme) {
    terminer(lot.map((r) => ({ nom: r.companyName, verdict: 'BLOCKED', motif: 'envoi non confirmé' })), 4);
  } else {
    const rapport = await runManualSendLot({
      repos, lot, send: SEND, engineMode: mode, outboundEnabled: autorisation.outboundEnabled,
      mailbox: boite, inbox, outbound: expediteur, onResult: afficher,
    });
    terminer(rapport.results, rapport.refused ? 3 : 0);
  }
}
