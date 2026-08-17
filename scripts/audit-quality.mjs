/**
 * Audit de la qualité métier d'une mission — doublons, preuves, scoring, coût.
 *
 *   node scripts/audit-quality.mjs M-XXXXX
 *
 * Lecture seule, aucune dépense, aucune correction. L'audit ne répare rien :
 * mesurer puis corriger dans le même geste rendrait la mesure invérifiable.
 */
import Database from 'better-sqlite3';

const db = new Database('data/atlas.db', { readonly: true });
const code = process.argv[2];
const m = db.prepare('SELECT * FROM missions WHERE code = ?').get(code);
if (!m) {
  console.error(`mission « ${code} » introuvable`);
  process.exit(1);
}

const line = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);

const opportunities = db
  .prepare(
    `SELECT o.id, o.stage, o.score, o.score_detail, o.qualification, o.rank, o.justification,
            o.reused_knowledge, c.id AS company_id, c.name, c.canonical_key, c.website, c.domain
     FROM opportunities o JOIN companies c ON c.id = o.company_id
     WHERE o.mission_id = ? ORDER BY c.name`,
  )
  .all(m.id);

const evidence = db
  .prepare(
    `SELECT e.*, c.name AS company_name FROM evidence e
     JOIN companies c ON c.id = e.company_id WHERE e.mission_id = ?`,
  )
  .all(m.id);

const calls = db.prepare('SELECT * FROM llm_calls WHERE mission_id = ?').all(m.id);
const tools = db.prepare('SELECT * FROM tool_calls WHERE mission_id = ?').all(m.id);

const cost = calls.reduce((n, c) => n + (c.cost_usd || 0), 0);

// ── 1. DÉDUPLICATION ────────────────────────────────────────────────────────
// Deux notions distinctes. Un doublon *exact* partage la clé canonique : c'est
// une défaillance de la déduplication elle-même. Un doublon *sémantique* est la
// même entreprise sous deux graphies — « Lilie GmbH » et « Lilie » — et c'est
// la normalisation du nom qui a laissé passer.
line('1. DÉDUPLICATION');

const normalise = (name) =>
  String(name)
    .toLowerCase()
    .replace(/\b(gmbh|ag|kg|se|ohg|gbr|mbh|co|kgaa|ug|e\.?k\.?|group|gruppe|holding)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();

const hostOf = (url) => {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

const byCanonical = new Map();
const byNormalised = new Map();
const byHost = new Map();

for (const o of opportunities) {
  const push = (map, key) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(o);
  };
  push(byCanonical, o.canonical_key);
  push(byNormalised, normalise(o.name));
  push(byHost, hostOf(o.website));
}

const exactDupes = [...byCanonical.values()].filter((g) => g.length > 1);
const semanticDupes = [...byNormalised.values()].filter((g) => g.length > 1);
const hostDupes = [...byHost.values()].filter((g) => g.length > 1);

console.log(`  candidats                    ${opportunities.length}`);
console.log(`  clés canoniques distinctes   ${byCanonical.size}`);
console.log(`  doublons exacts              ${exactDupes.length} groupe(s)`);
console.log(`  doublons sémantiques (nom)   ${semanticDupes.length} groupe(s)`);
console.log(`  doublons par domaine         ${hostDupes.length} groupe(s)`);

const showGroups = (label, groups) => {
  if (groups.length === 0) return;
  console.log(`\n  ${label} :`);
  for (const g of groups) {
    console.log(`    · ${g.map((o) => `${o.name} [${o.stage}]`).join('  ||  ')}`);
    console.log(`      ${g.map((o) => o.website ?? '(sans site)').join('  ||  ')}`);
  }
};
showGroups('doublons exacts', exactDupes);
showGroups('doublons sémantiques', semanticDupes);
showGroups('doublons par domaine', hostDupes);

// À quel stade apparaissent-ils ?
const dupeStages = new Set();
for (const g of [...exactDupes, ...semanticDupes, ...hostDupes]) {
  for (const o of g) dupeStages.add(o.stage);
}
if (dupeStages.size > 0) console.log(`\n  stades concernés             ${[...dupeStages].join(', ')}`);

// Coût gaspillé : les preuves rattachées aux exemplaires surnuméraires.
const redundant = new Set();
for (const g of [...semanticDupes, ...hostDupes]) {
  for (const o of g.slice(1)) redundant.add(o.id);
}
const redundantEvidence = evidence.filter((e) => redundant.has(e.opportunity_id));
const costPerEvidence = evidence.length > 0 ? cost / evidence.length : 0;
console.log(`  exemplaires surnuméraires    ${redundant.size}`);
console.log(`  preuves sur ces exemplaires  ${redundantEvidence.length}`);
console.log(
  `  coût imputable (estimation)  ${(redundantEvidence.length * costPerEvidence).toFixed(4)} $ ` +
    `${'[2m'}(preuves redondantes × coût moyen par preuve)${'[0m'}`,
);

// ── 2. QUALITÉ DES PREUVES ──────────────────────────────────────────────────
line('2. QUALITÉ DES PREUVES');

const natures = { observed: 0, reported: 0, inferred: 0 };
for (const e of evidence) natures[e.nature] = (natures[e.nature] ?? 0) + 1;

const validSource = evidence.filter((e) => {
  if (!e.source_ref) return false;
  try {
    const u = new URL(e.source_ref);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
});
const unsourcedFirsthand = evidence.filter(
  (e) => !e.source_ref && (e.nature === 'observed' || e.nature === 'reported'),
);

const claimCounts = new Map();
for (const e of evidence) {
  const key = `${e.company_id}::${String(e.claim).slice(0, 120)}`;
  claimCounts.set(key, (claimCounts.get(key) ?? 0) + 1);
}
const duplicatedClaims = [...claimCounts.entries()].filter(([, n]) => n > 1);

const weak = evidence.filter((e) => (e.confidence ?? 0) < 0.5);
const noBasis = evidence.filter((e) => !e.basis);

console.log(`  preuves totales              ${evidence.length}`);
console.log(`  sources valides (http/https) ${validSource.length}`);
console.log(`  observed / reported / inferred  ${natures.observed} / ${natures.reported} / ${natures.inferred}`);
console.log(`  première main sans source    ${unsourcedFirsthand.length}`);
console.log(`  claims dupliqués             ${duplicatedClaims.length} groupe(s)`);
console.log(`  preuves faibles (conf < 0.5) ${weak.length}`);
console.log(`  preuves sans « basis »       ${noBasis.length}`);

if (duplicatedClaims.length > 0) {
  console.log('\n  claims dupliqués :');
  for (const [key, n] of duplicatedClaims.slice(0, 8)) {
    const [, claim] = key.split('::');
    const name = evidence.find((e) => `${e.company_id}::${String(e.claim).slice(0, 120)}` === key)?.company_name;
    console.log(`    ×${n}  ${name} — ${claim.slice(0, 80)}`);
  }
}

// Preuves contradictoires : deux affirmations opposées sur le même champ.
const byField = new Map();
for (const e of evidence) {
  const key = `${e.company_id}::${e.field}`;
  if (!byField.has(key)) byField.set(key, []);
  byField.get(key).push(e);
}
const contradictory = [...byField.entries()].filter(([, list]) => {
  const claims = new Set(list.map((e) => String(e.claim).slice(0, 100)));
  return claims.size > 1 && list.length > 1;
});
console.log(`  champs à claims divergents   ${contradictory.length}`);

// ── 3. QUALIFICATION ────────────────────────────────────────────────────────
line('3. QUALIFICATION');

const qualified = opportunities.filter((o) => {
  const q = o.qualification ? JSON.parse(o.qualification) : null;
  return q?.verdict === 'qualified';
});
const rejected = opportunities.filter((o) => {
  const q = o.qualification ? JSON.parse(o.qualification) : null;
  return q?.verdict && q.verdict !== 'qualified';
});
const unqualified = opportunities.filter((o) => !o.qualification);

console.log(`  qualifiés                    ${qualified.length}`);
console.log(`  rejetés                      ${rejected.length}`);
console.log(`  jamais qualifiés             ${unqualified.length}`);
for (const o of rejected.slice(0, 6)) {
  const q = JSON.parse(o.qualification);
  console.log(`    ✗ ${o.name} — ${q.verdict} : ${String(q.rationale ?? '').slice(0, 90)}`);
}
console.log(
  `  coût par candidat qualifié   ${qualified.length > 0 ? (cost / qualified.length).toFixed(4) + ' $' : '— (aucun qualifié)'}`,
);

// ── 4. SCORING ──────────────────────────────────────────────────────────────
line('4. SCORING');

const scored = opportunities.filter((o) => o.score !== null);
console.log(`  candidats notés              ${scored.length}`);

let untraceable = 0;
for (const o of scored) {
  const ev = evidence.filter((e) => e.opportunity_id === o.id);
  const detail = o.score_detail ? JSON.parse(o.score_detail) : null;
  const traceable = ev.length > 0;
  if (!traceable) untraceable += 1;
  console.log(`    ${o.name} — ${o.score}/100 · ${ev.length} preuve(s) · rang ${o.rank ?? '-'}`);
  if (detail?.factors) {
    for (const f of detail.factors.slice(0, 3)) {
      console.log(`        ${String(f.label ?? f.name ?? '?').slice(0, 40)} : ${f.score ?? '?'}`);
    }
  }
  if (!traceable) console.log(`        ${'[31m'}aucune preuve rattachée à ce score${'[0m'}`);
}
console.log(`  scores sans preuve           ${untraceable}`);

const ranked = opportunities.filter((o) => o.rank !== null).sort((a, b) => a.rank - b.rank);
if (ranked.length > 0) {
  const monotone = ranked.every((o, i) => i === 0 || (ranked[i - 1].score ?? 0) >= (o.score ?? 0));
  console.log(`  classement cohérent          ${monotone ? 'oui' : 'NON — un rang meilleur a un score plus faible'}`);
}

// ── 5. ÉCONOMIE ─────────────────────────────────────────────────────────────
line('5. ÉCONOMIE');

const inputTokens = calls.reduce((n, c) => n + c.input_tokens, 0);
const outputTokens = calls.reduce((n, c) => n + c.output_tokens, 0);
const pages = tools.filter((t) => t.tool === 'http_fetch' || t.tool === 'fetch_page').length;
const searches = tools.filter((t) => String(t.tool).includes('discover') || String(t.tool).includes('search')).length;

console.log(`  appels LLM                   ${calls.length}`);
console.log(`  jetons entrée / sortie       ${inputTokens} / ${outputTokens}`);
console.log(`  recherches                   ${searches}`);
console.log(`  pages fetchées               ${pages}`);
console.log(`  outils en échec              ${tools.filter((t) => !t.ok).length} / ${tools.length}`);
console.log(`  coût total                   ${cost.toFixed(4)} $`);
console.log(`  coût par candidat            ${opportunities.length ? (cost / opportunities.length).toFixed(4) + ' $' : '—'}`);
console.log(
  `  coût par candidat qualifié   ${qualified.length ? (cost / qualified.length).toFixed(4) + ' $' : '— (aucun qualifié)'}`,
);
console.log(`  coût par preuve              ${evidence.length ? (cost / evidence.length).toFixed(4) + ' $' : '—'}`);

console.log('\n  par étape :');
const byStep = new Map();
for (const c of calls) {
  const k = c.task_ref ?? '(hors étape)';
  const e = byStep.get(k) ?? { calls: 0, cost: 0, input: 0 };
  e.calls += 1;
  e.cost += c.cost_usd || 0;
  e.input += c.input_tokens;
  byStep.set(k, e);
}
for (const [k, e] of [...byStep.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
  console.log(`    ${k.padEnd(16)} ${String(e.calls).padStart(3)} appels  ${e.cost.toFixed(4)} $  ${e.input} jetons entrée`);
}

db.close();
console.log();
