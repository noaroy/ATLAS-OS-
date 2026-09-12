import type { Repositories, ClientCandidate } from '@atlas/data';
import {
  buildClientReport, reportToHtml, reportToCsv, exclusionsToCsv, PIPELINE_VERSION,
  EXCLUSION_LABELS, CRITERION_VERDICT_LABELS, CHANNEL_CONFIDENCE_LABELS, RECOMMENDATION_LABELS, allCriteria, reportEconomics,
  reviewQueueToHtml, reviewQueueToCsv, compareReviewOrder,
  type ReportEntry, type ReportExclusion, type ProspectExtras, type ClientReport, type ReportCriterion, type ReviewQueueItem,
} from '@atlas/departments';
import type { ScoringModel } from '@atlas/contracts';
import { loadClientRun } from './client-mission.ts';

/**
 * Le rapport d'une mission client, tous lots confondus.
 *
 * L'audit avait trouvé le défaut : la donnée persistait mais le rapport ne
 * lisait qu'une mission. Ici la mission EST la clé de rattachement : chaque
 * lot y écrit ses candidats, et le rapport lit le journal de bord en entier —
 * les retenues, celles à revoir, et les écartées avec leur raison. Une société
 * apparaît une fois, avec la version de brief qui l'a traitée.
 *
 * PARTIAL livre une première sélection sans clore la mission ; FINAL est le
 * même document, complet, produit quand la recherche s'arrête.
 */
export interface ClientRunReportInput {
  status: 'PARTIAL' | 'FINAL';
  generatedAt: string;
  scoringModel: ScoringModel;
  executionMode: 'live' | 'simulation';
  sellingPriceEur?: number | null;
  /** Inclure les fiches à revoir dans la liste ? Par défaut oui, marquées. */
  includeReviewRequired?: boolean;
}

export interface ClientRunReport {
  report: ClientReport;
  html: string;
  csv: string;
  exclusionsCsv: string;
  retained: ClientCandidate[];
  /** À revoir, avec un dossier lu : présentes dans le rapport, marquées. */
  reviewRequired: ClientCandidate[];
  /**
   * À revoir avant toute lecture — pays présumé hors marché, seule page sans
   * terme du brief : aucun dossier, donc aucune fiche. Elles sont dans la
   * file de revue interne et comptées ici, pas dans « à revoir ».
   */
  pendingHumanCheck: ClientCandidate[];
  excluded: ClientCandidate[];
  /** Injoignables après leurs tentatives : ni analysées, ni écartées. */
  unreachable: ClientCandidate[];
  evidenceIds: string[];
  costUsd: number;
}

interface CriteriaDetail {
  key: string; label: string; kind: 'required' | 'preferred' | 'exclusion'; verdict: ReportCriterion['verdict'];
  note: string; evidence: Array<{ quote: string; url: string }>;
}

/** Ce que le pipeline écrit dans `detail` et que le rapport relit. */
interface CandidateDetail {
  criteria?: CriteriaDetail[];
  contacts?: {
    formUrl?: string | null; method?: 'EMAIL' | 'FORM' | 'PHONE' | 'NONE'; value?: string | null; sourceUrl?: string | null;
    confidence?: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'; why?: string; email?: string | null; phone?: string | null;
  };
  toConfirm?: string[];
  verifiedAt?: string; activity?: string;
  country?: { country?: string | null; basis?: string; quote?: string | null; sourceUrl?: string | null };
  generalistRisk?: { score: number; signals: Array<{ signal: string; detail: string; weight: number }> };
  triage?: { status: string; priority: 'P1' | 'P2' | 'P3' | null; recommendation: 'RETAIN' | 'EXCLUDE' | 'TO_CONFIRM'; reasons: string[] };
  score?: { total: number; confidence: number };
  specialisation?: { verdict: string; note: string; evidence: Array<{ quote: string; url: string }> };
}

function channelOf(d: CandidateDetail): ProspectExtras['channel'] {
  const k = d.contacts;
  if (!k || !k.method) return null;
  const confidence = k.confidence ?? 'NONE';
  return {
    method: k.method, value: k.value ?? null, sourceUrl: k.sourceUrl ?? null, confidence,
    confidenceLabel: CHANNEL_CONFIDENCE_LABELS[confidence] ?? confidence, why: k.why ?? '',
  };
}

function extrasFor(c: ClientCandidate): ProspectExtras {
  const d = c.detail as CandidateDetail;
  const criteria: ReportCriterion[] = (d.criteria ?? []).map((k) => ({
    key: k.key, label: k.label, kind: k.kind, verdict: k.verdict,
    verdictLabel: CRITERION_VERDICT_LABELS[k.verdict] ?? k.verdict,
    note: k.note ?? '', quotes: (k.evidence ?? []).map((e) => ({ quote: e.quote, url: e.url })),
  }));
  const statut = c.stage === 'RETAINED' ? 'VERIFIED' : 'REVIEW_REQUIRED';
  return {
    criteria,
    contactForm: d.contacts?.formUrl ?? null,
    verification: {
      status: statut,
      statusLabel: statut === 'VERIFIED' ? 'Vérifiée' : 'À revoir',
      verifiedAt: d.verifiedAt ?? c.updatedAt,
      toConfirm: d.toConfirm ?? [],
      country: {
        value: d.country?.country ?? null, basis: d.country?.basis ?? 'NONE',
        quote: d.country?.quote ?? null, url: d.country?.sourceUrl ?? null,
      },
    },
    activity: d.activity ?? null,
    channel: channelOf(d),
    generalistRisk: d.generalistRisk ? { score: d.generalistRisk.score, signals: d.generalistRisk.signals.map((s) => `${s.signal}${s.detail ? ` (${s.detail})` : ''}`) } : null,
  };
}

/**
 * La file de revue d'une mission : les candidats que le tri n'a pas pu
 * trancher seul, P1 en tête, chacun avec ce qu'il faut pour décider.
 */
export function buildReviewQueue(repos: Repositories, runId: string): ReviewQueueItem[] {
  const items: ReviewQueueItem[] = [];
  for (const c of repos.clientCandidates.forRun(runId)) {
    if (c.stage !== 'REVIEW_REQUIRED') continue;
    const d = c.detail as CandidateDetail;
    const criteria = d.criteria ?? [];
    const preuves: ReviewQueueItem['evidence'] = [];
    for (const k of criteria) for (const e of k.evidence.slice(0, 1)) preuves.push({ label: `${k.label} (${CRITERION_VERDICT_LABELS[k.verdict] ?? k.verdict})`, quote: e.quote, url: e.url });
    for (const e of (d.specialisation?.evidence ?? []).slice(0, 1)) preuves.push({ label: `spécialisation (${d.specialisation?.verdict ?? ''})`, quote: e.quote, url: e.url });
    if (d.country?.quote && d.country.sourceUrl) preuves.push({ label: `pays : ${d.country.country ?? '?'}`, quote: d.country.quote, url: d.country.sourceUrl });
    const canal = channelOf(d);
    const contact = canal && canal.method !== 'NONE' && canal.value
      ? `${canal.method === 'EMAIL' ? canal.value : canal.method === 'FORM' ? `formulaire ${canal.value}` : `tél. ${canal.value}`} — ${canal.confidenceLabel.toLowerCase()}`
      : 'aucune coordonnée commerciale publiée';
    const recommendation = d.triage?.recommendation ?? 'TO_CONFIRM';
    items.push({
      priority: d.triage?.priority ?? 'P2',
      company: c.name ?? c.domain, domain: c.domain, url: c.url,
      score: d.score?.total ?? 0, confidence: d.score?.confidence ?? 0,
      reasons: d.triage?.reasons?.length ? d.triage.reasons : [c.reason ?? 'à revoir'],
      evidence: preuves.slice(0, 5),
      problematicCriteria: criteria.filter((k) => k.verdict !== 'ESTABLISHED').map((k) => `${k.label} : ${CRITERION_VERDICT_LABELS[k.verdict] ?? k.verdict}`),
      contact,
      recommendation, recommendationLabel: RECOMMENDATION_LABELS[recommendation],
      generalistRisk: d.generalistRisk?.score ?? null,
      country: d.country?.country ?? null,
      commands: {
        retain: `npm run client:mission -- adjust --run=${runId} --keep=${c.domain}`,
        exclude: `npm run client:mission -- adjust --run=${runId} --exclude=${c.domain}`,
      },
    });
  }
  return items.sort(compareReviewOrder);
}

export function renderReviewQueue(repos: Repositories, runId: string, generatedAt: string): { items: ReviewQueueItem[]; html: string; csv: string } {
  const { brief } = loadClientRun(repos, runId);
  const items = buildReviewQueue(repos, runId);
  return { items, html: reviewQueueToHtml(items, { runId, clientName: brief.client.name, generatedAt }), csv: reviewQueueToCsv(items) };
}

export function buildClientRunReport(repos: Repositories, runId: string, input: ClientRunReportInput): ClientRunReport {
  const { brief } = loadClientRun(repos, runId);
  const mission = repos.missions.require(runId);
  const tous = repos.clientCandidates.forRun(runId);
  const retained = tous.filter((c) => c.stage === 'RETAINED');
  const avecDossier = (c: ClientCandidate) => Boolean(c.companyId && c.opportunityId);
  const reviewRequired = tous.filter((c) => c.stage === 'REVIEW_REQUIRED' && avecDossier(c));
  const pendingHumanCheck = tous.filter((c) => c.stage === 'REVIEW_REQUIRED' && !avecDossier(c));
  const excluded = tous.filter((c) => c.stage === 'EXCLUDED');
  const unreachable = tous.filter((c) => c.stage === 'FAILED_FINAL' || c.stage === 'FAILED_RETRYABLE');
  const listes = input.includeReviewRequired === false ? retained : [...retained, ...reviewRequired];

  const entries: ReportEntry[] = [];
  for (const c of listes) {
    if (!c.companyId || !c.opportunityId) continue;
    const company = repos.companies.get(c.companyId);
    const opportunity = repos.opportunities.get(c.opportunityId);
    if (!company || !opportunity) continue;
    entries.push({
      opportunity, company,
      evidence: repos.companies.evidenceForOpportunity(opportunity.id),
      contacts: repos.companies.contactsFor(company.id),
      extras: extrasFor(c),
    });
  }
  // Meilleure note d'abord ; à note égale, la plus sûre.
  entries.sort((a, b) => (b.opportunity.score ?? 0) - (a.opportunity.score ?? 0)
    || (b.opportunity.scoreDetail?.confidence ?? 0) - (a.opportunity.scoreDetail?.confidence ?? 0));
  entries.forEach((e, i) => { e.opportunity = { ...e.opportunity, rank: i + 1 }; });

  const exclusions: ReportExclusion[] = excluded.map((c) => ({
    company: c.name ?? c.domain, domain: c.domain, url: c.url,
    category: c.category ?? 'LOW_RELEVANCE',
    categoryLabel: EXCLUSION_LABELS[c.category ?? ''] ?? (c.category ?? 'Écartée'),
    reason: c.reason ?? '', quote: c.evidenceQuote, quoteUrl: c.evidenceUrl, batch: c.batch,
  }));

  const evidenceIds = entries.flatMap((e) => e.evidence.map((x) => x.id));
  const sources = [...new Set(entries.flatMap((e) => e.evidence.map((x) => x.sourceRef)).filter((s): s is string => Boolean(s)))];
  const appels = repos.llmCalls.forMission(runId, 5000);
  const costUsd = appels.reduce((s, a) => s + (a.costUsd ?? 0), 0);
  // Analysée : lue et jugée. Ni en attente, ni injoignable, ni un annuaire écarté d'office.
  const analysed = tous.filter((c) => ['RETAINED', 'REVIEW_REQUIRED', 'EXCLUDED'].includes(c.stage) && c.category !== 'DIRECTORY').length;
  const extraLimitations: string[] = [];
  if (pendingHumanCheck.length > 0) {
    extraLimitations.push(`${pendingHumanCheck.length} société(s) en attente d’une vérification humaine avant lecture (pays présumé hors marché, ou aucun terme du brief sur la seule page lisible) : ${pendingHumanCheck.map((c) => c.domain).join(', ')}.`);
  }
  if (unreachable.length > 0) {
    extraLimitations.push(`${unreachable.length} site(s) injoignable(s) au moment de la lecture, non analysé(s) : ${unreachable.map((c) => c.domain).join(', ')}.`);
  }

  const report = buildClientReport({
    clientName: brief.client.name,
    missionTitle: mission.title,
    market: `${brief.market.countryLabel} — ${brief.targetRoles.join(', ')}`,
    objective: mission.objective,
    generatedAt: input.generatedAt,
    analysedCount: analysed,
    entries,
    scoringModel: input.scoringModel,
    provenance: {
      missionId: runId, generatedAt: input.generatedAt, pipelineVersion: PIPELINE_VERSION,
      scoringVersion: 'client-criteria-v1', executionMode: input.executionMode,
      evidenceIds, sources, costUsd, reviewer: null, approvedAt: null, state: 'GENERATED',
    },
    economics: reportEconomics(
      { llmCostUsd: costUsd, searchCostUsd: 0, candidates: analysed, usefulOpportunities: retained.length },
      { sellingPriceEur: input.sellingPriceEur ?? null },
    ),
    status: input.status,
    criteriaLabels: allCriteria(brief).map((c) => ({ key: c.key, label: c.label, kind: c.kind })),
    exclusions,
    extraLimitations,
  });

  return {
    report, html: reportToHtml(report), csv: reportToCsv(report), exclusionsCsv: exclusionsToCsv(report),
    retained, reviewRequired, pendingHumanCheck, excluded, unreachable, evidenceIds, costUsd,
  };
}
