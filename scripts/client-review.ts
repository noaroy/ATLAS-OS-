/**
 * La revue intelligente : seuls les dossiers qui demandent un jugement,
 * P1 d'abord, et une touche par décision.
 *
 *   npm run client:review -- --run=<id>                 la file, en lecture
 *   npm run client:review -- --run=<id> --interactive   K garder · E écarter · C confirmer plus tard · S passer · Q quitter
 *
 * Les décisions sont appliquées à la fin, en un seul ajustement (un brief
 * v(n+1)) : `--keep` pour les K, `--exclude` pour les E. Rien n'est appliqué
 * si vous quittez avant la fin sans confirmer. Aucun envoi, aucun contact.
 */
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { buildReviewQueue, loadClientRun, adjustClientRun, readAutopilot, transition } from '../packages/runtime/src/index.ts';
import type { ReviewQueueItem as Item } from '../packages/departments/src/index.ts';

loadAtlasEnv();

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m' };
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => process.argv.includes(`--${n}`);

function fiche(i: Item, n: number, total: number): string {
  const couleur = i.priority === 'P1' ? c.green : i.priority === 'P2' ? c.amber : c.red;
  const lignes = [
    ``,
    `  ${c.dim}[${n}/${total}]${c.reset} ${couleur}${i.priority}${c.reset} ${c.bold}${i.company}${c.reset} · ${i.url}`,
    `  Décision suggérée : ${c.bold}${i.recommendationLabel}${c.reset} · note ${i.score}/100${i.evidenceLevel && i.evidenceLevel.level !== 'COMPLETE' ? ` (pertinence ${i.relevance ?? i.score}, preuve ${i.evidenceLevel.level === 'PARTIAL' ? 'partielle' : 'insuffisante'} : ${i.evidenceLevel.missing.join(', ')})` : ''}${i.country ? ` · ${i.country}` : ' · pays non prouvé'}${i.generalistRisk !== null ? ` · risque généraliste ${i.generalistRisk}/100` : ''}`,
    `  Pourquoi :`,
    ...i.reasons.map((r) => `    ⚠ ${r}`),
    ...(i.evidence.length ? [`  Preuves :`, ...i.evidence.slice(0, 3).map((e) => `    « ${e.quote.slice(0, 140)} » ${c.dim}— ${e.label} · ${e.url}${c.reset}`)] : []),
    ...(i.problematicCriteria.length ? [`  Critères litigieux : ${i.problematicCriteria.join(' · ')}`] : []),
    `  Contact : ${i.contact}`,
    `  ${c.dim}[K] KEEP   [E] EXCLUDE   [C] CONFIRM LATER   [S] SKIP   [Q] QUIT${c.reset}`,
  ];
  return lignes.join('\n');
}

async function toucheSuivante(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { resolve('q'); return; }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (k: string) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      if (k === '') { resolve('q'); return; }
      resolve(k.toLowerCase());
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);
  const { repos } = system;
  try {
    const runId = arg('run');
    if (!runId) throw new Error('--run=<id> requis');
    const { brief } = loadClientRun(repos, runId);
    const items: Item[] = buildReviewQueue(repos, runId);
    console.log(`\n  ${c.bold}REVUE${c.reset}  ${brief.client.name}${brief.client.internalTest ? ` ${c.amber}INTERNAL_TEST${c.reset}` : ''} · ${items.length} dossier(s) · P1 ${items.filter((i) => i.priority === 'P1').length} · P2 ${items.filter((i) => i.priority === 'P2').length} · P3 ${items.filter((i) => i.priority === 'P3').length}`);
    if (items.length === 0) { console.log(`  ${c.green}rien à revoir.${c.reset}\n`); return; }

    if (!flag('interactive') || !process.stdin.isTTY) {
      for (const [n, i] of items.entries()) console.log(fiche(i, n + 1, items.length));
      console.log(`\n  ${c.dim}--interactive dans un terminal pour décider touche par touche.${c.reset}\n`);
      return;
    }

    const keep: string[] = [];
    const exclude: string[] = [];
    let plusTard = 0;
    for (const [n, i] of items.entries()) {
      console.log(fiche(i, n + 1, items.length));
      let touche = '';
      while (!['k', 'e', 'c', 's', 'q'].includes(touche)) touche = await toucheSuivante();
      if (touche === 'q') break;
      if (touche === 'k') { keep.push(i.domain); console.log(`  ${c.green}→ garder${c.reset}`); }
      else if (touche === 'e') { exclude.push(i.domain); console.log(`  ${c.red}→ écarter${c.reset}`); }
      else if (touche === 'c') { plusTard += 1; console.log(`  ${c.amber}→ à confirmer plus tard${c.reset}`); }
      else console.log(`  ${c.dim}→ passé${c.reset}`);
    }

    if (keep.length === 0 && exclude.length === 0) {
      console.log(`\n  aucune décision à appliquer${plusTard ? ` · ${plusTard} à confirmer plus tard` : ''}.\n`);
      return;
    }
    console.log(`\n  À appliquer : ${c.green}${keep.length} garder${c.reset} · ${c.red}${exclude.length} écarter${c.reset}${plusTard ? ` · ${plusTard} laissé(s) en revue` : ''}`);
    console.log(`  Confirmer ? ${c.dim}[Y] oui  [autre] non${c.reset}`);
    const ok = await toucheSuivante();
    if (ok !== 'y') { console.log(`  ${c.amber}rien appliqué.${c.reset}\n`); return; }

    const suivant = adjustClientRun(repos, runId, { keepDomains: keep, excludeDomains: exclude, notes: `revue du ${new Date().toISOString().slice(0, 10)} : ${keep.length} gardée(s), ${exclude.length} écartée(s)` });
    // Le pilote, s'il attendait cette revue, peut reprendre quand la file est vide.
    const ap = readAutopilot(loadClientRun(repos, runId).context);
    if (ap && ap.state === 'HUMAN_REVIEW_REQUIRED' && buildReviewQueue(repos, runId).length === 0) {
      transition(repos, runId, ap, 'READY_TO_CONTINUE', 'revue terminée', new Date().toISOString());
    }
    console.log(`\n  ${c.bold}BRIEF v${suivant.version}${c.reset} — décisions appliquées. Reprise : npm run client:auto -- --run=${runId} --go\n`);
  } finally {
    await system.shutdown('client-review terminé');
  }
}

main().catch((err) => {
  console.error(`\n  ${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
  process.exitCode = 1;
});
