import { z } from 'zod';
import type { Department, SourceKind } from '@atlas/contracts';
import { FAILED_SEARCH_OUTCOMES, UNREPEATABLE_SEARCH_OUTCOMES } from '@atlas/intelligence';
import type { AtlasTool, ToolContext } from './tool-types.ts';
import { ok, fail } from './tool-types.ts';

/**
 * The tools that drive an intelligence pipeline.
 *
 * They are department-agnostic on purpose: none of them knows what a
 * distributor is. Each one hands the agent's judgement to the platform, which
 * then applies the guarantees the agent must not be able to skip —
 * deduplication, evidence discipline, verification before qualification, and
 * arithmetic behind every score.
 *
 * Note what these tools do *not* let an agent do: assert an evidence-quality
 * score, qualify a candidate on inference alone, or hand back a total that is
 * not the sum of its parts.
 */

const SOURCE_KINDS = [
  'company-website',
  'directory',
  'registry',
  'press',
  'social',
  'dataset',
  'model-inference',
  'founder',
] as const satisfies readonly SourceKind[];

/** Resolves the department that owns the current mission, if any. */
function departmentFor(ctx: ToolContext): Department | null {
  if (!ctx.missionId) return null;
  const mission = ctx.repos.missions.get(ctx.missionId);
  if (!mission?.departmentKey) return null;
  return ctx.repos.departments.get(mission.departmentKey);
}

/** Every tool here needs both a mission and the intelligence service. */
function requireContext(
  ctx: ToolContext,
): { department: Department; missionId: string } | { error: string } {
  if (!ctx.intelligence) {
    return { error: 'The intelligence pipeline is not available in this deployment.' };
  }
  if (!ctx.missionId) return { error: 'This tool can only be used inside a mission.' };

  const department = departmentFor(ctx);
  if (!department) {
    return {
      error:
        'This mission does not belong to a department, so there is no pipeline to write into. ' +
        'Report your findings in text instead.',
    };
  }
  return { department, missionId: ctx.missionId };
}

// ─── Discovery ──────────────────────────────────────────────────────────────

const candidateSchema = z.object({
  name: z.string().min(2).max(160),
  website: z.string().max(300).nullish(),
  country: z.string().max(60).nullish(),
  region: z.string().max(80).nullish(),
  city: z.string().max(80).nullish(),
  industries: z.array(z.string().max(120)).max(6).optional(),
  description: z.string().max(1000).nullish(),
  sourceKind: z.enum(SOURCE_KINDS).optional(),
  sourceRef: z.string().max(500).nullish(),
  sourceTitle: z.string().max(200).nullish(),
  rationale: z.string().max(600).nullish(),
});

const discoverCompanies: AtlasTool<{
  targetTypes: string[];
  countries: string[];
  industries?: string[];
  keywords?: string[];
  exclusions?: string[];
  limit?: number;
}> = {
  name: 'discover_companies',
  description:
    "Recherche des organisations réelles correspondant au profil demandé et les enregistre pour cette mission. " +
    "Vous décrivez CE QUE vous cherchez ; ATLAS interroge ses sources, déduplique et conserve la provenance de chaque résultat. " +
    "Vous ne fournissez pas la liste des entreprises : c'est ATLAS qui la trouve, à partir de sources citées.",
  category: 'research',
  inputSchema: {
    type: 'object',
    properties: {
      targetTypes: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: { type: 'string', maxLength: 40 },
        description:
          "Les rôles recherchés, tels qu'indiqués dans votre brief. Une même organisation peut correspondre à plusieurs.",
      },
      countries: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: { type: 'string', maxLength: 60 },
        description: 'Pays ou marchés visés',
      },
      industries: {
        type: 'array',
        maxItems: 8,
        items: { type: 'string', maxLength: 120 },
        description: 'Secteurs des clients finaux',
      },
      keywords: {
        type: 'array',
        maxItems: 10,
        items: { type: 'string', maxLength: 80 },
        description: 'Termes métier utiles à la recherche (gamme, technologie, vocabulaire local)',
      },
      exclusions: {
        type: 'array',
        maxItems: 8,
        items: { type: 'string', maxLength: 160 },
        description: 'Ce qui disqualifie un candidat',
      },
      limit: { type: 'integer', minimum: 1, maximum: 60, description: 'Nombre de candidats visé' },
    },
    required: ['targetTypes', 'countries'],
    additionalProperties: false,
  },
  parse: z.object({
    targetTypes: z.array(z.string().max(40)).min(1).max(6),
    countries: z.array(z.string().max(60)).min(1).max(8),
    industries: z.array(z.string().max(120)).max(8).optional(),
    keywords: z.array(z.string().max(80)).max(10).optional(),
    exclusions: z.array(z.string().max(160)).max(8).optional(),
    limit: z.number().int().min(1).max(60).optional(),
  }),
  async execute(input, ctx) {
    const resolved = requireContext(ctx);
    if ('error' in resolved) return fail(resolved.error);
    if (!ctx.discovery) return fail("Aucun provider de découverte n'est configuré sur ce déploiement.");

    const known = new Map(resolved.department.targetTypes.map((t) => [t.key, t]));
    const unknown = input.targetTypes.filter((key) => !known.has(key));
    if (known.size > 0 && unknown.length > 0) {
      return fail(
        `Rôle(s) non traité(s) par ce département : ${unknown.join(', ')}. ` +
          `Utilisez : ${[...known.keys()].join(', ')}.`,
      );
    }
    const targets = input.targetTypes.map(
      (key) => known.get(key) ?? { key, label: key, description: key },
    );

    const brief = (ctx.repos.missions.get(resolved.missionId)?.context as {
      brief?: { clientProfile?: { offering?: string } };
    })?.brief;

    // ── Ne pas rejouer une recherche qui a déjà échoué techniquement ───────
    // LIVE #004 : la recherche a expiré, l'outil a répondu « ne relancez pas,
    // la cause est technique et ne changera pas d'elle-même », et l'agent a
    // relancé deux fois. Ce qui l'a finalement arrêté n'est pas la consigne
    // mais un plafond — 12 appels par étape. Une consigne n'est pas un
    // garde-fou : ce que le système doit empêcher, il doit l'empêcher.
    const signature = searchSignature(input);
    const priorFailure = ctx.repos.toolCalls.hasFailedWithSignature(
      resolved.missionId,
      'discover_companies',
      signature,
      UNREPEATABLE_SEARCH_OUTCOMES,
    );
    if (priorFailure) {
      return fail(
        `Recherche refusée : exactement la même requête a déjà échoué sur cette mission ` +
          `(${priorFailure.outcome}). La rejouer à l'identique ne peut rien changer et coûterait autant.\n\n` +
          'Changez réellement de stratégie — autres mots-clés, autre angle du marché, autres rôles — ' +
          "ou concluez en signalant que la recherche n'a pas pu aboutir.",
        { registered: 0, outcome: 'duplicate-blocked', signature, blockedBy: priorFailure.outcome },
      );
    }

    const report = await ctx.discovery.discover(
      {
        targetTypes: targets,
        countries: input.countries,
        industries: input.industries ?? [],
        keywords: input.keywords ?? [],
        exclusions: input.exclusions ?? [],
        clientOffering: brief?.clientProfile?.offering ?? null,
        limit: input.limit ?? 20,
      },
      {
        logger: ctx.logger,
        missionId: resolved.missionId,
        taskRef: ctx.taskRef,
        agentKey: ctx.agentKey,
        departmentKey: resolved.department.key,
        // L'effort suit l'objectif. Chercher aussi large pour rendre deux
        // candidats que pour en rendre vingt se paie en contexte sans rendre
        // les deux meilleurs — et c'est le contexte qui coûte, pas la requête.
        limits: {
          maxSearches: searchesFor(input.limit ?? 20, ctx.config.web.maxSearchesPerDiscovery),
          maxFetches: ctx.config.web.maxFetchesPerCandidate,
        },
        timeoutMs: ctx.config.orchestration.providerTimeoutMs,
        signal: ctx.signal,
      },
    );

    // Le coût de la recherche appartient à la mission, pas au provider.
    if (report.tokensUsed > 0 && ctx.missionId) {
      ctx.repos.missions.addTokens(ctx.missionId, report.tokensUsed);
    }

    if (report.candidates.length === 0) {
      const why = report.providers
        .map((p) => `${p.label} [${p.outcome}] : ${p.used ? p.notes.join(' ') || 'aucun résultat' : p.reason}`)
        .join('\n  ');

      // ── Zéro résultat n'est pas une panne ────────────────────────────────
      // Et une panne n'est pas zéro résultat. LIVE #003 confondait les deux :
      // trois appels rendus « ok » alors que deux recherches avaient expiré.
      // L'agent croyait le marché vide et réessayait, chaque tentative
      // repayant un contexte grandissant.
      if (FAILED_SEARCH_OUTCOMES.includes(report.outcome)) {
        return fail(
          `La recherche n'a pas pu aboutir (${report.outcome}).\n  ${why}\n\n` +
            "Ce n'est PAS un constat de marché vide : ATLAS n'a pas pu chercher. " +
            "Ne relancez pas la même recherche — la cause est technique et ne changera pas d'elle-même. " +
            'Signalez la panne dans votre résultat.',
          { registered: 0, outcome: report.outcome, signature, providers: report.providers },
        );
      }

      return ok(
        `Recherche effectuée, aucune organisation documentée trouvée (${report.outcome}).\n  ${why}\n\n` +
          "La recherche a bien eu lieu : c'est un constat de marché, pas une panne. " +
          'Rapportez-le tel quel. Ne complétez pas la liste de mémoire : une entreprise sans source ne peut pas entrer dans le pipeline.',
        { registered: 0, outcome: report.outcome, signature, providers: report.providers },
      );
    }

    const outcome = ctx.intelligence!.discover({
      missionId: resolved.missionId,
      departmentKey: resolved.department.key,
      targetTypes: input.targetTypes,
      agentKey: ctx.agentKey,
      candidates: report.candidates.map((candidate) => ({
        name: candidate.name,
        website: candidate.website,
        country: candidate.country,
        region: candidate.region,
        city: candidate.city,
        industries: candidate.industries,
        description: candidate.description,
        rationale: candidate.relevance,
        confidence: candidate.confidence,
        roles: candidate.roles,
        sources: candidate.sources,
      })),
    });

    const lines = outcome.registered.map(
      (r) => `- ${r.name} → ${r.opportunityId}${r.reused ? ' (déjà connue, profil réutilisé)' : ''}`,
    );
    const providerLines = report.providers.map(
      (p) => `  ${p.label} : ${p.used ? `${p.found} trouvée(s)` : `non utilisé — ${p.reason}`}`,
    );

    return ok(
      [
        `${outcome.registered.length} candidat(s) enregistré(s).`,
        report.merged > 0 ? `${report.merged} doublon(s) fusionné(s) entre providers.` : null,
        outcome.duplicates.length ? `${outcome.duplicates.length} doublon(s) écarté(s).` : null,
        outcome.reusedCount ? `${outcome.reusedCount} repris de la mémoire ATLAS.` : null,
        '',
        'Sources interrogées :',
        ...providerLines,
        '',
        'Identifiants à utiliser dans les étapes suivantes :',
        ...lines,
      ]
        .filter((line) => line !== null)
        .join('\n'),
      {
        registered: outcome.registered.length,
        duplicates: outcome.duplicates.length + report.merged,
        reused: outcome.reusedCount,
        usedRealSource: report.usedRealSource,
        providers: report.providers,
        opportunities: outcome.registered,
        // Conservés même en cas de succès : sans empreinte, un appel n'est pas
        // identifiable, et la télémétrie ne pourrait pas dire quelle stratégie
        // a effectivement produit des résultats.
        signature,
        outcome: report.outcome,
      },
    );
  },
};

// ─── Enrichment ─────────────────────────────────────────────────────────────

const evidenceDraftSchema = z.object({
  field: z.string().min(2).max(60),
  claim: z.string().min(3).max(1000),
  nature: z.enum(['observed', 'reported', 'inferred']),
  sourceKind: z.enum(SOURCE_KINDS).optional(),
  sourceRef: z.string().max(500).nullish(),
  sourceTitle: z.string().max(200).nullish(),
  basis: z.string().max(600).nullish(),
  confidence: z.number().min(0).max(1).optional(),
});

const EVIDENCE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    field: { type: 'string', maxLength: 60, description: 'e.g. territory, portfolio, size, reach' },
    claim: { type: 'string', maxLength: 1000 },
    nature: {
      type: 'string',
      enum: ['observed', 'reported', 'inferred'],
      description:
        'observed = you read it at the cited source; reported = a third party states it; inferred = you concluded it',
    },
    sourceKind: { type: 'string', enum: [...SOURCE_KINDS] },
    sourceRef: { type: 'string', maxLength: 500, description: 'Required unless the claim is inferred' },
    sourceTitle: { type: 'string', maxLength: 200 },
    basis: { type: 'string', maxLength: 600, description: 'Required for an inference: what it rests on' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['field', 'claim', 'nature'],
  additionalProperties: false,
};

const enrichCompany: AtlasTool<{
  opportunityId: string;
  profile?: {
    legalName?: string | null;
    website?: string | null;
    country?: string | null;
    region?: string | null;
    city?: string | null;
    industries?: string[];
    sizeBand?: 'micro' | 'small' | 'medium' | 'large' | 'enterprise' | 'unknown';
    employeesEstimate?: number | null;
    foundedYear?: number | null;
    description?: string | null;
  };
  evidence: z.infer<typeof evidenceDraftSchema>[];
  relations?: Array<{ kind: string; toName: string; description: string; confidence?: number }>;
}> = {
  name: 'enrich_company',
  description:
    'Record what you have learned about one candidate, with the source behind every claim. ' +
    'ATLAS caps the confidence of anything you mark as inferred and refuses an unsourced observation, ' +
    'so state honestly how you know each thing.',
  category: 'research',
  // Un candidat enrichi est une unité de travail close. Ce qui a servi à y
  // arriver — pages récupérées, recherches, brouillons — n'aide en rien le
  // candidat suivant, et le lui renvoyer faisait croître l'entrée de 5 710 à
  // 32 443 jetons entre le premier appel et le huitième.
  boundary: true,
  inputSchema: {
    type: 'object',
    properties: {
      opportunityId: { type: 'string', maxLength: 40 },
      profile: {
        type: 'object',
        properties: {
          legalName: { type: 'string', maxLength: 200 },
          website: { type: 'string', maxLength: 300 },
          country: { type: 'string', maxLength: 60 },
          region: { type: 'string', maxLength: 80 },
          city: { type: 'string', maxLength: 80 },
          industries: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 120 } },
          sizeBand: {
            type: 'string',
            enum: ['micro', 'small', 'medium', 'large', 'enterprise', 'unknown'],
          },
          employeesEstimate: { type: 'integer', minimum: 0, maximum: 5_000_000 },
          foundedYear: { type: 'integer', minimum: 1600, maximum: 2100 },
          description: { type: 'string', maxLength: 2000 },
        },
        additionalProperties: false,
      },
      evidence: { type: 'array', minItems: 1, maxItems: 20, items: EVIDENCE_ITEM_SCHEMA },
      relations: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', maxLength: 60, description: 'e.g. distributes-for, owned-by, partners-with' },
            toName: { type: 'string', maxLength: 160 },
            description: { type: 'string', maxLength: 400 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['kind', 'toName', 'description'],
          additionalProperties: false,
        },
      },
    },
    required: ['opportunityId', 'evidence'],
    additionalProperties: false,
  },
  parse: z.object({
    opportunityId: z.string().min(3).max(40),
    profile: z
      .object({
        legalName: z.string().max(200).nullish(),
        website: z.string().max(300).nullish(),
        country: z.string().max(60).nullish(),
        region: z.string().max(80).nullish(),
        city: z.string().max(80).nullish(),
        industries: z.array(z.string().max(120)).max(8).optional(),
        sizeBand: z.enum(['micro', 'small', 'medium', 'large', 'enterprise', 'unknown']).optional(),
        employeesEstimate: z.number().int().min(0).max(5_000_000).nullish(),
        foundedYear: z.number().int().min(1600).max(2100).nullish(),
        description: z.string().max(2000).nullish(),
      })
      .optional(),
    evidence: z.array(evidenceDraftSchema).min(1).max(20),
    relations: z
      .array(
        z.object({
          kind: z.string().min(2).max(60),
          toName: z.string().min(2).max(160),
          description: z.string().max(400),
          confidence: z.number().min(0).max(1).optional(),
        }),
      )
      .max(8)
      .optional(),
  }),
  async execute(input, ctx) {
    const resolved = requireContext(ctx);
    if ('error' in resolved) return fail(resolved.error);

    const opportunity = ctx.repos.opportunities.get(input.opportunityId);
    if (!opportunity || opportunity.missionId !== resolved.missionId) {
      return fail(`No opportunity '${input.opportunityId}' in this mission. Use an id from discover_companies.`);
    }

    try {
      const { company, evidenceAdded } = ctx.intelligence!.enrich({
        missionId: resolved.missionId,
        opportunityId: input.opportunityId,
        agentKey: ctx.agentKey,
        patch: input.profile
          ? {
              legalName: input.profile.legalName ?? undefined,
              website: input.profile.website ?? undefined,
              country: input.profile.country ?? undefined,
              region: input.profile.region ?? undefined,
              city: input.profile.city ?? undefined,
              industries: input.profile.industries,
              sizeBand: input.profile.sizeBand,
              employeesEstimate: input.profile.employeesEstimate ?? undefined,
              foundedYear: input.profile.foundedYear ?? undefined,
              description: input.profile.description ?? undefined,
            }
          : undefined,
        evidence: input.evidence.map((e) => ({
          field: e.field,
          claim: e.claim,
          nature: e.nature,
          sourceKind: e.sourceKind,
          sourceRef: e.sourceRef ?? null,
          sourceTitle: e.sourceTitle ?? null,
          basis: e.basis ?? null,
          confidence: e.confidence,
        })),
        relations: input.relations,
      });

      return ok(
        `${company.name} enriched with ${evidenceAdded} sourced claim(s).`,
        { companyId: company.id, opportunityId: input.opportunityId, evidenceAdded },
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
};

// ─── Standalone evidence ────────────────────────────────────────────────────

const recordEvidence: AtlasTool<{
  opportunityId: string;
  evidence: z.infer<typeof evidenceDraftSchema>[];
}> = {
  name: 'record_evidence',
  description:
    'Add sourced claims to a candidate without changing its profile. Use it when you verify, correct or ' +
    'contradict something already recorded — evidence is append-only, so a later finding never erases an earlier one.',
  category: 'research',
  inputSchema: {
    type: 'object',
    properties: {
      opportunityId: { type: 'string', maxLength: 40 },
      evidence: { type: 'array', minItems: 1, maxItems: 20, items: EVIDENCE_ITEM_SCHEMA },
    },
    required: ['opportunityId', 'evidence'],
    additionalProperties: false,
  },
  parse: z.object({
    opportunityId: z.string().min(3).max(40),
    evidence: z.array(evidenceDraftSchema).min(1).max(20),
  }),
  async execute(input, ctx) {
    const resolved = requireContext(ctx);
    if ('error' in resolved) return fail(resolved.error);

    const opportunity = ctx.repos.opportunities.get(input.opportunityId);
    if (!opportunity || opportunity.missionId !== resolved.missionId) {
      return fail(`No opportunity '${input.opportunityId}' in this mission.`);
    }

    try {
      const ids = input.evidence.map(
        (draft) =>
          ctx.intelligence!.recordEvidence({
            missionId: resolved.missionId,
            opportunityId: opportunity.id,
            companyId: opportunity.companyId,
            agentKey: ctx.agentKey,
            sourceKind: draft.sourceKind ?? 'directory',
            draft: {
              field: draft.field,
              claim: draft.claim,
              nature: draft.nature,
              sourceRef: draft.sourceRef ?? null,
              sourceTitle: draft.sourceTitle ?? null,
              basis: draft.basis ?? null,
              confidence: draft.confidence,
            },
          }).id,
      );
      return ok(`${ids.length} claim(s) recorded.`, { evidenceIds: ids });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
};

// ─── Qualification ──────────────────────────────────────────────────────────

const qualifyOpportunity: AtlasTool<{
  opportunityId: string;
  verdict: 'qualified' | 'rejected' | 'uncertain';
  checks: Array<{ criterion: string; passed: boolean; detail: string; evidenceIds?: string[] }>;
  rationale: string;
  confidence: number;
  requiredFields?: string[];
  targetTypes?: string[];
}> = {
  name: 'qualify_opportunity',
  description:
    'Record your verdict on one candidate, with a check per criterion and the evidence that settles each. ' +
    'ATLAS downgrades a "qualified" verdict whose required fields rest only on inference — so verify before you assert.',
  category: 'analysis',
  inputSchema: {
    type: 'object',
    properties: {
      opportunityId: { type: 'string', maxLength: 40 },
      verdict: { type: 'string', enum: ['qualified', 'rejected', 'uncertain'] },
      checks: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            criterion: { type: 'string', maxLength: 200 },
            passed: { type: 'boolean' },
            detail: { type: 'string', maxLength: 800 },
            evidenceIds: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } },
          },
          required: ['criterion', 'passed', 'detail'],
          additionalProperties: false,
        },
      },
      rationale: { type: 'string', maxLength: 2000 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      requiredFields: {
        type: 'array',
        maxItems: 8,
        items: { type: 'string', maxLength: 60 },
        description: 'Evidence fields that must be grounded for this verdict to stand',
      },
      targetTypes: {
        type: 'array',
        maxItems: 6,
        items: { type: 'string', maxLength: 40 },
        description:
          "Les rôles finalement retenus après vérification. Omettez pour conserver ceux de la découverte ; précisez pour restreindre une entreprise présentée à tort sous plusieurs rôles.",
      },
    },
    required: ['opportunityId', 'verdict', 'checks', 'rationale', 'confidence'],
    additionalProperties: false,
  },
  parse: z.object({
    opportunityId: z.string().min(3).max(40),
    verdict: z.enum(['qualified', 'rejected', 'uncertain']),
    checks: z
      .array(
        z.object({
          criterion: z.string().min(2).max(200),
          passed: z.boolean(),
          detail: z.string().max(800),
          evidenceIds: z.array(z.string().max(40)).max(10).optional(),
        }),
      )
      .min(1)
      .max(12),
    rationale: z.string().min(10).max(2000),
    confidence: z.number().min(0).max(1),
    requiredFields: z.array(z.string().max(60)).max(8).optional(),
    targetTypes: z.array(z.string().max(40)).max(6).optional(),
  }),
  async execute(input, ctx) {
    const resolved = requireContext(ctx);
    if ('error' in resolved) return fail(resolved.error);

    const opportunity = ctx.repos.opportunities.get(input.opportunityId);
    if (!opportunity || opportunity.missionId !== resolved.missionId) {
      return fail(`No opportunity '${input.opportunityId}' in this mission.`);
    }

    try {
      const { opportunity: updated, downgraded } = ctx.intelligence!.qualify({
        opportunityId: input.opportunityId,
        agentKey: ctx.agentKey,
        verdict: input.verdict,
        checks: input.checks.map((c) => ({ ...c, evidenceIds: c.evidenceIds ?? [] })),
        rationale: input.rationale,
        confidence: input.confidence,
        requiredFields: input.requiredFields ?? ['territory', 'portfolio'],
        targetTypes: input.targetTypes,
      });

      return ok(
        downgraded
          ? `Verdict recorded as "uncertain" rather than "qualified": the required fields are not backed by observed or reported evidence. Gather sourced evidence and qualify again if you believe it fits.`
          : `Verdict "${updated.qualification!.verdict}" recorded.`,
        { opportunityId: updated.id, verdict: updated.qualification!.verdict, downgraded },
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
};

// ─── Scoring ────────────────────────────────────────────────────────────────

const scoreOpportunityTool: AtlasTool<{
  opportunityId: string;
  assessments: Array<{
    dimension: string;
    value: number;
    rationale: string;
    confidence?: number;
    evidenceIds?: string[];
  }>;
  roleFits?: Array<{
    role: string;
    value: number;
    rationale: string;
    confidence?: number;
    evidenceIds?: string[];
  }>;
}> = {
  name: 'score_opportunity',
  description:
    'Score one candidate on the dimensions its department declares. ATLAS does the weighting and computes ' +
    'evidence quality itself, so give each axis a value, the reason for it, and the evidence it rests on. ' +
    'The total is the sum of the parts — you cannot set it directly.',
  category: 'analysis',
  inputSchema: {
    type: 'object',
    properties: {
      opportunityId: { type: 'string', maxLength: 40 },
      assessments: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            dimension: { type: 'string', maxLength: 60 },
            value: { type: 'number', minimum: 0, maximum: 100 },
            rationale: { type: 'string', maxLength: 800 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            evidenceIds: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } },
          },
          required: ['dimension', 'value', 'rationale'],
          additionalProperties: false,
        },
      },
      roleFits: {
        type: 'array',
        maxItems: 6,
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', maxLength: 40 },
            value: { type: 'number', minimum: 0, maximum: 100 },
            rationale: { type: 'string', maxLength: 600 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            evidenceIds: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } },
          },
          required: ['role', 'value', 'rationale'],
          additionalProperties: false,
        },
        description:
          "Compatibilité avec chaque rôle retenu pour ce candidat. Ce qui décide de la relation à proposer, indépendamment du classement.",
      },
    },
    required: ['opportunityId', 'assessments'],
    additionalProperties: false,
  },
  parse: z.object({
    opportunityId: z.string().min(3).max(40),
    roleFits: z
      .array(
        z.object({
          role: z.string().min(2).max(40),
          value: z.number().min(0).max(100),
          rationale: z.string().min(3).max(600),
          confidence: z.number().min(0).max(1).optional(),
          evidenceIds: z.array(z.string().max(40)).max(10).optional(),
        }),
      )
      .max(6)
      .optional(),
    assessments: z
      .array(
        z.object({
          dimension: z.string().min(2).max(60),
          value: z.number().min(0).max(100),
          rationale: z.string().min(3).max(800),
          confidence: z.number().min(0).max(1).optional(),
          evidenceIds: z.array(z.string().max(40)).max(10).optional(),
        }),
      )
      .min(1)
      .max(12),
  }),
  async execute(input, ctx) {
    const resolved = requireContext(ctx);
    if ('error' in resolved) return fail(resolved.error);

    const opportunity = ctx.repos.opportunities.get(input.opportunityId);
    if (!opportunity || opportunity.missionId !== resolved.missionId) {
      return fail(`No opportunity '${input.opportunityId}' in this mission.`);
    }

    const model = resolved.department.scoringModel;
    const declared = new Set(model.dimensions.map((d) => d.key));
    const unknown = input.assessments.filter((a) => !declared.has(a.dimension)).map((a) => a.dimension);
    if (unknown.length > 0) {
      return fail(
        `Unknown dimension(s): ${unknown.join(', ')}. This department scores on: ${[...declared].join(', ')}.`,
      );
    }
    const computedAsserted = input.assessments.filter((a) =>
      model.dimensions.some((d) => d.key === a.dimension && d.computed),
    );
    if (computedAsserted.length > 0) {
      return fail(
        `${computedAsserted.map((a) => a.dimension).join(', ')} is computed by ATLAS from the evidence ledger and cannot be asserted. Remove it and score the rest.`,
      );
    }

    try {
      const { score } = ctx.intelligence!.score({
        opportunityId: input.opportunityId,
        agentKey: ctx.agentKey,
        model,
        assessments: input.assessments,
        roleFits: input.roleFits,
      });

      const breakdown = score.components
        .map((c) => `  ${c.label}: ${c.value}/100 × w${c.weight} → +${c.contribution.toFixed(1)}`)
        .join('\n');

      return ok(
        `Scored ${score.total.toFixed(1)}/100 (confidence ${(score.confidence * 100).toFixed(0)}%).\n${breakdown}`,
        { opportunityId: input.opportunityId, total: score.total, confidence: score.confidence },
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
};

// ─── Ranking ────────────────────────────────────────────────────────────────

const rankShortlist: AtlasTool<{ limit?: number }> = {
  name: 'rank_shortlist',
  description:
    'Produce the final ranked shortlist for this mission from the scores already recorded. ' +
    'Ordering and the justification for each position are generated from the score components, so the ' +
    'written reason and the arithmetic can never disagree.',
  category: 'analysis',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many to keep' },
    },
    required: [],
    additionalProperties: false,
  },
  parse: z.object({ limit: z.number().int().min(1).max(100).optional() }),
  async execute(input, ctx) {
    const resolved = requireContext(ctx);
    if ('error' in resolved) return fail(resolved.error);

    const shortlist = ctx.intelligence!.rank({
      missionId: resolved.missionId,
      agentKey: ctx.agentKey,
      model: resolved.department.scoringModel,
      limit: input.limit,
    });

    if (shortlist.length === 0) {
      const funnel = ctx.repos.opportunities.funnelFor(resolved.missionId);
      return ok(
        `No candidate reached the shortlist threshold of ${resolved.department.scoringModel.shortlistThreshold}. ` +
          `Funnel: ${Object.entries(funnel).map(([k, v]) => `${k} ${v}`).join(', ')}. ` +
          `Report this honestly rather than lowering the bar.`,
        { shortlisted: 0, funnel },
      );
    }

    const lines = shortlist.map((o) => {
      const name = ctx.repos.companies.get(o.companyId)?.name ?? o.companyId;
      return `${o.rank}. ${name} — ${o.score?.toFixed(1)}/100`;
    });

    return ok(`Shortlist of ${shortlist.length}:\n${lines.join('\n')}`, {
      shortlisted: shortlist.length,
      shortlist: shortlist.map((o) => ({
        rank: o.rank,
        opportunityId: o.id,
        companyId: o.companyId,
        score: o.score,
        justification: o.justification,
      })),
    });
  },
};

/**
 * L'identité d'une recherche, indépendante de sa formulation.
 *
 * Ne retient que ce qui change *ce qui est cherché* : rôles, pays, secteurs,
 * mots-clés, exclusions. La limite de résultats en est délibérément absente —
 * demander deux candidats au lieu de cinq ne fait pas une autre recherche, et
 * la faire compter permettrait de contourner le blocage en changeant un
 * chiffre sans changer de stratégie.
 *
 * Normalisée et triée pour que l'ordre des mots-clés ou leur casse ne crée pas
 * deux identités là où il n'y a qu'une seule requête.
 */
function searchSignature(input: {
  targetTypes: string[];
  countries: string[];
  industries?: string[];
  keywords?: string[];
  exclusions?: string[];
}): string {
  const norm = (values: string[] | undefined): string =>
    [...new Set((values ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean))]
      .sort()
      .join('|');

  return [
    norm(input.targetTypes),
    norm(input.countries),
    norm(input.industries),
    norm(input.keywords),
    norm(input.exclusions),
  ].join('::');
}

/**
 * Combien de recherches méritent d'être lancées pour un nombre de candidats.
 *
 * Une par candidat visé, plus une marge de deux pour couvrir les impasses —
 * puis borné par la configuration. Un objectif de deux candidats déclenche
 * quatre recherches, pas les six par défaut : la différence tient entièrement
 * dans le contexte accumulé, qui est ce que l'on paie.
 */
function searchesFor(desired: number, ceiling: number): number {
  return Math.max(1, Math.min(ceiling, desired + 2));
}

export const INTELLIGENCE_TOOLS = [
  discoverCompanies,
  enrichCompany,
  recordEvidence,
  qualifyOpportunity,
  scoreOpportunityTool,
  rankShortlist,
] as AtlasTool<never>[];
