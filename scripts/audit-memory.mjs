/**
 * Ce que contient la mémoire d'ATLAS, et d'où chaque connaissance vient.
 *
 *   node scripts/audit-memory.mjs
 *
 * Lecture seule. La mémoire est relue par toute mission future *avant* toute
 * recherche : une connaissance fabriquée pendant une démonstration y devient,
 * au deuxième usage, « ce qu'ATLAS sait ».
 *
 * Le marqueur « [SIMULÉ] » est relevé, mais **jamais** utilisé pour classer :
 * c'est un signal d'audit, pas une règle de sûreté. La lignée se déduit de la
 * mission d'origine et des entités citées.
 */
import Database from 'better-sqlite3';

const db = new Database('data/atlas.db', { readonly: true });
const items = db.prepare('SELECT * FROM memory_items ORDER BY tier, created_at').all();

const missionMode = (id) => {
  if (!id) return null;
  const m = db.prepare('SELECT code, context FROM missions WHERE id = ?').get(id);
  if (!m) return { code: '(mission supprimée)', mode: null };
  const ctx = JSON.parse(m.context || '{}');
  return { code: m.code, mode: ctx.executionMode ?? null };
};

/**
 * La lignée déductible d'un item, sans jamais lire son texte comme une preuve.
 *
 *   live       la mission d'origine s'est déclarée réelle
 *   simulated  la mission d'origine était une simulation, ou l'item cite une
 *              entité de lignée simulée
 *   unknown    tout le reste — y compris l'absence de mission d'origine
 */
function lineageOf(item) {
  const origin = missionMode(item.mission_id);

  // Une entité citée décide, même si la mission ne l'a pas dit : une
  // connaissance qui parle d'une entreprise fabriquée est fabriquée.
  const cited = db
    .prepare(
      `SELECT DISTINCT c.data_origin FROM companies c
        WHERE instr(?, c.name) > 0 OR (c.domain IS NOT NULL AND instr(?, c.domain) > 0)`,
    )
    .all(String(item.content ?? '') + ' ' + String(item.title ?? ''), String(item.content ?? ''))
    .map((r) => r.data_origin);

  if (cited.includes('simulated')) return { origin, cited, lineage: 'simulated', why: 'cite une entité de lignée simulée' };
  if (!origin) return { origin, cited, lineage: 'unknown', why: "aucune mission d'origine" };
  if (origin.mode === 'live') return { origin, cited, lineage: 'live', why: "mission d'origine déclarée réelle" };
  if (origin.mode === 'simulation') return { origin, cited, lineage: 'simulated', why: "mission d'origine simulée" };
  return { origin, cited, lineage: 'unknown', why: "mode d'origine non déclaré" };
}

const tally = { live: 0, simulated: 0, unknown: 0 };
const flagged = [];

console.log(`\n${items.length} connaissance(s) en mémoire\n${'─'.repeat(72)}`);

for (const item of items) {
  const { origin, cited, lineage, why } = lineageOf(item);
  tally[lineage] += 1;

  // Signal d'audit uniquement : ne participe jamais au classement.
  const marker = /\[SIMUL|\.example/.test(String(item.content) + String(item.title));
  if (marker) flagged.push(item.id);

  console.log(
    `${lineage.toUpperCase().padEnd(10)} [${String(item.tier).padEnd(11)}] ${String(item.kind).padEnd(14)} ${String(item.title).slice(0, 46)}`,
  );
  console.log(`           mission  ${origin ? `${origin.code} · mode=${origin.mode ?? 'non déclaré'}` : '(aucune)'}`);
  console.log(`           raison   ${why}`);
  if (cited.length > 0) console.log(`           entités  ${[...new Set(cited)].join(', ')}`);
  if (marker) console.log(`           audit    contient un marqueur « [SIMULÉ] » ou « .example »`);
  console.log(`           extrait  ${String(item.content).replace(/\s+/g, ' ').slice(0, 90)}`);
  console.log();
}

console.log('─'.repeat(72));
console.log(`  live      ${tally.live}`);
console.log(`  simulated ${tally.simulated}`);
console.log(`  unknown   ${tally.unknown}`);
console.log(`  TOTAL     ${items.length}`);
console.log(`\n  porteurs d'un marqueur textuel (audit seul) : ${flagged.length}`);

// Par palier : la mémoire métier est celle qui prétend décrire le monde.
console.log('\n  par palier :');
for (const tier of ['business', 'operational', 'strategic']) {
  const subset = items.filter((i) => i.tier === tier);
  const t = { live: 0, simulated: 0, unknown: 0 };
  for (const i of subset) t[lineageOf(i).lineage] += 1;
  console.log(`    ${tier.padEnd(12)} ${subset.length} — live ${t.live} · simulated ${t.simulated} · unknown ${t.unknown}`);
}

db.close();
console.log();
