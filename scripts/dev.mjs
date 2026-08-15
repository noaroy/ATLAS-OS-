import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

/**
 * Runs the API and the console together for development.
 *
 * The console is served by Vite on :5173 and proxies /api to the server on
 * :4700, so hot reload works on the frontend while the backend restarts on
 * change — with one Ctrl-C stopping both.
 *
 *   npm run dev              modèle réel si une clé est configurée
 *   npm run dev:sim          simulation garantie, aucune dépense possible
 *
 * La distinction compte : `.env` est lu automatiquement au démarrage, donc une
 * clé posée dans ce fichier suffit à faire basculer ATLAS en mode facturé sans
 * qu'on l'ait demandé. Le drapeau ci-dessous écrase la variable dans
 * l'environnement des processus enfants ; le lecteur de `.env` laisse toujours
 * gagner l'environnement réel, une clé vide reste donc vide.
 */
const simulation = process.argv.includes('--simulation');

const childEnv = { ...process.env, FORCE_COLOR: '1' };
if (simulation) childEnv.ANTHROPIC_API_KEY = '';

const processes = [
  {
    name: 'server',
    colour: '[36m',
    command: 'npx',
    args: ['tsx', 'watch', '--clear-screen=false', 'packages/server/src/main.ts'],
  },
  {
    name: 'console',
    colour: '[35m',
    command: 'npm',
    args: ['run', 'dev', '--workspace', '@atlas/console'],
  },
];

const children = processes.map(({ name, colour, command, args }) => {
  const child = spawn(command, args, {
    cwd: root,
    shell: isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });

  const prefix = `${colour}[${name}][0m `;
  const relay = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(prefix + line + '\n');
    });
  };

  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`${prefix}exited with code ${code}\n`);
    }
  });

  return child;
});

console.log('\n  ATLAS OS — development');
console.log('  Console  http://localhost:5173');
console.log('  API      http://localhost:4700');
console.log(
  simulation
    ? '  Mode     simulation forcée — aucun appel facturé possible\n'
    : '  Mode     selon la configuration (une clé dans .env active le modèle réel)\n',
);

let shuttingDown = false;
const stop = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
