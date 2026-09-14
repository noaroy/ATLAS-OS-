/**
 * Le coupe-circuit d'une mission en cours, depuis un autre terminal.
 *
 *   npm run client:pause -- --run=<id>            demande l'arrêt : le pilote finit le candidat en cours, écrit, rend la main
 *   npm run client:pause -- --run=<id> --clear    retire la demande
 *
 * Le pilote consulte la demande avant chaque candidat. Rien d'entamé n'est
 * perdu ; `client:auto -- --run=<id> --go` reprend exactement où c'était.
 */
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadAtlasEnv } from '../packages/core/src/index.ts';

// ATLAS_FOUNDER_EMAIL signe la demande : l'environnement se charge comme partout.
loadAtlasEnv();

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const runId = arg('run');
if (!runId) {
  console.error('  --run=<id> requis');
  process.exitCode = 1;
} else {
  const chemin = join('out', 'client', runId, 'pause.request');
  if (process.argv.includes('--clear')) {
    if (existsSync(chemin)) unlinkSync(chemin);
    console.log(`  demande d'arrêt retirée pour ${runId}`);
  } else {
    mkdirSync(dirname(chemin), { recursive: true });
    writeFileSync(chemin, JSON.stringify({ requestedAt: new Date().toISOString(), by: process.env.ATLAS_FOUNDER_EMAIL ?? 'founder' }), 'utf8');
    console.log(`  arrêt demandé pour ${runId} — le pilote termine le candidat en cours puis s'arrête.\n  Reprise : npm run client:auto -- --run=${runId} --go`);
  }
}
