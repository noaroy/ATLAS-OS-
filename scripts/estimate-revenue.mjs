/**
 * Ce que REVENUE-001 devrait coûter, d'après ce qui a réellement été facturé.
 *
 * Pas une estimation prudente ni un calcul de coin de table : les chiffres
 * viennent de `llm_calls`, c'est-à-dire des appels que les validations ont
 * réellement payés. Une estimation fondée sur des hypothèses serait exactement
 * le genre de calibrage qui a tué trois missions.
 *
 * Le correctif d'isolement change la formule, et c'est tout l'objet du calcul :
 * l'enrichissement de N candidats coûtait N² fois un candidat, il coûte
 * désormais N fois. On mesure donc le coût d'un candidat, et on multiplie.
 *
 *   node scripts/estimate-revenue.mjs
 */
import Database from 'better-sqlite3';
import { REVENUE_001 } from '../packages/departments/src/index.ts';

const db = new Database('data/atlas.db', { readonly: true });

// Haiku 4.5, tarif public au moment du calcul.
const IN_PER_M = 0.8;
const OUT_PER_M = 4;
const cost = (i, o) => (i / 1e6) * IN_PER_M + (o / 1e6) * OUT_PER_M;

/** Les appels réellement facturés, par étape, toutes missions réelles confondues. */
const rows = db
  .prepare(
    `SELECT task_ref,
            COUNT(*)               AS calls,
            AVG(input_tokens)      AS avg_in,
            AVG(output_tokens)     AS avg_out,
            MIN(input_tokens)      AS min_in,
            MAX(input_tokens)      AS max_in
       FROM llm_calls
      WHERE ok = 1 AND input_tokens > 0
      GROUP BY task_ref
      ORDER BY calls DESC`,
  )
  .all();

console.log('\n── Ce qui a réellement été facturé ' + '─'.repeat(40));
console.log(
  'étape'.padEnd(18) +
    'appels'.padStart(7) +
    'entrée moy.'.padStart(13) +
    'sortie moy.'.padStart(13) +
    'entrée min→max'.padStart(20),
);
for (const r of rows) {
  console.log(
    String(r.task_ref ?? '(hors étape)').padEnd(18) +
      String(r.calls).padStart(7) +
      Math.round(r.avg_in).toLocaleString('fr-FR').padStart(13) +
      Math.round(r.avg_out).toLocaleString('fr-FR').padStart(13) +
      `${Math.round(r.min_in).toLocaleString('fr-FR')} → ${Math.round(r.max_in).toLocaleString('fr-FR')}`.padStart(20),
  );
}

/**
 * Le coût d'*un* candidat enrichi, après isolement.
 *
 * On prend le premier appel d'enrichissement, jamais la moyenne : la moyenne
 * porte encore l'accumulation qu'on vient de supprimer, et estimerait un coût
 * qui ne peut plus se produire.
 */
const firstEnrich = db
  .prepare(
    `SELECT input_tokens, output_tokens
       FROM llm_calls
      WHERE ok = 1 AND task_ref LIKE '%enrich%' AND input_tokens > 0
      ORDER BY input_tokens ASC
      LIMIT 1`,
  )
  .get();

/**
 * Deux lectures d'une même étape, et l'écart entre elles est le sujet.
 *
 * `min` est le premier appel de l'étape : le seul dont le contexte ne portait
 * encore rien d'accumulé, donc le seul qui décrive le comportement d'après le
 * correctif. `avg` est la moyenne historique, qui porte l'accumulation qu'on
 * vient de supprimer.
 *
 * Aucune des deux n'est « la » vérité. La première est ce qu'on attend, la
 * seconde est ce qu'on payait — et projeter avec la seconde donnerait un budget
 * calibré sur un défaut corrigé, ce qui est précisément l'erreur qui a tué trois
 * missions dans l'autre sens.
 */
const other = (pattern) =>
  db
    .prepare(
      `SELECT AVG(input_tokens) AS i, AVG(output_tokens) AS o,
              MIN(input_tokens) AS min_i
         FROM llm_calls
        WHERE ok = 1 AND task_ref LIKE ? AND input_tokens > 0`,
    )
    .get(pattern);

const n = REVENUE_001.targetProspects;
const enrichIn = firstEnrich?.input_tokens ?? 0;
const enrichOut = firstEnrich?.output_tokens ?? 0;

const disc = other('%disco%');
const qual = other('%qualif%');
const score = other('%scor%');

/** Le plan d'appels, pour `p` prospects retenus. */
const planFor = (p, pick) => [
  ['découverte', 2, pick(disc, enrichIn), disc?.o ?? enrichOut],
  ['enrichissement', p * 2, enrichIn, enrichOut],
  ['qualification', p, pick(qual, enrichIn), qual?.o ?? enrichOut],
  ['scoring', p, pick(score, enrichIn), score?.o ?? enrichOut],
  ['classement', 1, enrichIn, enrichOut],
];

const attendu = (s, fallback) => s?.min_i ?? fallback;
const pireCas = (s, fallback) => s?.i ?? fallback;
const totalOf = (plan) => plan.reduce((sum, [, calls, i, o]) => sum + calls * cost(i, o), 0);

const budget = REVENUE_001.limits.maxCostUsd;

console.log('\n── Projection REVENUE-001, contexte isolé ' + '─'.repeat(28));
console.log(
  'prospects'.padEnd(14) + 'attendu'.padStart(11) + 'pire cas'.padStart(11) + 'tient ?'.padStart(18),
);
for (const p of [3, 4, 5]) {
  const low = totalOf(planFor(p, attendu));
  const high = totalOf(planFor(p, pireCas));
  const verdict = high <= budget ? 'oui' : low <= budget ? 'oui si attendu' : 'NON';
  console.log(
    `${p} prospects`.padEnd(14) +
      `${low.toFixed(4)} $`.padStart(11) +
      `${high.toFixed(4)} $`.padStart(11) +
      verdict.padStart(18),
  );
}

console.log('\n── Le détail au pack visé (' + n + ' prospects) ' + '─'.repeat(28));
console.log('étape'.padEnd(18) + 'appels'.padStart(7) + 'attendu'.padStart(12) + 'pire cas'.padStart(12));
const low5 = planFor(n, attendu);
const high5 = planFor(n, pireCas);
for (const [k, [label, calls, i, o]] of low5.entries()) {
  const hi = high5[k];
  console.log(
    label.padEnd(18) +
      String(calls).padStart(7) +
      `${(calls * cost(i, o)).toFixed(4)} $`.padStart(12) +
      `${(hi[1] * cost(hi[2], hi[3])).toFixed(4)} $`.padStart(12),
  );
}
console.log('─'.repeat(49));
console.log(
  'TOTAL'.padEnd(18) +
    ''.padStart(7) +
    `${totalOf(low5).toFixed(4)} $`.padStart(12) +
    `${totalOf(high5).toFixed(4)} $`.padStart(12),
);

console.log(`\nPlafond REVENUE-001 : ${budget.toFixed(2)} $`);
console.log(
  `\n« Attendu » projette avec le PREMIER appel de chaque étape — le seul dont le\n` +
    `contexte ne portait rien d'accumulé, donc le seul représentatif d'après le\n` +
    `correctif. « Pire cas » projette avec la moyenne historique, qui porte encore\n` +
    `l'accumulation supprimée : c'est un plafond, pas une prévision.`,
);

// Ce que le même travail aurait coûté sans l'isolement : l'enrichissement seul,
// dont l'entrée croissait de 5 710 à 32 443 jetons sur huit candidats.
const withoutFix = [5710, 12605, 24943, 32443, 32443].reduce((a, i) => a + cost(i, enrichOut), 0);
const withFix = n * cost(enrichIn, enrichOut);
console.log(`Enrichissement seul, sans le correctif : ${withoutFix.toFixed(4)} $`);
console.log(`Enrichissement seul, avec             : ${withFix.toFixed(4)} $`);
console.log(`Rapport                               : ${(withoutFix / withFix).toFixed(1)}×\n`);

db.close();
