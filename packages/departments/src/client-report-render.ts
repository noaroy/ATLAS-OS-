import type { ClientReport, ReportClaim, ReportProspect } from './client-report.ts';

/**
 * Le rapport client et son extrait gratuit, rendus depuis le même modèle.
 *
 * Un seul modèle et deux rendus, plutôt que deux documents : le teaser doit
 * montrer la qualité réelle du rapport, et le seul moyen d'en être sûr est
 * qu'il en soit une projection et non une réécriture. Ce qu'il montre est
 * exactement ce que le client recevra, en plus petit.
 *
 * Ce que le teaser retire est déclaré et vérifié par un test : un prospect au
 * lieu de tous, la moitié des faits, ni décomposition du score, ni contacts,
 * ni recommandations détaillées. Il démontre ; il ne livre pas.
 */

const esc = (t: unknown): string =>
  String(t ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Seuls `http` et `https` deviennent cliquables : le fichier s'ouvre chez le client. */
const safe = (url: string | null): boolean => /^https?:\/\//i.test((url ?? '').trim());

const link = (url: string | null, label?: string): string => {
  if (!url) return '<span class="absent">non renseigné</span>';
  const inner = esc(label ?? url);
  if (!safe(url)) return `<span class="raw">${inner}</span>`;
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${inner}</a>`;
};

/** Une adresse peut être annotée : « https://x.de (page Produits) ». */
const sourceLink = (ref: string | null): string => {
  const url = String(ref ?? '').match(/https?:\/\/[^\s)]+/)?.[0] ?? null;
  return url ? link(url, ref ?? undefined) : `<span class="raw">${esc(ref ?? '—')}</span>`;
};

const claimHtml = (claim: ReportClaim): string => `
  <li class="claim ${claim.nature}">
    <div class="claim-head">
      <span class="field">${esc(claim.fieldLabel)}</span>
      <span class="nature ${claim.nature}">${esc(claim.natureLabel)}</span>
    </div>
    <div class="text">${esc(claim.original)}</div>
    ${claim.french ? `<div class="fr">Traduction : ${esc(claim.french)}</div>` : ''}
    <div class="src">${
      claim.sourceRef
        ? `Source : ${sourceLink(claim.sourceRef)}`
        : `Déduit de : ${esc(claim.basis ?? 'base non précisée')}`
    }</div>
  </li>`;

const STYLE = `
  :root{--ink:#16181d;--muted:#5f6673;--line:#e2e5ea;--bg:#fff;--panel:#f7f8fa;
        --obs:#0a7d4b;--obs-bg:#e8f5ee;--rep:#1f6f8b;--rep-bg:#e6f1f5;
        --inf:#a1621a;--inf-bg:#fbf1e2;--accent:#2b4fa8;--dark:#111827}
  *{box-sizing:border-box}
  body{margin:0;padding:0 20px 72px;background:var(--bg);color:var(--ink);
       font:15px/1.65 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:860px;margin:0 auto}
  .cover{background:var(--dark);color:#fff;margin:0 -20px 36px;padding:44px 20px}
  .cover .inner{max-width:860px;margin:0 auto}
  .kicker{font-size:12px;letter-spacing:.14em;text-transform:uppercase;opacity:.7}
  .cover h1{margin:10px 0 4px;font-size:30px;letter-spacing:-.015em;line-height:1.2}
  .cover .market{font-size:17px;opacity:.9;margin:0 0 20px}
  .meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}
  .meta div{background:rgba(255,255,255,.1);border-radius:8px;padding:10px 14px;flex:1 1 150px}
  .meta b{display:block;font-size:18px}
  .meta span{font-size:12px;opacity:.72}
  h2{font-size:19px;margin:38px 0 14px;padding-bottom:8px;border-bottom:2px solid var(--ink)}
  h3{font-size:15px;margin:24px 0 10px}
  h4{font-size:13px;margin:18px 0 7px;color:var(--muted);
     text-transform:uppercase;letter-spacing:.05em}
  .lead{font-size:16px}
  ul.findings{padding-left:20px}
  ul.findings li{margin-bottom:8px}
  .prospect{border:1px solid var(--line);border-radius:10px;padding:24px;margin-bottom:26px;
            page-break-inside:avoid}
  .prospect header{display:flex;gap:16px;align-items:flex-start;
                   padding-bottom:16px;border-bottom:1px solid var(--line)}
  .rank{flex:0 0 36px;height:36px;border-radius:50%;background:var(--ink);color:#fff;
        display:grid;place-items:center;font-weight:700}
  .ident{flex:1 1 auto;min-width:0}
  .ident h3{margin:0 0 3px;font-size:20px}
  .ident .sub{color:var(--muted);font-size:13px;word-break:break-word}
  .tags{margin-top:7px;display:flex;gap:5px;flex-wrap:wrap}
  .tags span{background:var(--panel);border-radius:4px;padding:2px 7px;font-size:12px;color:var(--muted)}
  .score{flex:0 0 auto;text-align:right}
  .score .v{font-size:28px;font-weight:700;line-height:1}
  .score .v span{font-size:13px;font-weight:400;color:var(--muted)}
  .score .c{font-size:12px;color:var(--muted);margin-top:4px}
  table{width:100%;border-collapse:collapse;font-size:14px;margin:4px 0 12px}
  th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.04em;
     color:var(--muted);border-bottom:1px solid var(--line);padding:6px 8px 6px 0;font-weight:600}
  td{padding:8px 8px 8px 0;border-bottom:1px solid var(--line);vertical-align:top}
  td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  .dim-why{color:var(--muted);font-size:13px;margin-top:3px}
  ul.claims{list-style:none;margin:0;padding:0}
  .claim{border-left:3px solid var(--line);padding:9px 0 9px 13px;margin-bottom:11px}
  .claim.observed{border-left-color:var(--obs)}
  .claim.reported{border-left-color:var(--rep)}
  .claim.inferred{border-left-color:var(--inf)}
  .claim-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
  .field{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  .nature{font-size:11px;font-weight:700;padding:1px 6px;border-radius:3px}
  .nature.observed{background:var(--obs-bg);color:var(--obs)}
  .nature.reported{background:var(--rep-bg);color:var(--rep)}
  .nature.inferred{background:var(--inf-bg);color:var(--inf)}
  .text{margin:3px 0 4px}
  .fr{font-size:14px;color:var(--ink);background:var(--panel);border-radius:5px;
      padding:5px 8px;margin:4px 0}
  .src{font-size:13px;color:var(--muted);word-break:break-word}
  ul.risks{padding-left:20px;margin:0}
  ul.risks li{margin-bottom:6px}
  .reco{background:var(--panel);border-left:3px solid var(--accent);
        border-radius:0 6px 6px 0;padding:12px 14px;margin-top:6px}
  .contacts{list-style:none;padding:0;margin:0}
  .contacts li{margin-bottom:8px}
  .badge-named{font-size:11px;font-weight:700;padding:1px 6px;border-radius:3px;
               background:var(--obs-bg);color:var(--obs);margin-left:6px}
  .badge-generic{font-size:11px;font-weight:700;padding:1px 6px;border-radius:3px;
                 background:var(--panel);color:var(--muted);margin-left:6px}
  .absent{color:var(--muted);font-style:italic}
  .raw{color:var(--muted)}
  a{color:var(--accent)}
  .sources{font-size:14px;word-break:break-word}
  .sources li{margin-bottom:5px}
  .prov{background:var(--panel);border-radius:8px;padding:16px 20px;
        font-size:13px;color:var(--muted);margin-top:36px}
  .prov dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0}
  .prov dt{font-weight:600}
  .prov dd{margin:0;word-break:break-word}
  @media print{body{padding:0}.cover{margin:0 0 24px}.prospect{border-color:#ccc}}
`;

const shell = (title: string, body: string): string => `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;

/** Le rapport complet. */
export function reportToHtml(report: ClientReport): string {
  const body = `
<div class="cover"><div class="inner">
  <div class="kicker">Étude de prospection — ${esc(report.clientName)}</div>
  <h1>${esc(report.missionTitle)}</h1>
  <p class="market">${esc(report.market)}</p>
  <div class="meta">
    <div><b>${report.analysedCount}</b><span>entreprises analysées</span></div>
    <div><b>${report.retainedCount}</b><span>retenues</span></div>
    <div><b>${esc(report.generatedAt.slice(0, 10))}</b><span>date de l’étude</span></div>
    <div><b>${report.sources.length}</b><span>sources consultées</span></div>
  </div>
</div></div>

<div class="wrap">

  <h2>Résumé exécutif</h2>
  <h4>Objectif</h4>
  <p class="lead">${esc(report.summary.objective)}</p>
  <h4>Résultat</h4>
  <p class="lead">${esc(report.summary.result)}</p>
  <h4>Principaux enseignements</h4>
  <ul class="findings">${report.summary.findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>

  <h2>Opportunités retenues</h2>
  ${report.prospects.map(prospectHtml).join('\n')}

  ${
    report.limitations.length > 0
      ? `<h2>Ce qui n’a pas été trouvé</h2>
  <ul class="findings">${report.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  <p class="absent">Ces points sont signalés plutôt que comblés : une donnée absente reste absente.</p>`
      : ''
  }

  <h2>Sources consultées</h2>
  <ol class="sources">${report.sources.map((s) => `<li>${link(s)}</li>`).join('')}</ol>

  <h2>Méthode de notation</h2>
  <p>${esc(report.scoringNarrative)}</p>
  <p class="absent">Chaque note est sur 100 et pondérée selon le poids indiqué. La ligne
  « Qualité des preuves » est calculée par la plateforme depuis le registre des sources :
  elle ne peut pas être affirmée par un analyste.</p>

  ${provenanceHtml(report)}

</div>`;
  return shell(`${report.missionTitle} — ${report.clientName}`, body);
}

const prospectHtml = (p: ReportProspect): string => `
  <article class="prospect">
    <header>
      <div class="rank">${p.rank}</div>
      <div class="ident">
        <h3>${esc(p.company)}</h3>
        <div class="sub">${link(p.website)} · ${esc(p.location)}</div>
        ${p.sectors.length ? `<div class="tags">${p.sectors.map((s) => `<span>${esc(s)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="score">
        <div class="v">${p.score}<span>/100</span></div>
        <div class="c">confiance ${p.confidence.toFixed(2)}</div>
      </div>
    </header>

    <h4>Pourquoi cette entreprise</h4>
    <p>${esc(p.whyRelevant)}</p>

    <h4>Risques et incertitudes</h4>
    ${
      p.risks.length
        ? `<ul class="risks">${p.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
        : '<p class="absent">Aucune incertitude notable relevée.</p>'
    }

    <h4>Recommandation</h4>
    <div class="reco">${esc(p.recommendation)}</div>

    <h4>Justification de la note</h4>
    <table>
      <thead><tr><th>Dimension</th><th class="n">Note</th><th class="n">Poids</th><th class="n">Apport</th></tr></thead>
      <tbody>
        ${p.dimensions
          .map(
            (d) => `<tr>
          <td><strong>${esc(d.label)}</strong>
            <div class="dim-why">${esc(d.rationale)}</div>
            <div class="dim-why">${
              d.computed
                ? 'Calculée par la plateforme depuis le registre des preuves.'
                : `${d.evidenceIds.length} preuve(s) citée(s)`
            }</div>
          </td>
          <td class="n">${d.value}</td><td class="n">${d.weight}</td><td class="n">${d.contribution}</td>
        </tr>`,
          )
          .join('')}
      </tbody>
    </table>

    <h4>Preuves</h4>
    ${
      p.facts.length
        ? `<ul class="claims">${p.facts.map(claimHtml).join('')}</ul>`
        : '<p class="absent">Aucune affirmation de première main.</p>'
    }
    ${p.inferences.length ? `<ul class="claims">${p.inferences.map(claimHtml).join('')}</ul>` : ''}

    <h4>Contacts</h4>
    ${
      p.contacts.length
        ? `<ul class="contacts">${p.contacts
            .map(
              (c) => `<li>${esc(c.name)}${c.role ? ` — ${esc(c.role)}` : ''}` +
                `<span class="${c.named ? 'badge-named' : 'badge-generic'}">${
                  c.named ? 'interlocuteur nommé' : 'contact général'
                }</span>` +
                `${c.email ? `<br>${esc(c.email)}` : ''}${c.phone ? `<br>${esc(c.phone)}` : ''}</li>`,
            )
            .join('')}</ul>`
        : '<p class="absent">Aucun contact publié n’a été trouvé.</p>'
    }
  </article>`;

const provenanceHtml = (report: ClientReport): string => {
  const p = report.provenance;
  const e = report.economics;
  return `
  <div class="prov">
    <h4>Traçabilité de cette étude</h4>
    <dl>
      <dt>Mission</dt><dd>${esc(p.missionId)}</dd>
      <dt>Générée le</dt><dd>${esc(p.generatedAt)}</dd>
      <dt>Version du pipeline</dt><dd>${esc(p.pipelineVersion)}</dd>
      <dt>Version de notation</dt><dd>${esc(p.scoringVersion)}</dd>
      <dt>Mode d’exécution</dt><dd>${esc(p.executionMode)}</dd>
      <dt>Preuves citées</dt><dd>${p.evidenceIds.length}</dd>
      <dt>Sources</dt><dd>${p.sources.length}</dd>
      <dt>État</dt><dd>${esc(p.state)}</dd>
      <dt>Relecteur</dt><dd>${esc(p.reviewer ?? 'non relu')}</dd>
      <dt>Approuvée le</dt><dd>${esc(p.approvedAt ?? '—')}</dd>
      ${e ? `<dt>Coût de production</dt><dd>${e.totalCostUsd.toFixed(4)} $</dd>` : ''}
    </dl>
  </div>`;
};

/** Combien de faits le teaser laisse voir. Le reste est dans le rapport. */
export const TEASER_FACT_LIMIT = 4;

/**
 * L'extrait gratuit : un prospect, la moitié de ses faits, aucun contact.
 *
 * Ce qu'il retire est déclaré et vérifié par un test. Un teaser qui montrerait
 * tout supprimerait la raison d'acheter ; un teaser qui montrerait trop peu ne
 * démontrerait rien. La ligne passe ici : la qualité est visible, le volume ne
 * l'est pas.
 */
export function teaserToHtml(report: ClientReport, offer: { priceEur: number; deliveryHours: number }): string {
  const p = report.prospects[0];
  if (!p) {
    return shell(
      'Aucun prospect retenu',
      `<div class="wrap"><h2>Aucun prospect retenu</h2>
       <p>Le périmètre analysé n’a produit aucune entreprise au niveau requis.
       Rien n’est présenté ici : un extrait sans prospect n’aurait rien à démontrer.</p></div>`,
    );
  }

  const shown = p.facts.slice(0, TEASER_FACT_LIMIT);
  const hidden = p.facts.length - shown.length;

  const body = `
<div class="cover"><div class="inner">
  <div class="kicker">${esc(report.missionTitle)}</div>
  <h1>Exemple gratuit — 1 prospect sur ${report.retainedCount}</h1>
  <p class="market">Le rapport complet contient ${report.retainedCount} entreprise(s) analysée(s)
  pour votre marché, avec sources, notation détaillée, contacts et angles d’approche.</p>
  <div class="meta">
    <div><b>${offer.priceEur} €</b><span>offre de lancement, paiement unique</span></div>
    <div><b>${offer.deliveryHours} h</b><span>livraison après votre brief</span></div>
    <div><b>${report.sources.length}</b><span>sources vérifiables</span></div>
  </div>
</div></div>

<div class="wrap">
  <h2>Un prospect, tel qu’il figure dans le rapport</h2>

  <article class="prospect">
    <header>
      <div class="rank">${p.rank}</div>
      <div class="ident">
        <h3>${esc(p.company)}</h3>
        <div class="sub">${link(p.website)} · ${esc(p.location)}</div>
        ${p.sectors.length ? `<div class="tags">${p.sectors.map((s) => `<span>${esc(s)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="score">
        <div class="v">${p.score}<span>/100</span></div>
        <div class="c">confiance ${p.confidence.toFixed(2)}</div>
      </div>
    </header>

    <h4>Pourquoi cette entreprise</h4>
    <p>${esc(p.whyRelevant)}</p>

    <h4>Extrait des preuves</h4>
    <ul class="claims">${shown.map(claimHtml).join('')}</ul>
    ${
      hidden > 0
        ? `<p class="absent">${hidden} autre(s) affirmation(s) sourcée(s) figurent dans le rapport complet,
           avec la décomposition de la note dimension par dimension et les contacts identifiés.</p>`
        : ''
    }
  </article>

  <h2>Comment se passe la suite</h2>
  <ol>
    <li>Vous décrivez en deux lignes ce que vous vendez et à qui.</li>
    <li>Je confirme que le marché offre bien des prospects de ce niveau — <strong>avant</strong> tout paiement.</li>
    <li>Vous réglez ${offer.priceEur} €.</li>
    <li>Vous recevez le rapport complet sous ${offer.deliveryHours} h, en page à lire et en tableau à importer.</li>
  </ol>
  <p class="absent">Paiement unique, sans abonnement. Si le périmètre ne permet pas de produire
  des prospects de ce niveau, je vous le dis avant de facturer.</p>
</div>`;

  return shell(`${report.missionTitle} — extrait gratuit`, body);
}

/** Le tableau à importer dans un CRM. Une ligne par prospect. */
export function reportToCsv(report: ClientReport): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    // Excel exécute toute cellule commençant par `=`, `+`, `-` ou `@`.
    const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${guarded.replace(/"/g, '""')}"`;
  };

  const header = [
    'rang', 'entreprise', 'site', 'localisation', 'secteurs', 'score_sur_100', 'confiance',
    'pourquoi_pertinente', 'risques', 'recommandation',
    'nb_faits_sources', 'nb_deductions', 'sources',
    'contact_nom', 'contact_role', 'contact_email', 'contact_telephone', 'contact_nominatif',
  ];

  const rows = report.prospects.map((p) => {
    const contact = p.contacts.find((c) => c.named) ?? p.contacts[0] ?? null;
    return [
      p.rank, p.company, p.website, p.location, p.sectors.join(' | '), p.score, p.confidence,
      p.whyRelevant, p.risks.join(' || '), p.recommendation,
      p.facts.length, p.inferences.length,
      [...new Set(p.facts.map((f) => f.sourceRef).filter(Boolean))].join(' | '),
      contact?.name ?? null, contact?.role ?? null, contact?.email ?? null, contact?.phone ?? null,
      contact ? (contact.named ? 'oui' : 'non') : '',
    ].map(cell).join(',');
  });

  // BOM : sans lui, Excel lit l'UTF-8 en ANSI et rend « München » en « MÃ¼nchen ».
  return `﻿${[header.map(cell).join(','), ...rows].join('\r\n')}\r\n`;
}
