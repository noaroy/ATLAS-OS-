import type {
  Company,
  Contact,
  Evidence,
  Opportunity,
  OpportunityDetail,
  OpportunityScore,
  Qualification,
  QualificationCheck,
  QualificationVerdict,
  ScoringModel,
  Source,
  SourceKind,
} from '@atlas/contracts';
import type { EventBus, Logger } from '@atlas/core';
import { badRequest, invalidState, nowIso } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import type { MemoryService } from '@atlas/memory';
import { canonicalKey, isSameCompany, normaliseDomain } from './identity.ts';
import { hasGroundedEvidence, prepareEvidence, type EvidenceDraft } from './evidence.ts';
import { explainScore, rankOpportunities, scoreOpportunity, type DimensionAssessment } from './scoring.ts';

/**
 * The opportunity pipeline — the platform half of every intelligence department.
 *
 * Agents supply judgement; this service supplies the guarantees. Deduplication,
 * evidence discipline, verification before qualification, arithmetic behind
 * scores and the ordering of the shortlist all happen here, where an agent
 * cannot skip them. What is department-specific — which targets, which scoring
 * weights, which method — arrives as data.
 */

export interface CandidateDraft {
  name: string;
  website?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  industries?: string[];
  description?: string | null;
  /** Where this candidate was found. */
  sourceKind?: SourceKind;
  sourceRef?: string | null;
  sourceTitle?: string | null;
  /**
   * Every origin, when the candidate came through the discovery service.
   *
   * A company reported by two providers keeps both: that is corroboration, and
   * losing it would make one sighting indistinguishable from two.
   */
  sources?: Array<{
    kind: SourceKind;
    ref: string | null;
    title: string | null;
    retrievedAt: string;
    provider: string;
  }>;
  /** Why the agent believes this is worth considering. */
  rationale?: string | null;
  /** The discovering provider's own confidence, 0..1. */
  confidence?: number;
  /** Les rôles auxquels ce candidat correspond, selon le provider. */
  roles?: string[];
}

export interface DiscoveryInput {
  missionId: string;
  departmentKey: string;
  /** Les rôles que la mission recherche. Un candidat peut en porter plusieurs. */
  targetTypes: string[];
  agentKey: string;
  candidates: CandidateDraft[];
  /** Beyond this age, stored knowledge is re-verified rather than reused. */
  freshnessDays?: number;
}

export interface DiscoveryOutcome {
  registered: Array<{ opportunityId: string; companyId: string; name: string; reused: boolean }>;
  /** Candidates that resolved to a company already in this mission. */
  duplicates: Array<{ name: string; mergedInto: string }>;
  /** Companies answered from the registry instead of being researched again. */
  reusedCount: number;
}

export interface IntelligenceDeps {
  repos: Repositories;
  memory: MemoryService;
  events: EventBus;
  logger: Logger;
  /** True when ATLAS is running on simulated inference. */
  simulated: boolean;
}

const DEFAULT_FRESHNESS_DAYS = 90;

export class OpportunityService {
  #log: Logger;

  constructor(private readonly deps: IntelligenceDeps) {
    this.#log = deps.logger.child({ scope: 'intelligence' });
  }

  // ─── Discovery ───────────────────────────────────────────────────────────

  /**
   * Registers candidates, reconciling each against the company registry.
   *
   * Three things happen that an agent cannot opt out of: identical candidates
   * within one batch collapse, candidates already registered for this mission
   * are not duplicated, and a company ATLAS already knows well is *reused*
   * rather than researched again (Article XI).
   */
  discover(input: DiscoveryInput): DiscoveryOutcome {
    if (input.candidates.length === 0) throw badRequest('Discovery produced no candidates');

    const { repos } = this.deps;
    const freshnessDays = input.freshnessDays ?? DEFAULT_FRESHNESS_DAYS;
    const outcome: DiscoveryOutcome = { registered: [], duplicates: [], reusedCount: 0 };
    const accepted: Array<{ name: string; domain: string | null; country: string | null }> = [];

    for (const candidate of input.candidates) {
      const name = candidate.name?.trim();
      if (!name) continue;

      const domain = normaliseDomain(candidate.website);
      const identity = { name, domain, country: candidate.country ?? null };

      // Same batch, same company under two spellings.
      const twin = accepted.find((prior) => isSameCompany(prior, identity));
      if (twin) {
        outcome.duplicates.push({ name, mergedInto: twin.name });
        continue;
      }
      accepted.push(identity);

      const key = canonicalKey({ name, domain, country: candidate.country });
      const known = repos.companies.getByCanonicalKey(key);
      const reused = Boolean(known && this.#isFresh(known, freshnessDays));

      const { company } = repos.companies.upsert({
        canonicalKey: key,
        name,
        country: candidate.country ?? null,
        region: candidate.region ?? null,
        city: candidate.city ?? null,
        website: candidate.website ?? null,
        domain,
        industries: candidate.industries ?? [],
        description: candidate.description ?? null,
      });

      // Un provider qui ne se prononce pas laisse tous les rôles demandés
      // ouverts : la qualification tranchera plutôt que la découverte.
      const roles = candidate.roles?.length ? candidate.roles : input.targetTypes;

      const { opportunity, created } = repos.opportunities.register({
        missionId: input.missionId,
        departmentKey: input.departmentKey,
        companyId: company.id,
        targetTypes: roles,
        discoveredBy: input.agentKey,
        reusedKnowledge: reused,
      });

      if (!created) {
        outcome.duplicates.push({ name, mergedInto: company.name });
        continue;
      }

      // Discovery is itself a claim: this company exists and was found here.
      // One row per origin — two providers reporting the same company is
      // corroboration, and collapsing it into one row would hide that.
      const origins = candidate.sources?.length
        ? candidate.sources
        : [
            {
              kind: candidate.sourceKind ?? ('directory' as SourceKind),
              ref: candidate.sourceRef ?? null,
              title: candidate.sourceTitle ?? null,
              retrievedAt: nowIso(),
              provider: input.agentKey,
            },
          ];

      for (const origin of origins) {
        this.recordEvidence({
          missionId: input.missionId,
          opportunityId: opportunity.id,
          companyId: company.id,
          agentKey: input.agentKey,
          sourceKind: origin.kind,
          draft: {
            field: 'existence',
            claim:
              candidate.rationale?.trim() ||
              `${name} a été identifiée comme ${roles.join(' / ')} potentiel.`,
            value: { name, domain, country: candidate.country ?? null, provider: origin.provider },
            nature: origin.ref ? 'reported' : 'inferred',
            sourceRef: origin.ref,
            sourceTitle: origin.title,
            basis: origin.ref ? null : `Rapporté par ${origin.provider} sans URL de source`,
            confidence: candidate.confidence,
          },
        });
      }

      if (reused) {
        outcome.reusedCount++;
        repos.opportunities.setStage(opportunity.id, 'enriched');
      }

      outcome.registered.push({
        opportunityId: opportunity.id,
        companyId: company.id,
        name: company.name,
        reused,
      });
    }

    if (outcome.registered.length === 0 && outcome.duplicates.length > 0) {
      this.#log.info('discovery found only companies already registered', {
        missionId: input.missionId,
        duplicates: outcome.duplicates.length,
      });
    }

    this.deps.events.publish({
      type: 'opportunity.discovered',
      severity: 'info',
      source: input.agentKey,
      missionId: input.missionId,
      agentKey: input.agentKey,
      message: `${outcome.registered.length} candidat(s) ${input.targetTypes.join(' / ')} enregistré(s)${
        outcome.duplicates.length ? `, ${outcome.duplicates.length} duplicate(s) merged` : ''
      }`,
      payload: {
        registered: outcome.registered.length,
        duplicates: outcome.duplicates.length,
        reused: outcome.reusedCount,
        targetTypes: input.targetTypes,
      },
    });

    return outcome;
  }

  // ─── Enrichment and evidence ─────────────────────────────────────────────

  /** Deepens what is known about a company, with every claim sourced. */
  enrich(input: {
    missionId: string;
    opportunityId: string;
    agentKey: string;
    patch?: {
      legalName?: string | null;
      website?: string | null;
      country?: string | null;
      region?: string | null;
      city?: string | null;
      industries?: string[];
      sizeBand?: Company['sizeBand'];
      employeesEstimate?: number | null;
      foundedYear?: number | null;
      description?: string | null;
      profile?: Record<string, unknown>;
    };
    evidence?: Array<EvidenceDraft & { sourceKind?: SourceKind }>;
    contacts?: Array<Omit<Contact, 'id' | 'companyId' | 'createdAt' | 'evidenceId'>>;
    relations?: Array<{ kind: string; toName: string; description: string; confidence?: number }>;
  }): { company: Company; evidenceAdded: number } {
    const { repos } = this.deps;
    const opportunity = repos.opportunities.require(input.opportunityId);

    const patch = input.patch ?? {};
    const company = repos.companies.enrich(opportunity.companyId, {
      ...patch,
      domain: patch.website ? normaliseDomain(patch.website) : undefined,
    });

    let evidenceAdded = 0;
    for (const draft of input.evidence ?? []) {
      this.recordEvidence({
        missionId: input.missionId,
        opportunityId: opportunity.id,
        companyId: company.id,
        agentKey: input.agentKey,
        sourceKind: draft.sourceKind ?? 'company-website',
        draft,
      });
      evidenceAdded++;
    }

    for (const contact of input.contacts ?? []) {
      repos.companies.addContact({
        companyId: company.id,
        name: contact.name,
        role: contact.role ?? null,
        email: contact.email ?? null,
        phone: contact.phone ?? null,
        linkedin: contact.linkedin ?? null,
        confidence: contact.confidence ?? 0.5,
        evidenceId: null,
      });
    }

    for (const relation of input.relations ?? []) {
      repos.companies.addRelation({
        fromCompanyId: company.id,
        toCompanyId: null,
        toName: relation.toName,
        kind: relation.kind,
        description: relation.description,
        confidence: relation.confidence ?? 0.5,
        evidenceId: null,
      });
    }

    if (opportunity.stage === 'discovered') {
      repos.opportunities.setStage(opportunity.id, 'enriched');
    }

    return { company, evidenceAdded };
  }

  /**
   * Appends one sourced claim, after the platform has checked its discipline.
   *
   * The `simulated` stamp comes from the deployment, never from the caller, so
   * simulated output cannot be presented as real observation.
   */
  recordEvidence(input: {
    missionId: string | null;
    opportunityId: string | null;
    companyId: string;
    agentKey: string;
    sourceKind: SourceKind;
    draft: EvidenceDraft;
  }): Evidence {
    const prepared = prepareEvidence(input.draft, { simulated: this.deps.simulated });
    const source = this.#ensureSource(input.sourceKind, prepared.sourceRef ?? null);

    const evidence = this.deps.repos.companies.appendEvidence({
      companyId: input.companyId,
      opportunityId: input.opportunityId,
      missionId: input.missionId,
      field: prepared.field,
      claim: prepared.claim,
      value: prepared.value ?? null,
      nature: prepared.nature,
      sourceKey: source.key,
      sourceRef: prepared.sourceRef ?? null,
      sourceTitle: prepared.sourceTitle ?? null,
      basis: prepared.basis ?? null,
      confidence: prepared.confidence,
      simulated: this.deps.simulated,
      collectedAt: nowIso(),
      agentKey: input.agentKey,
    });

    if (prepared.nature === 'observed') {
      this.deps.repos.companies.markVerified(input.companyId, evidence.collectedAt);
    }
    return evidence;
  }

  // ─── Qualification ───────────────────────────────────────────────────────

  /**
   * Records a verdict — but only one the evidence can carry.
   *
   * Verification is not a separate pipeline stage staffed by another agent; it
   * is this check. A candidate cannot be qualified on fields whose only support
   * is the model's own inference, however confident the agent is.
   */
  qualify(input: {
    opportunityId: string;
    agentKey: string;
    verdict: QualificationVerdict;
    checks: QualificationCheck[];
    rationale: string;
    confidence: number;
    /** Fields that must be grounded before a positive verdict is allowed. */
    requiredFields?: string[];
    /**
     * Les rôles finalement retenus après vérification.
     *
     * Une entreprise présentée comme distributeur *et* intégrateur n'exerce
     * souvent que l'un des deux ; le constater est précisément l'objet de la
     * qualification, et cela décide de la relation à proposer.
     */
    targetTypes?: string[];
  }): { opportunity: Opportunity; downgraded: boolean } {
    const { repos } = this.deps;
    const opportunity = repos.opportunities.require(input.opportunityId);
    const evidence = repos.companies.evidenceForOpportunity(opportunity.id);

    let verdict = input.verdict;
    let rationale = input.rationale;
    let downgraded = false;

    if (verdict === 'qualified') {
      const ungrounded = (input.requiredFields ?? []).filter(
        (field) => !hasGroundedEvidence(evidence, field),
      );
      if (ungrounded.length > 0) {
        // Downgrade rather than reject: the candidate may well be right, but
        // ATLAS will not call it verified on the strength of a guess.
        verdict = 'uncertain';
        downgraded = true;
        rationale = `${rationale}\n\nATLAS downgraded this verdict: no observed or reported evidence supports ${ungrounded.join(', ')}.`;
      }
    }

    const qualification: Qualification = {
      verdict,
      checks: input.checks,
      rationale,
      confidence: Math.max(0, Math.min(1, input.confidence)),
      decidedBy: input.agentKey,
      decidedAt: nowIso(),
    };

    if (input.targetTypes?.length) {
      repos.opportunities.setTargetTypes(opportunity.id, input.targetTypes);
    }
    const updated = repos.opportunities.setQualification(opportunity.id, qualification);

    this.deps.events.publish({
      type: 'opportunity.qualified',
      severity: verdict === 'qualified' ? 'success' : 'info',
      source: input.agentKey,
      missionId: opportunity.missionId,
      agentKey: input.agentKey,
      message: `${this.#nameOf(opportunity)} qualified as ${verdict}`,
      payload: { opportunityId: opportunity.id, verdict, downgraded, checks: input.checks.length },
    });

    return { opportunity: updated, downgraded };
  }

  // ─── Scoring and ranking ─────────────────────────────────────────────────

  /** Scores one opportunity against its department's model. */
  score(input: {
    opportunityId: string;
    agentKey: string;
    model: ScoringModel;
    assessments: DimensionAssessment[];
    /** Compatibilité par rôle, quand la mission en cherche plusieurs. */
    roleFits?: Array<{ role: string; value: number; rationale: string; confidence?: number; evidenceIds?: string[] }>;
  }): { opportunity: Opportunity; score: OpportunityScore } {
    const { repos } = this.deps;
    const opportunity = repos.opportunities.require(input.opportunityId);

    if (opportunity.qualification?.verdict === 'rejected') {
      throw invalidState('A rejected opportunity is not scored');
    }

    const evidence = repos.companies.evidenceForOpportunity(opportunity.id);
    const score = scoreOpportunity({
      model: input.model,
      assessments: input.assessments,
      evidence,
      sources: this.#sourceMap(),
      scoredBy: input.agentKey,
      scoredAt: nowIso(),
      roleFits: input.roleFits,
      roles: opportunity.targetTypes,
      targetTypes: this.deps.repos.departments.get(opportunity.departmentKey)?.targetTypes ?? [],
    });

    const updated = repos.opportunities.setScore(opportunity.id, score);

    this.deps.events.publish({
      type: 'opportunity.scored',
      severity: 'info',
      source: input.agentKey,
      missionId: opportunity.missionId,
      agentKey: input.agentKey,
      message: `${this.#nameOf(opportunity)} scored ${score.total.toFixed(1)}/100`,
      payload: {
        opportunityId: opportunity.id,
        total: score.total,
        confidence: score.confidence,
        modelVersion: score.modelVersion,
      },
    });

    return { opportunity: updated, score };
  }

  /**
   * Produces the final shortlist.
   *
   * The ordering is arithmetic, and each justification is generated from the
   * score components — so the written reason and the number can never disagree,
   * which is the whole point of an explainable score.
   */
  rank(input: {
    missionId: string;
    agentKey: string;
    model: ScoringModel;
    limit?: number;
  }): Opportunity[] {
    const { repos } = this.deps;
    repos.opportunities.clearRanking(input.missionId);

    const scored = repos.opportunities
      .forMission(input.missionId)
      .filter((o) => o.score !== null && o.qualification?.verdict !== 'rejected');

    const ordered = rankOpportunities(scored, input.model.shortlistThreshold);
    const limited = input.limit ? ordered.slice(0, input.limit) : ordered;

    const shortlist: Opportunity[] = [];
    limited.forEach((opportunity, index) => {
      const next = limited[index + 1];
      const justification = explainScore(opportunity.scoreDetail!, {
        rank: index + 1,
        companyName: this.#nameOf(opportunity),
        comparedTo: next?.scoreDetail ?? null,
      });
      shortlist.push(repos.opportunities.setRank(opportunity.id, index + 1, justification));
    });

    this.deps.events.publish({
      type: 'opportunity.shortlisted',
      severity: 'success',
      source: input.agentKey,
      missionId: input.missionId,
      agentKey: input.agentKey,
      message: `Shortlist of ${shortlist.length} produced from ${scored.length} scored candidate(s)`,
      payload: {
        shortlisted: shortlist.length,
        scored: scored.length,
        threshold: input.model.shortlistThreshold,
      },
    });

    this.#remember(input.missionId, shortlist);
    return shortlist;
  }

  // ─── Reading ─────────────────────────────────────────────────────────────

  detail(opportunityId: string): OpportunityDetail {
    const { repos } = this.deps;
    const opportunity = repos.opportunities.require(opportunityId);
    return {
      opportunity,
      company: repos.companies.require(opportunity.companyId),
      evidence: repos.companies.evidenceForOpportunity(opportunityId),
      contacts: repos.companies.contactsFor(opportunity.companyId),
      relations: repos.companies.relationsFor(opportunity.companyId),
    };
  }

  detailsForMission(missionId: string): OpportunityDetail[] {
    return this.deps.repos.opportunities
      .forMission(missionId)
      .map((opportunity) => this.detail(opportunity.id));
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /** Whether stored knowledge is recent enough to stand in for fresh research. */
  #isFresh(company: Company, freshnessDays: number): boolean {
    if (!company.enriched || !company.lastVerifiedAt) return false;
    const ageDays = (Date.now() - Date.parse(company.lastVerifiedAt)) / 86_400_000;
    return ageDays <= freshnessDays;
  }

  #ensureSource(kind: SourceKind, reference: string | null): Source {
    // In simulation there is no real origin, so every claim resolves to the one
    // simulation source — which the console renders unmistakably.
    const effectiveKind: SourceKind = this.deps.simulated ? 'simulation' : kind;
    const host = reference ? normaliseDomain(reference) : null;
    const key = host ? `${effectiveKind}:${host}` : effectiveKind;

    return this.deps.repos.companies.ensureSource({
      key,
      kind: effectiveKind,
      label: host ?? labelForKind(effectiveKind),
      reference: host,
      reliability: reliabilityFor(effectiveKind),
    });
  }

  #sourceMap(): ReadonlyMap<string, Source> {
    return new Map(this.deps.repos.companies.listSources().map((s) => [s.key, s]));
  }

  #nameOf(opportunity: Opportunity): string {
    return this.deps.repos.companies.get(opportunity.companyId)?.name ?? opportunity.companyId;
  }

  /** A shortlist is knowledge: the next similar mission should start from it. */
  #remember(missionId: string, shortlist: Opportunity[]): void {
    if (shortlist.length === 0) return;
    const names = shortlist
      .slice(0, 10)
      .map((o, i) => `${i + 1}. ${this.#nameOf(o)} — ${o.score?.toFixed(1) ?? '—'}/100`)
      .join('\n');

    this.deps.memory.remember({
      kind: 'outcome',
      tier: 'business',
      title: `Shortlist produced (${shortlist.length} candidates)`,
      content: `The following candidates were shortlisted:\n${names}`,
      tags: ['shortlist', 'opportunity', ...shortlist[0]!.targetTypes],
      missionId,
      importance: 0.75,
    });
  }
}

const RELIABILITY: Record<SourceKind, number> = {
  'company-website': 0.9,
  registry: 0.95,
  directory: 0.6,
  press: 0.7,
  social: 0.45,
  dataset: 0.8,
  'model-inference': 0.3,
  founder: 0.95,
  simulation: 0.1,
};

const reliabilityFor = (kind: SourceKind): number => RELIABILITY[kind];

const labelForKind = (kind: SourceKind): string =>
  kind === 'simulation' ? 'Simulated inference (not real data)' : kind.replace(/-/g, ' ');
