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
import { GMAIL_SEND_SCOPE } from '../packages/intelligence/src/mail/outbound.ts';

/**
 * Les seules portées qu'ATLAS accepte de détenir.
 *
 * Lire pour rattacher les réponses, envoyer pour répondre après approbation
 * humaine. Rien d'autre : ni modification d'étiquette, ni suppression, ni accès
 * complet à la boîte.
 */
const ACCEPTED_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE];
import {
  buildGmailAuthorizeUrl, loopbackRedirectUri,
} from '../packages/intelligence/src/mail/oauth-url.ts';

/**
 * Ouvrir une URL dans le navigateur, sans passer par un shell.
 *
 * C'est ici que se trouvait la panne. `cmd /c start "" <url>` remet l'URL à
 * `cmd.exe`, qui traite `&` comme un séparateur de commandes : le navigateur ne
 * recevait que le fragment jusqu'au premier `&` — `client_id` seul — tandis que
 * `redirect_uri`, `response_type` et `scope` étaient exécutés comme autant de
 * commandes inconnues. Google signalait alors le premier paramètre requis
 * manquant, `response_type`, qui figurait pourtant dans l'URL émise.
 *
 * `rundll32 url.dll,FileProtocolHandler` est un exécutable appelé directement :
 * l'argument lui parvient tel quel, sans qu'aucun interpréteur ne le relise. Le
 * même raisonnement vaut pour `open` et `xdg-open`, déjà appelés sans shell.
 */
function openInBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    // `shell: false` est le défaut, et doit le rester : c'est la seule chose qui
    // sépare cette fonction du défaut qu'elle répare.
    spawn(command, args, { detached: true, stdio: 'ignore', shell: false }).unref();
  } catch {
    // Le lien affiché plus haut suffit : l'ouverture est un confort, pas le flux.
  }
}

const ENV_FILE = '.env.local';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

loadConfig(process.cwd());

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m' };

console.log(`\n  ${c.bold}AUTORISATION GMAIL — LECTURE ET ENVOI${c.reset}`);
for (const portee of ACCEPTED_SCOPES) console.log(`  portée demandée : ${portee}`);
console.log();

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

/**
 * Le code d'autorisation ET l'adresse de retour qui l'a produit.
 *
 * Google exige que le `redirect_uri` de l'echange soit strictement identique a
 * celui de la demande. Les faire voyager ensemble rend cette egalite
 * structurelle : il n'existe pas de chemin ou l'un change sans l'autre. La
 * version precedente deposait l'adresse sur `globalThis` et la relisait avec un
 * `!` — cela fonctionnait, mais rien ne l'imposait.
 */
const received = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
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
    else resolve({ code, redirectUri: agreedRedirectUri });
  });

  // Renseignee des que la boucle locale connait son port, relue a la
  // resolution : la demande et l'echange lisent la meme variable.
  let agreedRedirectUri = '';

  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    const redirectUri = loopbackRedirectUri(port);
    agreedRedirectUri = redirectUri;

    // Construite ET vérifiée avant toute ouverture. Une URL incomplète envoyée
    // au navigateur coûte un aller-retour vers une page d'erreur Google dont le
    // message désigne le mauvais coupable — c'est exactement ce qui s'est passé.
    let authorizeUrl: string;
    try {
      authorizeUrl = buildGmailAuthorizeUrl({
        clientId,
        redirectUri,
        // Lecture et envoi, rien d'autre. Le reste du script vérifie ce que
        // Google a réellement accordé, qui n'est pas toujours ce qu'on demande.
        scopes: ACCEPTED_SCOPES,
        state,
        codeChallenge: challenge,
      });
    } catch (err) {
      server.close();
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    console.log(`  Ouverture du navigateur sur les pages de Google…`);
    console.log(`  ${c.dim}Connectez-vous vous-même : ATLAS ne voit ni ne saisit votre mot de passe.${c.reset}\n`);
    console.log(`  Si rien ne s'ouvre, collez ceci dans votre navigateur :\n`);
    console.log(`  ${authorizeUrl}\n`);

    openInBrowser(authorizeUrl);
  });

  setTimeout(() => {
    server.close();
    reject(new Error('délai dépassé — aucun consentement reçu en 5 minutes'));
  }, 300_000).unref();
});

// ── Échange du code ─────────────────────────────────────────────────────────
const redirectUri = received.redirectUri;
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
//
// La liste blanche compte deux entrées, et pas une de plus. `gmail.send` permet
// d'expédier un message ; elle ne permet ni de lire un brouillon d'autrui, ni de
// modifier une étiquette, ni de supprimer quoi que ce soit. `gmail.modify` et
// `mail.google.com` restent refusées : elles donneraient sur la boîte entière un
// pouvoir qu'aucune fonction d'ATLAS ne demande.
//
// Le refus porte sur ce que Google a *réellement accordé*, pas sur ce qui a été
// demandé. Google reconduit parfois un consentement plus large donné auparavant
// au même client, et un jeton trop puissant obtenu par inadvertance reste un
// jeton trop puissant.
const granted = (token.scope ?? '').split(/\s+/).filter(Boolean);
console.log(`  portée accordée : ${granted.join(', ') || '(aucune)'}`);

const extra = granted.filter((scope) => !ACCEPTED_SCOPES.includes(scope));
if (extra.length > 0 || granted.length === 0) {
  console.error(`\n  ${c.red}CONNEXION REFUSÉE${c.reset}`);
  console.error(`  Google a accordé : ${granted.join(', ') || 'rien'}`);
  console.error(`  En trop          : ${extra.join(', ') || '(aucune portée accordée)'}`);
  console.error(`  ATLAS n'accepte que : ${ACCEPTED_SCOPES.join(', ')}\n`);
  console.error('  Un jeton qui peut lire les brouillons, étiqueter ou supprimer');
  console.error('  ne doit pas exister sur cette machine.');
  console.error('  Révoquez l’accès sur https://myaccount.google.com/permissions,');
  console.error('  puis recommencez en ne cochant que la lecture et l’envoi.\n');
  console.error('  Rien n’a été écrit.\n');
  process.exit(1);
}

const peutEnvoyer = granted.includes(GMAIL_SEND_SCOPE);

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
console.log(
  `  ${c.green}portée conforme${c.reset} — lecture`
  + `${peutEnvoyer ? ' et envoi (soumis à approbation humaine)' : ' seule'}.\n`,
);

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
