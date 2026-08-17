/**
 * Pourquoi une mission s'est arrêtée là où elle s'est arrêtée.
 *
 * Lit `llm_calls` appel par appel, dans l'ordre, avec la taille de contexte
 * mesurée à l'envoi. Un total par étape dit combien on a payé ; seule la
 * séquence dit *pourquoi*.
 *
 *   node scripts/diagnose-mission.mjs M-WX5T0
 */
import Database from 'better-sqlite3';

const code = process.argv[2];
if (!code) {
  console.error('Usage : node scripts/diagnose-mission.mjs <code de mission>');
  process.exit(1);
}

const db = new Database('data/atlas.db', { readonly: true });
const mission = db.prepare('SELECT id, code, status FROM missions WHERE code = ?').get(code);
if (!mission) {
  console.error(`Mission « ${code} » introuvable.`);
  process.exit(1);
}

const calls = db
  .prepare(
    `SELECT task_ref, purpose, input_tokens, output_tokens, cost_usd,
            context_chars, subject, evidence_count, tool_calls, ok, created_at
       FROM llm_calls WHERE mission_id = ? ORDER BY created_at`,
  )
  .all(mission.id);

console.log(`\n  ${mission.code} — ${mission.status} · ${calls.length} appels\n`);
console.log(
  '   #  étape          entrée   sortie   contexte    Δ ctx   outils    coût',
);
console.log('  ' + '─'.repeat(68));

let prev = null;
let cumIn = 0;
for (const [i, c] of calls.entries()) {
  cumIn += c.input_tokens;
  const delta = prev === null ? '' : (c.context_chars - prev >= 0 ? '+' : '') + (c.context_chars - prev);
  console.log(
    `  ${String(i + 1).padStart(2)}  ${String(c.task_ref ?? '—').padEnd(14)}` +
      `${c.input_tokens.toLocaleString('fr-FR').padStart(7)}  ` +
      `${c.output_tokens.toLocaleString('fr-FR').padStart(6)}  ` +
      `${(c.context_chars ?? 0).toLocaleString('fr-FR').padStart(9)}  ` +
      `${delta.padStart(7)}  ` +
      `${String(c.tool_calls).padStart(5)}  ` +
      `${(c.cost_usd ?? 0).toFixed(4)}$`,
  );
  prev = c.context_chars;
}

console.log('  ' + '─'.repeat(68));
console.log(
  `      cumul entrée  ${cumIn.toLocaleString('fr-FR')} jetons · ` +
    `coût ${calls.reduce((a, c) => a + (c.cost_usd ?? 0), 0).toFixed(4)} $`,
);

// Ce que les outils ont ramené dans le contexte — la vraie source du volume.
const tools = db
  .prepare(
    `SELECT tool, COUNT(*) AS n, SUM(duration_ms) AS ms,
            SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures
       FROM tool_calls WHERE mission_id = ? GROUP BY tool ORDER BY n DESC`,
  )
  .all(mission.id);

console.log(`\n  Outils appelés\n  ` + '─'.repeat(50));
for (const t of tools) {
  console.log(
    `  ${t.tool.padEnd(20)} ${String(t.n).padStart(3)} appels · ` +
      `${Math.round((t.ms ?? 0) / 1000)}s` +
      (t.failures > 0 ? ` · ${t.failures} échec(s)` : ''),
  );
}

const evidence = db
  .prepare(
    `SELECT nature, COUNT(*) AS n FROM evidence WHERE mission_id = ? GROUP BY nature`,
  )
  .all(mission.id);
console.log(`\n  Preuves produites : ${evidence.map((e) => `${e.n} ${e.nature}`).join(' · ')}\n`);

db.close();
