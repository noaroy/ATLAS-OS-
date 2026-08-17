/**
 * Où la provenance simulée peut se perdre, table par table.
 *
 *   node scripts/audit-provenance.mjs
 *
 * Lecture seule. Cherche les surfaces où une donnée fabriquée peut être relue
 * plus tard comme réelle — le défaut trouvé par VAL-003, généralisé.
 *
 * La question posée à chaque table : « si une ligne a été écrite pendant une
 * démonstration, qu'est-ce qui empêche une mission réelle de s'en servir comme
 * d'un fait ? »
 */
import Database from 'better-sqlite3';

const db = new Database('data/atlas.db', { readonly: true });
const has = (table, column) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
const count = (sql, ...args) => db.prepare(sql).get(...args)?.n ?? 0;

const line = (t) => console.log(`\n${'─'.repeat(70)}\n${t}\n${'─'.repeat(70)}`);

// ── Où les 67 entreprises simulées ont-elles été créées ? ───────────────────
line('ORIGINE DES ENTREPRISES SIMULÉES');

const simCompanies = db
  .prepare(`SELECT id, name, website, domain, first_seen_at, enriched FROM companies WHERE website LIKE '%.example%' OR domain LIKE '%.example%' OR name LIKE '[SIMUL%'`)
  .all();

console.log(`  entreprises à marqueur simulé : ${simCompanies.length}`);
console.log(`    dont enrichies (éligibles au registre) : ${simCompanies.filter((c) => c.enriched).length}`);

// Par quelle mission, et dans quel mode ?
const byMission = new Map();
for (const c of simCompanies) {
  const rows = db
    .prepare(`SELECT DISTINCT mission_id FROM evidence WHERE company_id = ?`)
    .all(c.id);
  for (const r of rows) {
    const m = db.prepare('SELECT code, context, created_at FROM missions WHERE id = ?').get(r.mission_id);
    if (!m) continue;
    const mode = JSON.parse(m.context || '{}').executionMode ?? '(non déclaré)';
    const key = `${m.code} · mode=${mode} · ${String(m.created_at).slice(0, 10)}`;
    byMission.set(key, (byMission.get(key) ?? 0) + 1);
  }
}
console.log('\n  missions qui les ont touchées :');
for (const [k, n] of [...byMission.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k}  →  ${n} lien(s) de preuve`);
}

// Combien portent un marqueur *structurel* plutôt que cosmétique ?
const byMarker = {
  nomPréfixé: simCompanies.filter((c) => String(c.name).startsWith('[SIMUL')).length,
  domaineExample: simCompanies.filter((c) => /\.example/.test(String(c.website ?? '') + String(c.domain ?? ''))).length,
};
console.log(`\n  marqueurs disponibles :`);
console.log(`    nom préfixé « [SIMULÉ] »  ${byMarker.nomPréfixé}`);
console.log(`    domaine en .example       ${byMarker.domaineExample}`);
console.log(
  `    les deux                  ${simCompanies.filter((c) => String(c.name).startsWith('[SIMUL') && /\.example/.test(String(c.website ?? '') + String(c.domain ?? ''))).length}`,
);

// ── Les surfaces exposées ───────────────────────────────────────────────────
line('SURFACES OÙ LA PROVENANCE PEUT SE PERDRE');

const surfaces = [
  {
    table: 'companies',
    lu_par: 'RegistryDiscoveryProvider en LIVE',
    marqueur: has('companies', 'data_origin') ? 'data_origin' : null,
  },
  {
    table: 'contacts',
    lu_par: 'enrichment, rapport final',
    marqueur: has('contacts', 'simulated') ? 'simulated' : null,
  },
  {
    table: 'opportunities',
    lu_par: 'qualification, scoring, ranking, revue humaine',
    marqueur: has('opportunities', 'simulated') ? 'simulated' : null,
  },
  {
    table: 'evidence',
    lu_par: 'toutes les étapes, verdict, rapport',
    marqueur: has('evidence', 'simulated') ? 'simulated' : null,
  },
  {
    table: 'memory_items',
    lu_par: 'toute mission future, avant toute recherche',
    marqueur: has('memory_items', 'simulated') ? 'simulated' : null,
  },
  {
    table: 'mission_decisions',
    lu_par: 'audit, cockpit',
    marqueur: has('mission_decisions', 'simulated') ? 'simulated' : null,
  },
  {
    table: 'company_relations',
    lu_par: 'enrichment',
    marqueur: has('company_relations', 'simulated') ? 'simulated' : null,
  },
];

for (const s of surfaces) {
  const exists = db
    .prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?`)
    .get(s.table).n;
  if (!exists) {
    console.log(`  ${s.table.padEnd(18)} (table absente)`);
    continue;
  }
  const total = count(`SELECT COUNT(*) n FROM ${s.table}`);
  const flag = s.marqueur ? `marqueur=${s.marqueur}` : 'AUCUN MARQUEUR DE PROVENANCE';
  console.log(`  ${s.table.padEnd(18)} ${String(total).padStart(6)} ligne(s)  ${flag}`);
  console.log(`  ${''.padEnd(18)} lu par : ${s.lu_par}`);
}

// ── La mémoire : la surface la plus dangereuse ──────────────────────────────
line('MÉMOIRE — CE QUI SERA RELU PAR TOUTE MISSION FUTURE');

const memTable = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory%'`)
  .all()
  .map((r) => r.name);
for (const t of memTable) {
  const total = count(`SELECT COUNT(*) n FROM ${t}`);
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  console.log(`  ${t} : ${total} ligne(s)`);
  console.log(`    colonnes : ${cols.join(', ')}`);
  if (cols.includes('tier') && total > 0) {
    for (const r of db.prepare(`SELECT tier, COUNT(*) n FROM ${t} GROUP BY tier`).all()) {
      console.log(`      ${r.tier} : ${r.n}`);
    }
  }
  // Une connaissance métier issue d'une démonstration serait relue comme un fait.
  if (cols.includes('content') && total > 0) {
    const suspicious = count(
      `SELECT COUNT(*) n FROM ${t} WHERE content LIKE '%.example%' OR content LIKE '%[SIMUL%' OR title LIKE '%[SIMUL%'`,
    );
    console.log(`      contenant un marqueur simulé : ${suspicious}`);
  }
}

db.close();
console.log();
