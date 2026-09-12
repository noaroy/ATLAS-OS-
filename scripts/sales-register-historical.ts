/**
 * Inscrire au registre une entreprise déjà contactée hors du système.
 *
 * Une entreprise contactée mais absente du registre est invisible : elle
 * n'apparaît ni dans l'entonnoir, ni dans les relances, ni dans le taux de
 * réponse. Elle n'est pas signalée comme oubliée — elle n'est pas signalée du
 * tout. Trois entreprises se trouvaient dans ce cas, et c'est la pire forme de
 * dette : celle qu'aucun tableau ne montre.
 *
 * Le script consigne l'histoire, il ne la fabrique pas. La date, le canal et la
 * preuve viennent du message réellement envoyé, et rien n'est expédié ici : le
 * registre note qu'un contact a eu lieu, pas qu'il faut en faire un nouveau.
 *
 *   npm run sales:register-historical -- --file=<lot.json>          simulation
 *   npm run sales:register-historical -- --file=<lot.json> --apply  écrit
 */
import { readFileSync } from 'node:fs';
import { createLogger, loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m',
};

const arg = (name: string): string | null =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const APPLY = process.argv.includes('--apply');
const fichier = arg('file');
if (!fichier) {
  console.error('  --file=<lot.json> est obligatoire : une inscription ne s’invente pas.');
  process.exit(2);
}

interface Historique {
  domain: string;
  companyName: string;
  channel: string;
  /** L'adresse réellement contactée, telle qu'elle figure dans le message. */
  contactedAt: string;
  contactedOn: string;
  /** D'où vient la preuve : identifiant de message, URL, référence. */
  evidence: string;
  note?: string;
}

const lot = JSON.parse(readFileSync(fichier, 'utf8')) as Historique[];
const config = loadConfig(process.cwd());
const repos = createRepositories(config.paths.databaseFile,
  createLogger({ level: 'error', pretty: false }));

const avant = repos.sales.ledgerDomains().filter((d) => d.kind === 'CONTACTED').length;

console.log(`\n  ${c.bold}INSCRIPTION RÉTROACTIVE${c.reset}`);
console.log(`  ${c.dim}${APPLY ? 'écriture réelle' : 'simulation — --apply pour écrire'} · aucun envoi${c.reset}`);
console.log(`  ${c.dim}entreprises contactées avant : ${avant}${c.reset}\n`);

let inscrites = 0;

for (const entree of lot) {
  const deja = repos.sales.ledgerFor(entree.domain);
  if (deja) {
    console.log(`  ${c.amber}DÉJÀ INSCRITE${c.reset}  ${entree.domain} — ${deja.kind}, rien à faire`);
    continue;
  }

  console.log(`  ${c.bold}${entree.companyName}${c.reset}  ${entree.domain}`);
  console.log(`    contacté le ${entree.contactedOn} · ${entree.channel} · ${entree.contactedAt}`);
  console.log(`    ${c.dim}preuve : ${entree.evidence}${c.reset}`);

  if (!APPLY) continue;

  /**
   * Un prospect d'abord, puis l'inscription au registre.
   *
   * Le lot porte un identifiant qui dit d'où vient l'entrée : « historique »
   * plutôt qu'un numéro de batch de découverte. Une inscription rétroactive ne
   * doit pas se confondre avec une prospection — la première constate, la
   * seconde décide.
   */
  const { prospect } = repos.sales.discover({
    batchId: `HISTORIQUE-${entree.contactedOn}`,
    companyName: entree.companyName,
    domain: entree.domain,
    website: `https://${entree.domain}`,
    sourceUrl: entree.evidence,
    discoveredAt: `${entree.contactedOn}T00:00:00.000Z`,
  });

  repos.sales.setChannels(prospect.id, [{
    type: entree.channel,
    value: entree.contactedAt,
    intent: 'OUTREACH',
    suitability: 'USABLE',
    sourceUrl: entree.evidence,
    confidence: 'CONFIRMED',
    selected: true,
  }]);

  const verdict = repos.sales.recordOutreach({
    domain: entree.domain,
    kind: 'CONTACTED',
    recordedBy: 'proprietaire',
    channel: entree.channel,
    note: entree.note
      ?? `Contact historique du ${entree.contactedOn} vers ${entree.contactedAt}. `
        + `Preuve : ${entree.evidence}. Inscrit rétroactivement, sans nouvel envoi.`,
    recordedAt: `${entree.contactedOn}T00:00:00.000Z`,
  });

  if (!verdict.recorded) {
    console.log(`    ${c.red}refusé${c.reset} : ${verdict.reason}`);
    continue;
  }
  console.log(`    ${c.green}inscrite${c.reset} — CONTACTED, sans nouvel envoi`);
  inscrites += 1;
}

const apres = repos.sales.ledgerDomains().filter((d) => d.kind === 'CONTACTED').length;
console.log(`\n  entreprises contactées : ${avant} → ${apres}`);
console.log(`  ${APPLY ? `${inscrites} inscription(s)` : 'simulation — rien écrit'}`);
console.log(`  ${c.dim}MESSAGES SENT: 0 — ce script n'envoie rien.${c.reset}\n`);
repos.close();
