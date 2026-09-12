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
  messageSubject: string | null;
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
  message_subject: string | null;
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
  messageSubject: row.message_subject,
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
      message_subject: null,
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
   * Établir le pays sur une preuve, jamais sur une supposition.
   *
   * Le pays valait « France » pour tout le monde : le lot le recopiait depuis
   * la régionalisation de sa propre requête. Un fabricant chinois et une
   * société canadienne sont entrés ainsi, et le profil ICP — France, Belgique,
   * Suisse — ne les a pas écartés.
   *
   * La source est obligatoire pour la même raison qu'ailleurs : sans elle, la
   * colonne redeviendrait ce qu'elle était, une intention déguisée en mesure.
   * Un pays qu'aucune page ne publie reste `null`, et `null` se lit
   * « à vérifier » — jamais « France ».
   */
  setCountry(
    prospectId: string,
    preuve: { country: string; basis: string; sourceUrl: string },
  ): SalesProspect {
    if (!preuve.country.trim()) {
      throw invalidState('Un pays vide ne s’enregistre pas : l’absence se note null.');
    }
    if (!preuve.sourceUrl.trim()) {
      throw invalidState(
        'Un pays sans source est une supposition. ' +
          'C’est exactement ce que cette colonne contenait avant.',
      );
    }
    const actuel = this.require(prospectId);
    const sources = [
      ...(actuel.identitySources ?? []),
      `pays « ${preuve.country} » etabli par ${preuve.basis} (${preuve.sourceUrl})`,
    ];
    this.db
      .prepare(
        `UPDATE sales_prospects SET country = ?, identity_sources = ?, updated_at = ?
           WHERE id = ?`,
      )
      .run(preuve.country.trim(), JSON.stringify(sources), nowIso(), prospectId);
    return this.require(prospectId);
  }

  /**
   * Effacer un pays qu'aucune source ne soutient.
   *
   * `setCountry` refuse d'écrire un pays non prouvé — c'est sa raison d'être.
   * Mais il fallait aussi pouvoir retirer ceux qui avaient été écrits avant que
   * la preuve soit exigée : Getinge portait « France » parce que la requête
   * était régionalisée en FR, et rien ne permettait de revenir en arrière.
   *
   * Effacer n'est pas écrire : on retire une affirmation sans en poser une
   * autre. Le champ redevient `null`, c'est-à-dire « à vérifier ».
   */
  clearUnprovenCountry(prospectId: string, reason: string): SalesProspect {
    const actuel = this.require(prospectId);
    if (actuel.country === null) return actuel;
    const sources = [
      ...(actuel.identitySources ?? []),
      `pays « ${actuel.country} » retire : ${reason}`,
    ];
    this.db
      .prepare(
        `UPDATE sales_prospects SET country = NULL, identity_sources = ?, updated_at = ?
           WHERE id = ?`,
      )
      .run(JSON.stringify(sources), nowIso(), prospectId);
    return this.require(prospectId);
  }

  /**
   * Corriger le nom commercial quand la découverte a retenu un titre de page.
   *
   * Le nom vient du titre du résultat de recherche, et ce titre est écrit pour
   * le référencement, pas pour désigner une entreprise. « Magasin de sécurité
   * près de Bordeaux » est un bon titre et un mauvais nom : le message
   * d'approche l'emploie tel quel, et arrive en s'adressant à une phrase.
   *
   * La correction exige une source. Sans elle, ce serait une invention polie —
   * exactement ce que l'extraction d'identité passe son temps à empêcher. Le
   * nom d'origine est conservé dans les sources : une correction qui efface ce
   * qu'elle corrige ne peut plus être relue.
   *
   * Ce n'est pas `confirmIdentity`, qui ne renomme jamais et n'élève que la
   * confiance : là, l'entité juridique sert de preuve et le nom commercial
   * reste celui que le destinataire reconnaît. Ici, c'est le nom commercial
   * lui-même qui était faux.
   */
  correctCommercialName(
    prospectId: string,
    correction: { name: string; source: string },
  ): SalesProspect {
    const nom = correction.name.trim();
    if (nom.length < 2) {
      throw invalidState('Un nom commercial vide ne corrige rien.');
    }
    if (!correction.source.trim()) {
      throw invalidState(
        'Une correction de nom sans source est une invention. ' +
          'La page qui porte le nom doit être citée.',
      );
    }
    const actuel = this.require(prospectId);
    if (actuel.companyName === nom) return actuel;

    const sources = [
      ...(actuel.identitySources ?? []),
      `nom commercial « ${nom} » releve sur ${correction.source} ` +
        `(remplace « ${actuel.companyName} », titre de page)`,
    ];
    this.db
      .prepare(
        `UPDATE sales_prospects SET company_name = ?, identity_sources = ?, updated_at = ?
           WHERE id = ?`,
      )
      .run(nom, JSON.stringify(sources), nowIso(), prospectId);
    return this.require(prospectId);
  }

  /**
   * Corriger un brouillon déjà écrit : son objet, son corps, rien d'autre.
   *
   * `setOutreach` compose un brouillon et exige pour cela la preuve qui le
   * fonde. Ce n'est pas ce qui se passe ici : le texte existe, il a été relu,
   * et seule sa forme change — une ligne d'objet qui manquait, une devise
   * écrite « EUR » au lieu de « € ».
   *
   * La garde est donc l'inverse de celle de `setOutreach` : au lieu d'exiger
   * une preuve nouvelle, cette méthode refuse d'agir si le brouillon n'existe
   * pas encore. Elle révise, elle ne crée pas — sans quoi elle offrirait un
   * chemin pour écrire un message sans la preuve qui le justifie.
   */
  reviseOutreachText(
    prospectId: string,
    revision: { subject?: string; messageEmail?: string },
  ): SalesProspect {
    const actuel = this.require(prospectId);
    if (!actuel.personalizationFactId || !actuel.messageEmail) {
      throw invalidState(
        'Ce prospect n’a pas de brouillon à corriger. ' +
          'Cette méthode révise un texte existant ; elle n’en compose aucun.',
      );
    }
    this.db
      .prepare(
        `UPDATE sales_prospects SET message_subject = ?, message_email = ?, updated_at = ?
           WHERE id = ?`,
      )
      .run(
        revision.subject ?? actuel.messageSubject,
        revision.messageEmail ?? actuel.messageEmail,
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
  /**
   * Confirmer l'identite d'un prospect avec une preuve de premiere main.
   *
   * L'identite est etablie a la decouverte, a partir de ce que la recherche a
   * rapporte : souvent le seul titre du resultat, ce qui plafonne la confiance
   * a 0,55 et bloque la redaction d'un brouillon. C'est voulu — ecrire a une
   * entreprise en l'appelant par un nom non verifie se remarque.
   *
   * **Cette methode ne renomme jamais le prospect.**
   *
   * Une entite juridique et une marque commerciale sont deux choses. Les
   * mentions legales de groupe-ledoux.com nomment LEDOUX FINANCE, le holding ;
   * l'entreprise qu'on a trouvee et dont on cite les faits s'appelle Cybermeca.
   * La preuve legale sert a corroborer que le domaine appartient bien a une
   * societe identifiee — elle ne dit pas a qui on ecrit. Ecraser le nom
   * commercial produirait un courriel qui cite un fait sur une marque en
   * s'adressant a sa maison mere : exact sur le papier, et incomprehensible
   * pour celui qui le recoit.
   *
   * Le nom legal est donc conserve dans les sources d'identite, ou il reste
   * lisible et verifiable, et la confiance seule est relevee.
   *
   * La confiance ne peut que monter : une confirmation s'ajoute, elle ne retire
   * pas ce qui etait deja etabli.
   */
  confirmIdentity(
    prospectId: string,
    input: {
      /** Le nom lu sur la preuve. Conserve comme source, jamais applique. */
      legalName: string;
      confidence: number;
      source: string;
    },
  ): { applied: boolean; reason: string } {
    const row = this.db
      .prepare('SELECT company_name, identity_confidence, identity_sources FROM sales_prospects WHERE id = ?')
      .get(prospectId) as
      | { company_name: string; identity_confidence: number | null; identity_sources: string | null }
      | undefined;
    if (!row) return { applied: false, reason: 'prospect inconnu' };

    const actuelle = row.identity_confidence ?? 0;
    if (input.confidence <= actuelle) {
      return {
        applied: false,
        reason: `confiance deja a ${actuelle} : une confirmation ne la baisse pas`,
      };
    }
    const legal = input.legalName.trim();
    if (legal.length < 2) return { applied: false, reason: 'denomination vide' };

    const sources: string[] = row.identity_sources
      ? (JSON.parse(row.identity_sources) as string[])
      : [];
    // Le nom legal entre ici, dans les sources — pas dans le nom commercial.
    const trace = `entite juridique « ${legal} » — ${input.source}`;
    if (!sources.includes(trace)) sources.push(trace);

    this.db
      .prepare(
        `UPDATE sales_prospects
            SET identity_confidence = @confidence,
                identity_sources = @sources
          WHERE id = @id`,
      )
      .run({
        id: prospectId,
        confidence: input.confidence,
        sources: JSON.stringify(sources),
      });

    return {
      applied: true,
      reason:
        `identite corroboree par « ${legal} » a ${input.confidence} ; ` +
        `nom commercial « ${row.company_name} » inchange`,
    };
  }

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
          ORDER BY CASE kind WHEN 'DO_NOT_CONTACT' THEN 0 ELSE 1 END,
                   recorded_at DESC, rowid DESC
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
  ledgerHistory(
    domain: string,
  ): Array<LedgerVerdict & { id: string; channel: string | null; followUpAt: string | null }> {
    return (
      this.db
        .prepare(
          `SELECT id, kind, channel, note, follow_up_at, recorded_by, recorded_at
             FROM outreach_ledger WHERE canonical_domain = ?
            ORDER BY recorded_at ASC, rowid ASC`,
        )
        .all(canonicalDomainOf(domain)) as Array<{
        id: string; kind: string; channel: string | null; note: string | null;
        follow_up_at: string | null; recorded_by: string; recorded_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      kind: row.kind as LedgerVerdict['kind'],
      channel: row.channel,
      note: row.note,
      followUpAt: row.follow_up_at,
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
    followUpAt?: string | null;
    recordedAt?: string;
  }): { recorded: boolean; reason: string } {
    const domain = canonicalDomainOf(input.domain);
    if (!domain) throw invalidState('Un registre sans domaine ne dédoublonne rien.');
    if (!input.recordedBy.trim()) {
      throw invalidState('Le registre exige de savoir qui a décidé : une décision anonyme ne se conteste pas.');
    }
    // Append-only ne veut pas dire « écrire deux fois la même chose ».
    // Réenregistrer un envoi déjà consigné, à l'identique, n'ajoute aucune
    // information et rend l'historique plus difficile à lire — ce qui est
    // exactement ce que l'append-only cherchait à préserver.
    const last = this.db
      .prepare(
        `SELECT kind, note, follow_up_at FROM outreach_ledger
          WHERE canonical_domain = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1`,
      )
      .get(domain) as { kind: string; note: string | null; follow_up_at: string | null } | undefined;

    if (
      last &&
      last.kind === input.kind &&
      (last.note ?? null) === (input.note ?? null) &&
      (last.follow_up_at ?? null) === (input.followUpAt ?? null)
    ) {
      return {
        recorded: false,
        reason: `« ${domain} » porte déjà exactement cette décision : rien à ajouter.`,
      };
    }

    this.db
      .prepare(
        `INSERT INTO outreach_ledger
           (id, canonical_domain, kind, channel, note, follow_up_at, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id('olg'),
        domain,
        input.kind,
        input.channel ?? null,
        input.note ?? null,
        input.followUpAt ?? null,
        input.recordedBy.trim(),
        input.recordedAt ?? nowIso(),
      );
    return { recorded: true, reason: `${domain} → ${input.kind}` };
  }

  /** Tout le registre, une ligne par domaine, verdict courant en tête. */
  ledgerDomains(): Array<{
    domain: string;
    kind: LedgerVerdict['kind'];
    note: string | null;
    followUpAt: string | null;
    recordedBy: string;
    recordedAt: string;
    entries: number;
  }> {
    return (
      this.db
        .prepare('SELECT DISTINCT canonical_domain FROM outreach_ledger ORDER BY canonical_domain')
        .all() as Array<{ canonical_domain: string }>
    ).map((row) => {
      const current = this.db
        .prepare(
          `SELECT kind, note, follow_up_at, recorded_by, recorded_at
             FROM outreach_ledger WHERE canonical_domain = ?
            ORDER BY CASE kind WHEN 'DO_NOT_CONTACT' THEN 0 ELSE 1 END,
                     recorded_at DESC, rowid DESC
            LIMIT 1`,
        )
        .get(row.canonical_domain) as {
        kind: string; note: string | null; follow_up_at: string | null;
        recorded_by: string; recorded_at: string;
      };
      const { n } = this.db
        .prepare('SELECT COUNT(*) n FROM outreach_ledger WHERE canonical_domain = ?')
        .get(row.canonical_domain) as { n: number };
      return {
        domain: row.canonical_domain,
        kind: current.kind as LedgerVerdict['kind'],
        note: current.note,
        followUpAt: current.follow_up_at,
        recordedBy: current.recorded_by,
        recordedAt: current.recorded_at,
        entries: n,
      };
    });
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
