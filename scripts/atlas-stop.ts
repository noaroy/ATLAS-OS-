/**
 * Arrêter ATLAS proprement, depuis un autre terminal.
 *
 *   npm run atlas:stop
 *
 * Lit le pid écrit par le serveur (`data/atlas.pid`), lui envoie SIGTERM, et
 * attend qu'il s'éteigne : le serveur ferme l'écoute, arrête le daemon
 * embarqué (le tour en cours se termine), sauvegarde et rend la main. Sous
 * systemd, préférez `systemctl stop atlas` — c'est le même signal.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';

loadAtlasEnv();
const config = loadConfig(process.cwd());
const pidFile = join(config.paths.dataDir, 'atlas.pid');

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

if (!existsSync(pidFile)) {
  console.log(`\n  Aucun fichier de pid (${pidFile}) : ATLAS ne tourne pas depuis ce répertoire.\n`);
  process.exit(0);
}
const pid = Number(readFileSync(pidFile, 'utf8').trim());
if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) {
  console.log(`\n  Le pid ${pid} n'est plus vivant : fichier périmé retiré.\n`);
  rmSync(pidFile, { force: true });
  process.exit(0);
}

console.log(`\n  Arrêt demandé au pid ${pid} (SIGTERM)…`);
process.kill(pid, 'SIGTERM');
const deadline = Date.now() + 60_000;
while (alive(pid) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (alive(pid)) {
  console.log(`  ${pid} tourne encore après 60 s : une tâche longue se termine. Relancez, ou attendez.\n`);
  process.exitCode = 1;
} else {
  rmSync(pidFile, { force: true });
  console.log('  ATLAS est arrêté proprement.\n');
}
