import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `deployment/vps-check.sh` doit lancer Compose comme le déploiement le
 * lance : mêmes fichiers (base, override, private), même `--env-file`.
 *
 * Relevé sur le VPS : le contrôle appelait `docker compose -p atlas-os -f
 * docker-compose.yml ps` sans `--env-file` ni fichier privé, Compose refusait
 * en silence, et deux conteneurs sains étaient déclarés « absents ». Le script
 * expose la commande résolue (`--compose-command`) ; c'est elle qu'on tient.
 */

const SCRIPT = resolve(import.meta.dirname, '../../../deployment/vps-check.sh');

/** Le bash qui sait lire un script POSIX : Git Bash sous Windows, bash ailleurs. */
function bashExecutable(): string | null {
  if (process.platform === 'win32') {
    for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']) if (existsSync(p)) return p;
    return null;
  }
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  return probe.status === 0 ? 'bash' : null;
}

/** Un chemin que Git Bash et bash lisent pareil : barres obliques. */
const posix = (p: string) => p.replace(/\\/g, '/');

function composeCommand(env: Record<string, string>): string {
  const bash = bashExecutable();
  assert.ok(bash, 'bash indisponible');
  const r = spawnSync(bash, [posix(SCRIPT), '--compose-command'], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

describe('vps-check : la commande Compose est celle du déploiement', { skip: bashExecutable() ? false : 'bash indisponible' }, () => {
  let dir: string;
  const setup = () => { dir = mkdtempSync(join(tmpdir(), 'atlas-vps-check-')); };
  const teardown = () => { rmSync(dir, { recursive: true, force: true }); };

  test('le fichier de base seul, sans .env : -p, -f, et rien d’autre', () => {
    setup();
    try {
      writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
      const cmd = composeCommand({ ATLAS_COMPOSE_DIR: posix(dir), ATLAS_ENV_FILE: posix(join(dir, 'absent.env')) });
      assert.equal(cmd, `docker compose -p atlas-os -f ${posix(dir)}/docker-compose.yml`);
    } finally { teardown(); }
  });

  test('override et private présents, .env présent : les trois fichiers dans l’ordre, et --env-file', () => {
    setup();
    try {
      for (const f of ['docker-compose.yml', 'docker-compose.override.yml', 'docker-compose.private.yml']) writeFileSync(join(dir, f), 'services: {}\n');
      writeFileSync(join(dir, '.env'), 'ATLAS_OUTBOUND_ENABLED=false\n');
      const cmd = composeCommand({ ATLAS_COMPOSE_DIR: posix(dir), ATLAS_ENV_FILE: posix(join(dir, '.env')) });
      assert.equal(cmd, [
        'docker compose -p atlas-os',
        `--env-file ${posix(dir)}/.env`,
        `-f ${posix(dir)}/docker-compose.yml`,
        `-f ${posix(dir)}/docker-compose.override.yml`,
        `-f ${posix(dir)}/docker-compose.private.yml`,
      ].join(' '));
    } finally { teardown(); }
  });

  test('private seul en plus de la base (le cas du VPS) : base puis private ; le projet se choisit', () => {
    setup();
    try {
      for (const f of ['docker-compose.yml', 'docker-compose.private.yml']) writeFileSync(join(dir, f), 'services: {}\n');
      writeFileSync(join(dir, '.env'), '');
      const cmd = composeCommand({ ATLAS_COMPOSE_DIR: posix(dir), ATLAS_ENV_FILE: posix(join(dir, '.env')), ATLAS_COMPOSE_PROJECT: 'atlas-test' });
      assert.equal(cmd, `docker compose -p atlas-test --env-file ${posix(dir)}/.env -f ${posix(dir)}/docker-compose.yml -f ${posix(dir)}/docker-compose.private.yml`);
    } finally { teardown(); }
  });

  test('ATLAS_COMPOSE_FILES explicite (séparés par « : ») l’emporte sur la détection', () => {
    setup();
    try {
      writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
      const cmd = composeCommand({
        ATLAS_COMPOSE_DIR: posix(dir), ATLAS_ENV_FILE: posix(join(dir, 'absent.env')),
        ATLAS_COMPOSE_FILES: '/opt/atlas/deployment/docker-compose.yml:/opt/atlas/deployment/docker-compose.private.yml',
      });
      assert.equal(cmd, 'docker compose -p atlas-os -f /opt/atlas/deployment/docker-compose.yml -f /opt/atlas/deployment/docker-compose.private.yml');
    } finally { teardown(); }
  });

  test('la commande ne porte jamais une valeur du .env — seulement son chemin', () => {
    setup();
    try {
      writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
      writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=cle-exemple-pas-une-vraie\nATLAS_SESSION_SECRET=secret-exemple\n');
      const cmd = composeCommand({ ATLAS_COMPOSE_DIR: posix(dir), ATLAS_ENV_FILE: posix(join(dir, '.env')) });
      assert.ok(!/cle-exemple|secret-exemple/.test(cmd), cmd);
      assert.match(cmd, /--env-file /);
    } finally { teardown(); }
  });
});
