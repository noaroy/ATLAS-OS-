#!/usr/bin/env node
/**
 * Compter ce que Graphify fait économiser, requête par requête.
 *
 * Le benchmark répond à « combien pourrait-on économiser ? ». Il ne répond pas
 * à « combien a-t-on économisé ? », parce que rien ne comptait les requêtes :
 * `graphify-out/cache/last_query_stamp` porte un seul horodatage, écrasé à
 * chaque appel. Une mesure sans dénominateur ne se totalise pas.
 *
 * Ce script est donc une enveloppe. Il passe la commande à `graphify`, affiche
 * sa sortie sans y toucher, et ajoute une ligne au journal. Aucun modèle,
 * aucun réseau, aucune dépendance : le coût de la mesure doit rester nul, sans
 * quoi elle finit par peser plus que ce qu'elle mesure.
 *
 *   node tools/graphify-meter/gq.mjs "comment fonctionne le scoring"
 *   node tools/graphify-meter/gq.mjs explain "SalesRepository"
 *   node tools/graphify-meter/gq.mjs stats
 *   node tools/graphify-meter/gq.mjs init      (relève la ligne de base)
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = '.graphify-meter';
const LOG = join(DIR, 'queries.jsonl');
const CONFIG = join(DIR, 'baseline.json');

/**
 * Mots → jetons, avec le facteur du benchmark Graphify lui-même.
 *
 * 98 200 / 73 650 et 246 333 / 184 750 donnent tous deux 4/3. Utiliser un autre
 * estimateur — chars/4, par exemple — produirait des ratios qui ne se
 * compareraient plus à ceux du benchmark, et la mesure perdrait son point de
 * référence.
 */
const TOKENS_PER_WORD = 4 / 3;
const tokensOf = (text) => Math.round(text.trim().split(/\s+/).filter(Boolean).length * TOKENS_PER_WORD);

const PASSTHROUGH = new Set(['query', 'explain', 'path', 'affected', 'god-nodes']);

function readBaseline() {
  if (!existsSync(CONFIG)) {
    console.error(
      `Aucune ligne de base. Lancez d'abord :\n  node ${process.argv[1]} init`,
    );
    process.exit(2);
  }
  return JSON.parse(readFileSync(CONFIG, 'utf8'));
}

/**
 * Relève la ligne de base depuis `graphify benchmark`.
 *
 * Elle est enregistrée plutôt que codée en dur : un graphe qui grossit change
 * la ligne de base, et un nombre figé dans le script deviendrait faux sans
 * prévenir. Chaque relevé garde sa date et l'empreinte du graphe mesuré.
 */
function init(argv) {
  // Une ligne de base choisie par l'appelant l'emporte sur celle du benchmark.
  //
  // Le benchmark suppose le corpus entier chargé à chaque question. C'est un
  // plafond, et il produit des ratios peu crédibles : une requête réelle rend
  // ~300 jetons sous le plafond de sortie par défaut, ce qui donne des 800x.
  // Qui veut un chiffre défendable pose ici ce qu'il chargerait vraiment sans
  // le graphe — quelques fichiers ciblés, soit 15 000 à 40 000 jetons.
  const override = argv.find((a) => a.startsWith('--baseline='));
  const run = spawnSync('graphify', ['benchmark'], { encoding: 'utf8' });
  if (run.status !== 0) {
    console.error('graphify benchmark a échoué :\n' + (run.stderr || run.stdout));
    process.exit(1);
  }
  const out = run.stdout;
  const corpus = /Corpus:\s+([\d,]+)\s+words\s+→\s+~([\d,]+)\s+tokens/.exec(out);
  const graph = /Graph:\s+([\d,]+)\s+nodes,\s+([\d,]+)\s+edges/.exec(out);
  const avg = /Avg query cost:\s+~([\d,]+)\s+tokens/.exec(out);
  if (!corpus || !graph || !avg) {
    console.error('Sortie du benchmark non reconnue :\n' + out);
    process.exit(1);
  }
  const num = (s) => Number(s.replace(/,/g, ''));

  mkdirSync(DIR, { recursive: true });
  const baseline = {
    recorded_at: new Date().toISOString(),
    basis: override ? 'lecture ciblée, posée à la main' : 'corpus entier (convention du benchmark)',
    corpus_words: num(corpus[1]),
    // Ce que coûterait la question si l'on chargeait tout le corpus. C'est la
    // convention du benchmark, et c'est un plafond : un agent réel cible ses
    // lectures. Les économies calculées ici en héritent.
    baseline_tokens_per_query: override ? Number(override.split('=')[1]) : num(corpus[2]),
    benchmark_avg_query_tokens: num(avg[1]),
    graph_nodes: num(graph[1]),
    graph_edges: num(graph[2]),
  };
  writeFileSync(CONFIG, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
  if (!existsSync(LOG)) appendFileSync(LOG, '', 'utf8');

  console.log('Ligne de base enregistrée :');
  for (const [key, value] of Object.entries(baseline)) {
    console.log(`  ${key.padEnd(28)}${typeof value === 'number' ? value.toLocaleString('fr-FR') : value}`);
  }
}

function stats() {
  const baseline = readBaseline();
  const lines = existsSync(LOG)
    ? readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim())
    : [];

  if (lines.length === 0) {
    console.log('GRAPHIFY STATS');
    console.log('  total queries              0');
    console.log(`  ligne de base par requête  ${baseline.baseline_tokens_per_query.toLocaleString('fr-FR')} jetons`);
    console.log('  Aucune requête enregistrée : rien à totaliser.');
    return;
  }

  const rows = lines.map((l) => JSON.parse(l));
  const graphifyTotal = rows.reduce((sum, r) => sum + r.estimated_graphify_tokens, 0);
  const baselineTotal = rows.reduce((sum, r) => sum + r.estimated_baseline_tokens, 0);
  const savedTotal = rows.reduce((sum, r) => sum + r.estimated_tokens_saved, 0);

  // Deux moyennes, parce qu'elles ne disent pas la même chose. Le rapport des
  // totaux est celui du benchmark, et le plus conservateur. La moyenne des
  // rapports se laisse tirer vers le haut par une seule requête très ciblée —
  // sur ATLAS, « what connects the data layer to the api » vaut 99,7x à elle
  // seule.
  const aggregate = graphifyTotal > 0 ? baselineTotal / graphifyTotal : 0;
  const meanOfRatios =
    rows.reduce((sum, r) => sum + (r.estimated_graphify_tokens > 0
      ? r.estimated_baseline_tokens / r.estimated_graphify_tokens
      : 0), 0) / rows.length;

  const n = (v) => Math.round(v).toLocaleString('fr-FR');
  console.log('GRAPHIFY STATS');
  console.log(`  total queries              ${rows.length}`);
  console.log(`  total Graphify tokens      ${n(graphifyTotal)}`);
  console.log(`  estimated baseline tokens  ${n(baselineTotal)}`);
  console.log(`  estimated tokens saved     ${n(savedTotal)}`);
  console.log(`  average reduction ratio    ${aggregate.toFixed(1)}x   (rapport des totaux)`);
  console.log(`                             ${meanOfRatios.toFixed(1)}x   (moyenne des rapports)`);
  console.log('');
  console.log(`  première requête           ${rows[0].timestamp}`);
  console.log(`  dernière requête           ${rows[rows.length - 1].timestamp}`);
  console.log(`  ligne de base relevée le   ${baseline.recorded_at.slice(0, 10)} ` +
    `(${baseline.corpus_words.toLocaleString('fr-FR')} mots, ${baseline.graph_nodes.toLocaleString('fr-FR')} nœuds)`);
  console.log('');
  const bases = [...new Set(rows.map((r) => r.baseline_basis ?? 'corpus entier (convention du benchmark)'))];
  console.log(`  ligne de base              ${bases.join(' + ')}`);
  if (bases.some((b) => b.startsWith('corpus entier'))) {
    console.log('');
    console.log('  Cette ligne de base suppose le corpus entier chargé à chaque question.');
    console.log('  C’est un plafond, pas une facture évitée : pour un chiffre défendable,');
    console.log('  relevez-la sur ce que vous liriez vraiment — gq.mjs init --baseline=N.');
  }
}

function runQuery(argv) {
  const baseline = readBaseline();
  const subcommand = PASSTHROUGH.has(argv[0]) ? argv[0] : 'query';
  const args = PASSTHROUGH.has(argv[0]) ? argv.slice(1) : argv;

  const run = spawnSync('graphify', [subcommand, ...args], { encoding: 'utf8' });
  const output = (run.stdout ?? '') + (run.stderr ?? '');
  process.stdout.write(output);

  // Une requête qui échoue n'a rien produit et n'a donc rien économisé :
  // l'enregistrer gonflerait le total avec du vide.
  if (run.status !== 0) {
    console.error('\n[meter] requête en échec — non comptabilisée.');
    process.exit(run.status ?? 1);
  }

  const graphifyTokens = tokensOf(run.stdout ?? '');
  const entry = {
    timestamp: new Date().toISOString(),
    command: subcommand,
    query: args.filter((a) => !a.startsWith('--')).join(' '),
    estimated_graphify_tokens: graphifyTokens,
    estimated_baseline_tokens: baseline.baseline_tokens_per_query,
    estimated_tokens_saved: baseline.baseline_tokens_per_query - graphifyTokens,
    // Sur quoi repose la ligne de base, écrit dans chaque ligne : elle peut
    // changer, et un total dont on ne sait plus ce qu'il compare ne vaut rien.
    baseline_basis: baseline.basis ?? 'corpus entier (convention du benchmark)',
  };

  // Ajout seul, jamais de réécriture : c'est la seule opération que ce script
  // sache faire sur le journal.
  mkdirSync(DIR, { recursive: true });
  appendFileSync(LOG, JSON.stringify(entry) + '\n', 'utf8');

  console.error(
    `\n[meter] ${graphifyTokens.toLocaleString('fr-FR')} jetons · ` +
      `${entry.estimated_tokens_saved.toLocaleString('fr-FR')} économisés · ` +
      `${(entry.estimated_baseline_tokens / Math.max(1, graphifyTokens)).toFixed(1)}x`,
  );
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.log('usage: gq.mjs init | stats | [query|explain|path|affected] "<question>" [flags]');
  process.exit(1);
} else if (argv[0] === 'init') {
  init(argv.slice(1));
} else if (argv[0] === 'stats') {
  stats();
} else {
  runQuery(argv);
}
