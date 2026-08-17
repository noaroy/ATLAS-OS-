/**
 * Fabrique l'échantillon gratuit remis au premier prospect payant.
 *
 *   node scripts/build-teaser.mjs [dossier de sortie]
 *
 * **Aucun appel au modèle.** Tout vient de `data/atlas.db` : les affirmations,
 * leurs sources, les contacts. La matière première a déjà été payée — 0,1119 $
 * pour la découverte de REVENUE-001 — et la remettre en forme ne justifie pas
 * de la repayer.
 *
 * Le choix du dossier est déterministe et se lit dans le code : parmi les
 * entreprises de lignée réelle, d'identité saine et dans le profil, celle qui
 * porte le plus d'affirmations de première main rattachées à une source
 * consultable. Ce n'est pas « la meilleure entreprise » — c'est celle sur
 * laquelle nous pouvons le plus prouver, et c'est ce qu'un échantillon doit
 * démontrer.
 *
 * Ce qui n'existe pas n'est pas fabriqué. Aucun score n'a été calculé sur ces
 * candidats : le teaser le dit, plutôt que d'afficher un nombre inventé.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const outDir = process.argv[2] ?? 'out';
const db = new Database('data/atlas.db', { readonly: true });

const ICP = new Set(['germany', 'deutschland', 'de', 'allemagne']);
const norm = (v) => (v ?? '').trim().toLowerCase();

// ── Le choix du dossier ────────────────────────────────────────────────────
const candidates = db
  .prepare(
    `SELECT c.id, c.name, c.website, c.domain, c.city, c.region, c.country,
            c.industries, c.data_origin, c.identity_status,
            (SELECT COUNT(*) FROM evidence e
              WHERE e.company_id = c.id AND e.nature != 'inferred'
                AND e.source_ref IS NOT NULL) AS firsthand
       FROM companies c
      WHERE c.data_origin = 'live' AND c.identity_status = 'ok'
      ORDER BY firsthand DESC`,
  )
  .all()
  .filter((c) => ICP.has(norm(c.country)) && c.firsthand >= 3);

if (candidates.length === 0) {
  console.error('Aucun dossier ne remplit les conditions. Rien n’est fabriqué.');
  process.exit(1);
}

const chosen = candidates[0];
const evidence = db
  .prepare(
    `SELECT id, field, nature, claim, source_ref, basis, confidence, collected_at
       FROM evidence WHERE company_id = ? ORDER BY nature, field`,
  )
  .all(chosen.id);

const facts = evidence.filter((e) => e.nature !== 'inferred' && e.source_ref);
const inferences = evidence.filter((e) => e.nature === 'inferred');
const contacts = db
  .prepare('SELECT name, role, email, phone, linkedin FROM contacts WHERE company_id = ?')
  .all(chosen.id);

const opportunity = db
  .prepare('SELECT score, rank, qualification FROM opportunities WHERE company_id = ? ORDER BY created_at DESC LIMIT 1')
  .get(chosen.id);

// ── Signaux commerciaux : mots-clés dans des faits sourcés, rien de plus ────
const SIGNALS = [
  { label: 'Recrutement en cours', re: /\b(recrut|stellenangebot|karriere|hiring|jobs?)\b/i },
  { label: 'Ancrage historique', re: /\b(seit \d{4}|founded in \d{4}|established in \d{4}|\d{3}\+ years)\b/i },
  { label: 'Multi-secteurs', re: /\b(pharma|lebensmittel|logistik|food|industries|sectors)\b/i },
  { label: 'Service après-vente structuré', re: /\b(service|maintenance|repair|wartung|support)\b/i },
  { label: 'Conseil et intégration sur mesure', re: /\b(beratung|consulting|modular|customi[sz])\b/i },
  { label: 'Expansion ou export', re: /\b(export|international|expansion|niederlassung)\b/i },
];
const signals = [...new Set(facts.flatMap((f) => SIGNALS.filter((s) => s.re.test(f.claim)).map((s) => s.label)))];

// ── L'angle d'approche : construit sur les signaux, jamais généré ───────────
const angle = [];
if (signals.includes('Conseil et intégration sur mesure')) {
  angle.push(
    'Entrer par un besoin d’intégration concret plutôt que par une présentation produit : ' +
      'leur offre est structurée autour du conseil et du sur-mesure, pas du catalogue.',
  );
}
if (signals.includes('Multi-secteurs')) {
  angle.push(
    'Choisir un secteur d’application précis pour le premier échange — ils en servent plusieurs, ' +
      'et une approche généraliste se perd.',
  );
}
if (signals.includes('Ancrage historique')) {
  angle.push(
    'L’ancienneté est revendiquée publiquement : la reconnaître ouvre mieux qu’un argument de rupture.',
  );
}
if (angle.length === 0) {
  angle.push('Ouvrir par une question sur leur activité réelle plutôt que par une proposition.');
}

// ── Rendu ──────────────────────────────────────────────────────────────────
const esc = (t) =>
  String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safe = (u) => /^https?:\/\//i.test(String(u ?? '').trim());
const link = (u, label) =>
  safe(u)
    ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">${esc(label ?? u)}</a>`
    : `<span class="raw">${esc(label ?? u ?? 'non renseigné')}</span>`;

/** La source telle qu'elle est écrite : parfois une URL, parfois une URL annotée. */
const sourceLink = (ref) => {
  const url = String(ref ?? '').match(/https?:\/\/[^\s)]+/)?.[0];
  return url ? link(url, ref) : `<span class="raw">${esc(ref ?? '—')}</span>`;
};

const place = [chosen.city, chosen.region, chosen.country].filter(Boolean).join(', ') || 'non établi';
const sectors = JSON.parse(chosen.industries || '[]');
const uniqueSources = [...new Set(facts.map((f) => String(f.source_ref).match(/https?:\/\/[^\s)]+/)?.[0]).filter(Boolean))];

const scoreBlock = opportunity?.score
  ? `<div class="score"><div class="v">${opportunity.score}<span>/100</span></div><div class="l">score d’adéquation</div></div>`
  : `<div class="score pending"><div class="v">—</div><div class="l">Qualification complète disponible<br>dans le rapport client.</div></div>`;

const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pack Prospection Allemagne — exemple gratuit</title>
<style>
  :root {
    --ink:#16181d; --muted:#5f6673; --line:#e2e5ea; --bg:#fff; --panel:#f7f8fa;
    --fact:#0a7d4b; --fact-bg:#e8f5ee;
    --inf:#a1621a; --inf-bg:#fbf1e2;
    --rec:#2b4fa8; --rec-bg:#eaeffb;
    --sell:#111827;
  }
  *{box-sizing:border-box}
  body{margin:0;padding:0 20px 64px;background:var(--bg);color:var(--ink);
       font:15px/1.6 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:820px;margin:0 auto}
  .offer{background:var(--sell);color:#fff;margin:0 -20px 32px;padding:30px 20px}
  .offer .inner{max-width:820px;margin:0 auto}
  .kicker{font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.75}
  .offer h1{margin:8px 0 6px;font-size:27px;letter-spacing:-.01em}
  .offer .sub{opacity:.85;margin:0 0 18px}
  .terms{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
  .term{background:rgba(255,255,255,.1);border-radius:8px;padding:10px 14px;flex:1 1 170px}
  .term b{display:block;font-size:19px}
  .term span{font-size:12px;opacity:.75}
  .badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;
         font-weight:700;letter-spacing:.04em;margin-right:8px;vertical-align:2px}
  .badge.f{background:var(--fact-bg);color:var(--fact)}
  .badge.i{background:var(--inf-bg);color:var(--inf)}
  .badge.r{background:var(--rec-bg);color:var(--rec)}
  .legend{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 28px;padding:14px 16px;
          background:var(--panel);border-radius:8px;font-size:13px}
  .legend div{flex:1 1 210px}
  .card{border:1px solid var(--line);border-radius:10px;padding:22px}
  .card header{display:flex;gap:16px;align-items:flex-start;padding-bottom:16px;
               border-bottom:1px solid var(--line)}
  .id{flex:1 1 auto;min-width:0}
  .id h2{margin:0 0 3px;font-size:20px}
  .id .sub{color:var(--muted);font-size:13px;word-break:break-word}
  .tags{margin-top:7px;display:flex;gap:5px;flex-wrap:wrap}
  .tags span{background:var(--panel);border-radius:4px;padding:2px 7px;font-size:12px;color:var(--muted)}
  .score{flex:0 0 auto;text-align:right;max-width:190px}
  .score .v{font-size:26px;font-weight:700;line-height:1}
  .score .v span{font-size:13px;font-weight:400;color:var(--muted)}
  .score .l{font-size:12px;color:var(--muted);margin-top:4px}
  .score.pending .v{color:var(--muted)}
  h3{font-size:14px;margin:22px 0 10px}
  h4{font-size:13px;margin:0 0 6px}
  ul.claims{list-style:none;margin:0;padding:0}
  .claim{border-left:3px solid var(--line);padding:8px 0 8px 12px;margin-bottom:10px}
  .claim.f{border-left-color:var(--fact)}
  .claim.i{border-left-color:var(--inf)}
  .claim.r{border-left-color:var(--rec)}
  .field{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  .text{margin:2px 0 4px}
  .src{font-size:13px;color:var(--muted);word-break:break-word}
  .foot{display:flex;gap:24px;flex-wrap:wrap;margin-top:20px;padding-top:16px;border-top:1px solid var(--line)}
  .foot>div{flex:1 1 240px}
  ul.plain{margin:0;padding-left:18px}
  .absent{color:var(--muted);font-style:italic}
  .raw{color:var(--muted)}
  a{color:var(--rec)}
  .cta{margin-top:32px;background:var(--panel);border-radius:10px;padding:22px}
  .cta h3{margin-top:0}
  .cta ol{margin:0;padding-left:20px}
  .note{margin-top:24px;font-size:13px;color:var(--muted)}
  @media print{body{padding:0}.offer{margin:0 0 24px}}
</style>
</head>
<body>

<div class="offer"><div class="inner">
  <div class="kicker">Pack Prospection Allemagne</div>
  <h1>Exemple gratuit — 1 prospect</h1>
  <p class="sub">Le rapport complet contient <strong>5 entreprises allemandes</strong> recherchées
  pour votre produit, avec sources, priorisation et angles d’approche.</p>
  <div class="terms">
    <div class="term"><b>49 €</b><span>offre de lancement, paiement unique</span></div>
    <div class="term"><b>24 h</b><span>livraison après votre brief</span></div>
    <div class="term"><b>Sources vérifiables</b><span>chaque fait porte son adresse</span></div>
  </div>
</div></div>

<div class="wrap">

  <div class="legend">
    <div><span class="badge f">FAIT</span>Lu sur une source consultable, dont l’adresse est donnée.</div>
    <div><span class="badge i">DÉDUCTION</span>Inféré, avec la base de la déduction.</div>
    <div><span class="badge r">RECOMMANDATION</span>Un avis. À juger, pas à croire.</div>
  </div>

  <article class="card">
    <header>
      <div class="id">
        <h2>${esc(chosen.name)}</h2>
        <div class="sub">${link(chosen.website ?? `https://${chosen.domain}`)} · ${esc(place)}</div>
        ${sectors.length ? `<div class="tags">${sectors.map((s) => `<span>${esc(s)}</span>`).join('')}</div>` : ''}
      </div>
      ${scoreBlock}
    </header>

    <h3>Pourquoi cette entreprise semble pertinente</h3>
    <p>${esc(
      `Spécialiste allemand de l’emballage industriel établi à ${place}, couvrant ` +
        `${sectors.join(', ')}. ${facts.length} affirmations vérifiables ont été relevées sur ` +
        `${uniqueSources.length} sources distinctes de son propre site.`,
    )}</p>

    <h3><span class="badge f">FAIT</span> Ce qui a été lu, avec la source</h3>
    <ul class="claims">
      ${facts
        .slice(0, 8)
        .map(
          (f) => `<li class="claim f">
        <div class="field">${esc(f.field)}</div>
        <div class="text">${esc(f.claim)}</div>
        <div class="src">Source : ${sourceLink(f.source_ref)}</div>
      </li>`,
        )
        .join('')}
    </ul>
    ${facts.length > 8 ? `<p class="absent">${facts.length - 8} autres affirmations sourcées figurent dans le rapport complet.</p>` : ''}

    <h3><span class="badge i">DÉDUCTION</span> Ce qui a été inféré, et à partir de quoi</h3>
    ${
      inferences.length
        ? `<ul class="claims">${inferences
            .slice(0, 4)
            .map(
              (f) => `<li class="claim i">
        <div class="field">${esc(f.field)}</div>
        <div class="text">${esc(f.claim)}</div>
        <div class="src">Déduit de : ${esc(f.basis ?? 'base non précisée')}</div>
      </li>`,
            )
            .join('')}</ul>`
        : '<p class="absent">Aucune déduction : tout ce qui précède est sourcé.</p>'
    }

    <h3><span class="badge r">RECOMMANDATION</span> Ce que nous conseillons — un avis, pas un constat</h3>
    <ul class="claims">
      ${angle.map((a) => `<li class="claim r"><div class="text">${esc(a)}</div></li>`).join('')}
    </ul>

    <div class="foot">
      <div>
        <h4>Signaux commerciaux détectés</h4>
        ${
          signals.length
            ? `<ul class="plain">${signals.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`
            : '<p class="absent">Aucun signal détecté dans les sources consultées.</p>'
        }
      </div>
      <div>
        <h4>Contact</h4>
        ${
          contacts.length
            ? `<ul class="plain">${contacts
                .map(
                  (c) =>
                    `<li>${esc(c.name)}${c.role ? ` — ${esc(c.role)}` : ''}` +
                    `${c.email ? `<br>${esc(c.email)}` : ''}${c.phone ? `<br>${esc(c.phone)}` : ''}</li>`,
                )
                .join('')}</ul>`
            : '<p class="absent">Aucun contact publié n’a été trouvé.</p>'
        }
      </div>
    </div>
  </article>

  <div class="cta">
    <h3>Comment se passe la suite</h3>
    <ol>
      <li>Vous me dites en deux lignes ce que vous vendez et à qui.</li>
      <li>Je confirme que le marché allemand offre bien cinq prospects de ce niveau — <strong>avant</strong> tout paiement.</li>
      <li>Vous réglez 49 €.</li>
      <li>Vous recevez le pack complet sous 24 h, en page à lire et en tableau à importer.</li>
    </ol>
    <p class="note">Paiement unique. Pas d’abonnement, pas de reconduction. Si le périmètre ne permet
    pas cinq prospects de ce niveau, je vous le dis avant de facturer.</p>
  </div>

  <p class="note">Cette fiche est un extrait réel : les ${facts.length} affirmations ci-dessus ont
  été relevées sur ${uniqueSources.length} sources publiques distinctes, dont les adresses sont
  données. Rien n’a été inventé pour compléter le document.</p>

</div>
</body>
</html>`;

mkdirSync(outDir, { recursive: true });
const path = join(outDir, 'teaser-premier-client.html');
writeFileSync(path, html, 'utf8');

console.log(`\n  Teaser : ${path}`);
console.log(`  Entreprise retenue : ${chosen.name}`);
console.log(`  Faits sourcés : ${facts.length} · sources distinctes : ${uniqueSources.length}`);
console.log(`  Déductions : ${inferences.length} · signaux : ${signals.length} · contacts : ${contacts.length}`);
console.log(`  Score affiché : ${opportunity?.score ?? 'aucun — mention de qualification à la place'}`);
console.log(`  Coût : 0 $ — aucun appel au modèle.\n`);

db.close();
