/**
 * SALVAGE-001 — tirer un livrable vendable de ce qui a déjà été payé.
 *
 *   npm run salvage           contrôle seul, aucune dépense
 *   npm run salvage -- --go   exécution réelle
 *
 * REVENUE-001 (M-WX5T0) a dépensé 0,1119 $ et trouvé six entreprises
 * allemandes réelles, 21 preuves sourcées sur 22, aucune lignée douteuse. Elle
 * s'est arrêtée avant la qualification : les candidats n'avaient donc ni score
 * ni verdict, et aucun n'était vendable.
 *
 * Rien de tout cela n'est perdu. La recherche est faite ; ce qui manque est le
 * jugement. Ce script reprend les candidats existants et ne fait que cela.
 *
 * **Aucune nouvelle découverte.** Ce n'est pas une consigne donnée à un agent,
 * c'est une propriété de construction : le plan ne comporte pas d'étape de
 * découverte, et `discover_companies` n'est offert à aucune des étapes
 * exécutées ici. Un agent ne peut pas appeler un outil qu'on ne lui donne pas.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSystem } from '../packages/server/src/bootstrap.ts';
import { loadConfig, formatDuration } from '../packages/core/src/index.ts';
import { preflight, formatPreflight } from '../packages/runtime/src/preflight.ts';
import { missionEconomics } from '../packages/intelligence/src/economics.ts';
import { normaliseCountry } from '../packages/intelligence/src/opportunities.ts';
import {
  REVENUE_001,
  meetsQualityBar,
  whyBelowBar,
  buildPack,
  packToHtml,
  packToCsv,
  type ProspectQuality,
} from '../packages/departments/src/index.ts';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  amber: '\x1b[33m',
  red: '\x1b[31m',
};

const GO = process.argv.includes('--go');
const SOURCE = process.argv.find((a) => a.startsWith('--from='))?.slice(7) ?? 'M-WX5T0';
const outDir = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'out';

/** Le plafond de SALVAGE-001. Dur, sans marge de tolérance. */
const MAX_COST_USD = 0.04;
/** Assez de prospects vendables pour livrer — on s'arrête là. */
const ENOUGH = 3;
const ICP_COUNTRIES = ['Germany'];

async function main(): Promise<void> {
  const config = loadConfig();
  const system = createSystem(config);
  const { repos } = system;

  console.log(`\n${c.bold}  SALVAGE-001 — reprise de ${SOURCE}${c.reset}`);
  console.log(
    `  ${c.dim}Aucune nouvelle découverte. Qualifier, noter, classer ce qui est déjà payé.${c.reset}\n`,
  );
  console.log(
    `  ${c.bold}Plafond ${MAX_COST_USD.toFixed(2)} $${c.reset} · ${REVENUE_001.limits.model} · ` +
      `arrêt dès ${ENOUGH} prospects vendables\n`,
  );

  const source = repos.missions.list({ limit: 200, offset: 0 }).items.find((m) => m.code === SOURCE);
  if (!source) {
    console.error(`  ${c.red}Mission « ${SOURCE} » introuvable.${c.reset}\n`);
    await system.shutdown('source introuvable');
    process.exitCode = 1;
    return;
  }

  // ── Tri des candidats déjà payés ────────────────────────────────────────
  //
  // Trois motifs d'exclusion, tous déterministes et tous vérifiés ici plutôt
  // que confiés au jugement d'un agent.
  const inherited = repos.opportunities.forMission(source.id);
  const eligible: typeof inherited = [];
  const excluded: Array<{ name: string; reason: string }> = [];

  for (const opportunity of inherited) {
    const company = repos.companies.require(opportunity.companyId);

    if (company.dataOrigin !== 'live') {
      excluded.push({ name: company.name, reason: `lignée « ${company.dataOrigin} »` });
      continue;
    }
    const country = normaliseCountry(company.country);
    const wanted = ICP_COUNTRIES.map(normaliseCountry);
    if (country && !wanted.includes(country)) {
      excluded.push({ name: company.name, reason: `hors profil : ${company.country}` });
      continue;
    }
    if (company.identityStatus !== 'ok') {
      excluded.push({ name: company.name, reason: `identité « ${company.identityStatus} »` });
      continue;
    }
    eligible.push(opportunity);
  }

  console.log(`  ${c.bold}Candidats hérités${c.reset} (${inherited.length})`);
  for (const o of eligible) {
    const company = repos.companies.require(o.companyId);
    const evidence = repos.companies.evidenceForOpportunity(o.id);
    const firsthand = evidence.filter((e) => e.nature !== 'inferred' && e.sourceRef).length;
    console.log(
      `    ${c.green}✓${c.reset} ${company.name.slice(0, 38).padEnd(40)}` +
        `${firsthand} preuve(s) de 1re main · ${company.country ?? '?'}`,
    );
  }
  for (const x of excluded) {
    console.log(`    ${c.dim}·${c.reset} ${x.name.slice(0, 38).padEnd(40)}${c.dim}${x.reason}${c.reset}`);
  }
  console.log();

  if (eligible.length < ENOUGH) {
    console.error(
      `  ${c.red}${eligible.length} candidat(s) éligible(s) — moins que les ${ENOUGH} requis. ` +
        `Aucune dépense engagée.${c.reset}\n`,
    );
    await system.shutdown('trop peu de candidats');
    process.exitCode = 1;
    return;
  }

  // ── Contrôle avant décollage ────────────────────────────────────────────
  const report = await preflight({
    config,
    repos,
    // Le moteur du déploiement, bien que ce sauvetage n'en appelle aucun.
    // Désactiver le contrôle « pas de moteur » pour la circonstance
    // affaiblirait une garde qui vaut pour toutes les missions réelles ; la
    // satisfaire honnêtement coûte moins cher qu'un contournement.
    search: system.searchFabric,
    inferenceFabric: system.inferenceFabric,
    logger: system.logger,
    missionBudgetUsd: MAX_COST_USD,
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

  // ── La mission de sauvetage ─────────────────────────────────────────────
  const started = Date.now();
  const mission = repos.missions.create({
    title: 'SALVAGE-001 — Pack Prospection Allemagne',
    objective:
      `Qualifier, noter et classer ${eligible.length} distributeurs ou intégrateurs allemands ` +
      `déjà identifiés et documentés. Ne cherchez aucune nouvelle entreprise : le travail de ` +
      `recherche est fait, et les preuves sont en base. Votre travail est le jugement — dire ` +
      `lesquels correspondent réellement au profil, à quel point, et dans quel ordre les aborder.`,
    context: {
      executionMode: 'live',
      preset: 'SALVAGE-001',
      budgetUsd: MAX_COST_USD,
      maxOutputTokensPerCall: REVENUE_001.limits.maxOutputTokensPerCall,
      inheritedFrom: SOURCE,
    },
    createdBy: 'salvage',
    departmentKey: 'business-expansion',
    tags: ['revenue', 'salvage', 'live'],
    tokenBudget: 40_000,
  });

  system.ledger.open(mission.id, {
    ...config.budget,
    maxMissionCostUsd: MAX_COST_USD,
    maxOutputTokensPerCall: REVENUE_001.limits.maxOutputTokensPerCall ?? config.budget.maxOutputTokensPerCall,
  });

  /** Le dossier de chaque candidat, tel qu'il est en base. */
  const dossier = eligible.map((o) => {
    const company = repos.companies.require(o.companyId);
    const evidence = repos.companies.evidenceForOpportunity(o.id);
    return {
      opportunityId: o.id,
      name: company.name,
      website: company.website ?? (company.domain ? `https://${company.domain}` : null),
      country: company.country,
      city: company.city,
      roles: o.targetTypes,
      evidence: evidence.map((e) => ({
        id: e.id,
        field: e.field,
        nature: e.nature,
        claim: e.claim.slice(0, 300),
        sourceRef: e.sourceRef,
      })),
    };
  });

  // Le plan, fixe. Pas d'appel de planification, et surtout pas de découverte.
  const [qualifyTask, scoreTask, rankTask] = repos.missions.replaceTasks(mission.id, [
    {
      ref: 'qualification',
      title: 'Trancher sur chaque candidat',
      agentKey: 'ambassador',
      action: 'qualify',
      instruction:
        `Pour chacun des ${dossier.length} candidats fournis, rendez un verdict avec ` +
        `qualify_opportunity : qualified, rejected ou uncertain. Appuyez chaque critère sur ` +
        `les preuves listées, par leur identifiant. Ne cherchez rien de nouveau — tout ce dont ` +
        `vous avez besoin est dans les entrées de l'étape.`,
      input: { candidates: dossier },
      dependsOn: [],
      maxAttempts: 1,
    },
    {
      ref: 'scoring',
      title: 'Noter l’adéquation de chaque candidat retenu',
      agentKey: 'analyst',
      action: 'score',
      instruction:
        `Notez chaque candidat qualifié avec score_opportunity, dimension par dimension, ` +
        `en rattachant chaque note aux preuves qui la portent.`,
      input: { candidates: dossier },
      dependsOn: ['qualification'],
      maxAttempts: 1,
    },
    {
      ref: 'ranking',
      title: 'Classer et justifier l’ordre d’approche',
      agentKey: 'analyst',
      action: 'evaluate',
      instruction:
        `Classez les candidats notés avec rank_shortlist, et justifiez la position de chacun ` +
        `pour le fondateur : par quoi commencer, et pourquoi.`,
      input: { candidates: dossier },
      dependsOn: ['scoring'],
      maxAttempts: 1,
    },
  ]);

  console.log(`  Mission ${c.bold}${mission.code}${c.reset} — plan fixe, sans découverte\n`);
  console.log(`  ${c.dim}temps  │ étape${c.reset}`);
  console.log(`  ${c.dim}───────┼──────────────────────────────────────────────${c.reset}`);

  const at = (): string => `${((Date.now() - started) / 1000).toFixed(0).padStart(5)}s`;
  const spent = (): number =>
    missionEconomics({ repos, missionId: mission.id, model: REVENUE_001.limits.model, simulated: false })
      .estimatedCostUsd ?? 0;

  const quality = (): ProspectQuality[] =>
    eligible.map((o) => {
      const current = repos.opportunities.require(o.id);
      return {
        opportunityId: current.id,
        score: current.score,
        firsthandEvidence: repos.companies
          .evidenceForOpportunity(current.id)
          .filter((e) => e.nature !== 'inferred' && Boolean(e.sourceRef)).length,
        qualified: current.qualification?.verdict === 'qualified',
      };
    });

  const upstream: Record<string, unknown> = {};
  let stopNote = '';

  for (const task of [qualifyTask!, scoreTask!, rankTask!]) {
    const before = spent();
    if (before >= MAX_COST_USD) {
      stopNote = `plafond atteint avant « ${task.ref} »`;
      console.log(`  ${c.dim}${at()}${c.reset} │ ${c.red}—${c.reset} ${task.ref.padEnd(14)} plafond atteint`);
      break;
    }

    const sellableNow = quality().filter((q) => meetsQualityBar(q, REVENUE_001.qualityBar)).length;
    if (sellableNow >= ENOUGH) {
      stopNote = `${sellableNow} prospects vendables — arrêt anticipé`;
      console.log(
        `  ${c.dim}${at()}${c.reset} │ ${c.green}■${c.reset} ${task.ref.padEnd(14)} inutile : ${sellableNow} prospects déjà vendables`,
      );
      break;
    }

    console.log(`  ${c.dim}${at()}${c.reset} │ ▶ ${task.ref.padEnd(14)} ${task.agentKey}`);
    repos.missions.setTaskStatus(task.id, 'running', { incrementAttempt: true });
    try {
      const agent = repos.agents.getDefinition(task.agentKey)!;
      const result = await system.runtime.run({
        agent,
        mission: repos.missions.require(mission.id),
        task,
        upstream,
      });
      upstream[task.ref] = result.output;
      repos.missions.setTaskStatus(task.id, 'succeeded', {
        output: result.output,
        tokensUsed: result.tokensUsed,
        durationMs: result.durationMs,
      });
      console.log(
        `  ${c.dim}${at()}${c.reset} │ ${c.green}✓${c.reset} ${task.ref.padEnd(14)}` +
          `${result.toolCalls} outil(s), ${result.toolFailures} échec(s) · ${spent().toFixed(4)} $`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      repos.missions.setTaskStatus(task.id, 'failed', { error: message });
      console.log(`  ${c.dim}${at()}${c.reset} │ ${c.red}✗${c.reset} ${task.ref.padEnd(14)}${message.slice(0, 70)}`);
      stopNote = `échec de « ${task.ref} » : ${message.slice(0, 80)}`;
      break;
    }
  }

  console.log(`  ${c.dim}───────┴──────────────────────────────────────────────${c.reset}\n`);

  // ── Mesure ──────────────────────────────────────────────────────────────
  const economics = missionEconomics({
    repos,
    missionId: mission.id,
    model: REVENUE_001.limits.model,
    simulated: false,
  });
  const cost = economics.estimatedCostUsd ?? 0;
  const llm = repos.llmCalls.forMission(mission.id);
  const finalQuality = quality();
  const sellable = eligible.filter((o) => {
    const q = finalQuality.find((x) => x.opportunityId === o.id);
    return q ? meetsQualityBar(q, REVENUE_001.qualityBar) : false;
  });

  console.log(`  ${c.bold}SALVAGE-001 — MESURE${c.reset}\n`);
  console.log(`    durée             ${formatDuration(Date.now() - started)}${stopNote ? ` ${c.dim}(${stopNote})${c.reset}` : ''}`);
  console.log(
    `    coût              ${c.bold}${cost.toFixed(4)} $${c.reset} ${c.dim}/ ${MAX_COST_USD.toFixed(2)} $${c.reset}` +
      (cost > MAX_COST_USD ? ` ${c.red}DÉPASSEMENT${c.reset}` : ` ${c.green}✓${c.reset}`),
  );
  console.log(`    appels LLM        ${llm.length}`);
  console.log(
    `    jetons            ${(economics.measured?.inputTokens ?? 0).toLocaleString('fr-FR')} entrée · ` +
      `${(economics.measured?.outputTokens ?? 0).toLocaleString('fr-FR')} sortie`,
  );
  console.log(`    coût cumulé       ${(0.1119 + cost).toFixed(4)} $ ${c.dim}(REVENUE-001 + SALVAGE-001)${c.reset}`);
  console.log();

  console.log(`  ${c.bold}Prospects${c.reset}`);
  for (const o of eligible) {
    const current = repos.opportunities.require(o.id);
    const company = repos.companies.require(o.companyId);
    const q = finalQuality.find((x) => x.opportunityId === o.id)!;
    const ok = meetsQualityBar(q, REVENUE_001.qualityBar);
    const why = ok ? '' : ` ${c.dim}— ${whyBelowBar(q, REVENUE_001.qualityBar).join(', ')}${c.reset}`;
    console.log(
      `    ${ok ? `${c.green}✓${c.reset}` : `${c.dim}·${c.reset}`} ${company.name.slice(0, 36).padEnd(38)}` +
        `score ${String(current.score ?? '—').padStart(3)} · rang ${String(current.rank ?? '—').padStart(2)} · ` +
        `${q.firsthandEvidence} preuve(s)${why}`,
    );
  }
  console.log();

  // ── Export ──────────────────────────────────────────────────────────────
  const entries = sellable
    .map((o) => repos.opportunities.require(o.id))
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || (b.score ?? 0) - (a.score ?? 0))
    .map((o) => ({
      opportunity: o,
      company: repos.companies.require(o.companyId),
      evidence: repos.companies.evidenceForOpportunity(o.id),
      contacts: repos.companies.contactsFor(o.companyId),
    }));

  const pack = buildPack({
    title: 'Pack Prospection Allemagne — ÉCHANTILLON CLIENT',
    brief:
      'Distributeurs et intégrateurs allemands qualifiés pour une offre B2B industrielle. ' +
      'Chaque affirmation porte sa source ; ce qui relève de la déduction est signalé comme tel.',
    generatedAt: new Date().toISOString(),
    entries,
  });

  mkdirSync(outDir, { recursive: true });
  const stem = `pack-prospection-allemagne-${mission.code}`;
  writeFileSync(join(outDir, `${stem}.html`), packToHtml(pack), 'utf8');
  writeFileSync(join(outDir, `${stem}.csv`), packToCsv(pack), 'utf8');

  const named = pack.prospects.filter((p) => p.contact?.name).length;
  const pageOnly = pack.prospects.filter((p) => !p.contact?.name && p.contact?.contactPage).length;

  console.log(`  ${c.bold}Livrable${c.reset}`);
  console.log(`    HTML              ${join(outDir, `${stem}.html`)}`);
  console.log(`    CSV               ${join(outDir, `${stem}.csv`)}`);
  console.log(`    prospects         ${pack.prospects.length}`);
  console.log(`    contact nominatif ${named}`);
  console.log(`    page de contact   ${pageOnly}`);
  console.log();

  // ── Verdict ─────────────────────────────────────────────────────────────
  const companies = entries.map((e) => e.company);
  const clean =
    companies.every((c2) => c2.dataOrigin === 'live' && c2.identityStatus === 'ok') &&
    entries.every((e) => e.evidence.every((ev) => !ev.simulated));
  const inIcp = companies.every((c2) => {
    const country = normaliseCountry(c2.country);
    return !country || ICP_COUNTRIES.map(normaliseCountry).includes(country);
  });
  const ready = sellable.length >= ENOUGH && clean && inIcp && cost <= MAX_COST_USD;

  console.log(`  ${c.bold}READY TO SELL : ${ready ? `${c.green}YES` : `${c.red}NO`}${c.reset}`);
  console.log(`    ${sellable.length >= ENOUGH ? '✓' : '✗'} ${sellable.length} / ${ENOUGH} prospects vendables`);
  console.log(`    ${clean ? '✓' : '✗'} aucune lignée douteuse ni identité en conflit`);
  console.log(`    ${inIcp ? '✓' : '✗'} tous dans le profil recherché`);
  console.log(`    ${cost <= MAX_COST_USD ? '✓' : '✗'} plafond respecté`);
  console.log();

  await system.shutdown('salvage terminée');
  process.exitCode = ready ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
