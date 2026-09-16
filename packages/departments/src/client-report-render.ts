import type { ClientReport, ReportCheck, ReportClaim, ReportProspect, ReportCriterion, ReviewQueueItem } from './client-report.ts';
import { CHANNEL_CONFIDENCE_LABELS, RECOMMENDATION_LABELS } from './client-report.ts';

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


/**
 * Un contrôle de qualification, avec son libellé d'origine quand il a fallu
 * le traduire.
 *
 * Les deux sont affichés, comme pour les preuves : la traduction pour lire, le
 * texte source pour vérifier ce qu'on lit.
 */
const checkHtml = (k: ReportCheck): string => `
  <li class="claim ${k.passed ? 'observed' : 'inferred'}">
    <div class="claim-head">
      <span class="field">${esc(k.criterion)}</span>
      <span class="nature ${k.passed ? 'observed' : 'inferred'}">${k.passed ? 'VÉRIFIÉ' : 'NON VÉRIFIÉ'}</span>
    </div>
    <div class="text">${esc(k.detail)}</div>
    ${
      // Le libellé d'origine n'est PAS affiché ici, contrairement aux preuves.
      //
      // Une preuve citée dans sa langue reste vérifiable : le client la
      // retrouve mot pour mot sur le site. Un contrôle, lui, est la note de
      // l'analyste — il n'a pas de référent externe. L'afficher en allemand
      // ajouterait de la langue étrangère sans rien rendre vérifiable. Il reste
      // dans le modèle et en base, pour la traçabilité.
      ''
    }
    <div class="src">${
      k.evidenceIds.length > 0
        ? `Établi par ${k.evidenceIds.length} preuve(s) citée(s) dans la section Preuves`
        : '<span class="absent">aucune preuve citée</span>'
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
  .badge-warn{font-size:11px;font-weight:700;padding:1px 6px;border-radius:3px;
              background:#fbe9e7;color:#b3261e;margin-left:6px}
  .prov-inline dt{font-weight:700;margin-top:6px}
  .prov-inline dd{margin:0 0 4px 0}
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

  ${statusBanner(report)}

  <h2>Opportunités retenues</h2>
  ${report.prospects.map(prospectHtml).join('\n')}

  ${exclusionsHtml(report)}

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

    ${p.activity ? `<p class="lead">${esc(p.activity)} <span class="absent">(résumé à partir des pages lues)</span></p>` : ''}
    ${synthesisHtml(p)}
    ${criteriaHtml(p)}

    <h4>Ce qui est établi</h4>
    ${
      p.established.length
        ? `<ul class="claims">${p.established.map(checkHtml).join('')}</ul>`
        : '<p class="absent">Aucun contrôle de qualification n’a été rendu.</p>'
    }

    <h4>Ce qui n’est pas établi</h4>
    ${
      p.notEstablished.length
        ? `<ul class="risks">${p.notEstablished.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
           <p class="absent">Ces points ne sont pas des défauts de l’entreprise : ce sont les
           questions qu’un premier échange tranchera. Les écrire évite de croire qu’elles sont
           déjà réglées.</p>`
        : '<p class="absent">Rien de ce que la mission demandait ne reste sans réponse.</p>'
    }

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
    ${p.contactForm ? `<p>Formulaire de contact observé : ${link(p.contactForm)}</p>` : ''}
    ${verificationHtml(p)}
  </article>`;

const synthesisHtml = (p: ReportProspect): string => {
  const s = p.synthesis;
  if (!s) return '';
  return `
    <div class="reco">
      <strong>En bref.</strong>
      ${s.why.length ? `<div><em>Pourquoi pertinente :</em><ul class="claims">${s.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '<div class="absent">Aucun critère établi sur les pages lues.</div>'}
      ${s.toConfirm.length ? `<div><em>À confirmer :</em> ${esc(s.toConfirm.join(', '))}</div>` : ''}
      <div><em>Contact :</em> ${esc(s.contact)}</div>
      ${p.channel && p.channel.method !== 'NONE' ? `<div class="dim-why">${esc(CHANNEL_CONFIDENCE_LABELS[p.channel.confidence] ?? p.channel.confidence)}${p.channel.sourceUrl ? ` · lu sur ${link(p.channel.sourceUrl)}` : ''}</div>` : ''}
      ${s.sources.length ? `<div class="dim-why">Sources : ${s.sources.map((u) => link(u)).join(' · ')}</div>` : ''}
    </div>`;
};

const statusBanner = (report: ClientReport): string => {
  if (!report.status) return '';
  return report.status === 'PARTIAL'
    ? `<div class="reco"><strong>Sélection intermédiaire.</strong> Cette première liste est livrée pour recueillir
       votre retour — sociétés à conserver, à écarter, critères à renforcer — avant la suite de la recherche.
       Elle n’est pas la liste finale.</div>`
    : `<div class="reco"><strong>Rapport final.</strong> La recherche est terminée sur le périmètre convenu.</div>`;
};

const criteriaHtml = (p: ReportProspect): string => {
  if (!p.criteria || p.criteria.length === 0) return '';
  const classe = (v: ReportCriterion['verdict']): string =>
    v === 'ESTABLISHED' ? 'badge-named' : v === 'TO_CONFIRM' ? 'badge-generic' : 'badge-warn';
  return `
    <h4>Vos critères</h4>
    <table>
      <thead><tr><th>Critère</th><th>Verdict</th><th>Ce que le site dit</th></tr></thead>
      <tbody>
        ${p.criteria.map((c) => `<tr>
          <td><strong>${esc(c.label)}</strong><div class="dim-why">${c.kind === 'required' ? 'requis' : c.kind === 'preferred' ? 'souhaité' : 'exclusion'}</div></td>
          <td><span class="${classe(c.verdict)}">${esc(c.verdictLabel)}</span></td>
          <td>${c.quotes.length
            ? c.quotes.map((q) => `<div>« ${esc(q.quote)} »<div class="dim-why">${link(q.url)}</div></div>`).join('')
            : `<div class="dim-why">${esc(c.note || 'les pages lues n’en parlent pas')}</div>`}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
};

const verificationHtml = (p: ReportProspect): string => {
  const v = p.verification;
  if (!v) return '';
  return `
    <h4>Vérification</h4>
    <dl class="prov-inline">
      <dt>Statut</dt><dd><span class="${v.status === 'VERIFIED' ? 'badge-named' : 'badge-generic'}">${esc(v.statusLabel)}</span></dd>
      <dt>Pays</dt><dd>${esc(v.country.value ?? 'non prouvé')}${v.country.quote ? ` — « ${esc(v.country.quote)} » ${link(v.country.url)}` : ''}${v.country.presence ? ` · ${esc(v.country.presence)}` : ''}</dd>
      <dt>Vérifié le</dt><dd>${esc(v.verifiedAt?.slice(0, 10) ?? '—')}</dd>
      ${v.toConfirm.length ? `<dt>À confirmer</dt><dd>${esc(v.toConfirm.join(', '))}</dd>` : ''}
    </dl>`;
};

const exclusionsHtml = (report: ClientReport): string => {
  const ex = report.exclusions ?? [];
  if (ex.length === 0) return '';
  const parCategorie = new Map<string, number>();
  for (const e of ex) parCategorie.set(e.categoryLabel, (parCategorie.get(e.categoryLabel) ?? 0) + 1);
  return `
  <h2>Entreprises écartées</h2>
  <p class="lead">${ex.length} société(s) ou page(s) examinée(s) puis écartée(s) : ${[...parCategorie].map(([k, n]) => `${esc(k)} (${n})`).join(', ')}.</p>
  <p class="absent">Le tri fait partie du travail : une liste courte est une liste où chaque absence a une raison.</p>
  <table>
    <thead><tr><th>Entreprise</th><th>Raison</th><th>Preuve</th></tr></thead>
    <tbody>
      ${ex.filter((e) => e.category !== 'DIRECTORY').map((e) => `<tr>
        <td><strong>${esc(e.company)}</strong><div class="dim-why">${link(e.url)}</div></td>
        <td>${esc(e.categoryLabel)}<div class="dim-why">${esc(e.reason)}</div></td>
        <td>${e.quote ? `« ${esc(e.quote)} »<div class="dim-why">${link(e.quoteUrl)}</div>` : '<span class="absent">—</span>'}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  ${ex.some((e) => e.category === 'DIRECTORY') ? `<p class="absent">${ex.filter((e) => e.category === 'DIRECTORY').length} annuaire(s), réseau(x) social(aux) ou agrégateur(s) écarté(s) d’office : ce ne sont pas des entreprises à contacter.</p>` : ''}`;
};

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

    <h4>Ce qui est établi</h4>
    ${
      p.established.length
        ? `<ul class="claims">${p.established.slice(0, 2).map(checkHtml).join('')}</ul>`
        : '<p class="absent">Aucun contrôle rendu.</p>'
    }

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

  const criteres = report.criteriaLabels ?? [];
  const header = [
    'rang', 'entreprise', 'domaine', 'site', 'pays', 'localisation', 'activite', 'secteurs', 'score_sur_100', 'confiance',
    'ce_qui_est_etabli',
    ...criteres.map((c) => `critere_${c.key}`),
    'ce_qui_n_est_pas_etabli', 'risques', 'recommandation',
    'nb_faits_sources', 'nb_deductions', 'sources',
    'contact_nom', 'contact_role', 'contact_email', 'contact_telephone', 'contact_formulaire', 'contact_nominatif',
    'statut_verification', 'verifie_le',
    'canal_retenu', 'canal_confiance', 'pourquoi_pertinente', 'risque_generaliste',
  ];

  const rows = report.prospects.map((p) => {
    const contact = p.contacts.find((c) => c.named) ?? p.contacts[0] ?? null;
    const critere = (key: string) => {
      const c = p.criteria?.find((x) => x.key === key);
      if (!c) return '';
      const preuve = c.quotes[0] ? ` — « ${c.quotes[0].quote} » (${c.quotes[0].url})` : c.note ? ` — ${c.note}` : '';
      return `${c.verdictLabel}${preuve}`;
    };
    const pourquoi = p.criteria
      ? p.criteria.filter((c) => c.verdict === 'ESTABLISHED').map((c) => `${c.label} : « ${c.quotes[0]?.quote ?? ''} »`).join(' || ')
      : p.established.filter((k) => k.passed).map((k) => `${k.criterion}: ${k.detail}`).join(' || ');
    const domaine = p.website ? p.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] : '';
    return [
      p.rank, p.company, domaine, p.website, p.verification?.country.value ?? '', p.location, p.activity ?? '',
      p.sectors.join(' | '), p.score, p.confidence,
      pourquoi,
      ...criteres.map((c) => critere(c.key)),
      p.verification?.toConfirm.join(' | ') ?? p.notEstablished.join(' || '),
      p.risks.join(' || '), p.recommendation,
      p.facts.length, p.inferences.length,
      [...new Set(p.facts.map((f) => f.sourceRef).filter(Boolean))].join(' | '),
      contact?.name ?? null, contact?.role ?? null, contact?.email ?? null, contact?.phone ?? null,
      p.contactForm ?? '',
      contact ? (contact.named ? 'oui' : 'non') : '',
      p.verification?.statusLabel ?? '', p.verification?.verifiedAt?.slice(0, 10) ?? '',
      p.channel && p.channel.method !== 'NONE' ? `${p.channel.method}: ${p.channel.value ?? ''}` : '',
      p.channel ? (CHANNEL_CONFIDENCE_LABELS[p.channel.confidence] ?? p.channel.confidence) : '',
      p.synthesis?.why.join(' || ') ?? '',
      p.generalistRisk?.score ?? '',
    ].map(cell).join(',');
  });

  // BOM : sans lui, Excel lit l'UTF-8 en ANSI et rend « München » en « MÃ¼nchen ».
  return `﻿${[header.map(cell).join(','), ...rows].join('\r\n')}\r\n`;
}

/** La feuille des écartées : une ligne par société, la raison, la preuve. */
export function exclusionsToCsv(report: ClientReport): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${guarded.replace(/"/g, '""')}"`;
  };
  const header = ['entreprise', 'domaine', 'site', 'categorie', 'raison', 'preuve', 'source_preuve', 'lot'];
  const rows = (report.exclusions ?? []).map((e) =>
    [e.company, e.domain, e.url, e.categoryLabel, e.reason, e.quote ?? '', e.quoteUrl ?? '', e.batch].map(cell).join(','));
  return `﻿${[header.map(cell).join(','), ...rows].join('\r\n')}\r\n`;
}


// ─── La file de revue : trancher vite, sans relire le site ──────────────────

/**
 * Une page pour le fondateur, pas pour le client : les sociétés à revoir,
 * P1 en tête, chacune avec sa raison exacte, deux à cinq preuves, le canal,
 * la recommandation et les deux commandes qui l'appliquent. Cinquante
 * candidats doivent se trancher en moins d'une heure — c'est le but.
 */
export function reviewQueueToHtml(items: readonly ReviewQueueItem[], context: { runId: string; clientName: string; generatedAt: string }): string {
  const parPriorite = (p: ReviewQueueItem['priority']) => items.filter((i) => i.priority === p);
  const badge = (p: ReviewQueueItem['priority']) => `<span class="${p === 'P1' ? 'badge-named' : p === 'P2' ? 'badge-generic' : 'badge-warn'}">${p}</span>`;
  const bloc = (i: ReviewQueueItem, n: number) => `
  <article class="prospect">
    <header>
      <div class="rank">${n}</div>
      <div class="ident">
        <h3>${badge(i.priority)} ${esc(i.company)}</h3>
        <div class="sub">${link(i.url)}${i.country ? ` · ${esc(i.country)}` : ' · pays non prouvé'}${i.generalistRisk !== null ? ` · risque généraliste ${i.generalistRisk}/100` : ''}</div>
      </div>
      <div class="score"><div class="v">${i.score}<span>/100</span></div><div class="c">confiance ${i.confidence.toFixed(2)}${i.evidenceLevel && i.evidenceLevel.level !== 'COMPLETE' ? ` · pertinence ${i.relevance ?? i.score} · preuve ${i.evidenceLevel.level === 'PARTIAL' ? 'partielle' : 'insuffisante'} (${esc(i.evidenceLevel.missing.join(', '))})` : ''}</div></div>
    </header>
    <h4>Pourquoi en revue</h4>
    <ul class="claims">${i.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    ${i.problematicCriteria.length ? `<p><strong>Critères en question :</strong> ${esc(i.problematicCriteria.join(' · '))}</p>` : ''}
    ${i.evidence.length ? `<h4>Ce que les pages disent</h4><ul class="claims">${i.evidence.map((e) => `<li><strong>${esc(e.label)}</strong> — « ${esc(e.quote)} » <span class="dim-why">${link(e.url)}</span></li>`).join('')}</ul>` : '<p class="absent">Aucun passage relu.</p>'}
    <p><strong>Contact :</strong> ${esc(i.contact)}</p>
    <div class="reco"><strong>Recommandation : ${esc(i.recommendationLabel)}.</strong>
      <div class="dim-why">RETAIN : <code>${esc(i.commands.retain)}</code></div>
      <div class="dim-why">EXCLUDE : <code>${esc(i.commands.exclude)}</code></div>
      <div class="dim-why">TO_CONFIRM : laisser telle quelle — la fiche reste marquée « à revoir » dans le rapport.</div>
    </div>
  </article>`;
  let n = 0;
  const body = `
<div class="wrap">
  <h2>File de revue — ${esc(context.clientName)}</h2>
  <p class="lead">${items.length} société(s) à trancher : ${parPriorite('P1').length} P1 (probablement à retenir), ${parPriorite('P2').length} P2 (ambiguës), ${parPriorite('P3').length} P3 (probablement à écarter). Mission ${esc(context.runId)} · ${esc(context.generatedAt.slice(0, 16).replace('T', ' '))}.</p>
  <p class="absent">Document interne. Chaque décision s’applique par une commande ; le rapport client se régénère ensuite.</p>
  ${(['P1', 'P2', 'P3'] as const).map((p) => parPriorite(p).length ? `<h2>${p} — ${p === 'P1' ? 'probablement à retenir' : p === 'P2' ? 'ambiguës' : 'probablement à écarter'}</h2>${parPriorite(p).map((i) => bloc(i, ++n)).join('\n')}` : '').join('\n')}
</div>`;
  return shell(`File de revue — ${context.clientName}`, body);
}

export function reviewQueueToCsv(items: readonly ReviewQueueItem[]): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${guarded.replace(/"/g, '""')}"`;
  };
  const header = ['priorite', 'entreprise', 'domaine', 'site', 'score', 'confiance', 'pays', 'raisons', 'criteres_en_question', 'preuves', 'contact', 'risque_generaliste', 'recommandation', 'commande_retenir', 'commande_ecarter'];
  const rows = items.map((i) => [
    i.priority, i.company, i.domain, i.url, i.score, i.confidence, i.country ?? '',
    i.reasons.join(' || '), i.problematicCriteria.join(' | '),
    i.evidence.map((e) => `${e.label} : « ${e.quote} » (${e.url})`).join(' || '),
    i.contact, i.generalistRisk ?? '', RECOMMENDATION_LABELS[i.recommendation], i.commands.retain, i.commands.exclude,
  ].map(cell).join(','));
  return [header.join(','), ...rows].join('\n');
}
