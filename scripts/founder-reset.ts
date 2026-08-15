/**
 * Définit le mot de passe du compte fondateur.
 *
 *   npm run founder:reset
 *
 * Deux façons d'obtenir le mot de passe, selon ce que le terminal permet.
 *
 * Par défaut, saisie masquée ici même, en mode brut. C'est le chemin des
 * terminaux POSIX.
 *
 * Avec `--stdin`, le mot de passe arrive sur l'entrée standard et rien n'est
 * demandé. C'est ce qu'utilise `founder-reset.ps1` : sous Windows, npm relaie
 * l'entrée standard par un tube, `isTTY` est faux, le mode brut ne s'active
 * jamais et il devient impossible de taper quoi que ce soit. PowerShell, lui,
 * sait masquer nativement — il lit, puis nous transmet.
 *
 * Dans les deux cas le mot de passe ne va nulle part ailleurs : il n'entre pas
 * dans `.env`, ne passe pas en argument de commande — donc ni dans l'historique
 * du shell ni dans la liste des processus, que tout le système peut lire — et
 * n'apparaît dans aucun journal. Seule son empreinte scrypt, avec un sel propre
 * à ce compte, est écrite dans la base.
 *
 * `ATLAS_FOUNDER_PASSWORD` ne sert qu'à *semer* le compte au tout premier
 * démarrage, quand la table des utilisateurs est vide. Une fois le compte créé,
 * cette variable n'a plus aucun effet : c'est la base qui fait foi, et c'est
 * elle que cette commande modifie.
 *
 * Le serveur peut tourner pendant l'opération — SQLite en mode WAL accepte
 * l'écriture concurrente. Les sessions ouvertes sont fermées : changer de mot
 * de passe sans les révoquer laisserait un jeton volé actif quatorze jours.
 */
import { loadConfig, createLogger } from '../packages/core/src/index.ts';
import { openDatabase } from '../packages/data/src/database.ts';
import { UserRepository } from '../packages/data/src/repositories/users.ts';

const c = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  green: '[32m',
  amber: '[33m',
  red: '[31m',
};

/** En deçà, l'empreinte est solide et le mot de passe ne l'est pas. */
const MIN_LENGTH = 8;

/** Le mot de passe arrive-t-il déjà saisi, sur l'entrée standard ? */
const fromStdin = process.argv.includes('--stdin');

/**
 * Lit une ligne sans jamais l'afficher.
 *
 * Le mode brut est ce qui garantit l'absence d'écho : masquer après coup
 * laisserait le mot de passe visible le temps d'une frappe, et présent dans le
 * tampon du terminal. Chaque touche est donc interceptée avant affichage.
 */
function promptSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;

    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      reject(
        new Error(
          "ce terminal ne permet pas la saisie masquée (entrée standard redirigée).\n" +
            (process.platform === 'win32'
              ? "  Sous Windows, lancez plutôt :\n" +
                '    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\founder-reset.ps1'
              : '  Lancez la commande depuis un terminal interactif.'),
        ),
      );
      return;
    }

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        switch (char) {
          case '\r':
          case '\n':
            cleanup();
            stdout.write('\n');
            resolve(value);
            return;

          // Ctrl-C : on sort sans rien écrire.
          case '':
            cleanup();
            stdout.write('\n');
            reject(new Error('interrompu'));
            return;

          case '': // Retour arrière
          case '\b':
            value = value.slice(0, -1);
            break;

          default:
            // Les caractères de contrôle ne font pas partie d'un mot de passe.
            if (char >= ' ') value += char;
        }
      }
    };

    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
    };

    stdin.on('data', onData);
  });
}

/**
 * Lit le mot de passe sur l'entrée standard, une seule ligne.
 *
 * Le vis-à-vis a déjà demandé la confirmation et comparé les deux saisies : le
 * refaire ici obligerait à transmettre le secret deux fois pour rien.
 */
function readFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin } = process;

    if (stdin.isTTY) {
      reject(
        new Error(
          "--stdin attend un mot de passe sur l'entrée standard, mais celle-ci est un terminal. " +
            'Lancez la commande sans --stdin, ou via scripts/founder-reset.ps1 sous Windows.',
        ),
      );
      return;
    }

    let buffer = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      buffer += chunk;
    });
    stdin.on('end', () => {
      // Une seule ligne, sans le saut final. Le reste est ignoré : si quelque
      // chose d'autre suit, ce n'est pas le mot de passe.
      resolve(buffer.split(/\r?\n/)[0] ?? '');
    });
    stdin.on('error', reject);
  });
}

/**
 * Ce qui rend un mot de passe inacceptable.
 *
 * Volontairement court : refuser ce qui est manifestement faible, sans imposer
 * de règles de composition qui poussent surtout à écrire le mot de passe sur un
 * papier.
 */
function rejectionReason(password: string): string | null {
  if (password.length < MIN_LENGTH) return `il faut au moins ${MIN_LENGTH} caractères`;
  if (/^\s|\s$/.test(password)) return 'les espaces en début ou en fin se perdent au copier-coller';

  const banned = ['change-me', 'atlas-founder', 'password', 'motdepasse', '12345678', 'atlas'];
  if (banned.includes(password.toLowerCase())) return 'ce mot de passe est un exemple connu publiquement';

  return null;
}

async function main(): Promise<void> {
  const config = loadConfig();

  console.log(`\n${c.bold}  ATLAS OS — mot de passe du compte fondateur${c.reset}`);
  console.log(`  ${c.dim}base : ${config.paths.databaseFile}${c.reset}\n`);

  // `error` : cette commande ne doit rien écrire d'autre que ce qu'elle affiche
  // volontairement. Un journal bavard autour d'une saisie de mot de passe est
  // un risque en soi.
  const db = openDatabase(config.paths.databaseFile, createLogger({ level: 'error', pretty: false }));
  const users = new UserRepository(db);

  const email = config.security.founderEmail.toLowerCase();
  let account = users.findByEmail(email);

  if (account) {
    console.log(`  Compte trouvé : ${c.bold}${account.email}${c.reset} ${c.dim}(rôle ${account.role})${c.reset}`);
    console.log(`  ${c.dim}créé le ${new Date(account.createdAt).toLocaleString('fr-FR')}${c.reset}`);
  } else if (users.count() > 0) {
    // Un compte existe sous une autre adresse : la remplacer silencieusement
    // créerait un doublon et laisserait le fondateur devant deux identités.
    const others = users.list().map((u) => `${u.email} (${u.role})`);
    console.error(
      `\n${c.red}  Aucun compte pour ${email}, mais la base en contient d'autres :${c.reset}\n` +
        others.map((o) => `    · ${o}`).join('\n') +
        `\n\n  Alignez ATLAS_FOUNDER_EMAIL sur l'un d'eux, ou supprimez-les avant de recommencer.\n`,
    );
    process.exit(1);
  } else {
    console.log(`  ${c.amber}Aucun compte n'existe encore.${c.reset} Il va être créé pour ${c.bold}${email}${c.reset}.`);
  }

  let password = '';

  if (fromStdin) {
    // Le vis-à-vis a déjà masqué la saisie et fait confirmer. Les règles de
    // refus s'appliquent quand même : elles sont la propriété de cette
    // commande, pas une politesse de l'appelant.
    password = await readFromStdin();
    const reason = rejectionReason(password);
    if (reason) {
      console.error(`\n${c.red}  Refusé — ${reason}. Rien n'a été modifié.${c.reset}\n`);
      process.exit(1);
    }
  } else {
    console.log(`\n  ${c.dim}La saisie est masquée : rien ne s'affiche pendant la frappe.${c.reset}`);
    console.log(`  ${c.dim}Minimum ${MIN_LENGTH} caractères.${c.reset}\n`);

    for (let attempt = 1; attempt <= 3; attempt++) {
      password = await promptSecret('  Nouveau mot de passe        : ');

      const reason = rejectionReason(password);
      if (reason) {
        console.log(`  ${c.red}Refusé — ${reason}.${c.reset}\n`);
        password = '';
        continue;
      }

      const confirmation = await promptSecret('  Confirmez le mot de passe   : ');
      if (confirmation !== password) {
        console.log(`  ${c.red}Les deux saisies diffèrent.${c.reset}\n`);
        password = '';
        continue;
      }
      break;
    }

    if (!password) {
      console.error(`\n${c.red}  Abandon : trois tentatives sans saisie valable. Rien n'a été modifié.${c.reset}\n`);
      process.exit(1);
    }
  }

  if (!account) {
    account = users.create({ email, name: 'Founder', role: 'founder', password });
    console.log(`\n  ${c.green}✓${c.reset} Compte créé.`);
  } else {
    users.setPassword(account.id, password);
    console.log(`\n  ${c.green}✓${c.reset} Mot de passe remplacé.`);
  }

  // Le mot de passe quitte la mémoire du script dès qu'il a servi.
  password = '';

  const closed = users.revokeAllForUser(account.id);
  console.log(
    `  ${c.green}✓${c.reset} ${closed === 0 ? 'Aucune session ouverte à fermer' : `${closed} session(s) ouverte(s) fermée(s)`}.`,
  );

  // Relecture depuis la base : on affirme ce qu'on a vérifié, pas ce qu'on
  // croit avoir écrit.
  const stored = users.credentialShape(account.id);
  console.log(
    `  ${c.green}✓${c.reset} Stocké en scrypt, empreinte de ${stored.hashBytes} octets, ` +
      `sel de ${stored.saltBytes} octets propre à ce compte.`,
  );

  db.close();

  console.log(`\n  ${c.bold}Vous pouvez vous connecter :${c.reset}`);
  console.log(`    identifiant  ${c.bold}${email}${c.reset}`);
  console.log(`    adresse      ${c.bold}http://localhost:5173${c.reset}  ${c.dim}(console de développement)${c.reset}`);
  console.log(`                 ${c.dim}http://localhost:${config.server.port}  (console servie par le serveur)${c.reset}`);
  console.log(`\n  ${c.dim}Le mot de passe n'a été affiché nulle part, et n'est écrit dans aucun fichier.${c.reset}\n`);
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n${c.red}  Échec : ${message}${c.reset}\n`);
  process.exit(1);
});
