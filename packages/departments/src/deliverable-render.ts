import type { Pack, PackClaim, PackProspect } from './deliverable.ts';

/**
 * Les deux formats remis au client : une page à lire, un tableau à exploiter.
 *
 * Aucun des deux ne réutilise l'interface d'ATLAS. Le client n'achète pas un
 * accès à l'outil, il achète un document ; et un document qui exige d'ouvrir
 * une application pour être lu n'est pas un document.
 *
 * Le HTML est autonome — styles compris, aucune ressource externe. Il doit
 * s'ouvrir depuis une pièce jointe, hors ligne, sur un poste qui n'a jamais
 * entendu parler d'ATLAS.
 */

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Une adresse qu'on accepte de rendre cliquable.
 *
 * Seuls `http` et `https` : un `javascript:` glissé dans une référence de
 * source deviendrait exécutable chez le client, à l'ouverture d'un fichier
 * qu'il nous a payé. Le reste est affiché en texte, ce qui reste lisible sans
 * rien engager.
 */
const isSafeUrl = (url: string): boolean => /^https?:\/\//i.test(url.trim());

const link = (url: string | null, label?: string): string => {
  if (!url) return '<span class="absent">non renseigné</span>';
  const text = escapeHtml(label ?? url);
  if (!isSafeUrl(url)) return `<span class="raw">${text}</span>`;
  return `<a href="${escapeHtml(url)}" rel="noopener noreferrer nofollow" target="_blank">${text}</a>`;
};

const claimHtml = (claim: PackClaim, kind: 'fact' | 'inference'): string => {
  const support =
    kind === 'fact'
      ? `<div class="support">Source : ${link(claim.sourceRef, claim.sourceTitle ?? claim.sourceRef ?? undefined)}</div>`
      : `<div class="support">Déduit de : ${escapeHtml(claim.basis ?? 'base non précisée')}</div>`;
  return `
      <li class="claim ${kind}">
        <div class="claim-field">${escapeHtml(claim.field)}</div>
        <div class="claim-text">${escapeHtml(claim.text)}</div>
        ${support}
        <div class="meta">confiance ${claim.confidence.toFixed(2)} · relevé le ${escapeHtml(claim.collectedAt.slice(0, 10))}</div>
      </li>`;
};

const prospectHtml = (p: PackProspect, index: number): string => {
  const contact = p.contact
    ? p.contact.name
      ? `${escapeHtml(p.contact.name)}${p.contact.role ? ` — ${escapeHtml(p.contact.role)}` : ''}` +
        `${p.contact.email ? `<br>${escapeHtml(p.contact.email)}` : ''}` +
        `${p.contact.phone ? `<br>${escapeHtml(p.contact.phone)}` : ''}`
      : `Page de contact : ${link(p.contact.contactPage)}`
    : '<span class="absent">aucun contact trouvé</span>';

  return `
  <article class="prospect">
    <header>
      <div class="rank">${p.rank ?? index + 1}</div>
      <div class="identity">
        <h2>${escapeHtml(p.company)}</h2>
        <div class="sub">${link(p.website)} · ${escapeHtml(p.location)}</div>
        ${p.sector.length > 0 ? `<div class="tags">${p.sector.map((s) => `<span>${escapeHtml(s)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="score">
        <div class="score-value">${p.score ?? '—'}<span>/100</span></div>
        <div class="score-label">${p.confidence !== null ? `confiance ${p.confidence.toFixed(2)}` : 'confiance non mesurée'}</div>
      </div>
    </header>

    <section class="why">
      <h3>Pourquoi ce prospect correspond à la cible</h3>
      <p>${escapeHtml(p.whyItMatches)}</p>
      ${p.roles.length > 0 ? `<p class="roles">Rôles retenus : ${p.roles.map((r) => escapeHtml(r)).join(', ')}</p>` : ''}
    </section>

    <section class="block fact-block">
      <h3><span class="badge fact">FAIT</span> Ce qui a été lu, avec la source</h3>
      ${
        p.facts.length > 0
          ? `<ul class="claims">${p.facts.map((c) => claimHtml(c, 'fact')).join('')}</ul>`
          : '<p class="absent">Aucune affirmation de première main.</p>'
      }
    </section>

    <section class="block inference-block">
      <h3><span class="badge inference">DÉDUCTION</span> Ce qu’ATLAS a inféré, et à partir de quoi</h3>
      ${
        p.inferences.length > 0
          ? `<ul class="claims">${p.inferences.map((c) => claimHtml(c, 'inference')).join('')}</ul>`
          : '<p class="absent">Aucune déduction.</p>'
      }
    </section>

    <section class="block reco-block">
      <h3><span class="badge reco">RECOMMANDATION</span> Ce qu’ATLAS conseille — un avis, pas un constat</h3>
      <ul class="claims">
        ${p.recommendations
          .map(
            (r) => `
        <li class="claim reco">
          <div class="claim-text">${escapeHtml(r.text)}</div>
          <div class="support">Fondé sur : ${escapeHtml(r.because)}</div>
        </li>`,
          )
          .join('')}
      </ul>
    </section>

    <section class="foot">
      <div>
        <h4>Signaux commerciaux détectés</h4>
        ${
          p.signals.length > 0
            ? `<ul class="signals">${p.signals.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`
            : '<p class="absent">Aucun signal détecté dans les sources consultées.</p>'
        }
      </div>
      <div>
        <h4>Contact</h4>
        <p>${contact}</p>
      </div>
    </section>
  </article>`;
};

/** La page complète, autonome et lisible hors ligne. */
export function packToHtml(pack: Pack): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pack.title)}</title>
<style>
  :root {
    --ink: #16181d; --muted: #5f6673; --line: #e2e5ea; --bg: #ffffff; --panel: #f7f8fa;
    --fact: #0a7d4b; --fact-bg: #e8f5ee;
    --inference: #a1621a; --inference-bg: #fbf1e2;
    --reco: #2b4fa8; --reco-bg: #eaeffb;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 64px; background: var(--bg); color: var(--ink);
         font: 15px/1.6 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; }
  .cover { border-bottom: 2px solid var(--ink); padding-bottom: 20px; margin-bottom: 12px; }
  .cover h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.01em; }
  .cover .brief { color: var(--muted); margin: 8px 0 0; }
  .cover .date { color: var(--muted); font-size: 13px; margin-top: 10px; }
  .legend { display: flex; gap: 8px; flex-wrap: wrap; margin: 20px 0 32px;
            padding: 14px 16px; background: var(--panel); border-radius: 8px; font-size: 13px; }
  .legend div { flex: 1 1 200px; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px;
           font-weight: 700; letter-spacing: 0.04em; margin-right: 8px; vertical-align: 2px; }
  .badge.fact { background: var(--fact-bg); color: var(--fact); }
  .badge.inference { background: var(--inference-bg); color: var(--inference); }
  .badge.reco { background: var(--reco-bg); color: var(--reco); }
  .prospect { border: 1px solid var(--line); border-radius: 10px; padding: 22px;
              margin-bottom: 24px; page-break-inside: avoid; }
  .prospect header { display: flex; gap: 16px; align-items: flex-start;
                     padding-bottom: 16px; border-bottom: 1px solid var(--line); }
  .rank { flex: 0 0 34px; height: 34px; border-radius: 50%; background: var(--ink); color: #fff;
          display: grid; place-items: center; font-weight: 700; font-size: 15px; }
  .identity { flex: 1 1 auto; min-width: 0; }
  .identity h2 { margin: 0 0 3px; font-size: 19px; }
  .sub { color: var(--muted); font-size: 13px; word-break: break-word; }
  .tags { margin-top: 7px; display: flex; gap: 5px; flex-wrap: wrap; }
  .tags span { background: var(--panel); border-radius: 4px; padding: 2px 7px; font-size: 12px; color: var(--muted); }
  .score { flex: 0 0 auto; text-align: right; }
  .score-value { font-size: 25px; font-weight: 700; line-height: 1; }
  .score-value span { font-size: 13px; font-weight: 400; color: var(--muted); }
  .score-label { font-size: 12px; color: var(--muted); margin-top: 4px; }
  h3 { font-size: 14px; margin: 20px 0 10px; }
  h4 { font-size: 13px; margin: 0 0 6px; }
  .why p { margin: 0 0 6px; }
  .roles { color: var(--muted); font-size: 13px; }
  .claims { list-style: none; margin: 0; padding: 0; }
  .claim { border-left: 3px solid var(--line); padding: 8px 0 8px 12px; margin-bottom: 10px; }
  .claim.fact { border-left-color: var(--fact); }
  .claim.inference { border-left-color: var(--inference); }
  .claim.reco { border-left-color: var(--reco); }
  .claim-field { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
  .claim-text { margin: 2px 0 4px; }
  .support { font-size: 13px; color: var(--muted); word-break: break-word; }
  .meta { font-size: 12px; color: var(--muted); margin-top: 3px; }
  .foot { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 20px;
          padding-top: 16px; border-top: 1px solid var(--line); }
  .foot > div { flex: 1 1 240px; }
  .signals { margin: 0; padding-left: 18px; }
  .absent { color: var(--muted); font-style: italic; }
  .raw { color: var(--muted); }
  a { color: var(--reco); }
  .limits { background: var(--panel); border-radius: 8px; padding: 16px 20px; margin-top: 32px; }
  .limits h3 { margin-top: 0; }
  .limits ul { margin: 0; padding-left: 18px; color: var(--muted); font-size: 14px; }
  @media print { body { padding: 0; } .prospect { border-color: #ccc; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="cover">
    <h1>${escapeHtml(pack.title)}</h1>
    <p class="brief">${escapeHtml(pack.brief)}</p>
    <p class="date">Recherche effectuée le ${escapeHtml(pack.generatedAt.slice(0, 10))} · ${pack.prospects.length} prospect(s)</p>
  </div>

  <div class="legend">
    <div><span class="badge fact">FAIT</span>Lu sur une source consultable, dont l’adresse est donnée.</div>
    <div><span class="badge inference">DÉDUCTION</span>Inféré par ATLAS, avec la base de la déduction.</div>
    <div><span class="badge reco">RECOMMANDATION</span>Un avis d’ATLAS. À juger, pas à croire.</div>
  </div>

  ${pack.prospects.map(prospectHtml).join('\n')}

  ${
    pack.limitations.length > 0
      ? `<div class="limits">
    <h3>Ce qui n’a pas été trouvé</h3>
    <ul>${pack.limitations.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
  </div>`
      : ''
  }
</div>
</body>
</html>`;
}

/**
 * Une cellule sûre à ouvrir dans un tableur.
 *
 * Excel et LibreOffice interprètent comme formule toute cellule commençant par
 * `=`, `+`, `-` ou `@`. Un nom d'entreprise ou une affirmation venue du web
 * peut commencer par l'un d'eux — et le fichier est destiné à être ouvert par
 * un client, sur son poste. Le préfixe apostrophe neutralise l'interprétation
 * sans altérer ce qui s'affiche.
 */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * Le tableau exploitable.
 *
 * Une ligne par prospect, colonnes stables. Les faits et les déductions y sont
 * comptés et concaténés plutôt que détaillés : le CSV sert à trier, filtrer et
 * importer dans un CRM, pas à lire — c'est le HTML qui porte la lecture. Mais
 * les colonnes restent séparées par nature, pour qu'un import ne mélange jamais
 * ce qui est établi et ce qui est supposé.
 */
export function packToCsv(pack: Pack): string {
  const header = [
    'rang',
    'entreprise',
    'site',
    'secteur',
    'localisation',
    'roles',
    'score_sur_100',
    'confiance',
    'pourquoi_correspond',
    'nb_faits',
    'faits',
    'sources',
    'nb_deductions',
    'deductions',
    'signaux',
    'contact_nom',
    'contact_role',
    'contact_email',
    'contact_telephone',
    'page_contact',
    'recommandation_angle',
  ];

  const rows = pack.prospects.map((p, i) =>
    [
      p.rank ?? i + 1,
      p.company,
      p.website,
      p.sector.join(' | '),
      p.location,
      p.roles.join(' | '),
      p.score,
      p.confidence,
      p.whyItMatches,
      p.facts.length,
      p.facts.map((f) => `${f.field}: ${f.text}`).join(' || '),
      p.facts.map((f) => f.sourceRef).filter(Boolean).join(' | '),
      p.inferences.length,
      p.inferences.map((f) => `${f.field}: ${f.text}`).join(' || '),
      p.signals.join(' | '),
      p.contact?.name ?? null,
      p.contact?.role ?? null,
      p.contact?.email ?? null,
      p.contact?.phone ?? null,
      p.contact?.contactPage ?? null,
      p.approachAngle,
    ]
      .map(csvCell)
      .join(','),
  );

  // BOM : sans lui, Excel lit un CSV UTF-8 en ANSI et rend « München » en
  // « MÃ¼nchen » — sur un livrable allemand, dès la première ligne.
  return `﻿${[header.map(csvCell).join(','), ...rows].join('\r\n')}\r\n`;
}
