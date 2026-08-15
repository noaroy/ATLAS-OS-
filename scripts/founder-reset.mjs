import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `npm run founder:reset` — une commande, deux chemins.
 *
 * Sous Windows, la saisie masquée passe par PowerShell. La raison est concrète :
 * npm relaie l'entrée standard par un tube, `process.stdin.isTTY` y est faux, et
 * le mode brut de Node — sur lequel repose le masquage — ne peut pas s'activer.
 * On ne peut alors rien taper du tout. `Read-Host -AsSecureString` ne dépend pas
 * du tube : il lit dans la console, sous le contrôle de Windows.
 *
 * Ailleurs, Node fait le travail lui-même.
 *
 * Dans les deux cas le mot de passe voyage par l'entrée standard et jamais par
 * la ligne de commande, que tout processus du système peut lire.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const [command, args] =
  process.platform === 'win32'
    ? [
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/founder-reset.ps1'],
      ]
    : ['node', ['--import', 'tsx', 'scripts/founder-reset.ts']];

// `inherit` sur les trois flux : c'est ce qui laisse la console maîtresse de la
// saisie. La rediriger, ne serait-ce que pour l'afficher joliment, reproduirait
// exactement le problème que ce lanceur existe pour contourner.
const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });

child.on('error', (err) => {
  console.error(`\n  Impossible de lancer ${command} : ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code) => process.exit(code ?? 1));
