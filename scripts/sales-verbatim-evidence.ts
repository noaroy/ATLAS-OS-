/**
 * Reprendre un prospect en citant sa page, au lieu de la résumer.
 *
 * La qualification du lot ne reçoit que l'extrait rendu par le moteur de
 * recherche — jamais la page. On lui demandait donc de produire des « faits
 * observés » sur un texte qu'elle n'avait pas lu, et elle rendait ce qu'elle
 * pouvait : des reformulations. « Asytec propose du sous-traitance industrielle
 * low-cost » est juste, et introuvable sur asytec.fr. La vérification la
 * rejetait à 50 %, il ne restait rien à citer, et huit PRIORITY n'ont produit
 * aucun brouillon.
 *
 * Ce script fait l'inverse : il lit d'abord, découpe la page en passages
 * numérotés, et ne demande au modèle qu'un NUMÉRO. La citation est ensuite
 * relue dans la page, à ce numéro. Ce qu'un modèle ne peut pas écrire, il ne
 * peut pas l'inventer.
 *
 *   npm run sales:verbatim -- harmony-beton.com asytec.fr
 *   npm run sales:verbatim -- --dry-run harmony-beton.com
 */
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, loadAtlasEnv } from '../packages/core/src/index.ts';
import { fetchRawPages } from '../packages/intelligence/src/contact-fetch.ts';
import { textOf, type LlmRequest } from '../packages/llm/src/index.ts';
import {
  buildBlockCatalogue, resolveSelections, INTERPRETATION_PREFIX,
  VERBATIM_SYSTEM, VERBATIM_SCHEMA,
  distinctCommercialFacts, MIN_COMMERCIAL_FACTS, buildOutreachDraft,
  countryFit, ATLAS_SALES_ICP, looksMultinational,
  type BlockSelection, type OutreachFact,
} from '../packages/departments/src/index.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m',
};

const DRY = process.argv.includes('--dry-run');
const cibles = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (cibles.length === 0) {
  console.error('  nommez au moins un domaine.');
  process.exit(2);
}

const config = loadConfig(process.cwd());
const system = createSystem(config);
const { repos } = system;
const MODEL = 'claude-haiku-4-5-20251001';

const SENT_AVANT = repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z');

const mission = repos.missions.create({
  title: 'Preuves verbatim par bloc source',
  objective: 'Citer les pages au lieu de les résumer, sur des prospects déjà collectés.',
  context: { executionMode: 'live', preset: 'VERBATIM-001' },
  createdBy: 'sales-verbatim-evidence',
  tokenBudget: 30_000,
});

const tous = repos.sales.batchIds().flatMap((b) => repos.sales.forBatch(b));
let cout = 0;

for (const domaine of cibles) {
  const p = tous.filter((x) => x.domain === domaine)
    .sort((a, b) => (a.discoveredAt < b.discoveredAt ? 1 : -1))[0];
  if (!p) { console.log(`\n  ${c.red}${domaine} — absent de la base${c.reset}`); continue; }

  console.log(`\n  ${c.bold}${p.companyName.slice(0, 44)}${c.reset}  ${c.dim}${domaine} · score ${p.score} · ${p.tier}${c.reset}`);

  // ── Le profil, avant toute dépense ──────────────────────────────────────
  const pays = countryFit(p.country, ATLAS_SALES_ICP.countries);
  const urlsConnues = [p.website, p.contactSourceUrl, p.contactPage,
    ...repos.sales.evidenceFor(p.id).map((e) => e.sourceUrl)]
    .filter((u): u is string => Boolean(u));
  if (pays.fit === 'OUT_OF_SCOPE' || looksMultinational(urlsConnues)) {
    console.log(`    ${c.amber}hors ICP${c.reset} ${c.dim}${pays.fit === 'OUT_OF_SCOPE' ? pays.reason : 'site multi-pays'} — dossier conservé, aucun brouillon${c.reset}`);
    continue;
  }

  // ── Les pages, relues une fois ──────────────────────────────────────────
  const aLire = [...new Set([p.website ?? `https://${domaine}`, ...urlsConnues])].slice(0, 4);
  const out = await fetchRawPages(aLire, { logger: system.logger, timeoutMs: 12_000, maxPages: 3 });
  if (out.pages.length === 0) {
    console.log(`    ${c.red}aucune page lisible${c.reset}`);
    continue;
  }

  const catalogue = buildBlockCatalogue(out.pages);

  console.log(`    ${c.dim}${out.pages.length} page(s) · ${catalogue.size} passage(s) proposés${c.reset}`);
  if (catalogue.size === 0) { console.log(`    ${c.red}aucun passage citable${c.reset}`); continue; }

  if (DRY) {
    console.log(`    ${c.dim}dry run : aucun appel modèle, aucune écriture${c.reset}`);
    continue;
  }

  // ── Le modèle choisit des numéros, jamais des phrases ───────────────────
  const request: LlmRequest = {
    model: MODEL,
    system: VERBATIM_SYSTEM,
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: `# Entreprise\n${p.companyName}\n${p.website ?? domaine}\n\n# Passages${catalogue.text}`,
      }],
    }],
    jsonSchema: VERBATIM_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1200,
    meta: {
      missionId: mission.id, taskRef: 'verbatim-evidence', agentKey: 'ambassador',
      purpose: 'sales-verbatim-evidence', subject: p.id, evidenceCount: null,
    },
  };

  let selections: BlockSelection[] = [];
  try {
    const response = await system.provider.complete(request);
    const brut = textOf(response.content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const a = brut.indexOf('{');
    const b = brut.lastIndexOf('}');
    if (a >= 0 && b > a) {
      selections = (JSON.parse(brut.slice(a, b + 1)) as { selections?: BlockSelection[] }).selections ?? [];
    }
  } catch (err) {
    console.log(`    ${c.red}sélection impossible${c.reset} ${(err as Error).message.slice(0, 60)}`);
    continue;
  }

  // ── Chaque numéro est relu dans la page ─────────────────────────────────
  const { evidence: preuves, rejected } = resolveSelections(selections, catalogue);
  for (const r of rejected) console.log(`    ${c.red}refusé${c.reset} ${c.dim}${r.slice(0, 70)}${c.reset}`);

  const commerciaux = distinctCommercialFacts(preuves);
  console.log(`    ${c.dim}${selections.length} sélection(s) · ${preuves.length} vérifiée(s) · ${commerciaux.length} fait(s) commercial(aux) distinct(s)${c.reset}`);
  for (const f of commerciaux) {
    console.log(`      ${c.green}·${c.reset} ${f.normalizedClaim.slice(0, 62)}`);
    console.log(`        ${c.dim}« ${f.evidenceQuote.slice(0, 88)} »${c.reset}`);
    console.log(`        ${c.dim}${f.sourceUrl}${c.reset}`);
  }

  if (commerciaux.length < MIN_COMMERCIAL_FACTS) {
    console.log(`    ${c.amber}${commerciaux.length}/${MIN_COMMERCIAL_FACTS} fait(s) — aucun brouillon${c.reset}`);
    continue;
  }

  // ── Écriture : les preuves, puis le brouillon ───────────────────────────
  const dejaEcrites = new Set(repos.sales.evidenceFor(p.id).map((e) => e.claim.trim()));
  const ids: string[] = [];
  for (const f of commerciaux) {
    if (dejaEcrites.has(f.evidenceQuote.trim())) {
      const existante = repos.sales.evidenceFor(p.id).find((e) => e.claim.trim() === f.evidenceQuote.trim());
      if (existante) ids.push(existante.id);
      continue;
    }
    const e = repos.sales.addEvidence({
      prospectId: p.id,
      field: `verbatim:${f.blockId}`,
      // Le `claim` est la citation exacte : c'est lui que le message reprend.
      claim: f.evidenceQuote,
      nature: 'observed',
      sourceUrl: f.sourceUrl,
      // L'interpretation vit dans la base, a cote de la preuve, sans jamais
      // se faire passer pour elle.
      basis: `${INTERPRETATION_PREFIX}${f.normalizedClaim}${f.sourcePageTitle ? ` — page « ${f.sourcePageTitle} »` : ''}`,
      confidence: 0.9,
    });
    ids.push(e.id);
  }

  const facts: OutreachFact[] = commerciaux.map((f, i) => ({
    evidenceId: ids[i] ?? '', claim: f.evidenceQuote, sourceUrl: f.sourceUrl, nature: 'observed' as const,
  }));

  const draft = buildOutreachDraft({
    company: p.companyName, website: p.website, facts,
    contact: p.contactEmail || p.contactPhone || p.contactPage
      ? {
          name: p.contactName, role: p.contactRole, email: p.contactEmail,
          phone: p.contactPhone, contactPage: p.contactPage, sourceUrl: p.contactSourceUrl,
          confidence: p.contactConfidence ?? 0.5, named: Boolean(p.contactName?.trim()),
        }
      : null,
    whyThisCompany: p.whyFit ?? '', senderName: config.sales.senderName,
    offer: { priceEur: 49, deliveryHours: 24 },
  });

  if (!draft.draft) {
    console.log(`    ${c.amber}rédaction refusée${c.reset} ${c.dim}${draft.reason.slice(0, 70)}${c.reset}`);
    continue;
  }

  repos.sales.setOutreach(p.id, {
    personalizationFactId: draft.draft.personalizationFact.evidenceId,
    messageShort: draft.draft.messageShort,
    messageEmail: draft.draft.messageEmail,
    sourceUrl: draft.draft.sourceUsedForPersonalization,
  });
  // L'objet a une seule origine : le brouillon, donc les mots exacts de la source.
  repos.sales.reviseOutreachText(p.id, { subject: draft.draft.subject });
  if (p.state !== 'READY_FOR_REVIEW') repos.sales.setState(p.id, 'READY_FOR_REVIEW');
  console.log(`    ${c.green}${c.bold}READY_FOR_REVIEW${c.reset} ${c.dim}${draft.draft.messageEmail.length} caractères${c.reset}`);
}

cout = repos.llmCalls.forMission(mission.id).reduce((a, k) => a + (k.costUsd ?? 0), 0);
console.log(`\n  ${c.dim}coût modèle : ${cout.toFixed(4)} $${c.reset}`);
console.log(`  ${c.dim}MESSAGES SENT : ${SENT_AVANT} → ${repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z')} — ce script n'envoie rien${c.reset}\n`);

await system.shutdown('verbatim terminé');
