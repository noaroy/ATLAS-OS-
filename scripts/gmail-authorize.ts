/**
 * Obtenir un jeton de rafraîchissement Gmail, en lecture seule.
 *
 * Le consentement se donne dans le navigateur, sur les pages de Google. ATLAS
 * n'affiche aucun formulaire de connexion, ne lit aucun mot de passe et n'en
 * transporte aucun : il ouvre une page, écoute une redirection locale, et
 * reçoit un code d'autorisation à usage unique.
 *
 * Deux refus sont posés ici plutôt qu'ailleurs, parce qu'après c'est trop tard :
 *
 *   · la demande ne porte que `gmail.readonly` — jamais `gmail.modify`, jamais
 *     `mail.google.com` ;
 *   · la réponse est vérifiée. Si Google accorde davantage — cela arrive quand
 *     un consentement plus large existe déjà pour le même client — le jeton est
 *     rejeté et rien n'est écrit. Un accès qu'on n'a pas voulu est un accès
 *     qu'on finira par utiliser.
 *
 * Le jeton part dans `.env.local`, qui est ignoré par Git. Il n'est jamais
 * affiché, ni entier ni tronqué : un secret qui apparaît dans un terminal
 * finit dans un historique de commandes.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../packages/core/src/index.ts';
import { GMAIL_READONLY_SCOPE } from '../packages/intelligence/src/mail/gmail.ts';

const ENV_FILE = '.env.local';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

loadConfig(process.cwd());

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m' };

console.log(`\n  ${c.bold}AUTORISATION GMAIL — LECTURE SEULE${c.reset}`);
console.log(`  portée demandée : ${GMAIL_READONLY_SCOPE}\n`);

const clientId = process.env.GMAIL_CLIENT_ID?.trim();
const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  // ATLAS ne peut pas créer le client OAuth : cela se fait dans la console
  // Google Cloud du propriétaire de la boîte, et cela reste sa décision.
  console.log(`  ${c.amber}Identifiants client absents.${c.reset}\n`);
  console.log('  À faire une fois, dans votre console Google Cloud :');
  console.log('    1. APIs & Services → Library → activer « Gmail API »');
  console.log('    2. APIs & Services → Credentials → Create credentials');
  console.log('       → OAuth client ID → type « Desktop app »');
  console.log('    3. OAuth consent screen → ajoutez votre adresse en « Test user »');
  console.log('       et n’ajoutez QUE la portée .../auth/gmail.readonly\n');
  console.log(`  Puis, dans ${ENV_FILE} (ignoré par Git) :`);
  console.log('    GMAIL_CLIENT_ID=…apps.googleusercontent.com');
  console.log('    GMAIL_CLIENT_SECRET=…\n');
  console.log('  Relancez ensuite : npm run gmail:authorize\n');
  process.exit(2);
}

// ── Boucle locale ───────────────────────────────────────────────────────────
//
// Le flux « loopback » est celui que Google recommande pour une application de
// bureau : le code d'autorisation revient sur 127.0.0.1, il ne transite par
// aucun serveur tiers, et l'échange final exige le secret client qui n'a jamais
// quitté cette machine.
const state = randomBytes(16).toString('hex');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

const received = await new Promise<{ code: string }>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const returned = url.searchParams.get('state');

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      error || !code || returned !== state
        ? '<h1>Autorisation refusée</h1><p>Vous pouvez fermer cet onglet.</p>'
        : '<h1>ATLAS est autorisé en lecture seule</h1><p>Vous pouvez fermer cet onglet.</p>',
    );
    server.close();

    if (error) reject(new Error(`consentement refusé : ${error}`));
    else if (returned !== state) reject(new Error('état de session invalide — tentative rejetée'));
    else if (!code) reject(new Error('aucun code reçu'));
    else resolve({ code });
  });

  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const authorize = new URL(AUTH_URL);
    authorize.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      // La seule portée demandée. Le reste du script vérifie ce qui est rendu.
      scope: GMAIL_READONLY_SCOPE,
      access_type: 'offline',
      // Force l'écran de consentement, donc l'émission d'un refresh token.
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();

    (globalThis as { __redirectUri?: string }).__redirectUri = redirectUri;

    console.log(`  Ouverture du navigateur sur les pages de Google…`);
    console.log(`  ${c.dim}Connectez-vous vous-même : ATLAS ne voit ni ne saisit votre mot de passe.${c.reset}\n`);
    console.log(`  Si rien ne s'ouvre, collez ceci dans votre navigateur :\n`);
    console.log(`  ${authorize.toString()}\n`);

    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', authorize.toString()]]
      : process.platform === 'darwin' ? ['open', [authorize.toString()]]
      : ['xdg-open', [authorize.toString()]];
    try {
      spawn(opener[0] as string, opener[1] as string[], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      // Le lien affiché ci-dessus suffit.
    }
  });

  setTimeout(() => {
    server.close();
    reject(new Error('délai dépassé — aucun consentement reçu en 5 minutes'));
  }, 300_000).unref();
});

// ── Échange du code ─────────────────────────────────────────────────────────
const redirectUri = (globalThis as { __redirectUri?: string }).__redirectUri!;
const tokenResponse = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: received.code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  }),
});

if (!tokenResponse.ok) {
  console.error(`\n  ${c.red}Échange refusé (HTTP ${tokenResponse.status}).${c.reset}`);
  console.error('  Vérifiez que le client OAuth est bien de type « Desktop app ».\n');
  process.exit(1);
}

const token = (await tokenResponse.json()) as {
  access_token?: string; refresh_token?: string; scope?: string;
};

// ── Vérification de la portée réellement accordée ───────────────────────────
const granted = (token.scope ?? '').split(/\s+/).filter(Boolean);
console.log(`  portée accordée : ${granted.join(', ') || '(aucune)'}`);

const extra = granted.filter((scope) => scope !== GMAIL_READONLY_SCOPE);
if (extra.length > 0 || granted.length === 0) {
  console.error(`\n  ${c.red}CONNEXION REFUSÉE${c.reset}`);
  console.error(`  Google a accordé : ${granted.join(', ') || 'rien'}`);
  console.error(`  ATLAS n'accepte que : ${GMAIL_READONLY_SCOPE}\n`);
  console.error('  Un jeton capable d’écrire ne doit pas exister sur cette machine.');
  console.error('  Révoquez l’accès sur https://myaccount.google.com/permissions,');
  console.error('  puis recommencez en ne cochant que la lecture.\n');
  console.error('  Rien n’a été écrit.\n');
  process.exit(1);
}

if (!token.refresh_token) {
  console.error(`\n  ${c.red}Aucun jeton de rafraîchissement rendu.${c.reset}`);
  console.error('  Révoquez l’accès sur https://myaccount.google.com/permissions puis recommencez :');
  console.error('  Google ne le renvoie qu’au premier consentement.\n');
  process.exit(1);
}

// L'adresse de la boîte, lue plutôt que demandée : une faute de frappe dans
// GMAIL_USER ferait échouer chaque synchronisation sans dire pourquoi.
let mailbox = 'inconnue';
try {
  const profile = await fetch(PROFILE_URL, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (profile.ok) mailbox = ((await profile.json()) as { emailAddress?: string }).emailAddress ?? 'inconnue';
} catch {
  // Sans importance : l'adresse peut être renseignée à la main.
}

console.log(`  boîte           : ${mailbox}`);
console.log(`  ${c.green}portée conforme — lecture seule.${c.reset}\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question(`  Écrire le jeton dans ${ENV_FILE} ? [o/N] `)).trim().toLowerCase();
rl.close();

if (answer !== 'o' && answer !== 'oui' && answer !== 'y') {
  console.log('\n  Rien écrit. Le jeton est perdu ; relancez la commande si besoin.\n');
  process.exit(0);
}

// Écriture sans jamais afficher la valeur.
const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
const withoutOld = existing
  .split(/\r?\n/)
  .filter((line) => !/^\s*(GMAIL_REFRESH_TOKEN|GMAIL_USER)\s*=/.test(line))
  .join('\n')
  .replace(/\n+$/, '');

writeFileSync(
  ENV_FILE,
  `${withoutOld}${withoutOld ? '\n' : ''}` +
    `# Jeton Gmail en lecture seule — obtenu le ${new Date().toISOString().slice(0, 10)}.\n` +
    `# Ce fichier est ignoré par Git. Ne le partagez pas, ne le commitez pas.\n` +
    `GMAIL_REFRESH_TOKEN=${token.refresh_token}\n` +
    `GMAIL_USER=${mailbox}\n`,
  'utf8',
);

console.log(`\n  ${c.green}Écrit dans ${ENV_FILE}${c.reset} — GMAIL_REFRESH_TOKEN, GMAIL_USER`);
console.log(`  ${c.dim}Le jeton n'a été affiché nulle part.${c.reset}\n`);
console.log('  Vérifiez, puis synchronisez :');
console.log('    npm run gmail:check');
console.log('    npm run sales:inbox-sync -- --allow-production\n');

void appendFileSync;
