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
import { loadConfig, formatDuration, GUARD_VERSION } from '../packages/core/src/index.ts';
import { preflight, formatPreflight } from '../packages/runtime/src/preflight.ts';
import { createSearchFabric } from '../packages/intelligence/src/search/fabric/factory.ts';
import { fetchRawPages } from '../packages/intelligence/src/contact-fetch.ts';
import {
  checkPriorityEligibility,
  SALES_TIER_THRESHOLDS,
  runSalesPipeline,
  funnelBalances,
  resolveContacts,
  isOfficialPage, isCommercialEvidence, outreachFactFrom,
  contactPagesFor,
  contactLinksIn,
  collectSourcedFacts,
  extractLegalIdentity,
  extractCountryEvidence,
  countryFit,
  ATLAS_SALES_ICP,
  legalPagesFor,
  legalLinksIn,
  confidenceFromLegal,
  canonicalUrl,
  verifyClaimAgainstSource,
  readableText,
  type EnrichmentOutcome,
  type ContactPage,
  domainOf,
  scoreSalesProspect,
  buildOutreachDraft,
  SALES_SCORING_MODEL,
  planQueries,
  whyNotACompanyName,
  checkHumanization,
  collectIdentitySignals,
  corroborateIdentity,
  collectCountrySignals,
  corroborateCountry,
  buildBlockCatalogue,
  resolveSelections,
  INTERPRETATION_PREFIX,
  distinctCommercialFacts,
  MIN_COMMERCIAL_FACTS,
  VERBATIM_SYSTEM,
  VERBATIM_SCHEMA,
  type SourcedEvidence,
  type BlockSelection,
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

  /**
   * Ce que la lecture du web a reellement coute.
   *
   * Un cycle a un jour passe deux minutes trente sur un hote qui refusait
   * toutes les connexions, sans que le rapport le dise. Ces compteurs le
   * disent.
   */
  const reseau = { attempts: 0, aborts: 0, timeSavedMs: 0, abortedHosts: [] as string[] };
  const compteReseau = (o: { attempts: number; aborted: Array<{ host: string; kind: string }>; timeSavedMsEstimate: number }) => {
    reseau.attempts += o.attempts;
    reseau.aborts += o.aborted.length;
    reseau.timeSavedMs += o.timeSavedMsEstimate;
    for (const a of o.aborted) reseau.abortedHosts.push(a.host + ' (' + a.kind + ')');
  };

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

  // La vague tourne le vocabulaire d'un lot à l'autre. Sans elle, les mêmes
  // requêtes ramènent les mêmes entreprises, que la déduplication écarte
  // toutes : le lot rend zéro sans dire que la cause est la requête.
  const wave = Number(arg('wave') ?? repos.sales.batchIds().length);
  console.log(`  ${c.dim}vague ${wave}${c.reset}`);

  for (const plan of planQueries(undefined, 8, wave)) {
    const query = plan.query;
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
          /*
           * Le pays n'est pas connu a la decouverte.
           *
           * Il valait « France » ici, parce que la requete est regionalisee en
           * FR. Ce n'etait pas une mesure du prospect : c'etait la reformulation
           * de notre propre intention, ecrite dans une colonne que le filtre ICP
           * est cense interroger. Zhejiang NPC Machinery, fabricant chinois, et
           * Diversitech Equipment & Sales, societe canadienne, sont ainsi entres
           * en base comme francaises.
           *
           * Il est etabli plus loin, sur les pages du site, ou reste `null`.
           */
          country: null,
          industry: null,
          sourceUrl: result.url,
          searchProvider: provider,
          query,
          discoveredAt: new Date().toISOString(),
          snippet: result.snippet ?? null,
        });
      }
      console.log(
        `    ${c.dim}[${plan.family}]${c.reset} ${query.slice(0, 54).padEnd(56)}` +
          `→ ${results.results?.length ?? 0}`,
      );
    } catch (err) {
      console.log(`    ${c.amber}échec${c.reset} ${query.slice(0, 50)} — ${(err as Error).message.slice(0, 50)}`);
    }
  }

  // Le plafond de résultats est dur : la boucle ci-dessus le contrôle avant
  // chaque requête, donc la dernière peut le dépasser. On tranche ici.
  const MAX_RESULTS = MAX_DISCOVERED * 2;
  if (raw.length > MAX_RESULTS) raw.length = MAX_RESULTS;

  // ── Résolution d'identité, avant toute dépense ───────────────────────────
  //
  // L'ordre vit dans `runSalesPipeline`, pas ici : un ordre écrit dans un
  // script ne peut être qu'affirmé, alors qu'un module se teste. Le test passe
  // une qualification qui compte ses appels et vérifie qu'elle reste à zéro
  // sur un candidat refusé — ce que le lot 002 aurait rendu impossible.
  const outcome = await runSalesPipeline({
    candidates: raw.map((r) => ({
      searchTitle: r.companyName,
      url: r.sourceUrl,
      domain: r.domain,
      country: r.country,
      industry: r.industry,
      snippet: r.snippet,
    })),
    maxRetained: MAX_DISCOVERED,
    // Ce qu'ATLAS a déjà vu ne se repaie pas : lots précédents, entreprises
    // déjà contactées, entreprises écartées à la main.
    excludeDomains: repos.sales.knownDomains(),
    // La qualification payante ne se fait pas ici : elle a besoin du prospect
    // persisté, de son identifiant et de son budget. Le pipeline sert d'abord
    // à établir qui survit.
    qualify: async () => null,
    maxQualifications: 0,
  });

  const funnel = outcome.funnel;
  const balance = funnelBalances(funnel);
  const kept = outcome.survivors;

  console.log(
    `
  ${funnel.searchResults} résultat(s) · ${c.green}${funnel.retained} retenue(s)${c.reset} · ` +
      `${c.dim}${outcome.rejections.length} écartée(s) sans dépense${c.reset}
`,
  );
  console.log(
    `    ${c.dim}type de page ${funnel.pageTypeRejected} · forme d'URL ${funnel.urlShapeRejected} · ` +
      `identité ${funnel.identityUnresolved} · profil ${funnel.outOfIcp} · ` +
      `doublons ${funnel.deduplicated} · déjà connues ${funnel.alreadyKnown} · ` +
      `retenus ${funnel.retained}${c.reset}`,
  );
  if (!balance.balanced) {
    console.log(
      `    ${c.red}entonnoir déséquilibré : ${balance.missing} résultat(s) sans case${c.reset}`,
    );
  }
  for (const r of outcome.rejections.slice(0, 14)) {
    console.log(
      `    ${c.dim}${r.stage.padEnd(20)}${c.reset} ${r.candidate.searchTitle.slice(0, 34).padEnd(36)}` +
        `${c.dim}${r.reason.slice(0, 60)}${c.reset}`,
    );
  }

  for (const { candidate, identity } of kept) {
    const source = raw.find((r) => r.sourceUrl === candidate.url);
    repos.sales.discover({
      batchId,
      companyName: identity.companyName,
      domain: identity.canonicalDomain,
      website: identity.officialWebsite,
      country: identity.country,
      sourceUrl: candidate.url,
      searchProvider: source?.searchProvider ?? null,
      query: source?.query ?? null,
      discoveredAt: source?.discoveredAt ?? new Date().toISOString(),
      searchTitle: candidate.searchTitle,
      pageType: 'OFFICIAL_COMPANY_SITE',
      identityConfidence: identity.identityConfidence,
      identitySources: identity.identitySources,
      guardVersion: GUARD_VERSION,
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

    const source = kept.find((k) => k.identity.canonicalDomain === prospect.domain);
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
                `# Ce que la recherche a rapporté\n${source?.candidate.snippet ?? '(aucun résumé)'}\n` +
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
      // La source rendue par le modèle est vérifiée contre le domaine officiel.
      // Le lot 005 a attribué « PME française fondée en 1976 » à
      // `groupe-ravel.com` pour une entreprise dont le domaine est
      // `groupe-reval.com` : une lettre d'écart, et le fait cesse d'être
      // vérifiable. Un fait « observé » l'est sur le site de l'entreprise ou
      // ne l'est pas — hors domaine, il redevient rapporté, et sa source est
      // remplacée par celle qu'on connaît.
      const claimed = signal.sourceUrl?.startsWith('http') ? signal.sourceUrl : null;
      const onOfficialSite = claimed ? isOfficialPage(claimed, prospect.domain!) : false;
      const nature = signal.nature === 'observed' && !onOfficialSite ? 'reported' : signal.nature;
      repos.sales.addEvidence({
        prospectId: prospect.id,
        field: signal.field,
        claim: signal.claim,
        nature,
        // Les parametres de suivi marketing ne survivent pas a l'enregistrement :
        // colles dans un courriel, ils se periment et signalent le pistage.
        sourceUrl: canonicalUrl(onOfficialSite ? claimed : prospect.sourceUrl),
        basis:
          nature === 'inferred'
            ? 'Déduit du texte rapporté par la recherche.'
            : claimed && !onOfficialSite
              ? `Source annoncée « ${claimed} » hors du domaine officiel : le fait n'est pas constaté sur le site.`
              : null,
        confidence: onOfficialSite ? 0.7 : 0.5,
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
    // Ce que le modèle croit savoir d'un contact n'est pas écrit : une adresse
    // rendue par un modèle est plausible, et une adresse plausible est
    // indéfendable. La résolution de contacts, plus bas, lit les pages.
    void parsed.contact;

    repos.sales.setState(prospect.id, score.tier === 'REJECTED' ? 'REJECTED' : 'QUALIFIED', {
      rejectReason: score.tier === 'REJECTED' ? `score ${score.total} sous le seuil` : null,
    });

    console.log(
      `    ${score.tier === 'REJECTED' ? `${c.dim}·${c.reset}` : `${c.green}✓${c.reset}`} ` +
        `${prospect.companyName.slice(0, 34).padEnd(36)}${String(score.total).padStart(6)} · ${score.tier}`,
    );
  }

  // ── Contacts : lus sur le site officiel, jamais devinés ──────────────────
  //
  // Le lot 003 a rendu « aucun contact publié » pour deux entreprises qui en
  // publient : l'extraction exigeait que l'adresse porte le domaine du site.
  // La règle porte désormais sur la page. Rien ici n'appelle le modèle.
  console.log(`
  ${c.bold}Contacts${c.reset}`);
  // Les pages lues ici sont conservées : l'enrichissement qui suit commence
  // par elles. Les jeter puis les redemander doublerait les requêtes pour lire
  // exactement le même HTML — et c'est précisément ce que faisait ce lot.
  const readPages = new Map<string, ContactPage[]>();

  for (const prospect of repos.sales.forBatch(batchId).filter((p) => p.state === 'QUALIFIED')) {
    const domain = prospect.domain!;
    const queue = contactPagesFor(prospect.website, domain);
    const seen = new Set<string>();
    const pages: ContactPage[] = [];

    for (let pass = 0; pass < 2; pass++) {
      const batch = queue.filter((u) => !seen.has(u));
      for (const u of batch) seen.add(u);
      if (batch.length === 0) break;
      const fetched = await fetchRawPages(batch, {
        logger: system.logger,
        timeoutMs: 12_000,
        // Le plafond était écrit 8 en dur ici, alors que la configuration en
        // porte un. Les deux valaient huit, donc rien ne le signalait ; changer
        // le réglage n'aurait simplement rien fait.
        maxPages: Math.max(0, config.sales.maxPagesPerDomain - pages.length),
      });
      compteReseau(fetched);
      pages.push(...fetched.pages);
      if (pass === 0) {
        const home = fetched.pages.find((page) => new URL(page.url).pathname === '/');
        if (home) {
          for (const link of contactLinksIn(home.html, home.url, domain)) {
            if (!seen.has(link)) queue.push(link);
          }
        }
      }
    }

    readPages.set(prospect.id, pages);

    const contacts = resolveContacts({ officialDomain: domain, pages });
    if (contacts.primary) {
      /*
       * Le contact RETENU, pas le premier trouve.
       *
       * Cette ligne prenait `publicEmails[0]` — l'adresse brute, dans l'ordre
       * ou elle apparaissait sur la page. La selection par intention
       * (`selectOutreachContact`, qui ecarte les boites juridiques, support,
       * RGPD et personnelles) etait donc calculee puis ignoree.
       *
       * Consequence reelle : Fujielectric est arrive en READY_FOR_REVIEW avec
       * `nadia.dasilva@fujielectric.fr`, une adresse personnelle relevee dans
       * les mentions legales. Ecrire a une personne nommee sans fonction
       * publiee, sur une adresse trouvee dans un avis juridique, est exactement
       * ce que la garde existait pour empecher.
       *
       * La meme garde protege desormais les deux chemins, batch et boucle.
       */
      const retenu = contacts.primary;
      const commercial = retenu.suitability !== 'LOW' && retenu.intent !== 'PERSONAL';
      const email = retenu.type === 'EMAIL' && commercial ? retenu : null;
      const phone = retenu.type === 'PHONE' ? retenu : contacts.publicPhones[0] ?? null;

      if (!commercial) {
        console.log(
          `       ${c.amber}canal ecarte${c.reset} ${c.dim}${retenu.intent} / ${retenu.suitability} — ` +
            `aucun brouillon commercial sur cette adresse${c.reset}`,
        );
      }

      repos.sales.setContact(prospect.id, {
        name: contacts.contactPersonName,
        role: contacts.contactPersonRole,
        email: email?.value ?? null,
        phone: phone?.value ?? null,
        contactPage: contacts.contactFormUrl?.value ?? null,
        sourceUrl: contacts.primary.sourceUrl,
        confidence: contacts.primary.confidence === 'HIGH' ? 0.9
          : contacts.primary.confidence === 'MEDIUM' ? 0.7 : 0.5,
        method: contacts.method,
        confidenceLabel: contacts.primary.confidence,
        observed: true,
      });
    }
    console.log(
      `    ${contacts.primary ? `${c.green}✓${c.reset}` : `${c.dim}·${c.reset}`} ` +
        `${prospect.companyName.slice(0, 30).padEnd(32)}${contacts.method.padEnd(6)} ` +
        `${c.dim}${(contacts.primary?.value ?? 'aucun canal public relevé').slice(0, 42)}${c.reset}`,
    );
  }

  // ── Enrichissement : les faits qui manquent, lus sur le site ─────────────
  //
  // Le lot précédent a qualifié huit entreprises, en a retenu une en PRIORITY,
  // et n'a produit aucun brouillon : zéro fait constaté et sourcé, alors que
  // l'étape ci-dessus venait de lire leurs pages. La garde des deux faits n'a
  // pas été touchée — c'est la collecte qui était aveugle.
  //
  // Seuls les PRIORITY passent ici. Élargir la profondeur à tout le monde
  // multiplierait les requêtes sur des dossiers dont aucun brouillon ne peut
  // sortir, et ferait payer en temps ce qui ne change aucune décision.
  const enrichmentStart = spendOf(repos, mission.id, startedAt);
  const enrichment = new Map<string, EnrichmentOutcome>();
  const toEnrich = repos.sales
    .forBatch(batchId)
    .filter((p) => p.state === 'QUALIFIED' && p.tier === 'PRIORITY' && p.domain);

  if (toEnrich.length > 0) {
    console.log(`\n  ${c.bold}Enrichissement PRIORITY${c.reset} ${c.dim}` +
      `${config.sales.maxPagesPerPriorityDomain} pages max · arrêt à 2 faits distincts · aucun modèle${c.reset}`);
  }

  for (const prospect of toEnrich) {
    const domain = prospect.domain!;
    const already = repos.sales
      .evidenceFor(prospect.id)
      .filter((e) => e.nature === 'observed' && e.sourceUrl && !e.field.startsWith('identite:')).length;

    const outcome = await collectSourcedFacts({
      website: prospect.website,
      domain,
      maxPages: config.sales.maxPagesPerPriorityDomain,
      targetFacts: Math.max(0, 2 - already),
      seedPages: readPages.get(prospect.id) ?? [],
      deadline: Date.now() + 90_000,
      fetchPages: async (urls, maxPages) => {
        const o = await fetchRawPages(urls, { logger: system.logger, timeoutMs: 12_000, maxPages });
        compteReseau(o);
        return o;
      },
    });
    enrichment.set(prospect.id, outcome);

    // Chaque fait est écrit comme constaté, avec l'adresse de la page où il a
    // été lu — jamais celle du résultat de recherche. C'est cette distinction
    // qui rend le fait vérifiable par le destinataire lui-même.
    /**
     * La raison sociale, lue la ou la loi oblige a l'ecrire.
     *
     * Deux prospects du lot precedent avaient leurs deux faits sources et n'ont
     * produit aucun brouillon : leur nom venait du titre d'un resultat de
     * recherche, et la garde d'identite refuse — a raison — d'ecrire a une
     * entreprise dont le nom n'est confirme par rien.
     *
     * Cette lecture ne touche pas la garde : elle lui apporte la preuve qu'elle
     * reclame. Trois pages au plus, aucun appel de modele.
     */
    const identiteConfirmee = await (async () => {
      const dejaSur = new Set((readPages.get(prospect.id) ?? []).map((pg) => pg.url));
      const accueil = (readPages.get(prospect.id) ?? [])[0];
      const candidates = [
        ...(accueil ? legalLinksIn(accueil.html, accueil.url, domain) : []),
        ...legalPagesFor(prospect.website, domain),
      ].filter((u) => !dejaSur.has(u));

      // Les pages deja en main d'abord : elles ne coutent rien.
      const dejaLues = readPages.get(prospect.id) ?? [];
      const trouve = extractLegalIdentity(dejaLues, domain);
      if (trouve) return trouve;

      // Une seule page suffit : les chemins conventionnels redirigent tous vers
      // la meme, et `fetchRawPages` s'arrete au premier succes. Demander trois
      // pages payait trois requetes pour lire le meme document.
      const fetched = await fetchRawPages(candidates, {
        logger: system.logger, timeoutMs: 12_000, maxPages: 1,
      });
      compteReseau(fetched);
      return extractLegalIdentity(fetched.pages, domain);
    })();

    if (identiteConfirmee) {
      const niveau = confidenceFromLegal(identiteConfirmee);
      const verdict = repos.sales.confirmIdentity(prospect.id, {
        legalName: identiteConfirmee.legalName,
        confidence: niveau,
        source: `mentions legales (${identiteConfirmee.sourceUrl})`,
      });
      repos.sales.addEvidence({
        prospectId: prospect.id,
        // L'entite juridique est une preuve d'identite du domaine, pas le nom
        // auquel on ecrit : le champ le dit, pour qu'aucune relecture ne s'y
        // trompe.
        field: 'identite:entite_juridique',
        claim: `${identiteConfirmee.legalName}${identiteConfirmee.legalForm ? ' ' + identiteConfirmee.legalForm : ''}`
          + (identiteConfirmee.registration ? ` — ${identiteConfirmee.registration}` : ''),
        nature: 'observed',
        sourceUrl: identiteConfirmee.sourceUrl,
        basis: identiteConfirmee.basis,
        confidence: niveau,
      });
      console.log(
        `       ${c.green}identite${c.reset} ${identiteConfirmee.legalName}` +
          `${identiteConfirmee.legalForm ? ' ' + identiteConfirmee.legalForm : ''} ` +
          `${c.dim}${niveau} · ${verdict.applied ? 'confirmee' : verdict.reason}${c.reset}`,
      );
    }

    /*
     * Le pays, etabli sur les pages deja lues.
     *
     * Aucune requete supplementaire : les memes pages qui portent la raison
     * sociale portent l'adresse. Si rien ne le dit, le pays reste `null` et le
     * profil traitera le dossier comme « a verifier » -- ce qu'il est.
     */
    /*
     * La corroboration plutot que la preuve isolee.
     *
     * `extractCountryEvidence` ne voit que les preuves directes -- adresse,
     * identifiant national, metadonnee. Beaucoup de sites francais n'en
     * publient aucune aux chemins conventionnels et ressortaient UNKNOWN alors
     * qu'ils affichaient un numero en +33 et le mot France sur leur page
     * contact. Deux signaux secondaires concordants valent desormais une
     * preuve ; un seul ne vaut toujours rien, et le `.fr` n'entre nulle part.
     */
    const pagesLues = readPages.get(prospect.id) ?? [];
    const paysCorrobore = corroborateCountry(collectCountrySignals(pagesLues));
    const paysLu = extractCountryEvidence(pagesLues);
    const paysSource = paysLu.sourceUrl
      ?? paysCorrobore.signals.find((x) => !x.corroborationOnly)?.sourceUrl
      ?? paysCorrobore.signals[0]?.sourceUrl
      ?? null;
    if (paysCorrobore.country && paysSource) {
      repos.sales.setCountry(prospect.id, {
        country: paysCorrobore.country,
        basis: paysLu.basis === 'NONE' ? 'CORROBORATION' : paysLu.basis,
        sourceUrl: paysSource,
      });
      const fit = countryFit(paysCorrobore.country, ATLAS_SALES_ICP.countries);
      const teinte = fit.fit === 'IN_SCOPE' ? c.green : c.amber;
      console.log(`       ${teinte}pays${c.reset} ${paysCorrobore.country} ${c.dim}${paysCorrobore.reason.slice(0, 70)}${c.reset}`);
    } else {
      console.log(`       ${c.dim}pays     UNKNOWN — ${paysCorrobore.reason.slice(0, 70)}${c.reset}`);
    }

    /*
     * L'identite, lue dans les pages et jamais dans le titre du moteur.
     *
     * Le nom venait du titre du resultat de recherche : pour nincar.com il
     * commencait par « Sous-traitance… » et la base a enregistre une entreprise
     * appelee « Sous ». Treize citations verbatim parfaitement verifiees n'ont
     * produit aucun brouillon, la garde d'identite refusant -- a raison --
     * d'ecrire a une societe dont le nom n'etait confirme par rien.
     *
     * `confirmIdentity` ne renomme jamais : il eleve la confiance et consigne
     * ses sources. Le nom commercial affiche reste celui de la decouverte, et
     * le nom corrobore vit comme preuve a cote.
     */
    const signaux = collectIdentitySignals(pagesLues);
    const identite = corroborateIdentity(signaux, prospect.domain ?? '');
    if (identite.name && identite.confidence >= 0.75) {
      repos.sales.confirmIdentity(prospect.id, {
        legalName: identite.name,
        confidence: identite.confidence,
        source: `identite corroboree (${[...new Set(identite.supporting.map((x) => x.sourceType))].join(', ')})`,
      });
      console.log(`       ${c.green}identite${c.reset} « ${identite.name} » ${c.dim}${identite.confidence} — ${identite.reason.slice(0, 56)}${c.reset}`);
    } else if (signaux.length > 0) {
      console.log(`       ${c.dim}identite « ${identite.name ?? 'aucune'} » ${identite.confidence} — ${identite.reason.slice(0, 56)}${c.reset}`);
    }

    const dejaEcrites = new Set(
      repos.sales.evidenceFor(prospect.id).map((e) => e.claim.trim()),
    );
    for (const fact of outcome.facts) {
      // La table est append-only : une seconde passe réécrirait la même phrase
      // sous un second identifiant, et le compte de faits doublerait sans
      // qu'un seul fait de plus ait été constaté.
      if (dejaEcrites.has(fact.claim.trim())) continue;
      repos.sales.addEvidence({
        prospectId: prospect.id,
        field: `signal:${fact.kind.toLowerCase()}`,
        claim: fact.claim,
        nature: 'observed',
        sourceUrl: canonicalUrl(fact.sourceUrl),
        basis: `Relevé sur ${fact.sourceUrl} — motif « ${fact.marker} ».`,
        confidence: 0.8,
      });
    }

    console.log(
      `    ${outcome.factsFound > 0 ? `${c.green}✓${c.reset}` : `${c.dim}·${c.reset}`} ` +
        `${prospect.companyName.slice(0, 28).padEnd(30)}` +
        `FACTS ${String(already + outcome.factsFound).padStart(2)} · ` +
        `PAGES ${String(outcome.pagesVisited).padStart(2)} ` +
        `${c.dim}(${outcome.pagesReused} reprises, +${outcome.pagesFetchedExtra} nouvelles) · ${outcome.earlyStopReason}${c.reset}`,
    );
    for (const fact of outcome.facts) {
      console.log(`       ${c.dim}« ${fact.claim.slice(0, 88)} » ${fact.sourceUrl.slice(0, 60)}${c.reset}`);
    }
  }
  const enrichmentCost = spendOf(repos, mission.id, startedAt) - enrichmentStart;

  // ── Approche : un brouillon par PRIORITY, sur un fait sourcé ─────────────
  // Relecture apres l'enrichissement : une identite confirmee a pu remplacer
  // le nom et remonter la confiance, et c'est cette version que la garde doit
  // examiner — pas celle qu'on avait avant d'aller lire les mentions legales.
  const qualified = repos.sales.forBatch(batchId).filter((p) => p.state === 'QUALIFIED');

  // Le score ne suffit pas à faire un PRIORITY. Le lot 002 en a produit deux à
  // 73 et 71 : l'un était l'éditeur d'une étude de marché, l'autre une agence
  // de communication. Un score élevé sur un objet mal identifié reste un score
  // élevé — c'est l'identification qui doit précéder, et cette garde le vérifie
  // une dernière fois avant qu'un brouillon existe.
  /*
   * Les preuves verbatim, sur les pages deja lues.
   *
   * La qualification ne recoit que l'extrait du moteur de recherche : on lui
   * demandait des « faits observes » sur un texte qu'elle n'avait jamais lu, et
   * elle rendait des reformulations. Vingt-cinq entreprises, huit PRIORITY,
   * zero brouillon -- chaque fait echouait a la verification entre 50 et 75 %.
   *
   * Ici les pages sont en main. Elles sont decoupees en passages numerotes, le
   * modele en designe quelques-uns, et la citation est relue a ce numero. Le
   * modele n'a aucun champ ou ecrire une phrase de la page.
   *
   * Un seul appel par PRIORITY -- il n'y en a qu'un ou deux par cycle -- et il
   * remplace des faits qui ne servaient a rien.
   */
  const verbatim = new Map<string, SourcedEvidence[]>();
  let verbatimCalls = 0;
  const verbatimAvant = spendOf(repos, mission.id, startedAt);

  for (const p of qualified.filter((x) => x.tier === 'PRIORITY')) {
    const pages = readPages.get(p.id) ?? [];
    if (pages.length === 0) continue;
    if (spendOf(repos, mission.id, startedAt) >= MAX_COST_USD) {
      console.log(`    ${c.red}plafond atteint — pas de preuve verbatim${c.reset}`);
      break;
    }
    const catalogue = buildBlockCatalogue(pages);
    if (catalogue.size === 0) continue;

    let selections: BlockSelection[] = [];
    try {
      const reponse = await system.provider.complete({
        model: MODEL,
        system: VERBATIM_SYSTEM,
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: `# Entreprise
${p.companyName}
${p.website ?? p.domain}

# Passages${catalogue.text}`,
          }],
        }],
        jsonSchema: VERBATIM_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 1200,
        meta: {
          missionId: mission.id, taskRef: 'verbatim-evidence', agentKey: 'ambassador',
          purpose: 'sales-verbatim-evidence', subject: p.id, evidenceCount: null,
        },
      });
      verbatimCalls += 1;
      const brut = textOf(reponse.content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const a = brut.indexOf('{');
      const b = brut.lastIndexOf('}');
      if (a >= 0 && b > a) {
        selections = (JSON.parse(brut.slice(a, b + 1)) as { selections?: BlockSelection[] }).selections ?? [];
      }
    } catch (err) {
      console.log(`    ${c.amber}·${c.reset} ${p.companyName.slice(0, 30)} — selection impossible : ${(err as Error).message.slice(0, 40)}`);
      continue;
    }

    const { evidence, rejected } = resolveSelections(selections, catalogue);
    for (const r of rejected) console.log(`    ${c.red}refuse${c.reset} ${c.dim}${r.slice(0, 66)}${c.reset}`);
    const commerciaux = distinctCommercialFacts(evidence);
    verbatim.set(p.id, commerciaux);
    console.log(`    ${commerciaux.length >= MIN_COMMERCIAL_FACTS ? c.green : c.amber}${commerciaux.length} fait(s) verbatim${c.reset} ${c.dim}${p.companyName.slice(0, 34)}${c.reset}`);

    // Les citations rejoignent les preuves : elles se relisent plus tard.
    const dejaLa = new Set(repos.sales.evidenceFor(p.id).map((e) => e.claim.trim()));
    for (const f of commerciaux) {
      if (dejaLa.has(f.evidenceQuote.trim())) continue;
      repos.sales.addEvidence({
        prospectId: p.id,
        field: `verbatim:${f.blockId}`,
        claim: f.evidenceQuote,
        nature: 'observed',
        sourceUrl: f.sourceUrl,
        basis: `${INTERPRETATION_PREFIX}${f.normalizedClaim}${f.sourcePageTitle ? ` — page « ${f.sourcePageTitle} »` : ''}`,
        confidence: 0.9,
      });
    }
  }
  const verbatimCost = spendOf(repos, mission.id, startedAt) - verbatimAvant;

  const priority: typeof qualified = [];
  for (const p of qualified) {
    if (p.tier !== 'PRIORITY') continue;
    // Une preuve d'identite n'est pas un fait commercial : elle etablit qui
    // edite le domaine, pas ce que l'entreprise fait.
    const observed = repos.sales
      .evidenceFor(p.id)
      .filter((e) => e.nature === 'observed' && e.sourceUrl && !e.field.startsWith('identite:'));
    const check = checkPriorityEligibility({
      identity: p.identityConfidence != null && p.domain
        ? {
            companyName: p.companyName,
            canonicalDomain: p.domain,
            officialWebsite: p.website ?? `https://${p.domain}`,
            country: p.country,
            identityConfidence: p.identityConfidence,
            identitySources: p.identitySources ?? [],
          }
        : null,
      pageType: (p.pageType as 'OFFICIAL_COMPANY_SITE') ?? 'UNKNOWN',
      icp: 'MATCH',
      observedFacts: observed.length,
      score: p.score ?? 0,
      scoreThreshold: SALES_TIER_THRESHOLDS.priority,
      hasSourcedPersonalization: observed.length > 0,
    });
    const hasContact = p.contactObserved && Boolean(p.contactEmail || p.contactPage || p.contactPhone);
    if (!hasContact) check.blockers.push('aucun canal de contact public observé');
    if (!check.eligible || !hasContact) {
      console.log(`    ${c.amber}rétrogradé${c.reset} ${p.companyName.slice(0, 32).padEnd(34)} ${c.dim}${check.blockers.join(' · ').slice(0, 60)}${c.reset}`);
      repos.sales.setScore(p.id, { score: p.score ?? 0, tier: 'GOOD_FIT', detail: p.scoreDetail ?? {}, whyFit: p.whyFit ?? '' });
      continue;
    }
    if (priority.length < MAX_PRIORITY) priority.push(p);
  }

  console.log(`\n  ${c.bold}Brouillons d'approche${c.reset}`);
  let drafts = 0;
  for (const prospect of priority) {
    /*
     * Seuls les faits reellement retrouvables dans leur source peuvent etre
     * cites.
     *
     * Le message ecrit « j'ai releve ceci, publie sur votre site ». Deux
     * natures de texte se melangeaient dans les preuves : ce qu'un extracteur a
     * lu mot pour mot, et ce qu'un modele a resume apres lecture. Les deux
     * portaient `observed` et une adresse source. Fujielectric citait ainsi
     * « Integrateur d'automatisme industriel avec solutions IOT et maintenance
     * predictive » — un resume, introuvable tel quel sur la page.
     *
     * La verification se fait sur les pages deja en main : elle ne coute aucune
     * requete.
     */
    const texteDesPages = new Map<string, string>();
    for (const pg of readPages.get(prospect.id) ?? []) {
      texteDesPages.set(canonicalUrl(pg.url) ?? pg.url, readableText(pg.html));
    }

    /*
     * Les preuves verbatim d'abord.
     *
     * Quand l'etape de selection a produit des citations, elles sont deja
     * verifiees par construction : le texte vient du bloc, et le bloc a ete
     * relu dans sa page. Les comparer a 80 % n'apprendrait rien -- une phrase
     * comparee a elle-meme.
     *
     * Le chemin d'apres reste en place pour les preuves anciennes, ecrites en
     * texte libre : celles-la doivent toujours se retrouver dans leur source.
     */
    const citations = verbatim.get(prospect.id) ?? [];
    if (citations.length >= MIN_COMMERCIAL_FACTS) {
      const parCitation = new Map(
        repos.sales.evidenceFor(prospect.id).map((e) => [e.claim.trim(), e.id]),
      );
      /*
       * L'interpretation voyage avec la citation.
       *
       * Elle etait ecrite dans `basis` deux lignes plus bas, puis oubliee ici :
       * le generateur recevait des citations nues, ne trouvait aucune
       * observation lisible, et refusait chaque brouillon. La donnee etait la,
       * a portee de main, jamais transmise.
       */
      const factsVerbatim: OutreachFact[] = citations.map((f) => ({
        evidenceId: parCitation.get(f.evidenceQuote.trim()) ?? '',
        claim: f.evidenceQuote,
        sourceUrl: f.sourceUrl,
        nature: 'observed' as const,
        // Relue au numero du passage : c'est la definition meme de ce chemin.
        verbatim: true,
        normalizedClaim: f.normalizedClaim,
      })).filter((f) => f.evidenceId !== '');

      if (factsVerbatim.length >= MIN_COMMERCIAL_FACTS) {
        const sortie = buildOutreachDraft({
          company: prospect.companyName,
          website: prospect.website,
          facts: factsVerbatim,
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
          senderName: config.sales.senderName,
          offer: { priceEur: 49, deliveryHours: 24 },
        });
        /*
         * Le controle d'humanisation, avant que le dossier soit relisible.
         *
         * La regle vit dans `docs/SALES_HUMANIZATION_POLICY.md` ; ce qui en est
         * verifiable est applique ici. Il vient APRES la verification
         * factuelle : un message chaleureux et faux reste faux, et aucune des
         * gardes precedentes n'est assouplie par ce controle.
         *
         * Seul `BLOCKED` arrete -- ce qui se lit franchement comme une machine.
         * `NEEDS_EDIT` laisse passer avec sa remarque : c'est le role
         * d'Approvals de trancher le style, pas celui d'un lot nocturne.
         */
        const humain = sortie.draft
          ? checkHumanization({ body: sortie.draft.messageEmail, kind: 'FIRST_TOUCH' })
          : null;
        if (humain && humain.verdict === 'BLOCKED') {
          console.log(`    ${c.amber}·${c.reset} ${prospect.companyName.slice(0, 30)} — humanisation : ${humain.blockers[0]?.slice(0, 50)}`);
          continue;
        }
        if (humain && humain.remarks.length > 0) {
          console.log(`    ${c.dim}  humanisation NEEDS_EDIT : ${humain.remarks[0]?.slice(0, 60)}${c.reset}`);
        }
        if (sortie.draft) {
          repos.sales.setOutreach(prospect.id, {
            personalizationFactId: sortie.draft.personalizationFact.evidenceId,
            messageShort: sortie.draft.messageShort,
            messageEmail: sortie.draft.messageEmail,
            sourceUrl: sortie.draft.sourceUsedForPersonalization,
          });
          /*
           * L'objet, pose ici et sans appel de modele.
           *
           * Trois brouillons complets sont restes bloques faute d'une ligne de
           * sujet : un courriel sans objet arrive comme un envoi automatique.
           * Il se deduit de ce qui est deja verifie.
           */
          repos.sales.reviseOutreachText(prospect.id, {
            // L'objet vient du brouillon : un seul generateur, un seul resultat.
            subject: sortie.draft.subject,
          });
          repos.sales.setState(prospect.id, 'READY_FOR_REVIEW');
          drafts++;
          console.log(`    ${c.green}✓${c.reset} ${prospect.companyName.slice(0, 34)} ${c.dim}${citations.length} citation(s) verbatim${c.reset}`);
          continue;
        }
        console.log(`    ${c.amber}·${c.reset} ${prospect.companyName.slice(0, 30)} — ${sortie.reason.slice(0, 50)}`);
        continue;
      }
    }

    const facts: OutreachFact[] = repos.sales
      .evidenceFor(prospect.id)
      /*
       * Une preuve d'identite n'est pas un fait commercial.
       *
       * Cette exclusion existait dans l'audit, dans la vue d'approbation et
       * dans le controle d'eligibilite ; elle manquait ici, au seul endroit qui
       * ecrit le message. Sur igus.fr, le seul element verifie a 100 % etait
       * `identite:entite_juridique` = « IGUS SAS » -- le courriel aurait annonce
       * « j'ai releve ceci, publie sur votre site : IGUS SAS ».
       *
       * La regle est celle des autres chemins, mot pour mot.
       */
      .filter((e) => isCommercialEvidence(e))
      .filter((e) => e.sourceUrl)
      .filter((e) => {
        const texte = texteDesPages.get(canonicalUrl(e.sourceUrl!) ?? e.sourceUrl!);
        // Page non relue dans ce cycle : on ne peut ni confirmer ni infirmer,
        // et on ne cite pas ce qu'on ne peut pas verifier.
        if (texte === undefined) return false;
        return verifyClaimAgainstSource(e.claim, texte).verifiable;
      })
      // Le meme lecteur que partout ailleurs : l'interpretation rangee dans
      // `basis` revient au generateur au lieu d'etre perdue.
      .map((e) => outreachFactFrom(e));

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
      senderName: config.sales.senderName,
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

  // L'enrichissement, mesuré et non supposé. Le coût est lu dans le registre
  // des appels, pas affirmé à zéro : si quelqu'un branche un modèle ici un
  // jour, le chiffre le dira au lieu de mentir par construction.
  if (enrichment.size > 0) {
    say(`  ${c.bold}ENRICHISSEMENT PRIORITY${c.reset}`);
    for (const [prospectId, outcome] of enrichment) {
      const p = all.find((x) => x.id === prospectId);
      const sourced = repos.sales
        .evidenceFor(prospectId)
        .filter((e) => e.nature === 'observed' && e.sourceUrl).length;
      say(`    ${p?.companyName ?? prospectId}`);
      say(`      FACTS_FOUND:       ${sourced} fait(s) constaté(s) et sourcé(s)`);
      // Trois mesures distinctes plutôt qu'une ambiguë : « 0 page visitée »
      // a décrit un prospect dont quatre pages avaient bien été lues, mais par
      // l'étape précédente. Le total, la reprise et le coût réel se lisent
      // maintenant séparément.
      say(`      PAGES_VISITED:      ${outcome.pagesVisited}`);
      say(`      PAGES_REUSED:       ${outcome.pagesReused} (déjà chargées par l'étape contacts)`);
      say(`      PAGES_FETCHED_EXTRA:${String(outcome.pagesFetchedExtra).padStart(3)} (${outcome.fetchFailures} adresse(s) sans réponse)`);
      say(`      EARLY_STOP_REASON: ${outcome.earlyStopReason}`);
      for (const fact of outcome.facts) {
        say(`      · « ${fact.claim.slice(0, 100)} »`);
        say(`        ${fact.sourceUrl}`);
      }
    }
    say(`    ENRICHMENT_COST:     ${enrichmentCost.toFixed(4)} $ ` +
      `${enrichmentCost === 0 ? '(aucun appel de modèle : extraction déterministe)' : ''}`);
    say();
  }

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
  // Ce que la preuve verbatim a coute, distinct du reste : c'est la seule
  // depense ajoutee par le nouveau chemin, et elle doit se lire seule.
  say(`  MODEL CALLS:       ${llmCalls + verbatimCalls} (${llmCalls} qualification · ${verbatimCalls} preuve verbatim)`);
  say(`  EVIDENCE COST:     ${verbatimCost.toFixed(5)} $`);
  say(`  TOTAL DRAFT COST:  ${drafts > 0 ? (cost / drafts).toFixed(5) : '—'} $ par brouillon`);
  say(`  DURÉE:           ${formatDuration(Date.now() - started)}`);
  say();
  // ── Fiabilite du cycle ───────────────────────────────────────────────────
  const contacts = all.filter((p) => p.contactObserved && (p.contactEmail || p.contactPhone || p.contactPage)).length;
  const identites = all.filter((p) => (p.identityConfidence ?? 0) >= 0.75).length;
  const faits2 = all.filter((p) => repos.sales.evidenceFor(p.id)
    .filter((e) => e.nature === 'observed' && e.sourceUrl && !e.field.startsWith('identite:')).length >= 2).length;

  say(`  DOMAIN_FETCH_ATTEMPTS:  ${reseau.attempts}`);
  say(`  DOMAIN_FETCH_ABORTS:    ${reseau.aborts}${reseau.abortedHosts.length ? '  ' + reseau.abortedHosts.join(', ') : ''}`);
  say(`  TIME_SAVED_ESTIMATE:    ${Math.round(reseau.timeSavedMs / 1000)} s`);
  say(`  CONTACTS_FOUND:         ${contacts}`);
  say(`  IDENTITIES_VERIFIED:    ${identites}`);
  say(`  FACTS_VALID:            ${faits2}`);
  say(`  DRAFT_ELIGIBLE:         ${priority.length}`);
  say(`  READY_FOR_REVIEW_CREATED: ${drafts}`);
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
