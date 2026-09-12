/**
 * Vérifier ce que le jeton Gmail permet réellement, avant de s'en servir.
 *
 * La portée demandée et la portée accordée sont deux choses différentes :
 * Google reconduit parfois un consentement plus large donné auparavant au même
 * client. Poser la question à l'exécution est le seul moyen de savoir.
 *
 * Aucune donnée n'est écrite, aucun message n'est lu — seulement l'en-tête de
 * la boîte et la liste des portées. Le jeton n'est jamais affiché.
 */
import { loadConfig } from '../packages/core/src/index.ts';
import {
  ACCEPTED_GMAIL_SCOPES, scopesInExcess, GMAIL_SEND_SCOPE_URI,
} from '../packages/intelligence/src/mail/types.ts';
import { GMAIL_READONLY_SCOPE } from '../packages/intelligence/src/mail/gmail.ts';

loadConfig(process.cwd());

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m' };

console.log(`\n  ${c.bold}VÉRIFICATION GMAIL${c.reset}  ${c.dim}lecture seule · rien n'est écrit${c.reset}\n`);

const clientId = process.env.GMAIL_CLIENT_ID?.trim();
const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();
const refreshToken = process.env.GMAIL_REFRESH_TOKEN?.trim();
const user = process.env.GMAIL_USER?.trim();

const missing = Object.entries({
  GMAIL_CLIENT_ID: clientId, GMAIL_CLIENT_SECRET: clientSecret,
  GMAIL_REFRESH_TOKEN: refreshToken, GMAIL_USER: user,
}).filter(([, v]) => !v).map(([k]) => k);

if (missing.length > 0) {
  console.log(`  ${c.amber}GMAIL_NOT_CONFIGURED${c.reset} — absent(s) : ${missing.join(', ')}`);
  console.log('  Lancez : npm run gmail:authorize\n');
  process.exit(2);
}

const response = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId!, client_secret: clientSecret!,
    refresh_token: refreshToken!, grant_type: 'refresh_token',
  }),
});

if (!response.ok) {
  console.log(`  ${c.red}Le jeton est refusé (HTTP ${response.status}).${c.reset}`);
  console.log('  Il a peut-être été révoqué. Relancez : npm run gmail:authorize\n');
  process.exit(1);
}

const payload = (await response.json()) as { access_token?: string; scope?: string; expires_in?: number };
const granted = (payload.scope ?? '').split(/\s+/).filter(Boolean);
// La regle vient de la liste partagee, pas d'une copie locale : trois copies
// d'une meme regle finissent par ne plus dire la meme chose, et c'est ce qui
// est arrive le jour ou l'envoi a ete accorde.
const extra = scopesInExcess(granted);
const peutLire = granted.includes(GMAIL_READONLY_SCOPE);
const peutEnvoyer = granted.includes(GMAIL_SEND_SCOPE_URI);

console.log(`  boîte           ${user}`);
console.log(`  portée accordée ${granted.join(', ') || '(aucune)'}`);
console.log(`  portées admises ${ACCEPTED_GMAIL_SCOPES.join(', ')}`);

if (extra.length > 0) {
  console.log(`\n  ${c.red}CONNEXION REFUSÉE${c.reset} — portée(s) d'écriture : ${extra.join(', ')}`);
  console.log('  Révoquez sur https://myaccount.google.com/permissions puis réautorisez.\n');
  process.exit(1);
}

// Une lecture minimale, pour prouver que l'accès fonctionne : le libellé de la
// boîte, pas son contenu.
const profile = await fetch(
  `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(user!)}/profile`,
  { headers: { authorization: `Bearer ${payload.access_token}` } },
);
if (profile.ok) {
  const info = (await profile.json()) as { emailAddress?: string; messagesTotal?: number };
  console.log(`  accès           ${c.green}confirmé${c.reset} · ${info.emailAddress} · ${info.messagesTotal ?? '?'} message(s)`);
} else {
  console.log(`  accès           ${c.red}refusé (HTTP ${profile.status})${c.reset}`);
  process.exit(1);
}

console.log(
  `\n  ${c.green}Portées confirmées${c.reset} — lecture${peutEnvoyer ? ' et envoi' : ' seule'}.`,
);
if (peutEnvoyer) {
  console.log(`  ${c.dim}L'envoi reste soumis à l'approbation humaine : rien ne part seul.${c.reset}`);
}
if (!peutLire) {
  console.log(`  ${c.red}La lecture n'est pas accordée : les réponses ne remonteront pas.${c.reset}`);
}
console.log('  npm run sales:inbox-sync -- --allow-production\n');
