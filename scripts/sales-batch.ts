/**
 * ATLAS SALES PROSPECTING — ATLAS cherche ses propres clients.
 *
 *   npm run sales                       contrôle seul, aucune dépense
 *   npm run sales -- --go               batch réel
 *   npm run sales -- --go --budget=0.12 plafond explicite
 *
 * L'ordre des étapes est ce qui rend ce batch bon marché :
 *
 *   recherche      Search Fabric, déterministe — le modèle n'est pas un moteur
 *   tri            gratuit, syntaxique : les annuaires tombent ici
 *   qualification  le modèle, seulement sur les survivants
 *   score          sept axes, dont un calculé par la plateforme
 *   contacts       ce qui est publié, jamais reconstruit
 *   approche       un brouillon par PRIORITY, sur un fait sourcé
 *
 * Rien n'est envoyé. Le dernier état atteignable est READY_FOR_REVIEW.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, formatDuration } from '../packages/core/src/index.ts';
import { preflight, formatPreflight } from '../packages/runtime/src/preflight.ts';
import { createSearchFabric } from '../packages/intelligence/src/search/fabric/factory.ts';
import {
  ATLAS_SALES_ICP,
  filterCandidate,
  dedupeCandidates,
  domainOf,
  scoreSalesProspect,
  buildOutreachDraft,
  SALES_SCORING_MODEL,
  type RawCandidate,
  type SalesAssessment,
  type OutreachFact,
} from '../packages/departments/src/index.ts';
import { textOf, type LlmRequest } from '../packages/llm/src/index.ts';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m',
};

const GO = process.argv.includes('--go');
const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const MAX_COST_USD = Number(arg('budget') ?? 0.12);
const MAX_DISCOVERED = Number(arg('discovered') ?? 20);
const MAX_QUALIFIED = Number(arg('qualified') ?? 10);
const MAX_PRIORITY = Number(arg('priority') ?? 5);
const MODEL = 'claude-haiku-4-5-20251001';
const outDir = arg('out') ?? 'out';

/**
 * Les requêtes du premier lot.
 *
 * Écrites à la main et versionnées : ce sont elles qui déterminent qui l'on
 * trouve, et les confier à un modèle reviendrait à s'en remettre à son idée du
 * marché plutôt qu'à la nôtre. Elles visent des pages où une entreprise dit
 * elle-même chercher des partenaires — le signal le plus proche du besoin.
 */
const QUERIES: readonly string[] = [
  'PME française industrielle "nous recherchons des distributeurs"',
  '"devenir revendeur" fabricant français B2B site officiel',
  'PME France "réseau de distribution" recherche partenaires export',
  'fabricant français "développement export" distributeurs recherchés',
];

interface Qualification {
  b2b: boolean;
  signals: Array<{ field: string; claim: string; nature: 'observed' | 'reported' | 'inferred'; sourceUrl: string | null }>;
  assessments: SalesAssessment[];
  whyFit: string;
  contact: {
    name: string | null;
    role: string | null;
    email: string | null;
    phone: string | null;
    contactPage: string | null;
    sourceUrl: string | null;
    confidence: number;
  } | null;
}

const QUALIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    b2b: { type: 'boolean', description: 'Vend-elle à des entreprises ?' },
    whyFit: { type: 'string', maxLength: 500 },
    signals: {
      type: 'array', minItems: 1, maxItems: 6,
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', maxLength: 60 },
          claim: { type: 'string', maxLength: 400 },
          nature: { type: 'string', enum: ['observed', 'reported', 'inferred'] },
          sourceUrl: { type: 'string', maxLength: 300 },
        },
        required: ['field', 'claim', 'nature', 'sourceUrl'],
        additionalProperties: false,
      },
    },
    assessments: {
      type: 'array', minItems: 1, maxItems: 6,
      items: {
        type: 'object',
        properties: {
          dimension: {
            type: 'string',
            enum: SALES_SCORING_MODEL.filter((d) => !d.computed).map((d) => d.key),
          },
          value: { type: 'number', minimum: 0, maximum: 100, description: 'Note SUR 100, jamais sur 10.' },
          rationale: { type: 'string', maxLength: 400 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['dimension', 'value', 'rationale', 'confidence'],
        additionalProperties: false,
      },
    },
    contact: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 120 },
        role: { type: 'string', maxLength: 120 },
        email: { type: 'string', maxLength: 200 },
        phone: { type: 'string', maxLength: 60 },
        contactPage: { type: 'string', maxLength: 300 },
        sourceUrl: { type: 'string', maxLength: 300 },
      },
      required: [],
      additionalProperties: false,
    },
  },
  required: ['b2b', 'whyFit', 'signals', 'assessments'],
  additionalProperties: false,
} as const;

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);
  const { repos } = system;

  console.log(`\n${c.bold}  ATLAS SALES PROSPECTING${c.reset}`);
  console.log(`  ${c.dim}ATLAS cherche ses propres clients. Rien n'est envoyé.${c.reset}\n`);
  console.log(
    `  ${c.bold}Plafond ${MAX_COST_USD.toFixed(2)} $${c.reset} · ${MODEL} · ` +
      `${MAX_DISCOVERED} découverts / ${MAX_QUALIFIED} qualifiés / ${MAX_PRIORITY} prioritaires\n`,
  );

  const need = { countries: ['FR'], languages: ['fr'], commercial: true };
  const fabric = createSearchFabric(config.search, { need });
  if (!fabric) {
    console.error(`  ${c.red}Aucun moteur de recherche configuré : ce batch en dépend.${c.reset}
`);
    await system.shutdown('aucun moteur');
    process.exitCode = 1;
    return;
  }
  const report = await preflight({
    config, repos, search: fabric,
    inferenceFabric: system.inferenceFabric,
    logger: system.logger,
    missionBudgetUsd: MAX_COST_USD,
    need,
  });
  console.log(formatPreflight(report).replace(/^/gm, '  '));
  console.log();

  if (!report.cleared) {
    console.error(`  ${c.red}BLOCKED${c.reset} — aucune dépense engagée.\n`);
    await system.shutdown('preflight refusé');
    process.exitCode = 1;
    return;
  }
  if (!GO) {
    console.log(`  ${c.amber}Contrôle seul.${c.reset} Relancez avec --go pour exécuter.\n`);
    await system.shutdown('contrôle seul');
    return;
  }
  if (config.llm.mode !== 'live') {
    console.error(`  ${c.red}Refus : mode « ${config.llm.mode} », pas « live ».${c.reset}\n`);
    await system.shutdown('mode incorrect');
    process.exitCode = 1;
    return;
  }

  const started = Date.now();
  const startedAt = new Date().toISOString();
  const batchId = `BATCH-${startedAt.slice(0, 10)}-${Date.now().toString(36).slice(-4)}`;

  // La mission n'existe que pour porter le plafond : le registre budgétaire
  // raisonne par mission, et sans elle aucun appel ne serait borné.
  const mission = repos.missions.create({
    title: `ATLAS Sales — ${batchId}`,
    objective: 'Identifier des PME B2B françaises susceptibles d’acheter une étude de prospection.',
    context: { executionMode: 'live', preset: 'SALES-001', budgetUsd: MAX_COST_USD },
    createdBy: 'sales',
    tokenBudget: 60_000,
  });
  system.ledger.open(mission.id, {
    ...config.budget, maxMissionCostUsd: MAX_COST_USD, maxOutputTokensPerCall: 2000,
  });

  // ── Recherche déterministe ───────────────────────────────────────────────
  console.log(`  ${c.bold}Recherche${c.reset}`);
  const raw: RawCandidate[] = [];
  let searchCalls = 0;

  for (const query of QUERIES) {
    if (raw.length >= MAX_DISCOVERED * 2) break;
    try {
      const results = await fabric.search(
        { query, country: 'FR', language: 'fr', count: 10 },
        { logger: system.logger, timeoutMs: config.orchestration.toolTimeoutMs },
      );
      searchCalls++;
      // Le moteur qui a réellement répondu : le parc bascule tout seul, et
      // consigner « searxng » quand DuckDuckGo a servi rendrait la traçabilité
      // fausse au moment où elle sert le plus.
      const provider = fabric.lastTrace().attempts.at(-1)?.providerId ?? 'inconnu';
      for (const result of results.results ?? []) {
        raw.push({
          companyName: (result.title ?? '').replace(/\s*[|–—-]\s*.*$/, '').trim(),
          domain: domainOf(result.url),
          country: 'France',
          industry: null,
          sourceUrl: result.url,
          searchProvider: provider,
          query,
          discoveredAt: new Date().toISOString(),
          snippet: result.snippet ?? null,
        });
      }
      console.log(`    ${c.dim}${query.slice(0, 62)}${c.reset} → ${results.results?.length ?? 0}`);
    } catch (err) {
      console.log(`    ${c.amber}échec${c.reset} ${query.slice(0, 50)} — ${(err as Error).message.slice(0, 50)}`);
    }
  }

  // ── Tri gratuit ──────────────────────────────────────────────────────────
  const unique = dedupeCandidates(raw);
  const kept: RawCandidate[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];

  for (const candidate of unique) {
    const decision = filterCandidate(candidate, ATLAS_SALES_ICP);
    if (decision.outcome === 'kept' && kept.length < MAX_DISCOVERED) kept.push(candidate);
    else if (decision.outcome === 'rejected') rejected.push({ name: candidate.companyName || candidate.domain!, reason: decision.reason });
  }

  console.log(
    `\n  ${raw.length} résultat(s) · ${unique.length} entreprise(s) distincte(s) · ` +
      `${c.green}${kept.length} retenue(s)${c.reset} · ${c.dim}${rejected.length} écartée(s) sans dépense${c.reset}\n`,
  );

  for (const candidate of kept) {
    repos.sales.discover({
      batchId,
      companyName: candidate.companyName || candidate.domain!,
      domain: candidate.domain!,
      website: `https://${candidate.domain}`,
      country: candidate.country,
      sourceUrl: candidate.sourceUrl,
      searchProvider: candidate.searchProvider,
      query: candidate.query,
      discoveredAt: candidate.discoveredAt,
    });
  }

  // ── Qualification : le modèle, sur les survivants seulement ──────────────
  console.log(`  ${c.bold}Qualification${c.reset}`);
  const prospects = repos.sales.forBatch(batchId).slice(0, MAX_QUALIFIED);
  let llmCalls = 0;

  for (const prospect of prospects) {
    const spent = spendOf(repos, mission.id, startedAt);
    if (spent >= MAX_COST_USD) {
      console.log(`    ${c.red}plafond atteint — arrêt de la qualification${c.reset}`);
      break;
    }

    const source = kept.find((k) => k.domain === prospect.domain);
    const request: LlmRequest = {
      model: MODEL,
      system:
        'Vous évaluez si une entreprise pourrait acheter une étude de prospection B2B à 49 €. ' +
        'N’écrivez JAMAIS qu’elle « a besoin » de ce service : écrivez « signal compatible avec ' +
        'un besoin de prospection », et seulement si le signal figure dans le texte fourni. ' +
        'Chaque note est SUR 100. Ne reconstruisez jamais une adresse e-mail : ne rendez un ' +
        'contact que s’il est explicitement présent dans le texte.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `# Entreprise\n${prospect.companyName}\nSite : ${prospect.website}\n` +
                `Pays : ${prospect.country ?? 'inconnu'}\n\n` +
                `# Ce que la recherche a rapporté\n${source?.snippet ?? '(aucun résumé)'}\n` +
                `Source : ${prospect.sourceUrl}\n\n` +
                `# Profil recherché\nPME B2B, 3 à 250 salariés, vendant à des entreprises, ` +
                `susceptible de chercher clients, distributeurs ou partenaires.`,
            },
          ],
        },
      ],
      jsonSchema: QUALIFICATION_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 2000,
      meta: {
        missionId: mission.id, taskRef: 'sales-qualification', agentKey: 'ambassador',
        purpose: 'sales-qualification', subject: prospect.id, evidenceCount: null,
      },
    };

    let parsed: Qualification | null = null;
    try {
      const response = await system.provider.complete(request);
      llmCalls++;
      const rawText = textOf(response.content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const start = rawText.indexOf('{');
      const end = rawText.lastIndexOf('}');
      if (start >= 0 && end > start) parsed = JSON.parse(rawText.slice(start, end + 1)) as Qualification;
    } catch (err) {
      console.log(`    ${c.amber}·${c.reset} ${prospect.companyName.slice(0, 34)} — ${(err as Error).message.slice(0, 40)}`);
    }

    if (!parsed) {
      repos.sales.setState(prospect.id, 'REJECTED', { rejectReason: 'qualification sans sortie exploitable' });
      continue;
    }

    // Les preuves : seules celles qui portent une adresse comptent comme faits.
    for (const signal of parsed.signals ?? []) {
      repos.sales.addEvidence({
        prospectId: prospect.id,
        field: signal.field,
        claim: signal.claim,
        nature: signal.nature,
        sourceUrl: signal.sourceUrl?.startsWith('http') ? signal.sourceUrl : prospect.sourceUrl,
        basis: signal.nature === 'inferred' ? 'Déduit du texte rapporté par la recherche.' : null,
        confidence: 0.7,
      });
    }

    const evidence = repos.sales.evidenceFor(prospect.id);
    const score = scoreSalesProspect({
      assessments: parsed.assessments ?? [],
      evidence: {
        observed: evidence.filter((e) => e.nature === 'observed').length,
        reported: evidence.filter((e) => e.nature === 'reported').length,
        inferred: evidence.filter((e) => e.nature === 'inferred').length,
        sourced: evidence.filter((e) => Boolean(e.sourceUrl)).length,
      },
    });

    repos.sales.setScore(prospect.id, {
      score: score.total, tier: score.tier, detail: score, whyFit: parsed.whyFit ?? '',
    });

    // Le contact : uniquement ce qui a été rendu, jamais reconstruit.
    if (parsed.contact && (parsed.contact.email || parsed.contact.phone || parsed.contact.contactPage)) {
      repos.sales.setContact(prospect.id, { ...parsed.contact, confidence: 0.6 });
    }

    repos.sales.setState(prospect.id, score.tier === 'REJECTED' ? 'REJECTED' : 'QUALIFIED', {
      rejectReason: score.tier === 'REJECTED' ? `score ${score.total} sous le seuil` : null,
    });

    console.log(
      `    ${score.tier === 'REJECTED' ? `${c.dim}·${c.reset}` : `${c.green}✓${c.reset}`} ` +
        `${prospect.companyName.slice(0, 34).padEnd(36)}${String(score.total).padStart(6)} · ${score.tier}`,
    );
  }

  // ── Approche : un brouillon par PRIORITY, sur un fait sourcé ─────────────
  const qualified = repos.sales.forBatch(batchId).filter((p) => p.state === 'QUALIFIED');
  const priority = qualified.filter((p) => p.tier === 'PRIORITY').slice(0, MAX_PRIORITY);

  console.log(`\n  ${c.bold}Brouillons d'approche${c.reset}`);
  let drafts = 0;
  for (const prospect of priority) {
    const facts: OutreachFact[] = repos.sales
      .evidenceFor(prospect.id)
      .filter((e) => e.sourceUrl)
      .map((e) => ({
        evidenceId: e.id, claim: e.claim, sourceUrl: e.sourceUrl!, nature: e.nature,
      }));

    const outcome = buildOutreachDraft({
      company: prospect.companyName,
      website: prospect.website,
      facts,
      contact: prospect.contactEmail || prospect.contactPhone || prospect.contactPage
        ? {
            name: prospect.contactName, role: prospect.contactRole,
            email: prospect.contactEmail, phone: prospect.contactPhone,
            contactPage: prospect.contactPage, sourceUrl: prospect.contactSourceUrl,
            confidence: prospect.contactConfidence ?? 0.5,
            named: Boolean(prospect.contactName?.trim()),
          }
        : null,
      whyThisCompany: prospect.whyFit ?? '',
      offer: { priceEur: 49, deliveryHours: 24 },
    });

    if (!outcome.draft) {
      console.log(`    ${c.amber}·${c.reset} ${prospect.companyName.slice(0, 34)} — ${outcome.reason.slice(0, 60)}`);
      continue;
    }
    repos.sales.setOutreach(prospect.id, {
      personalizationFactId: outcome.draft.personalizationFact.evidenceId,
      messageShort: outcome.draft.messageShort,
      messageEmail: outcome.draft.messageEmail,
      sourceUrl: outcome.draft.sourceUsedForPersonalization,
    });
    repos.sales.setState(prospect.id, 'READY_FOR_REVIEW');
    drafts++;
    console.log(`    ${c.green}✓${c.reset} ${prospect.companyName.slice(0, 34)}`);
  }

  // ── Mesure ───────────────────────────────────────────────────────────────
  const calls = repos.llmCalls.forMission(mission.id).filter((k) => k.createdAt >= startedAt);
  const cost = calls.reduce((a, k) => a + (k.costUsd ?? 0), 0);
  const all = repos.sales.forBatch(batchId);
  const ready = all.filter((p) => p.state === 'READY_FOR_REVIEW');

  const lines: string[] = [];
  const say = (t = '') => { lines.push(t); console.log(t); };

  say();
  say(`  ${c.bold}ATLAS SALES PROSPECTING — ${batchId}${c.reset}`);
  say();
  say(`  DISCOVERED:  ${all.length}`);
  say(`  QUALIFIED:   ${all.filter((p) => p.state !== 'DISCOVERED' && p.state !== 'REJECTED').length}`);
  say(`  PRIORITY:    ${all.filter((p) => p.tier === 'PRIORITY').length}`);
  say();

  for (const p of ready) {
    const fact = repos.sales.evidenceFor(p.id).find((e) => e.id === p.personalizationFactId);
    say(`  ── ${p.companyName}`);
    say(`     WEBSITE:      ${p.website}`);
    say(`     SCORE:        ${p.score} · ${p.tier}`);
    say(`     WHY FIT:      ${(p.whyFit ?? '').slice(0, 140)}`);
    say(`     CONTACT:      ${p.contactName ?? p.contactEmail ?? p.contactPhone ?? p.contactPage ?? 'aucun contact publié trouvé'}`);
    say(`     SOURCE:       ${p.contactSourceUrl ?? p.sourceUrl}`);
    say(`     PERSO FACT:   ${(fact?.claim ?? '').slice(0, 140)}`);
    say(`     PERSO SOURCE: ${p.outreachSourceUrl}`);
    say();
  }

  say(`  COST:            ${cost.toFixed(4)} $ / ${MAX_COST_USD.toFixed(2)} $ ${cost <= MAX_COST_USD ? '✓' : 'DÉPASSEMENT'}`);
  say(`  LLM CALLS:       ${llmCalls}`);
  say(`  SEARCH CALLS:    ${searchCalls}`);
  say(`  TOKENS:          ${calls.reduce((a, k) => a + k.inputTokens, 0)} entrée · ${calls.reduce((a, k) => a + k.outputTokens, 0)} sortie`);
  say(`  COST / DISCOVERED: ${all.length ? (cost / all.length).toFixed(5) : '—'} $`);
  say(`  COST / QUALIFIED:  ${qualified.length ? (cost / qualified.length).toFixed(5) : '—'} $`);
  say(`  COST / PRIORITY:   ${priority.length ? (cost / priority.length).toFixed(5) : '—'} $`);
  say(`  DURÉE:           ${formatDuration(Date.now() - started)}`);
  say();
  say(`  HUMAN REVIEW:    PENDING`);
  say(`  READY TO CONTACT: ${drafts} prospect(s) — aucun message envoyé`);
  say();

  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `sales-${batchId}.txt`);
  writeFileSync(path, lines.join('\n').replace(/\x1b\[[0-9;]*m/g, ''), 'utf8');
  console.log(`  ${c.dim}Rapport : ${path}${c.reset}\n`);

  await system.shutdown('batch terminé');
  process.exitCode = drafts > 0 ? 0 : 1;
}

function spendOf(repos: ReturnType<typeof createSystem>['repos'], missionId: string, since: string): number {
  return repos.llmCalls
    .forMission(missionId)
    .filter((k) => k.createdAt >= since)
    .reduce((a, k) => a + (k.costUsd ?? 0), 0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
