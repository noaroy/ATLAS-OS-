import type {
  Company,
  CompanyId,
  CompanyRelation,
  CompanySizeBand,
  Contact,
  Evidence,
  EvidenceNature,
  Source,
  SourceKey,
  SourceKind,
} from '@atlas/contracts';
import { id, nowIso, notFound } from '@atlas/core';
import type { Db } from '../database.ts';
import { fromJson, toJson, toBool, fromBool } from '../database.ts';

interface CompanyRow {
  id: string;
  canonical_key: string;
  name: string;
  legal_name: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  website: string | null;
  domain: string | null;
  industries: string;
  size_band: CompanySizeBand;
  employees_estimate: number | null;
  founded_year: number | null;
  description: string | null;
  profile: string;
  enriched: number;
  data_origin: string;
  first_seen_at: string;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

const toCompany = (row: CompanyRow): Company => ({
  id: row.id,
  canonicalKey: row.canonical_key,
  name: row.name,
  legalName: row.legal_name,
  country: row.country,
  region: row.region,
  city: row.city,
  website: row.website,
  domain: row.domain,
  industries: fromJson<string[]>(row.industries, []),
  sizeBand: row.size_band,
  employeesEstimate: row.employees_estimate,
  foundedYear: row.founded_year,
  description: row.description,
  profile: fromJson<Record<string, unknown>>(row.profile, {}),
  enriched: toBool(row.enriched),
  dataOrigin: (row.data_origin ?? 'unknown') as Company['dataOrigin'],
  firstSeenAt: row.first_seen_at,
  lastVerifiedAt: row.last_verified_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface EvidenceRow {
  id: string;
  company_id: string;
  opportunity_id: string | null;
  mission_id: string | null;
  field: string;
  claim: string;
  value: string | null;
  nature: EvidenceNature;
  source_key: string;
  source_ref: string | null;
  source_title: string | null;
  basis: string | null;
  confidence: number;
  simulated: number;
  collected_at: string;
  agent_key: string;
  created_at: string;
}

const toEvidence = (row: EvidenceRow): Evidence => ({
  id: row.id,
  companyId: row.company_id,
  opportunityId: row.opportunity_id,
  missionId: row.mission_id,
  field: row.field,
  claim: row.claim,
  value: fromJson<unknown>(row.value, null),
  nature: row.nature,
  sourceKey: row.source_key,
  sourceRef: row.source_ref,
  sourceTitle: row.source_title,
  basis: row.basis,
  confidence: row.confidence,
  simulated: toBool(row.simulated),
  collectedAt: row.collected_at,
  agentKey: row.agent_key,
  createdAt: row.created_at,
});

export interface UpsertCompanyInput {
  canonicalKey: string;
  name: string;
  legalName?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  website?: string | null;
  domain?: string | null;
  industries?: string[];
  sizeBand?: CompanySizeBand;
  employeesEstimate?: number | null;
  foundedYear?: number | null;
  description?: string | null;
  profile?: Record<string, unknown>;
  enriched?: boolean;
  /**
   * La lignée de la fiche, posée à la création.
   *
   * Omise, elle vaut `unknown` — et `unknown` est refusé en mode réel. Un
   * appelant qui sait d'où vient sa donnée doit le dire ; celui qui ne le sait
   * pas ne doit pas pouvoir faire passer son ignorance pour une garantie.
   */
  dataOrigin?: Company['dataOrigin'];
}

/**
 * The company registry and everything ATLAS holds about a company.
 *
 * Kept in one repository because they share a lifetime: evidence, contacts and
 * relations are meaningless without the company they describe, and all four are
 * written together during discovery and enrichment.
 */
export class CompanyRepository {
  constructor(private readonly db: Db) {}

  // ─── Companies ──────────────────────────────────────────────────────────

  /**
   * Registers a company, or merges into the existing one.
   *
   * Merging is deliberately conservative: a later sighting fills gaps but never
   * overwrites a field that is already known, so a thin directory listing
   * cannot degrade a well-researched profile.
   */
  upsert(input: UpsertCompanyInput): { company: Company; created: boolean } {
    const existing = this.getByCanonicalKey(input.canonicalKey);
    const now = nowIso();

    if (!existing) {
      const row: CompanyRow = {
        id: id('cmp'),
        canonical_key: input.canonicalKey,
        name: input.name,
        legal_name: input.legalName ?? null,
        country: input.country ?? null,
        region: input.region ?? null,
        city: input.city ?? null,
        website: input.website ?? null,
        domain: input.domain ?? null,
        industries: toJson(input.industries ?? []),
        size_band: input.sizeBand ?? 'unknown',
        employees_estimate: input.employeesEstimate ?? null,
        founded_year: input.foundedYear ?? null,
        description: input.description ?? null,
        profile: toJson(input.profile ?? {}),
        enriched: fromBool(input.enriched ?? false),
        data_origin: input.dataOrigin ?? 'unknown',
        first_seen_at: now,
        last_verified_at: null,
        created_at: now,
        updated_at: now,
      };
      this.db
        .prepare(
          `INSERT INTO companies (id, canonical_key, name, legal_name, country, region, city,
                                  website, domain, industries, size_band, employees_estimate,
                                  founded_year, description, profile, enriched, data_origin,
                                  first_seen_at, last_verified_at, created_at, updated_at)
           VALUES (@id, @canonical_key, @name, @legal_name, @country, @region, @city,
                   @website, @domain, @industries, @size_band, @employees_estimate,
                   @founded_year, @description, @profile, @enriched, @data_origin,
                   @first_seen_at, @last_verified_at, @created_at, @updated_at)`,
        )
        .run(row);
      return { company: toCompany(row), created: true };
    }

    const merged: Company = {
      ...existing,
      name: existing.name || input.name,
      legalName: existing.legalName ?? input.legalName ?? null,
      country: existing.country ?? input.country ?? null,
      region: existing.region ?? input.region ?? null,
      city: existing.city ?? input.city ?? null,
      website: existing.website ?? input.website ?? null,
      domain: existing.domain ?? input.domain ?? null,
      industries: existing.industries.length > 0 ? existing.industries : (input.industries ?? []),
      sizeBand: existing.sizeBand !== 'unknown' ? existing.sizeBand : (input.sizeBand ?? 'unknown'),
      employeesEstimate: existing.employeesEstimate ?? input.employeesEstimate ?? null,
      foundedYear: existing.foundedYear ?? input.foundedYear ?? null,
      description: existing.description ?? input.description ?? null,
      profile: { ...(input.profile ?? {}), ...existing.profile },
      enriched: existing.enriched || (input.enriched ?? false),
      // `...existing` a déjà posé `dataOrigin`, et rien ne le réécrit ici :
      // c'est délibéré et c'est la propriété centrale de cette colonne. Une
      // mission réelle qui recroise une fiche fabriquée ne doit pas pouvoir la
      // blanchir — c'est exactement le chemin par lequel quatre entreprises
      // inventées sont entrées dans les résultats de VAL-003.
      updatedAt: now,
    };

    this.#write(merged);
    return { company: merged, created: false };
  }

  /** Applies enrichment, which — unlike a sighting — may replace known fields. */
  enrich(companyId: CompanyId, patch: Partial<UpsertCompanyInput>): Company {
    const existing = this.require(companyId);
    const updated: Company = {
      ...existing,
      legalName: patch.legalName ?? existing.legalName,
      country: patch.country ?? existing.country,
      region: patch.region ?? existing.region,
      city: patch.city ?? existing.city,
      website: patch.website ?? existing.website,
      domain: patch.domain ?? existing.domain,
      industries: patch.industries?.length ? patch.industries : existing.industries,
      sizeBand: patch.sizeBand ?? existing.sizeBand,
      employeesEstimate: patch.employeesEstimate ?? existing.employeesEstimate,
      foundedYear: patch.foundedYear ?? existing.foundedYear,
      description: patch.description ?? existing.description,
      profile: { ...existing.profile, ...(patch.profile ?? {}) },
      enriched: true,
      updatedAt: nowIso(),
    };
    this.#write(updated);
    return updated;
  }

  /** Records that a fact about this company was observed at a source just now. */
  markVerified(companyId: CompanyId, at = nowIso()): void {
    this.db
      .prepare('UPDATE companies SET last_verified_at = ?, updated_at = ? WHERE id = ?')
      .run(at, at, companyId);
  }

  get(companyId: CompanyId): Company | null {
    const row = this.db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as
      | CompanyRow
      | undefined;
    return row ? toCompany(row) : null;
  }

  require(companyId: CompanyId): Company {
    const company = this.get(companyId);
    if (!company) throw notFound(`Company '${companyId}'`);
    return company;
  }

  getByCanonicalKey(canonicalKey: string): Company | null {
    const row = this.db
      .prepare('SELECT * FROM companies WHERE canonical_key = ?')
      .get(canonicalKey) as CompanyRow | undefined;
    return row ? toCompany(row) : null;
  }

  /** Domain is the strongest identity signal, so it gets its own lookup. */
  getByDomain(domain: string): Company | null {
    const row = this.db.prepare('SELECT * FROM companies WHERE domain = ?').get(domain) as
      | CompanyRow
      | undefined;
    return row ? toCompany(row) : null;
  }

  search(query: { text?: string; country?: string; limit?: number }): Company[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.text) {
      clauses.push('(name LIKE ? OR legal_name LIKE ? OR domain LIKE ?)');
      const like = `%${query.text}%`;
      params.push(like, like, like);
    }
    if (query.country) {
      clauses.push('country = ?');
      params.push(query.country);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(query.limit ?? 50);
    return (
      this.db
        .prepare(`SELECT * FROM companies ${where} ORDER BY updated_at DESC LIMIT ?`)
        .all(...params) as CompanyRow[]
    ).map(toCompany);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number }).n;
  }

  #write(company: Company): void {
    this.db
      .prepare(
        `UPDATE companies SET
           name = @name, legal_name = @legal_name, country = @country, region = @region,
           city = @city, website = @website, domain = @domain, industries = @industries,
           size_band = @size_band, employees_estimate = @employees_estimate,
           founded_year = @founded_year, description = @description, profile = @profile,
           enriched = @enriched, updated_at = @updated_at
         WHERE id = @id`,
        // `data_origin` est absente de cette liste, et doit le rester : la
        // lignée se pose à la création et ne se réévalue jamais. L'ajouter ici
        // rouvrirait silencieusement le blanchiment que la colonne empêche.
      )
      .run({
        id: company.id,
        name: company.name,
        legal_name: company.legalName,
        country: company.country,
        region: company.region,
        city: company.city,
        website: company.website,
        domain: company.domain,
        industries: toJson(company.industries),
        size_band: company.sizeBand,
        employees_estimate: company.employeesEstimate,
        founded_year: company.foundedYear,
        description: company.description,
        profile: toJson(company.profile),
        enriched: fromBool(company.enriched),
        updated_at: company.updatedAt,
      });
  }

  // ─── Sources ────────────────────────────────────────────────────────────

  ensureSource(input: {
    key: SourceKey;
    kind: SourceKind;
    label: string;
    reference?: string | null;
    reliability?: number;
  }): Source {
    const existing = this.getSource(input.key);
    if (existing) return existing;

    const source: Source = {
      key: input.key,
      kind: input.kind,
      label: input.label,
      reference: input.reference ?? null,
      reliability: input.reliability ?? 0.5,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO sources (key, kind, label, reference, reliability, created_at)
         VALUES (@key, @kind, @label, @reference, @reliability, @createdAt)`,
      )
      .run(source);
    return source;
  }

  getSource(key: SourceKey): Source | null {
    const row = this.db.prepare('SELECT * FROM sources WHERE key = ?').get(key) as
      | { key: string; kind: SourceKind; label: string; reference: string | null; reliability: number; created_at: string }
      | undefined;
    return row
      ? {
          key: row.key,
          kind: row.kind,
          label: row.label,
          reference: row.reference,
          reliability: row.reliability,
          createdAt: row.created_at,
        }
      : null;
  }

  listSources(): Source[] {
    return (
      this.db.prepare('SELECT * FROM sources ORDER BY reliability DESC, key').all() as Array<{
        key: string;
        kind: SourceKind;
        label: string;
        reference: string | null;
        reliability: number;
        created_at: string;
      }>
    ).map((row) => ({
      key: row.key,
      kind: row.kind,
      label: row.label,
      reference: row.reference,
      reliability: row.reliability,
      createdAt: row.created_at,
    }));
  }

  // ─── Evidence ───────────────────────────────────────────────────────────

  /** Appends one sourced claim. Evidence is never updated, only added to. */
  appendEvidence(input: Omit<Evidence, 'id' | 'createdAt'>): Evidence {
    const now = nowIso();
    const evidence: Evidence = { ...input, id: id('evd'), createdAt: now };
    this.db
      .prepare(
        `INSERT INTO evidence (id, company_id, opportunity_id, mission_id, field, claim, value,
                               nature, source_key, source_ref, source_title, basis, confidence,
                               simulated, collected_at, agent_key, created_at)
         VALUES (@id, @company_id, @opportunity_id, @mission_id, @field, @claim, @value,
                 @nature, @source_key, @source_ref, @source_title, @basis, @confidence,
                 @simulated, @collected_at, @agent_key, @created_at)`,
      )
      .run({
        id: evidence.id,
        company_id: evidence.companyId,
        opportunity_id: evidence.opportunityId,
        mission_id: evidence.missionId,
        field: evidence.field,
        claim: evidence.claim,
        value: toJson(evidence.value ?? null),
        nature: evidence.nature,
        source_key: evidence.sourceKey,
        source_ref: evidence.sourceRef,
        source_title: evidence.sourceTitle,
        basis: evidence.basis,
        confidence: evidence.confidence,
        simulated: fromBool(evidence.simulated),
        collected_at: evidence.collectedAt,
        agent_key: evidence.agentKey,
        created_at: now,
      });
    return evidence;
  }

  evidenceFor(companyId: CompanyId): Evidence[] {
    return (
      this.db
        .prepare('SELECT * FROM evidence WHERE company_id = ? ORDER BY collected_at DESC')
        .all(companyId) as EvidenceRow[]
    ).map(toEvidence);
  }

  /**
   * Une affirmation déjà écrite mot pour mot sur cette entreprise.
   *
   * Les agents reformulent rarement : quand un candidat est revu, la même
   * phrase revient à l'identique. Chaque copie compte pourtant dans la force de
   * la preuve, où la largeur joue — trois fois la même source y ressemble à
   * trois corroborations. C'est le seul endroit où la répétition ment.
   *
   * La comparaison est syntaxique : espaces normalisés et casse ignorée, rien
   * de plus. Deux formulations différentes du même fait restent deux preuves —
   * les rapprocher demanderait de comprendre les phrases, donc un appel au
   * modèle, donc une dépense, pour un jugement qu'on ne pourrait pas auditer.
   */
  findIdenticalEvidence(companyId: CompanyId, field: string, claim: string): Evidence | null {
    const row = this.db
      .prepare(
        `SELECT * FROM evidence
          WHERE company_id = ?
            AND lower(trim(field)) = lower(trim(?))
            AND lower(trim(claim)) = lower(trim(?))
          LIMIT 1`,
      )
      .get(companyId, field, claim.trim().replace(/\s+/g, ' ')) as EvidenceRow | undefined;
    return row ? toEvidence(row) : null;
  }

  evidenceForOpportunity(opportunityId: string): Evidence[] {
    return (
      this.db
        .prepare('SELECT * FROM evidence WHERE opportunity_id = ? ORDER BY collected_at DESC')
        .all(opportunityId) as EvidenceRow[]
    ).map(toEvidence);
  }

  evidenceForMission(missionId: string): Evidence[] {
    return (
      this.db
        .prepare('SELECT * FROM evidence WHERE mission_id = ? ORDER BY collected_at DESC')
        .all(missionId) as EvidenceRow[]
    ).map(toEvidence);
  }

  countEvidenceForMission(missionId: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM evidence WHERE mission_id = ?')
        .get(missionId) as { n: number }
    ).n;
  }

  // ─── Contacts ───────────────────────────────────────────────────────────

  addContact(input: Omit<Contact, 'id' | 'createdAt'>): Contact {
    const contact: Contact = { ...input, id: id('cnt'), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO contacts (id, company_id, name, role, email, phone, linkedin,
                               confidence, evidence_id, created_at)
         VALUES (@id, @company_id, @name, @role, @email, @phone, @linkedin,
                 @confidence, @evidence_id, @created_at)`,
      )
      .run({
        id: contact.id,
        company_id: contact.companyId,
        name: contact.name,
        role: contact.role,
        email: contact.email,
        phone: contact.phone,
        linkedin: contact.linkedin,
        confidence: contact.confidence,
        evidence_id: contact.evidenceId,
        created_at: contact.createdAt,
      });
    return contact;
  }

  contactsFor(companyId: CompanyId): Contact[] {
    return (
      this.db
        .prepare('SELECT * FROM contacts WHERE company_id = ? ORDER BY confidence DESC')
        .all(companyId) as Array<{
        id: string;
        company_id: string;
        name: string;
        role: string | null;
        email: string | null;
        phone: string | null;
        linkedin: string | null;
        confidence: number;
        evidence_id: string | null;
        created_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      companyId: row.company_id,
      name: row.name,
      role: row.role,
      email: row.email,
      phone: row.phone,
      linkedin: row.linkedin,
      confidence: row.confidence,
      evidenceId: row.evidence_id,
      createdAt: row.created_at,
    }));
  }

  // ─── Relations ──────────────────────────────────────────────────────────

  addRelation(input: Omit<CompanyRelation, 'id' | 'createdAt'>): CompanyRelation {
    const relation: CompanyRelation = { ...input, id: id('rel'), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO company_relations (id, from_company_id, to_company_id, to_name, kind,
                                        description, confidence, evidence_id, created_at)
         VALUES (@id, @from_company_id, @to_company_id, @to_name, @kind,
                 @description, @confidence, @evidence_id, @created_at)`,
      )
      .run({
        id: relation.id,
        from_company_id: relation.fromCompanyId,
        to_company_id: relation.toCompanyId,
        to_name: relation.toName,
        kind: relation.kind,
        description: relation.description,
        confidence: relation.confidence,
        evidence_id: relation.evidenceId,
        created_at: relation.createdAt,
      });
    return relation;
  }

  relationsFor(companyId: CompanyId): CompanyRelation[] {
    return (
      this.db
        .prepare('SELECT * FROM company_relations WHERE from_company_id = ? ORDER BY created_at')
        .all(companyId) as Array<{
        id: string;
        from_company_id: string;
        to_company_id: string | null;
        to_name: string | null;
        kind: string;
        description: string;
        confidence: number;
        evidence_id: string | null;
        created_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      fromCompanyId: row.from_company_id,
      toCompanyId: row.to_company_id,
      toName: row.to_name,
      kind: row.kind,
      description: row.description,
      confidence: row.confidence,
      evidenceId: row.evidence_id,
      createdAt: row.created_at,
    }));
  }
}
