import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `deployment/atlas-cli.sh` — la commande Docker qu'il construit, sans Docker.
 *
 * Le mode `--print` rend la commande exacte que `run` exécuterait : même
 * fichiers Compose que le déploiement (base, override, private), même
 * --env-file, `run --rm` sur le service `atlas-cli`, la commande npm et ses
 * arguments intacts. C'est ce qu'on tient ici ; Docker lui-même se vérifie sur
 * le serveur, avec un volume de test.
 *
 * Et la topologie déclarée : `docker compose config` — qui ne demande aucun
 * démon — confirme que `atlas-cli` partage le volume `atlas-data` en /data
 * avec `atlas`, ne publie aucun port, ne redémarre pas, et reste hors de
 * `up -d` par son profil.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const WRAPPER = join(ROOT, 'deployment', 'atlas-cli.sh');
const COMPOSE = join(ROOT, 'deployment', 'docker-compose.yml');

function bashExecutable(): string | null {
  if (process.platform === 'win32') {
    for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']) if (existsSync(p)) return p;
    return null;
  }
  return spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).status === 0 ? 'bash' : null;
}
const posix = (p: string) => p.replace(/\\/g, '/');

function wrapper(args: string[], env: Record<string, string> = {}) {
  const bash = bashExecutable();
  assert.ok(bash, 'bash indisponible');
  // stdin fermé : pas de terminal, comme sous cron — le wrapper doit passer -T.
  return spawnSync(bash, [posix(WRAPPER), ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('atlas-cli.sh : la commande construite', { skip: bashExecutable() ? false : 'bash indisponible' }, () => {
  test('client-mission status → run --rm atlas-cli npm run client:mission -- status …, avec --env-file et les fichiers Compose', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cli-'));
    try {
      for (const f of ['docker-compose.yml', 'docker-compose.private.yml']) writeFileSync(join(dir, f), 'services: {}\n');
      writeFileSync(join(dir, '.env'), 'ATLAS_OUTBOUND_ENABLED=false\n');
      const r = wrapper(['--print', 'client-mission', 'status', '--run=msn_42'], { ATLAS_COMPOSE_DIR: posix(dir), ATLAS_ENV_FILE: posix(join(dir, '.env')) });
      assert.equal(r.status, 0, r.stderr);
      const cmd = r.stdout.trim();
      assert.match(cmd, /^docker compose -p atlas-os --env-file \S+\/\.env -f \S+\/docker-compose\.yml -f \S+\/docker-compose\.private\.yml run --rm -T atlas-cli npm run client:mission -- status --run=msn_42 ?$/);
      assert.ok(!cmd.includes('ATLAS_OUTBOUND_ENABLED'), 'aucune valeur du .env dans la commande');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('sans fichier privé : la base seule ; les arguments d’un lot passent intacts, dans l’ordre', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cli-'));
    try {
      writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
      const r = wrapper(['--print', 'client-mission', 'batch', '--run=msn_42', '--size=20', '--queries=8', '--budget=0.30', '--batch-budget=0.30', '--concurrency=4', '--go'], { ATLAS_COMPOSE_DIR: posix(dir), ATLAS_ENV_FILE: posix(join(dir, 'absent.env')) });
      assert.equal(r.status, 0, r.stderr);
      const cmd = r.stdout.trim();
      assert.ok(!/private/.test(cmd));
      assert.ok(!/--env-file/.test(cmd), 'pas de --env-file quand le fichier n’existe pas (le préalable le refusera à l’exécution)');
      assert.match(cmd, /run --rm -T atlas-cli npm run client:mission -- batch --run=msn_42 --size=20 --queries=8 --budget=0\.30 --batch-budget=0\.30 --concurrency=4 --go ?$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('client-review, client-preflight, backup, restore-check : la table des commandes ; une commande npm brute passe telle quelle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cli-'));
    try {
      writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
      const env = { ATLAS_COMPOSE_DIR: posix(dir), ATLAS_ENV_FILE: posix(join(dir, 'absent.env')) };
      const attendu: Array<[string[], RegExp]> = [
        [['client-review', '--run=msn_1'], /atlas-cli npm run client:review -- --run=msn_1 ?$/],
        [['client-preflight', '--brief=briefs/x.json'], /atlas-cli npm run client:preflight -- --brief=briefs\/x\.json ?$/],
        [['backup'], /atlas-cli npm run backup ?$/],
        [['restore-check'], /atlas-cli npm run restore-check ?$/],
        [['production-check'], /atlas-cli npm run atlas:production-check ?$/],
        [['npm', 'run', 'client:status'], /atlas-cli npm run client:status ?$/],
      ];
      for (const [args, motif] of attendu) {
        const r = wrapper(['--print', ...args], env);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout.trim(), motif, args.join(' '));
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('une commande inconnue est refusée (code 2), jamais devinée ; --help et --compose-command répondent sans Docker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-cli-'));
    try {
      writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n');
      const env = { ATLAS_COMPOSE_DIR: posix(dir), ATLAS_ENV_FILE: posix(join(dir, 'absent.env')) };
      const inconnue = wrapper(['--print', 'rm', '-rf', '/data'], env);
      assert.equal(inconnue.status, 2);
      assert.match(inconnue.stderr, /commande inconnue : rm/);
      const help = wrapper(['--help'], env);
      assert.equal(help.status, 0);
      assert.match(help.stdout, /client-mission status/);
      const compose = wrapper(['--compose-command'], env);
      assert.equal(compose.status, 0);
      assert.equal(compose.stdout.trim(), `docker compose -p atlas-os -f ${posix(dir)}/docker-compose.yml`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('la topologie Compose : atlas-cli partage la base, et rien d’autre', () => {
  test('le fichier déclare atlas-cli sur le volume atlas-data en /data, sans port, sans redémarrage, sous profil cli', () => {
    const yml = readFileSync(COMPOSE, 'utf8');
    const bloc = yml.slice(yml.indexOf('\n  atlas-cli:'), yml.indexOf('\n  n8n:'));
    assert.ok(bloc.length > 0, 'service atlas-cli présent');
    assert.match(bloc, /target: cli/);
    assert.match(bloc, /profiles: \["cli"\]/);
    assert.match(bloc, /restart: "no"/);
    assert.match(bloc, /- atlas-data:\/data/);
    assert.match(bloc, /ATLAS_DATA_DIR: \/data/);
    assert.match(bloc, /ATLAS_CLI_CONTEXT: docker/);
    assert.match(bloc, /networks: \[atlas\]/);
    assert.match(bloc, /env_file: \.\.\/\.env/);
    assert.ok(!/\n\s+ports:/.test(bloc), 'aucun port publié');
    assert.ok(!/healthcheck/.test(bloc), 'aucun healthcheck : rien ne doit rester en vie');
    // Le serveur, lui, garde le même volume au même endroit — c'est la condition.
    const atlas = yml.slice(yml.indexOf('\n  atlas:'), yml.indexOf('\n  atlas-cli:'));
    assert.match(atlas, /- atlas-data:\/data/);
    assert.match(atlas, /ATLAS_DATA_DIR: \/data/);
    assert.match(atlas, /target: runtime/, 'l’étape serveur est nommée : ajouter `cli` au Dockerfile ne change pas ce que `build atlas` construit');
  });

  test('le Dockerfile : l’étape cli précède runtime, copie pièce par pièce (jamais .env ni data/), tourne en `node`, sans HEALTHCHECK ni EXPOSE', () => {
    const df = readFileSync(join(ROOT, 'deployment', 'Dockerfile'), 'utf8');
    const iCli = df.indexOf('AS cli');
    const iRuntime = df.indexOf('AS runtime');
    assert.ok(iCli > 0 && iRuntime > iCli, 'cli avant runtime : l’étape finale reste le serveur');
    const cli = df.slice(iCli, iRuntime);
    assert.ok(!/COPY --from=build \/build\/?\s/.test(cli) && !/COPY \. \./.test(cli), 'pas de copie en bloc');
    assert.ok(!/\.env/.test(cli.replace(/#.*$/gm, '')), 'jamais le .env');
    assert.match(cli, /USER node/);
    assert.match(cli, /ATLAS_CLI_CONTEXT=docker/);
    assert.ok(!/HEALTHCHECK/.test(cli) && !/EXPOSE/.test(cli));
    const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8');
    for (const motif of ['.env', 'data/', '*.bundle', 'node_modules/']) assert.ok(ignore.includes(motif), `.dockerignore : ${motif}`);
  });

  test('docker compose config (sans démon) : atlas-cli hors de `up -d`, et résolu avec le volume, sans port', (t) => {
    const probe = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
    if (probe.status !== 0) { t.skip('docker compose indisponible'); return; }
    const dir = mkdtempSync(join(tmpdir(), 'atlas-compose-'));
    try {
      // Un .env factice, pour les « :? » du fichier : jamais le vrai.
      const env = join(dir, '.env');
      writeFileSync(env, 'ATLAS_DOMAIN=example.invalid\nSEARXNG_SECRET=test\nN8N_PASSWORD=test\nATLAS_SESSION_SECRET=0123456789abcdef\n');
      const base = ['compose', '-p', 'atlas-os', '--env-file', env, '-f', COMPOSE];
      const services = spawnSync('docker', [...base, 'config', '--services'], { encoding: 'utf8' });
      assert.equal(services.status, 0, services.stderr);
      const liste = services.stdout.trim().split(/\r?\n/);
      assert.ok(liste.includes('atlas') && liste.includes('searxng'), liste.join(','));
      assert.ok(!liste.includes('atlas-cli'), 'sans profil, `up -d` ne le démarre pas');
      const json = spawnSync('docker', [...base, '--profile', 'cli', 'config', '--format', 'json'], { encoding: 'utf8' });
      assert.equal(json.status, 0, json.stderr);
      const config = JSON.parse(json.stdout) as { services: Record<string, { ports?: unknown[]; restart?: string; build?: { target?: string }; environment?: Record<string, string>; volumes?: Array<{ type: string; source: string; target: string }>; profiles?: string[] }> };
      const cli = config.services['atlas-cli']!;
      const atlas = config.services['atlas']!;
      assert.equal(cli.ports, undefined);
      assert.equal(cli.restart, 'no');
      assert.equal(cli.build?.target, 'cli');
      assert.deepEqual(cli.profiles, ['cli']);
      assert.equal(cli.environment?.ATLAS_DATA_DIR, '/data');
      assert.equal(cli.environment?.ATLAS_CLI_CONTEXT, 'docker');
      const volCli = cli.volumes?.find((v) => v.type === 'volume');
      const volAtlas = atlas.volumes?.find((v) => v.type === 'volume');
      assert.ok(volCli && volAtlas);
      assert.equal(volCli.source, volAtlas.source, 'le même volume nommé');
      assert.equal(volCli.target, '/data');
      assert.equal(volAtlas.target, '/data');
      assert.equal(atlas.build?.target, 'runtime');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
