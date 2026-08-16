/**
 * Relève ce qu'une mission pilote a réellement fait.
 *
 * Lecture seule, aucun appel réseau, aucun modèle. Sert à établir la cause d'un
 * refus budgétaire à partir des lignes écrites pendant la mission, plutôt qu'à
 * la supposer depuis le code.
 *
 *   node scripts/inspect-pilot.mjs [chemin/atlas.db]
 */
import Database from 'better-sqlite3';

const db = new Database(process.argv[2] ?? 'data/atlas.db', { readonly: true });

const missions = db
  .prepare(
    `SELECT id, code, title, status, token_budget, context, created_at
     FROM missions
     WHERE title LIKE '%LIVE PILOT%' OR context LIKE '%LIVE-001%'
     ORDER BY created_at DESC LIMIT 4`,
  )
  .all();

for (const m of missions) {
  const ctx = JSON.parse(m.context || '{}');
  console.log(`\n=== ${m.code} | ${m.status} | tokenBudget=${m.token_budget} | ${m.created_at}`);
  console.log(`    budgetUsd=${ctx.budgetUsd} mode=${ctx.executionMode} pilot=${ctx.pilot}`);

  const calls = db
    .prepare(
      `SELECT purpose, task_ref, model, input_tokens, output_tokens, cost_usd, ok, error
       FROM llm_calls WHERE mission_id = ? ORDER BY created_at`,
    )
    .all(m.id);

  let tokens = 0;
  let cost = 0;
  for (const c of calls) {
    tokens += c.input_tokens + c.output_tokens;
    cost += c.cost_usd || 0;
  }
  console.log(`    appels=${calls.length} tokens=${tokens} cout=${cost.toFixed(4)}`);

  console.log('    --- chronologie (tokens cumulés) ---');
  let running = 0;
  for (const c of calls) {
    running += c.input_tokens + c.output_tokens;
    const flag = c.ok ? ' ' : 'X';
    console.log(
      `    ${flag} ${String(c.task_ref ?? '-').padEnd(14)} ${String(c.purpose).padEnd(18)} ` +
        `in=${String(c.input_tokens).padStart(6)} out=${String(c.output_tokens).padStart(5)} ` +
        `cum=${String(running).padStart(7)} ${(c.cost_usd || 0).toFixed(4)}$`,
    );
    if (!c.ok && c.error) console.log(`       -> ${c.error.slice(0, 400)}`);
  }

  const tasks = db
    .prepare(`SELECT ref, title, status, error FROM mission_tasks WHERE mission_id = ? ORDER BY ref`)
    .all(m.id);
  console.log('    --- etapes ---');
  for (const t of tasks) {
    console.log(`    ${String(t.ref).padEnd(14)} ${String(t.status).padEnd(10)} ${t.title ?? ''}`);
    if (t.error) console.log(`       -> ${String(t.error).slice(0, 400)}`);
  }

  const opps = db.prepare(`SELECT COUNT(*) n FROM opportunities WHERE mission_id = ?`).get(m.id);
  const evid = db.prepare(`SELECT COUNT(*) n FROM evidence WHERE mission_id = ?`).get(m.id);
  console.log(`    opportunites=${opps.n} preuves=${evid.n}`);

  // La provenance de chaque candidat : sans elle, reprendre une mission
  // reviendrait à faire confiance à des noms sans savoir d'où ils viennent.
  const provenance = db
    .prepare(
      `SELECT c.name, c.website, o.stage, e.source_key, e.source_ref, e.nature,
              e.collected_at, e.simulated, e.claim
       FROM opportunities o
       JOIN companies c ON c.id = o.company_id
       LEFT JOIN evidence e ON e.opportunity_id = o.id
       WHERE o.mission_id = ?
       ORDER BY c.name`,
    )
    .all(m.id);

  if (provenance.length > 0) {
    console.log('    --- provenance des candidats ---');
    for (const p of provenance) {
      console.log(`    ${p.name}  [${p.stage}]`);
      console.log(`       moteur   ${p.source_key ?? '(aucun)'}`);
      console.log(`       source   ${p.source_ref ?? '(aucune)'}`);
      console.log(`       nature   ${p.nature ?? '-'}  simule=${p.simulated}`);
      console.log(`       releve   ${p.collected_at ?? '-'}`);
      if (p.claim) console.log(`       claim    ${String(p.claim).slice(0, 120)}`);
    }
  }
}

db.close();
