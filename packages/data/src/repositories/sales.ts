import {
  id,
  nowIso,
  invalidState,
  effectiveOutreachEligibility,
  isOutreachState,
  GUARD_VERSION,
  canonicalDomainOf,
  type EligibilityVerdict,
  type LedgerVerdict,
} from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson } from '../database.ts';

/**
 * Nos propres prospects, et les preuves recueillies sur eux.
 *
 * Séparés des opportunités clientes, et volontairement. Une opportunité sert
 * une mission facturée ; un prospect sert notre acquisition, et sa sortie n'est
 * pas un rapport mais un message qui partira sous notre nom. Mêler les deux
 * ferait apparaître nos propres prospects dans un livrable client — au mieux
 * embarrassant.
 */

export type ProspectState =
  | 'DISCOVERED'
  | 'QUALIFIED'
  | 'READY_FOR_REVIEW'
  | 'APPROVED_TO_CONTACT'
  | 'REJECTED'
  | 'CONTACTED'
  | 'REPLIED'
  | 'INTERESTED'
  | 'ORDERED'
  | 'PAID'
  | 'LOST';

export type ProspectTier = 'PRIORITY' | 'GOOD_FIT' | 'WATCH' | 'REJECTED';
export type SalesEvidenceNature = 'observed' | 'reported' | 'inferred';

/**
 * Les transitions permises.
 *
 * `READY_FOR_REVIEW → APPROVED_TO_CONTACT` est la seule qu'aucun automatisme
 * ne franchit. Le dépôt refuse plutôt qu'il ne journalise : un rapport mal relu
 * se corrige, un message envoyé ne se reprend pas.
 */
const TRANSITIONS: Readonly<Record<ProspectState, readonly ProspectState[]>> = {
  DISCOVERED: ['QUALIFIED', 'REJECTED'],
  QUALIFIED: ['READY_FOR_REVIEW', 'REJECTED'],
  READY_FOR_REVIEW: ['APPROVED_TO_CONTACT', 'REJECTED'],
  APPROVED_TO_CONTACT: ['CONTACTED', 'REJECTED'],
  CONTACTED: ['REPLIED', 'LOST'],
  REPLIED: ['INTERESTED', 'LOST'],
  INTERESTED: ['ORDERED', 'LOST'],
  ORDERED: ['PAID', 'LOST'],
  PAID: [],
  REJECTED: ['DISCOVERED'],
  LOST: [],
};

export interface SalesProspect {
  id: string;
  batchId: string;
  companyName: string;
  domain: string | null;
  website: string | null;
  country: string | null;
  industry: string | null;
  sourceUrl: string | null;
  searchProvider: string | null;
  query: string | null;
  discoveredAt: string;
  /** Ce que la page annoncait, garde a cote de ce qu'on a etabli. */
  searchTitle: string | null;
  pageType: string | null;
  identityConfidence: number | null;
  identitySources: string[] | null;
  /** Sous quelles gardes cette ligne a ete resolue. NULL = non verifiee. */
  guardVersion: string | null;
  /** EMAIL · FORM · PHONE · NONE — le canal retenu, selon la priorite. */
  contactMethod: string | null;
  contactConfidenceLabel: string | null;
  /** Faux tant qu'aucune page officielle n'a livre la coordonnee. */
  contactObserved: boolean;
  /** À quoi la boîte retenue est destinée, et si on peut lui écrire. */
  contactIntent: string | null;
  contactSuitability: string | null;
  state: ProspectState;
  tier: ProspectTier | null;
  score: number | null;
  scoreDetail: Record<string, unknown> | null;
  whyFit: string | null;
  rejectReason: string | null;
  contactName: string | null;
  contactRole: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactPage: string | null;
  contactSourceUrl: string | null;
  contactConfidence: number | null;
  /** La preuve sur laquelle repose le « j'ai vu que… » du message. */
  personalizationFactId: string | null;
  messageShort: string | null;
  messageEmail: string | null;
  outreachSourceUrl: string | null;
  reviewer: string | null;
  approvedAt: string | null;
  contactedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SalesEvidence {
  id: string;
  prospectId: string;
  field: string;
  claim: string;
  nature: SalesEvidenceNature;
  sourceUrl: string | null;
  basis: string | null;
  confidence: number;
  collectedAt: string;
}

interface Row {
  id: string;
  batch_id: string;
  company_name: string;
  domain: string | null;
  website: string | null;
  country: string | null;
  industry: string | null;
  source_url: string | null;
  search_provider: string | null;
  query: string | null;
  discovered_at: string;
  page_type: string | null;
  identity_confidence: number | null;
  identity_sources: string | null;
  search_title: string | null;
  guard_version: string | null;
  contact_method: string | null;
  contact_confidence_label: string | null;
  contact_observed: number;
  contact_intent: string | null;
  contact_suitability: string | null;
  state: ProspectState;
  tier: ProspectTier | null;
  score: number | null;
  score_detail: string | null;
  why_fit: string | null;
  reject_reason: string | null;
  contact_name: string | null;
  contact_role: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_page: string | null;
  contact_source_url: string | null;
  contact_confidence: number | null;
  personalization_fact_id: string | null;
  message_short: string | null;
  message_email: string | null;
  outreach_source_url: string | null;
  reviewer: string | null;
  approved_at: string | null;
  contacted_at: string | null;
  created_at: string;
  updated_at: string;
}

const toProspect = (row: Row): SalesProspect => ({
  id: row.id,
  batchId: row.batch_id,
  companyName: row.company_name,
  domain: row.domain,
  website: row.website,
  country: row.country,
  industry: row.industry,
  sourceUrl: row.source_url,
  searchProvider: row.search_provider,
  query: row.query,
  discoveredAt: row.discovered_at,
  pageType: row.page_type,
  identityConfidence: row.identity_confidence,
  identitySources: row.identity_sources ? (JSON.parse(row.identity_sources) as string[]) : null,
  searchTitle: row.search_title,
  guardVersion: row.guard_version,
  contactMethod: row.contact_method,
  contactConfidenceLabel: row.contact_confidence_label,
  contactObserved: row.contact_observed === 1,
  contactIntent: row.contact_intent,
  contactSuitability: row.contact_suitability,
  state: row.state,
  tier: row.tier,
  score: row.score,
  scoreDetail: row.score_detail ? fromJson<Record<string, unknown>>(row.score_detail, {}) : null,
  whyFit: row.why_fit,
  rejectReason: row.reject_reason,
  contactName: row.contact_name,
  contactRole: row.contact_role,
  contactEmail: row.contact_email,
  contactPhone: row.contact_phone,
  contactPage: row.contact_page,
  contactSourceUrl: row.contact_source_url,
  contactConfidence: row.contact_confidence,
  personalizationFactId: row.personalization_fact_id,
  messageShort: row.message_short,
  messageEmail: row.message_email,
  outreachSourceUrl: row.outreach_source_url,
  reviewer: row.reviewer,
  approvedAt: row.approved_at,
  contactedAt: row.contacted_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SalesRepository {
  constructor(private readonly db: Db) {}

  /**
   * Enregistre un candidat découvert, ou rend celui qui existe déjà.
   *
   * L'unicité porte sur `(batch, domaine)` : deux pages d'un même site sont un
   * seul prospect. L'oublier gonflerait le compte de découverte sans rien
   * ajouter, et le premier chiffre qu'on regarde deviendrait le moins fiable.
   */
  discover(input: {
    batchId: string;
    companyName: string;
    domain: string;
    website?: string | null;
    country?: string | null;
    industry?: string | null;
    sourceUrl?: string | null;
    searchProvider?: string | null;
    query?: string | null;
    discoveredAt?: string;
    searchTitle?: string | null;
    pageType?: string | null;
    identityConfidence?: number | null;
    identitySources?: string[] | null;
    guardVersion?: string | null;
  }): { prospect: SalesProspect; created: boolean } {
    const existing = this.db
      .prepare('SELECT * FROM sales_prospects WHERE batch_id = ? AND domain = ?')
      .get(input.batchId, input.domain) as Row | undefined;
    if (existing) return { prospect: toProspect(existing), created: false };

    const now = nowIso();
    const row: Row = {
      id: id('prs'),
      batch_id: input.batchId,
      company_name: input.companyName,
      domain: input.domain,
      website: input.website ?? `https://${input.domain}`,
      country: input.country ?? null,
      industry: input.industry ?? null,
      source_url: input.sourceUrl ?? null,
      search_provider: input.searchProvider ?? null,
      query: input.query ?? null,
      discovered_at: input.discoveredAt ?? now,
      search_title: input.searchTitle ?? null,
      page_type: input.pageType ?? null,
      identity_confidence: input.identityConfidence ?? null,
      identity_sources: input.identitySources ? JSON.stringify(input.identitySources) : null,
      guard_version: input.guardVersion ?? null,
      contact_method: null,
      contact_confidence_label: null,
      contact_observed: 0,
      contact_intent: null,
      contact_suitability: null,
      state: 'DISCOVERED',
      tier: null,
      score: null,
      score_detail: null,
      why_fit: null,
      reject_reason: null,
      contact_name: null,
      contact_role: null,
      contact_email: null,
      contact_phone: null,
      contact_page: null,
      contact_source_url: null,
      contact_confidence: null,
      personalization_fact_id: null,
      message_short: null,
      message_email: null,
      outreach_source_url: null,
      reviewer: null,
      approved_at: null,
      contacted_at: null,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO sales_prospects (id, batch_id, company_name, domain, website, country,
           industry, source_url, search_provider, query, discovered_at,
           search_title, page_type, identity_confidence, identity_sources, guard_version,
           contact_method, contact_confidence_label, contact_observed,
           contact_intent, contact_suitability,
           state, tier, score,
           score_detail, why_fit, reject_reason, contact_name, contact_role, contact_email,
           contact_phone, contact_page, contact_source_url, contact_confidence,
           personalization_fact_id, message_short, message_email, outreach_source_url,
           reviewer, approved_at, contacted_at, created_at, updated_at)
         VALUES (@id, @batch_id, @company_name, @domain, @website, @country,
           @industry, @source_url, @search_provider, @query, @discovered_at,
           @search_title, @page_type, @identity_confidence, @identity_sources, @guard_version,
           @contact_method, @contact_confidence_label, @contact_observed,
           @contact_intent, @contact_suitability,
           @state, @tier, @score,
           @score_detail, @why_fit, @reject_reason, @contact_name, @contact_role, @contact_email,
           @contact_phone, @contact_page, @contact_source_url, @contact_confidence,
           @personalization_fact_id, @message_short, @message_email, @outreach_source_url,
           @reviewer, @approved_at, @contacted_at, @created_at, @updated_at)`,
      )
      .run(row);
    return { prospect: toProspect(row), created: true };
  }

  get(prospectId: string): SalesProspect | null {
    const row = this.db.prepare('SELECT * FROM sales_prospects WHERE id = ?').get(prospectId) as
      | Row
      | undefined;
    return row ? toProspect(row) : null;
  }

  forBatch(batchId: string): SalesProspect[] {
    return (
      this.db
        .prepare('SELECT * FROM sales_prospects WHERE batch_id = ? ORDER BY score DESC, company_name')
        .all(batchId) as Row[]
    ).map(toProspect);
  }

  latestBatchId(): string | null {
    const row = this.db
      .prepare('SELECT batch_id FROM sales_prospects ORDER BY created_at DESC LIMIT 1')
      .get() as { batch_id: string } | undefined;
    return row?.batch_id ?? null;
  }

  /** Pose le score et le rang. Le rang découle du score, il n'est jamais choisi. */
  setScore(
    prospectId: string,
    patch: { score: number; tier: ProspectTier; detail: unknown; whyFit: string },
  ): SalesProspect {
    this.db
      .prepare(
        `UPDATE sales_prospects SET score = ?, tier = ?, score_detail = ?, why_fit = ?,
                                    updated_at = ? WHERE id = ?`,
      )
      .run(patch.score, patch.tier, toJson(patch.detail), patch.whyFit, nowIso(), prospectId);
    return this.require(prospectId);
  }

  setContact(
    prospectId: string,
    contact: {
      name?: string | null;
      role?: string | null;
      email?: string | null;
      phone?: string | null;
      contactPage?: string | null;
      sourceUrl?: string | null;
      confidence?: number | null;
      method?: string | null;
      confidenceLabel?: string | null;
      intent?: string | null;
      suitability?: string | null;
      /** Vrai seulement si la coordonnée a été lue sur une page officielle. */
      observed?: boolean;
    },
  ): SalesProspect {
    // Une coordonnée sans source ne peut pas être défendue en revue, et une
    // coordonnée qu'on ne peut pas défendre n'a rien à faire dans un message.
    if ((contact.email || contact.phone || contact.contactPage) && !contact.sourceUrl?.trim()) {
      throw invalidState(
        'Une coordonnée exige la page où elle a été lue. Sans source, elle est indéfendable.',
      );
    }
    this.db
      .prepare(
        `UPDATE sales_prospects SET contact_name = ?, contact_role = ?, contact_email = ?,
           contact_phone = ?, contact_page = ?, contact_source_url = ?, contact_confidence = ?,
           contact_method = ?, contact_confidence_label = ?, contact_observed = ?,
           contact_intent = ?, contact_suitability = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(
        contact.name ?? null,
        contact.role ?? null,
        contact.email ?? null,
        contact.phone ?? null,
        contact.contactPage ?? null,
        contact.sourceUrl ?? null,
        contact.confidence ?? null,
        contact.method ?? null,
        contact.confidenceLabel ?? null,
        contact.observed ? 1 : 0,
        contact.intent ?? null,
        contact.suitability ?? null,
        nowIso(),
        prospectId,
      );
    return this.require(prospectId);
  }

  /**
   * Enregistre les brouillons d'approche.
   *
   * `personalizationFactId` est obligatoire : un message sans le fait qui le
   * fonde ne peut pas être relu, et une personnalisation qu'on ne peut pas
   * relire est une personnalisation qu'on ne peut pas défendre.
   */
  setOutreach(
    prospectId: string,
    draft: {
      personalizationFactId: string;
      messageShort: string;
      messageEmail: string;
      sourceUrl: string;
    },
  ): SalesProspect {
    if (!draft.personalizationFactId) {
      throw invalidState(
        'Un brouillon d’approche exige la preuve sur laquelle il repose. ' +
          'Sans elle, la personnalisation ne peut être ni relue ni défendue.',
      );
    }
    this.db
      .prepare(
        `UPDATE sales_prospects SET personalization_fact_id = ?, message_short = ?,
           message_email = ?, outreach_source_url = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        draft.personalizationFactId,
        draft.messageShort,
        draft.messageEmail,
        draft.sourceUrl,
        nowIso(),
        prospectId,
      );
    return this.require(prospectId);
  }

  /**
   * Change l'état, si la transition est permise.
   *
   * `APPROVED_TO_CONTACT` exige un relecteur nommé. Une approbation anonyme
   * n'engage personne, et c'est précisément ce que cette étape doit faire.
   */
  setState(
    prospectId: string,
    state: ProspectState,
    patch: { reviewer?: string | null; rejectReason?: string | null } = {},
  ): SalesProspect {
    const current = this.require(prospectId);
    if (!TRANSITIONS[current.state].includes(state)) {
      throw invalidState(
        `Transition refusée : ${current.state} → ${state}. ` +
          `Depuis ${current.state}, seuls ${TRANSITIONS[current.state].join(', ') || '(aucun état)'} ` +
          `sont atteignables.`,
      );
    }
    if (state === 'APPROVED_TO_CONTACT' && !patch.reviewer?.trim()) {
      throw invalidState(
        'Approuver un contact exige un relecteur nommé : un message partira sous notre nom.',
      );
    }

    // Le tier historique n'autorise rien. Le lot 002 a écrit deux PRIORITY qui
    // n'auraient pas dû l'être ; ses lignes existent toujours, et c'est ici
    // qu'elles cessent de pouvoir nuire. La question posée n'est pas « qu'a
    // décidé le lot ? » mais « les gardes d'aujourd'hui le confirment-elles ? ».
    // La revue fondateur est l'antichambre de l'envoi : ce qui n'y entre pas ne
    // sera jamais approuvé. Poser la garde ici plutôt qu'au seul moment de
    // l'approbation évite de présenter à la relecture des prospects que rien
    // n'aurait pu valider.
    if (state === 'READY_FOR_REVIEW') {
      const verdict = this.outreachEligibility(prospectId);
      if (verdict.eligibility !== 'ELIGIBLE') {
        throw invalidState(
          `Revue refusée pour « ${current.companyName} » : ${verdict.reason}`,
        );
      }
    }

    if (isOutreachState(state)) {
      const verdict = this.outreachEligibility(prospectId);
      if (verdict.eligibility !== 'ELIGIBLE') {
        throw invalidState(
          `Contact refusé (${verdict.eligibility}) pour « ${current.companyName} ». ` +
            `${verdict.reason} — l'état historique était ${verdict.historicalState}` +
            `${verdict.historicalTier ? ` / ${verdict.historicalTier}` : ''}, ` +
            `mais l'historique n'autorise pas un envoi.`,
        );
      }
    }

    const now = nowIso();
    this.db
      .prepare(
        `UPDATE sales_prospects SET state = @state,
           reviewer = COALESCE(@reviewer, reviewer),
           reject_reason = COALESCE(@reject, reject_reason),
           approved_at = CASE WHEN @state = 'APPROVED_TO_CONTACT' THEN @now ELSE approved_at END,
           contacted_at = CASE WHEN @state = 'CONTACTED' THEN @now ELSE contacted_at END,
           updated_at = @now
         WHERE id = @id`,
      )
      .run({
        id: prospectId,
        state,
        reviewer: patch.reviewer ?? null,
        reject: patch.rejectReason ?? null,
        now,
      });
    return this.require(prospectId);
  }

  require(prospectId: string): SalesProspect {
    const prospect = this.get(prospectId);
    if (!prospect) throw invalidState(`Prospect « ${prospectId} » introuvable`);
    return prospect;
  }

  // ─── Preuves ─────────────────────────────────────────────────────────────

  addEvidence(input: Omit<SalesEvidence, 'id' | 'collectedAt'> & { collectedAt?: string }): SalesEvidence {
    const evidence: SalesEvidence = {
      ...input,
      id: id('sev'),
      collectedAt: input.collectedAt ?? nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO sales_evidence (id, prospect_id, field, claim, nature, source_url, basis,
                                     confidence, collected_at)
         VALUES (@id, @prospect_id, @field, @claim, @nature, @source_url, @basis,
                 @confidence, @collected_at)`,
      )
      .run({
        id: evidence.id,
        prospect_id: evidence.prospectId,
        field: evidence.field,
        claim: evidence.claim,
        nature: evidence.nature,
        source_url: evidence.sourceUrl,
        basis: evidence.basis,
        confidence: evidence.confidence,
        collected_at: evidence.collectedAt,
      });
    return evidence;
  }

  /**
   * Ce qu'on peut faire aujourd'hui de ce prospect, gardes actuelles à l'appui.
   *
   * Recalculé à chaque lecture plutôt que stocké : une garde corrigée doit
   * neutraliser d'un coup tout ce qu'elle aurait dû arrêter, sans migration et
   * sans qu'aucune ligne historique bouge.
   */
  outreachEligibility(prospectId: string): EligibilityVerdict {
    const p = this.require(prospectId);
    const invalidation = this.db
      .prepare('SELECT reason FROM sales_invalidations WHERE prospect_id = ?')
      .get(prospectId) as { reason: string } | undefined;

    const sourced = this.evidenceFor(prospectId).filter(
      (e) => e.nature === 'observed' && Boolean(e.sourceUrl),
    );

    return effectiveOutreachEligibility({
      historicalState: p.state,
      historicalTier: p.tier,
      guardVersion: p.guardVersion,
      pageType: p.pageType,
      identityConfidence: p.identityConfidence,
      domain: p.domain,
      // Le profil n'est pas restocké : une ligne qui a traversé la résolution
      // sous les gardes actuelles y est passée par un ICP MATCH, seule issue
      // qui mène à l'écriture. Une ligne antérieure est arrêtée avant, sur sa
      // version de gardes.
      icp: p.guardVersion === GUARD_VERSION ? 'MATCH' : null,
      observedSourcedFacts: sourced.length,
      score: p.score,
      scoreThreshold: 70,
      hasSourcedPersonalization: Boolean(p.personalizationFactId),
      // Observé, pas seulement présent : une coordonnée déduite ne compte pas.
      // Observé ET utilisable. Le lot 005 a retenu un service après-vente et
      // une adresse de mentions légales : les deux étaient bien observées.
      hasObservedContact:
        p.contactObserved &&
        Boolean(p.contactEmail || p.contactPage || p.contactPhone) &&
        p.contactSuitability !== 'BLOCKED',
      invalidation: invalidation ?? null,
      ledger: p.domain ? this.ledgerFor(p.domain) : null,
    });
  }

  /**
   * Ce que le registre dit d'un domaine, l'entrée la plus forte d'abord.
   *
   * `DO_NOT_CONTACT` prime sur `CONTACTED` : une entreprise à qui on a écrit
   * puis qu'on a décidé d'écarter reste écartée, et l'ordre chronologique ne
   * doit pas pouvoir inverser cela par accident.
   */
  ledgerFor(domain: string): LedgerVerdict | null {
    const row = this.db
      .prepare(
        `SELECT kind, note, recorded_by, recorded_at
           FROM outreach_ledger WHERE canonical_domain = ?
          ORDER BY CASE kind WHEN 'DO_NOT_CONTACT' THEN 0 ELSE 1 END, recorded_at DESC
          LIMIT 1`,
      )
      .get(canonicalDomainOf(domain)) as
      | { kind: string; note: string | null; recorded_by: string; recorded_at: string }
      | undefined;
    if (!row) return null;
    return {
      kind: row.kind as LedgerVerdict['kind'],
      note: row.note,
      recordedBy: row.recorded_by,
      recordedAt: row.recorded_at,
    };
  }

  /** Les identifiants de lots, du plus récent au plus ancien. */
  batchIds(): string[] {
    return (
      this.db
        .prepare('SELECT DISTINCT batch_id FROM sales_prospects ORDER BY batch_id DESC')
        .all() as Array<{ batch_id: string }>
    ).map((row) => row.batch_id);
  }

  /** Tout ce qui a été écrit sur ce domaine, dans l'ordre. */
  ledgerHistory(domain: string): Array<LedgerVerdict & { channel: string | null }> {
    return (
      this.db
        .prepare(
          `SELECT kind, channel, note, recorded_by, recorded_at
             FROM outreach_ledger WHERE canonical_domain = ? ORDER BY recorded_at ASC`,
        )
        .all(canonicalDomainOf(domain)) as Array<{
        kind: string; channel: string | null; note: string | null;
        recorded_by: string; recorded_at: string;
      }>
    ).map((row) => ({
      kind: row.kind as LedgerVerdict['kind'],
      channel: row.channel,
      note: row.note,
      recordedBy: row.recorded_by,
      recordedAt: row.recorded_at,
    }));
  }

  /**
   * Consigne un envoi ou une mise à l'écart. Jamais une correction.
   *
   * La table refuse les mises à jour et les suppressions : une décision
   * révisée s'écrit en ajoutant une ligne. L'historique reste donc lisible
   * dans l'ordre où il a été décidé, ce qu'une correction sur place détruirait.
   */
  recordOutreach(input: {
    domain: string;
    kind: LedgerVerdict['kind'];
    recordedBy: string;
    channel?: string | null;
    note?: string | null;
    recordedAt?: string;
  }): void {
    const domain = canonicalDomainOf(input.domain);
    if (!domain) throw invalidState('Un registre sans domaine ne dédoublonne rien.');
    if (!input.recordedBy.trim()) {
      throw invalidState('Le registre exige de savoir qui a décidé : une décision anonyme ne se conteste pas.');
    }
    this.db
      .prepare(
        `INSERT INTO outreach_ledger (id, canonical_domain, kind, channel, note, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id('olg'),
        domain,
        input.kind,
        input.channel ?? null,
        input.note ?? null,
        input.recordedBy.trim(),
        input.recordedAt ?? nowIso(),
      );
  }

  /**
   * Tous les domaines qu'ATLAS a déjà vus — prospects de tous les lots, plus
   * le registre.
   *
   * Sert à écarter un candidat avant la moindre dépense : repayer pour
   * qualifier une entreprise déjà en base est une dépense sans objet.
   */
  knownDomains(): Set<string> {
    const domains = new Set<string>();
    for (const row of this.db
      .prepare('SELECT DISTINCT domain FROM sales_prospects WHERE domain IS NOT NULL')
      .all() as Array<{ domain: string }>) {
      domains.add(canonicalDomainOf(row.domain));
    }
    for (const row of this.db
      .prepare('SELECT DISTINCT canonical_domain FROM outreach_ledger')
      .all() as Array<{ canonical_domain: string }>) {
      domains.add(row.canonical_domain);
    }
    return domains;
  }

  /**
   * Consigne qu'un ré-audit a condamné cette ligne.
   *
   * Écrit à côté, jamais dessus : `sales_prospects` garde ce que le lot avait
   * décidé, `sales_invalidations` porte ce qu'on en sait depuis.
   */
  invalidate(prospectId: string, reason: string): void {
    this.require(prospectId);
    this.db
      .prepare(
        `INSERT INTO sales_invalidations (prospect_id, reason, guard_version, recorded_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(prospect_id) DO UPDATE SET
           reason = excluded.reason,
           guard_version = excluded.guard_version,
           recorded_at = excluded.recorded_at`,
      )
      .run(prospectId, reason, GUARD_VERSION, nowIso());
  }

  invalidationFor(prospectId: string): { reason: string; guardVersion: string } | null {
    const row = this.db
      .prepare('SELECT reason, guard_version FROM sales_invalidations WHERE prospect_id = ?')
      .get(prospectId) as { reason: string; guard_version: string } | undefined;
    return row ? { reason: row.reason, guardVersion: row.guard_version } : null;
  }

  /**
   * Reclasse un fait dont la source ne tient pas.
   *
   * La revendication n'est pas touchée : c'est ce que le modèle a lu, et
   * l'effacer effacerait la trace. Seuls changent sa nature, sa source et le
   * motif — un fait dont on ne peut plus dire qu'il a été constaté sur le site
   * de l'entreprise redevient rapporté, ce qu'il n'aurait jamais dû cesser
   * d'être.
   */
  reclassifyEvidence(
    evidenceId: string,
    patch: {
      nature: SalesEvidence['nature'];
      sourceUrl?: string | null;
      basis?: string | null;
      confidence?: number;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE sales_evidence SET nature = ?, source_url = ?, basis = ?, confidence = ?
         WHERE id = ?`,
      )
      .run(
        patch.nature,
        patch.sourceUrl ?? null,
        patch.basis ?? null,
        patch.confidence ?? 0.5,
        evidenceId,
      );
  }

  /**
   * Enregistre toutes les coordonnées relevées, écartées comprises.
   *
   * Ne garder que celle retenue ferait disparaître le raisonnement : la revue
   * humaine doit pouvoir voir qu'une adresse commerciale n'existait pas, et
   * que c'est pour cela qu'un formulaire a été choisi.
   */
  setChannels(
    prospectId: string,
    channels: ReadonlyArray<{
      type: string;
      value: string;
      intent: string;
      suitability: string;
      sourceUrl: string;
      confidence: string;
      selected?: boolean;
    }>,
  ): void {
    this.require(prospectId);
    const insert = this.db.prepare(
      `INSERT INTO sales_contact_channels
         (id, prospect_id, type, value, intent, suitability, source_url, confidence,
          observed, selected, collected_at)
       VALUES (@id, @prospect, @type, @value, @intent, @suitability, @source, @confidence,
               1, @selected, @now)
       ON CONFLICT(prospect_id, type, value) DO UPDATE SET
         intent = excluded.intent, suitability = excluded.suitability,
         source_url = excluded.source_url, confidence = excluded.confidence,
         selected = excluded.selected`,
    );
    const now = nowIso();
    for (const channel of channels) {
      if (!channel.sourceUrl?.trim()) {
        throw invalidState(
          `« ${channel.value} » n'a pas de source : une coordonnée indéfendable ne s'enregistre pas.`,
        );
      }
      insert.run({
        id: id('sch'),
        prospect: prospectId,
        type: channel.type,
        value: channel.value,
        intent: channel.intent,
        suitability: channel.suitability,
        source: channel.sourceUrl,
        confidence: channel.confidence,
        selected: channel.selected ? 1 : 0,
        now,
      });
    }
  }

  channelsFor(prospectId: string): Array<{
    type: string; value: string; intent: string; suitability: string;
    sourceUrl: string; confidence: string; selected: boolean;
  }> {
    return (
      this.db
        .prepare(
          `SELECT type, value, intent, suitability, source_url, confidence, selected
             FROM sales_contact_channels WHERE prospect_id = ?
            ORDER BY selected DESC,
              CASE suitability WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1
                               WHEN 'LOW' THEN 2 ELSE 3 END, value`,
        )
        .all(prospectId) as Array<{
        type: string; value: string; intent: string; suitability: string;
        source_url: string; confidence: string; selected: number;
      }>
    ).map((row) => ({
      type: row.type,
      value: row.value,
      intent: row.intent,
      suitability: row.suitability,
      sourceUrl: row.source_url,
      confidence: row.confidence,
      selected: row.selected === 1,
    }));
  }

  evidenceFor(prospectId: string): SalesEvidence[] {
    return (
      this.db
        .prepare('SELECT * FROM sales_evidence WHERE prospect_id = ? ORDER BY collected_at')
        .all(prospectId) as Array<{
        id: string;
        prospect_id: string;
        field: string;
        claim: string;
        nature: SalesEvidenceNature;
        source_url: string | null;
        basis: string | null;
        confidence: number;
        collected_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      prospectId: row.prospect_id,
      field: row.field,
      claim: row.claim,
      nature: row.nature,
      sourceUrl: row.source_url,
      basis: row.basis,
      confidence: row.confidence,
      collectedAt: row.collected_at,
    }));
  }
}
