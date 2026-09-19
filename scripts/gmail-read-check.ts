/**
 * Lire la boîte, en lecture seule, pour prouver que la lecture marche.
 *
 * `gmail:check` prouve le jeton et les portées ; ceci prouve le chemin de
 * lecture de bout en bout — le même fournisseur, la même pagination, les mêmes
 * en-têtes que la synchronisation du daemon — sans rien écrire nulle part :
 * ni dans la boîte, ni dans la base. Seuls des en-têtes s'affichent (date,
 * expéditeur, sujet, fil, étiquettes) ; jamais un corps de message, jamais un
 * jeton.
 *
 *   npm run gmail:read-check                     les 5 derniers messages entrants
 *   npm run gmail:read-check -- --max=20         plus loin
 *   npm run gmail:read-check -- --thread=<id>    les messages d'un fil (lus, puis filtrés ici)
 *   npm run gmail:read-check -- --since=2026-09-01
 *
 * MESSAGES SENT : 0, par construction — le fournisseur d'entrée n'a pas de
 * méthode d'envoi.
 */
import { createLogger, loadConfig } from '../packages/core/src/index.ts';
import { GmailInboxProvider } from '../packages/intelligence/src/mail/gmail.ts';

const config = loadConfig(process.cwd());
const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m' };
const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const max = Math.max(1, Math.min(Number(flag('max') ?? 5) || 5, 100));
const thread = flag('thread');
const since = flag('since');

console.log(`\n  ${c.bold}LECTURE GMAIL${c.reset}  ${c.dim}lecture seule · en-têtes seulement · rien n'est écrit${c.reset}`);
console.log(`  ${c.dim}ATLAS_OUTBOUND_ENABLED=${config.sales.outboundEnabled} · mode ${config.sales.engineMode}${c.reset}\n`);

const provider = new GmailInboxProvider({ logger: createLogger({ level: 'error', pretty: false }) });
const status = provider.status();
console.log(`  fournisseur : ${provider.id} · ${status.code} · ${status.detail}`);
console.log(`  portées     : ${status.scopes.join(', ')}`);
if (!status.configured) {
  console.log(`\n  ${c.amber}${status.code}${c.reset} — renseignez GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER (npm run gmail:authorize).\n`);
  process.exit(2);
}

try {
  const t0 = Date.now();
  // Un fil demandé se lit dans une fenêtre plus large, puis se filtre ici :
  // le fournisseur ne fait que lister, il n'ouvre rien d'autre.
  const messages = await provider.list({ max: thread ? Math.max(max, 50) : max, ...(since ? { since: `${since}T00:00:00.000Z` } : {}) });
  const retenus = thread ? messages.filter((m) => m.threadId === thread) : messages;
  console.log(`  lus         : ${messages.length} message(s) entrant(s) en ${Date.now() - t0} ms${thread ? ` · ${retenus.length} dans le fil ${thread}` : ''}\n`);
  for (const m of retenus) {
    const expediteur = m.from.replace(/<[^>]*>/g, '').trim() || m.from;
    console.log(`  ${c.dim}${m.receivedAt.slice(0, 16).replace('T', ' ')}${c.reset}  ${expediteur.slice(0, 32).padEnd(32)}  ${(m.subject ?? '(sans sujet)').slice(0, 48)}`);
    console.log(`  ${c.dim}${''.padEnd(16)}  fil ${m.threadId ?? '—'} · ${m.labels.filter((l) => !l.startsWith('CATEGORY_')).join(', ') || 'sans étiquette'}${c.reset}`);
  }
  if (retenus.length === 0) console.log(`  ${c.dim}aucun message dans cette fenêtre${c.reset}`);
  console.log(`\n  ${c.green}LECTURE CONFIRMÉE${c.reset} — ${c.dim}MESSAGES SENT: 0${c.reset}\n`);
} catch (error) {
  // Le message d'erreur du fournisseur ne porte jamais de secret (HTTP et code seulement).
  console.log(`\n  ${c.red}LECTURE IMPOSSIBLE${c.reset} — ${error instanceof Error ? error.message : String(error)}\n`);
  // Pas de process.exit ici : une connexion réseau encore ouverte ferait
  // tomber libuv sous Windows à la sortie forcée. Le code de sortie suffit.
  process.exitCode = 1;
}
