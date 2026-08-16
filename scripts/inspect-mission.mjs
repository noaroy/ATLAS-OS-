/**
 * Relève ce qu'une mission a réellement fait, par son code.
 *
 *   node scripts/inspect-mission.mjs M-XXXXX
 *
 * Lecture seule. Sert à établir une cause plutôt qu'à la supposer.
 */
import Database from 'better-sqlite3';

const db = new Database('data/atlas.db', { readonly: true });
const code = process.argv[2];

const m = code
  ? db.prepare('SELECT * FROM missions WHERE code = ?').get(code)
  : db.prepare('SELECT * FROM missions ORDER BY created_at DESC LIMIT 1').get();

if (!m) {
  console.error('mission introuvable');
  process.exit(1);
}

const ctx = JSON.parse(m.context || '{}');
console.log(`\n${m.code} | ${m.status} | tokenBudget=${m.token_budget}`);
console.log(`  preset=${ctx.preset} budgetUsd=${ctx.budgetUsd}`);
console.log(`  error=${m.error ?? '(aucune)'}`);

const calls = db
  .prepare(
    `SELECT task_ref, purpose, input_tokens, output_tokens, cost_usd, ok
     FROM llm_calls WHERE mission_id = ? ORDER BY created_at`,
  )
  .all(m.id);

let cum = 0;
console.log('\n  --- appels ---');
for (const c of calls) {
  cum += c.input_tokens + c.output_tokens;
  console.log(
    `  ${String(c.task_ref ?? '-').padEnd(14)} ${String(c.purpose).padEnd(18)} ` +
      `in=${String(c.input_tokens).padStart(6)} out=${String(c.output_tokens).padStart(5)} cum=${String(cum).padStart(7)}`,
  );
}

console.log('\n  --- etapes ---');
for (const t of db
  .prepare('SELECT ref, status, tokens_used, attempts, error FROM mission_tasks WHERE mission_id = ? ORDER BY seq')
  .all(m.id)) {
  console.log(`  ${t.ref.padEnd(14)} ${t.status.padEnd(10)} tokens=${String(t.tokens_used).padStart(7)} tentatives=${t.attempts}`);
  if (t.error) console.log(`     -> ${String(t.error).slice(0, 200)}`);
}

const sumTasks = db
  .prepare('SELECT SUM(tokens_used) n FROM mission_tasks WHERE mission_id = ?')
  .get(m.id);
const sumCalls = calls.reduce((n, c) => n + c.input_tokens + c.output_tokens, 0);
console.log(`\n  tokens comptes par etapes = ${sumTasks.n}`);
console.log(`  tokens comptes par appels  = ${sumCalls}`);
console.log(`  plafond mission            = ${m.token_budget}`);

console.log('\n  --- outils ---');
for (const t of db
  .prepare('SELECT tool, outcome, ok FROM tool_calls WHERE mission_id = ? ORDER BY created_at')
  .all(m.id)) {
  console.log(`  ${t.tool.padEnd(18)} ${String(t.outcome).padEnd(14)} ok=${t.ok}`);
}

console.log('\n  --- candidats ---');
for (const r of db
  .prepare(
    `SELECT c.name, o.stage, e.source_key, e.source_ref, e.nature
     FROM opportunities o JOIN companies c ON c.id = o.company_id
     LEFT JOIN evidence e ON e.opportunity_id = o.id
     WHERE o.mission_id = ?`,
  )
  .all(m.id)) {
  console.log(`  ${r.name} [${r.stage}]`);
  console.log(`     ${r.source_key ?? '-'} | ${r.source_ref ?? '-'} | ${r.nature ?? '-'}`);
}

db.close();
