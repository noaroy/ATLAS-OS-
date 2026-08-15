import type { Department, Mission, MissionEconomics, OpportunityDetail } from '@atlas/contracts';

/**
 * Export commercial d'une shortlist.
 *
 * Deux formats, aucun dépendance ajoutée. Le CSV s'ouvre dans Excel, Numbers et
 * Sheets, et se recharge dans un CRM. Le HTML est mis en page pour être imprimé
 * en PDF depuis le navigateur — ce qui donne un document présentable sans faire
 * entrer un moteur PDF dans le produit pour une seule fonctionnalité.
 *
 * Un point de fond : l'export dit toujours ce qu'il vaut. Une shortlist non
 * revue par un humain, ou produite en simulation, le porte en clair sur le
 * document. Un fichier qui circule sans son contexte finit toujours par être lu
 * comme s'il était définitif.
 */

export interface ExportInput {
  mission: Mission;
  department: Department | null;
  opportunities: OpportunityDetail[];
  economics: MissionEconomics | null;
  /** Vrai lorsque l'inférence était simulée. */
  simulated: boolean;
  generatedAt: string;
}

export interface ExportedFile {
  filename: string;
  mediaType: string;
  content: string;
}

const COLUMNS = [
  'Rang',
  'Entreprise',
  'Pays',
  'Localisation',
  'Site web',
  'Rôles pertinents',
  'Compatibilité par rôle',
  'Score /100',
  'Confiance %',
  'Qualification',
  'Revue',
  'Justification',
  'Preuves principales',
  'Sources',
  'Contact',
  'Statut des données',
] as const;

/** La shortlist en CSV, prête pour Excel ou un CRM. */
export function toCsv(input: ExportInput): ExportedFile {
  const rows = ordered(input.opportunities).map((detail) => {
    const { opportunity: o, company: c } = detail;
    return [
      o.rank !== null ? String(o.rank) : '',
      c.name,
      c.country ?? '',
      [c.city, c.region].filter(Boolean).join(', '),
      c.website ?? '',
      o.targetTypes.join(' + '),
      roleFitSummary(o),
      o.score !== null ? o.score.toFixed(1) : '',
      o.scoreDetail ? String(Math.round(o.scoreDetail.confidence * 100)) : '',
      o.qualification?.verdict ?? 'non qualifié',
      reviewLabel(detail),
      flatten(o.justification ?? ''),
      topEvidence(detail),
      sourcesOf(detail),
      contactOf(detail),
      input.simulated ? 'SIMULÉ — ne pas transmettre' : 'Données réelles',
    ];
  });

  // Le BOM est ce qui fait qu'Excel lit correctement les accents sous Windows ;
  // sans lui, « Düsseldorf » arrive en mojibake chez le client.
  const csv = '﻿' + [COLUMNS, ...rows].map((row) => row.map(escapeCsv).join(';')).join('\r\n');

  return {
    filename: `${slug(input.mission.title)}-shortlist.csv`,
    mediaType: 'text/csv; charset=utf-8',
    content: csv,
  };
}

/** Un document de synthèse, mis en page pour l'impression PDF du navigateur. */
export function toPrintableHtml(input: ExportInput): ExportedFile {
  const list = ordered(input.opportunities);
  const banner = input.simulated
    ? `<p class="alerte">Document produit en mode simulation. Les organisations citées sont fabriquées et ne doivent pas être transmises à un tiers.</p>`
    : unreviewed(list)
      ? `<p class="alerte">Shortlist non encore revue intégralement par le fondateur. À vérifier avant transmission.</p>`
      : '';

  const cards = list
    .map((detail) => {
      const { opportunity: o, company: c } = detail;
      const evidence = detail.evidence
        .slice(0, 6)
        .map(
          (e) =>
            `<li><span class="nature ${e.nature}">${natureLabel(e.nature)}</span> ${escapeHtml(e.claim)}${
              e.sourceRef
                ? ` <a href="${escapeHtml(e.sourceRef)}">${escapeHtml(hostOf(e.sourceRef))}</a>`
                : ''
            } <span class="conf">${Math.round(e.confidence * 100)} %</span></li>`,
        )
        .join('');

      const score = o.scoreDetail
        ? `<table class="score"><tbody>${o.scoreDetail.components
            .map(
              (component) =>
                `<tr><td>${escapeHtml(component.label)}</td><td class="num">${component.value}</td><td class="num">+${component.contribution.toFixed(1)}</td><td class="why">${escapeHtml(component.rationale)}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : '<p class="vide">Non scoré.</p>';

      return `
        <article class="fiche">
          <header>
            <span class="rang">${o.rank !== null ? `#${o.rank}` : '—'}</span>
            <h2>${escapeHtml(c.name)}</h2>
            <p class="meta">${escapeHtml([c.city, c.country].filter(Boolean).join(', ') || 'localisation inconnue')}
              ${c.website ? ` · <a href="${escapeHtml(c.website)}">${escapeHtml(hostOf(c.website))}</a>` : ''}
              · ${escapeHtml(o.targetTypes.join(' + ') || 'rôle non déterminé')}</p>
            <p class="note">${o.score !== null ? o.score.toFixed(1) : '—'}/100
              ${o.scoreDetail ? ` · confiance ${Math.round(o.scoreDetail.confidence * 100)} %` : ''}</p>
          </header>
          ${c.description ? `<p class="desc">${escapeHtml(c.description)}</p>` : ''}
          ${o.justification ? `<p class="justif">${escapeHtml(o.justification).replace(/\n/g, '<br>')}</p>` : ''}
          ${roleFitBlock(o)}
          <h3>Score</h3>
          ${score}
          <h3>Preuves</h3>
          <ul class="preuves">${evidence || '<li class="vide">Aucune preuve enregistrée.</li>'}</ul>
          ${contactBlock(detail)}
          ${reviewBlock(detail)}
        </article>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>${escapeHtml(input.mission.title)} — shortlist</title>
<style>${STYLE}</style></head>
<body>
  <header class="entete">
    <p class="dep">${escapeHtml(input.department?.name ?? 'ATLAS OS')}</p>
    <h1>${escapeHtml(input.mission.title)}</h1>
    <p class="objectif">${escapeHtml(input.mission.objective)}</p>
    ${banner}
  </header>

  <section class="resume">
    <p><strong>${list.length}</strong> candidat(s) retenu(s)${
      input.economics
        ? ` sur ${input.economics.opportunitiesDiscovered} découvert(s) et ${input.economics.opportunitiesQualified} qualifié(s)`
        : ''
    }.</p>
    <p class="date">Généré le ${new Date(input.generatedAt).toLocaleString('fr-FR')} · mission ${escapeHtml(input.mission.code)}</p>
  </section>

  ${cards}

  <footer>
    <p>Chaque affirmation porte sa source et sa nature : <em>constaté</em> (lu à la source citée),
    <em>rapporté</em> (affirmé par un tiers), <em>déduit</em> (conclusion d'ATLAS, jamais présentée comme un fait).</p>
  </footer>
</body></html>`;

  return {
    filename: `${slug(input.mission.title)}-shortlist.html`,
    mediaType: 'text/html; charset=utf-8',
    content: html,
  };
}

// ─── Aides ────────────────────────────────────────────────────────────────

/** La compatibilité par rôle, condensée pour une cellule de tableur. */
function roleFitSummary(opportunity: OpportunityDetail['opportunity']): string {
  const fits = opportunity.scoreDetail?.roleFits ?? [];
  if (fits.length === 0) return '';
  return fits
    .slice()
    .sort((a, b) => b.value - a.value)
    .map((f) => `${f.label} ${f.value}/100`)
    .join(' | ');
}

/**
 * Le bloc « rôles » du rapport.
 *
 * Placé avant le score parce que la première question commerciale n'est pas
 * « quelle note ? » mais « quelle relation proposer ? ».
 */
function roleFitBlock(opportunity: OpportunityDetail['opportunity']): string {
  const fits = [...(opportunity.scoreDetail?.roleFits ?? [])].sort((a, b) => b.value - a.value);
  if (fits.length === 0) {
    return opportunity.targetTypes.length
      ? `<h3>Rôles</h3><p class="desc">${escapeHtml(opportunity.targetTypes.join(', '))} — compatibilité non évaluée séparément.</p>`
      : '';
  }
  const rows = fits
    .map(
      (f) =>
        `<tr><td>${escapeHtml(f.label)}</td><td class="num">${f.value}</td>` +
        `<td class="num">${Math.round(f.confidence * 100)} %</td>` +
        `<td class="why">${escapeHtml(f.rationale)}</td></tr>`,
    )
    .join('');
  return `<h3>Rôles pertinents</h3><table class="score"><tbody>${rows}</tbody></table>`;
}

const ordered = (details: OpportunityDetail[]): OpportunityDetail[] =>
  [...details].sort((a, b) => {
    const rankA = a.opportunity.rank ?? Number.MAX_SAFE_INTEGER;
    const rankB = b.opportunity.rank ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return (b.opportunity.score ?? 0) - (a.opportunity.score ?? 0);
  });

const unreviewed = (details: OpportunityDetail[]): boolean =>
  details.some((d) => d.opportunity.review?.decision !== 'approved');

function reviewLabel(detail: OpportunityDetail): string {
  const review = detail.opportunity.review;
  if (!review) return 'non revu';
  if (review.decision === 'approved') return `approuvé par ${review.reviewedBy}`;
  if (review.decision === 'rejected') return `rejeté par ${review.reviewedBy}`;
  return `lu par ${review.reviewedBy}`;
}

/** Les preuves qui portent le plus : constatées d'abord, puis les mieux notées. */
function topEvidence(detail: OpportunityDetail): string {
  const order = { observed: 0, reported: 1, inferred: 2 } as const;
  return [...detail.evidence]
    .sort((a, b) => order[a.nature] - order[b.nature] || b.confidence - a.confidence)
    .slice(0, 3)
    .map((e) => `[${natureLabel(e.nature)}] ${flatten(e.claim)}`)
    .join(' | ');
}

const sourcesOf = (detail: OpportunityDetail): string =>
  [...new Set(detail.evidence.map((e) => e.sourceRef).filter(Boolean))].slice(0, 4).join(' | ');

function contactOf(detail: OpportunityDetail): string {
  const contact = detail.contacts.find((c) => c.email) ?? detail.contacts[0];
  if (!contact) return '';
  return [contact.email, contact.phone].filter(Boolean).join(' / ');
}

function contactBlock(detail: OpportunityDetail): string {
  if (detail.contacts.length === 0) {
    return '<h3>Contact</h3><p class="vide">Aucune coordonnée publique trouvée.</p>';
  }
  const items = detail.contacts
    .slice(0, 4)
    .map(
      (c) =>
        `<li>${escapeHtml([c.email, c.phone].filter(Boolean).join(' · ') || c.name)}
          <span class="conf">${Math.round(c.confidence * 100)} %</span></li>`,
    )
    .join('');
  return `<h3>Contact</h3><ul class="contacts">${items}</ul>`;
}

function reviewBlock(detail: OpportunityDetail): string {
  const review = detail.opportunity.review;
  if (!review) return '<p class="revue attente">Non revu par le fondateur.</p>';
  const label =
    review.decision === 'approved' ? 'Approuvé' : review.decision === 'rejected' ? 'Rejeté' : 'Lu';
  return `<p class="revue ${review.decision}">${label} par ${escapeHtml(review.reviewedBy)}${
    review.note ? ` — ${escapeHtml(review.note)}` : ''
  }</p>`;
}

const natureLabel = (nature: string): string =>
  nature === 'observed' ? 'constaté' : nature === 'reported' ? 'rapporté' : 'déduit';

function escapeCsv(value: string): string {
  const text = value ?? '';
  // Un champ commençant par =, +, - ou @ est interprété comme une formule par
  // Excel ; le préfixer d'une apostrophe neutralise l'injection.
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[";\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim();

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const slug = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'shortlist';

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #14181f;
         max-width: 900px; margin: 0 auto; padding: 32px 24px; background: #fff; }
  h1 { font-size: 22pt; margin: 4px 0 8px; }
  h2 { font-size: 13pt; margin: 0; display: inline; }
  h3 { font-size: 9pt; text-transform: uppercase; letter-spacing: .08em; color: #6b7684;
       margin: 14px 0 6px; }
  .entete { border-bottom: 2px solid #14181f; padding-bottom: 14px; margin-bottom: 20px; }
  .dep { font-size: 9pt; text-transform: uppercase; letter-spacing: .12em; color: #6b7684; margin: 0; }
  .objectif { color: #414b59; margin: 6px 0 0; }
  .alerte { background: #fff4e5; border-left: 3px solid #d97706; padding: 8px 12px;
            margin: 12px 0 0; font-size: 9.5pt; }
  .resume { margin-bottom: 24px; }
  .resume p { margin: 2px 0; }
  .date { color: #6b7684; font-size: 9pt; }
  .fiche { border: 1px solid #e3e7ec; border-radius: 6px; padding: 16px 18px; margin-bottom: 14px;
           break-inside: avoid; page-break-inside: avoid; }
  .rang { font-weight: 700; color: #6b7684; margin-right: 8px; }
  .meta { color: #6b7684; font-size: 9.5pt; margin: 4px 0 0; }
  .note { font-weight: 700; margin: 6px 0 0; }
  .desc { margin: 8px 0 0; color: #414b59; }
  .justif { margin: 8px 0 0; white-space: pre-line; }
  table.score { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  table.score td { border-bottom: 1px solid #eef1f4; padding: 3px 6px; vertical-align: top; }
  table.score .num { text-align: right; white-space: nowrap; width: 60px; }
  table.score .why { color: #6b7684; }
  ul { margin: 0; padding-left: 18px; }
  .preuves li, .contacts li { margin-bottom: 3px; font-size: 9.5pt; }
  .nature { font-size: 8pt; text-transform: uppercase; letter-spacing: .06em; padding: 1px 5px;
            border-radius: 3px; margin-right: 4px; }
  .nature.observed { background: #dcfce7; color: #166534; }
  .nature.reported { background: #dbeafe; color: #1e40af; }
  .nature.inferred { background: #fef3c7; color: #92400e; }
  .conf { color: #6b7684; font-size: 8.5pt; }
  .vide { color: #97a1ad; font-style: italic; margin: 0; }
  .revue { margin: 12px 0 0; font-size: 9.5pt; padding: 5px 9px; border-radius: 4px; }
  .revue.approved { background: #dcfce7; color: #166534; }
  .revue.rejected { background: #fee2e2; color: #991b1b; }
  .revue.attente, .revue.pending { background: #f3f4f6; color: #4b5563; }
  a { color: #1d4ed8; }
  footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #e3e7ec;
           color: #6b7684; font-size: 9pt; }
  @media print { body { padding: 0; } .fiche { border-color: #ccd2da; } }
`;
