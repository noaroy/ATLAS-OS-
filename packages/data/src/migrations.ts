/**
 * Schema migrations.
 *
 * Migrations are append-only and never edited once released — the `version`
 * column in `schema_migrations` is the contract. Each entry runs inside a
 * transaction; a failure leaves the database at the previous version.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
-- ─── Identity ──────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('founder','operator','viewer')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

-- Sessions are stored so a token can be revoked immediately.
CREATE TABLE auth_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX idx_auth_sessions_expiry ON auth_sessions(expires_at);

-- ─── Runtime settings (mutable configuration) ──────────────────────────────
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,           -- JSON
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- ─── Village geography ─────────────────────────────────────────────────────
CREATE TABLE buildings (
  key            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  department     TEXT NOT NULL,
  purpose        TEXT NOT NULL,
  x              REAL NOT NULL,
  y              REAL NOT NULL,
  level          INTEGER NOT NULL DEFAULT 1,
  activity_score REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'nominal',
  unlocked_at    TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

-- ─── Agents ────────────────────────────────────────────────────────────────
-- Definition and live state share a row: an agent is a singleton actor, and
-- keeping them together makes the village query a single scan.
CREATE TABLE agents (
  key              TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  role             TEXT NOT NULL,
  tier             TEXT NOT NULL CHECK (tier IN ('director','business','support','evolution')),
  building         TEXT NOT NULL REFERENCES buildings(key),
  mission          TEXT NOT NULL,
  skills           TEXT NOT NULL,    -- JSON array
  tools            TEXT NOT NULL,    -- JSON array (allow-list)
  actions          TEXT NOT NULL,    -- JSON array
  system_prompt    TEXT NOT NULL,
  model            TEXT,
  max_steps        INTEGER NOT NULL DEFAULT 8,
  appearance       TEXT NOT NULL,    -- JSON
  enabled          INTEGER NOT NULL DEFAULT 1,

  status           TEXT NOT NULL DEFAULT 'available',
  current_mission  TEXT,
  current_task     TEXT,
  current_activity TEXT,
  location         TEXT NOT NULL,
  destination      TEXT,
  last_active_at   TEXT,

  quality_score    REAL NOT NULL DEFAULT 75,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_building ON agents(building);

-- ─── Missions ──────────────────────────────────────────────────────────────
CREATE TABLE missions (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  objective   TEXT NOT NULL,
  context     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL,
  priority    TEXT NOT NULL DEFAULT 'normal',
  created_by  TEXT NOT NULL,
  plan        TEXT,               -- JSON MissionPlan
  progress    REAL NOT NULL DEFAULT 0,
  result      TEXT,               -- JSON MissionResult
  error       TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  parent_id   TEXT REFERENCES missions(id) ON DELETE SET NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_missions_status ON missions(status);
CREATE INDEX idx_missions_created ON missions(created_at DESC);
CREATE INDEX idx_missions_parent ON missions(parent_id);

CREATE TABLE mission_tasks (
  id           TEXT PRIMARY KEY,
  mission_id   TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  ref          TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  title        TEXT NOT NULL,
  agent_key    TEXT NOT NULL,
  action       TEXT NOT NULL,
  instruction  TEXT NOT NULL,
  input        TEXT NOT NULL DEFAULT '{}',
  output       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  depends_on   TEXT NOT NULL DEFAULT '[]',
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  error        TEXT,
  tokens_used  INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT,
  finished_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (mission_id, ref)
);
CREATE INDEX idx_tasks_mission ON mission_tasks(mission_id, seq);
CREATE INDEX idx_tasks_status ON mission_tasks(status);
CREATE INDEX idx_tasks_agent ON mission_tasks(agent_key, finished_at DESC);

-- ─── Inter-agent communication ─────────────────────────────────────────────
CREATE TABLE agent_messages (
  id              TEXT PRIMARY KEY,
  mission_id      TEXT REFERENCES missions(id) ON DELETE CASCADE,
  task_id         TEXT,
  from_actor      TEXT NOT NULL,
  to_actor        TEXT NOT NULL,
  kind            TEXT NOT NULL,
  objective       TEXT NOT NULL,
  payload         TEXT NOT NULL DEFAULT '{}',
  expected_output TEXT,
  status          TEXT NOT NULL DEFAULT 'sent',
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_messages_mission ON agent_messages(mission_id, created_at);
CREATE INDEX idx_messages_actors ON agent_messages(from_actor, to_actor);

-- ─── Event log ─────────────────────────────────────────────────────────────
CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  severity   TEXT NOT NULL,
  source     TEXT NOT NULL,
  mission_id TEXT,
  agent_key  TEXT,
  message    TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_created ON events(created_at DESC);
CREATE INDEX idx_events_type ON events(type, created_at DESC);
CREATE INDEX idx_events_mission ON events(mission_id, created_at DESC);
CREATE INDEX idx_events_severity ON events(severity, created_at DESC);

-- ─── Memory ────────────────────────────────────────────────────────────────
CREATE TABLE memory_items (
  id              TEXT PRIMARY KEY,
  tier            TEXT NOT NULL CHECK (tier IN ('operational','strategic','business')),
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}',
  tags            TEXT NOT NULL DEFAULT '[]',
  mission_id      TEXT,
  agent_key       TEXT,
  importance      REAL NOT NULL DEFAULT 0.5,
  confidence      REAL NOT NULL DEFAULT 0.7,
  access_count    INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  expires_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_memory_tier ON memory_items(tier, importance DESC);
CREATE INDEX idx_memory_mission ON memory_items(mission_id);
CREATE INDEX idx_memory_expiry ON memory_items(expires_at);

-- Full-text index over title/content/tags. External-content FTS keeps a single
-- source of truth in memory_items; triggers hold the index in sync.
CREATE VIRTUAL TABLE memory_fts USING fts5(
  title, content, tags,
  content='memory_items',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER memory_ai AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;
CREATE TRIGGER memory_ad AFTER DELETE ON memory_items BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;
CREATE TRIGGER memory_au AFTER UPDATE ON memory_items BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
  INSERT INTO memory_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;

-- ─── Automation ────────────────────────────────────────────────────────────
CREATE TABLE workflows (
  id           TEXT PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  external_id  TEXT,
  webhook_path TEXT,
  trigger      TEXT NOT NULL,     -- JSON WorkflowTrigger
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_run_at  TEXT,
  last_status  TEXT,
  run_count    INTEGER NOT NULL DEFAULT 0,
  next_run_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_workflows_next_run ON workflows(enabled, next_run_at);

CREATE TABLE workflow_runs (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  mission_id  TEXT,
  status      TEXT NOT NULL,
  input       TEXT NOT NULL DEFAULT '{}',
  output      TEXT,
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_workflow_runs ON workflow_runs(workflow_id, started_at DESC);

-- ─── Evolution ─────────────────────────────────────────────────────────────
CREATE TABLE improvements (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL,
  rationale   TEXT NOT NULL,
  evidence    TEXT NOT NULL DEFAULT '{}',
  change      TEXT NOT NULL,      -- JSON ImprovementChange
  revert_data TEXT,               -- JSON snapshot for a clean rollback
  impact      TEXT NOT NULL DEFAULT 'low',
  risk        TEXT NOT NULL DEFAULT 'low',
  status      TEXT NOT NULL DEFAULT 'proposed',
  proposed_by TEXT NOT NULL,
  decided_by  TEXT,
  /* Stable hash of the change, so the same proposal is never raised twice. */
  fingerprint TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  applied_at  TEXT
);
CREATE INDEX idx_improvements_status ON improvements(status, created_at DESC);
CREATE UNIQUE INDEX idx_improvements_open_fingerprint
  ON improvements(fingerprint) WHERE status IN ('proposed','approved');

-- ─── Operations ────────────────────────────────────────────────────────────
CREATE TABLE alerts (
  id           TEXT PRIMARY KEY,
  level        TEXT NOT NULL,
  title        TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_alerts_open ON alerts(acknowledged, created_at DESC);

CREATE TABLE resource_samples (
  id              TEXT PRIMARY KEY,
  cpu_load        REAL NOT NULL,
  memory_used_mb  REAL NOT NULL,
  memory_total_mb REAL NOT NULL,
  db_size_mb      REAL NOT NULL,
  event_backlog   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_samples_created ON resource_samples(created_at DESC);

CREATE TABLE backups (
  id         TEXT PRIMARY KEY,
  path       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  trigger    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_backups_created ON backups(created_at DESC);
`,
  },
  {
    version: 2,
    name: 'agent-capabilities-and-mission-budget',
    sql: `
-- ─── Explicit agent capabilities (replaces tier-based filtering) ───────────
-- Existing agents keep the ordinary specialist capability; the evolution tier
-- is corrected below so it is advisory rather than assignable.
ALTER TABLE agents ADD COLUMN capabilities TEXT NOT NULL DEFAULT '["mission-execution"]';

UPDATE agents
   SET capabilities = '["system-analysis","advisory"]'
 WHERE tier = 'evolution';

UPDATE agents
   SET capabilities = '["mission-execution","system-analysis"]'
 WHERE key = 'engineer';

-- ─── Per-mission cost control and bounded replanning ───────────────────────
-- NULL budget means "use the deployment default"; 0 means unlimited.
ALTER TABLE missions ADD COLUMN token_budget INTEGER;
ALTER TABLE missions ADD COLUMN replan_count INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 3,
    name: 'constitution-nomenclature-and-skills',
    sql: `
-- ─── Article VII — Skills as a first-class registry ───────────────────────
-- A skill is a reusable technical know-how belonging to the platform. Tools
-- implement skills; agents declare them; departments draw on them.
CREATE TABLE skills (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL,
  tools       TEXT NOT NULL DEFAULT '[]',   -- JSON array of tool ids
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_skills_category ON skills(category, key);

-- ─── Nomenclature — "capability" is retired from the vocabulary ───────────
-- What an agent may be *used for* is a mandate; what it is *able to do* is a
-- set of skills. Conflating the two under one word made the model unreadable.
ALTER TABLE agents RENAME COLUMN capabilities TO mandates;

-- Declared skills replace the free-text list and the separate tool allow-list.
-- The values below reproduce each founding role's previous permissions exactly,
-- so no agent gains access it did not already have.
UPDATE agents SET skills = '["memory-recall","memory-curation","web-research"]'                         WHERE key = 'explorer';
UPDATE agents SET skills = '["memory-recall","memory-curation","scoring"]'                              WHERE key = 'analyst';
UPDATE agents SET skills = '["memory-recall","memory-curation","web-research","scoring"]'               WHERE key = 'ambassador';
UPDATE agents SET skills = '["memory-recall","memory-curation","document-production"]'                  WHERE key = 'messenger';
UPDATE agents SET skills = '["memory-recall","memory-curation","document-production"]'                  WHERE key = 'architect';
UPDATE agents SET skills = '["memory-recall","memory-curation","mission-inspection"]'                   WHERE key = 'archivist';
UPDATE agents SET skills = '["system-diagnostics","mission-inspection","workflow-execution","memory-curation"]' WHERE key = 'engineer';
UPDATE agents SET skills = '["system-diagnostics","mission-inspection","memory-recall","memory-curation"]'      WHERE key = 'evolution-manager';

-- Any agent created before this migration keeps its tools until re-declared
-- with skills; an empty skill set simply grants nothing.
UPDATE agents SET skills = '[]'
 WHERE key NOT IN ('explorer','analyst','ambassador','messenger','architect','archivist','engineer','evolution-manager');

-- The allow-list is now derived from skills, so storing it would invite drift.
ALTER TABLE agents DROP COLUMN tools;
`,
  },
  {
    version: 4,
    name: 'departments-teams-and-business-intelligence',
    sql: `
-- ─── Departments and teams (Articles IV and V) ────────────────────────────
-- A department is a sellable product; everything that distinguishes one from
-- another is data in these rows, so a new department is a definition rather
-- than a schema change.
CREATE TABLE departments (
  key            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  tagline        TEXT NOT NULL DEFAULT '',
  mission        TEXT NOT NULL,
  building       TEXT NOT NULL,
  target_types   TEXT NOT NULL DEFAULT '[]',
  brief_schema   TEXT NOT NULL DEFAULT '{}',
  playbook       TEXT NOT NULL DEFAULT '[]',
  scoring_model  TEXT NOT NULL DEFAULT '{}',
  kpis           TEXT NOT NULL DEFAULT '[]',
  triggers       TEXT NOT NULL DEFAULT '[]',
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE teams (
  key            TEXT NOT NULL,
  department_key TEXT NOT NULL REFERENCES departments(key) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  purpose        TEXT NOT NULL DEFAULT '',
  stages         TEXT NOT NULL DEFAULT '[]',
  agent_keys     TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL,
  PRIMARY KEY (department_key, key)
);

-- A mission may belong to a department. Generic objectives keep NULL.
ALTER TABLE missions ADD COLUMN department_key TEXT REFERENCES departments(key);
CREATE INDEX idx_missions_department ON missions(department_key, status);

-- ─── Company registry ─────────────────────────────────────────────────────
-- Shared across missions and departments: a company found while looking for
-- distributors is the same company later considered as a supplier.
CREATE TABLE companies (
  id                 TEXT PRIMARY KEY,
  canonical_key      TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  legal_name         TEXT,
  country            TEXT,
  region             TEXT,
  city               TEXT,
  website            TEXT,
  domain             TEXT,
  industries         TEXT NOT NULL DEFAULT '[]',
  size_band          TEXT NOT NULL DEFAULT 'unknown',
  employees_estimate INTEGER,
  founded_year       INTEGER,
  description        TEXT,
  profile            TEXT NOT NULL DEFAULT '{}',
  enriched           INTEGER NOT NULL DEFAULT 0,
  first_seen_at      TEXT NOT NULL,
  last_verified_at   TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_companies_domain  ON companies(domain);
CREATE INDEX idx_companies_country ON companies(country, name);

CREATE TABLE company_relations (
  id              TEXT PRIMARY KEY,
  from_company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  to_company_id   TEXT REFERENCES companies(id) ON DELETE SET NULL,
  to_name         TEXT,
  kind            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  confidence      REAL NOT NULL DEFAULT 0.5,
  evidence_id     TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_relations_from ON company_relations(from_company_id);

-- ─── Sources and evidence ─────────────────────────────────────────────────
-- Reliability belongs to the source, not to the claim, so it is stored once
-- and reused by every piece of evidence citing it.
CREATE TABLE sources (
  key         TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  label       TEXT NOT NULL,
  reference   TEXT,
  reliability REAL NOT NULL DEFAULT 0.5,
  created_at  TEXT NOT NULL
);

-- Append-only: a later contradiction is another row, never an edit, so what
-- ATLAS believed and when survives.
CREATE TABLE evidence (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  opportunity_id TEXT,
  mission_id     TEXT,
  field          TEXT NOT NULL,
  claim          TEXT NOT NULL,
  value          TEXT,
  nature         TEXT NOT NULL,
  source_key     TEXT NOT NULL,
  source_ref     TEXT,
  source_title   TEXT,
  basis          TEXT,
  confidence     REAL NOT NULL DEFAULT 0.5,
  simulated      INTEGER NOT NULL DEFAULT 0,
  collected_at   TEXT NOT NULL,
  agent_key      TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_evidence_company     ON evidence(company_id, field);
CREATE INDEX idx_evidence_opportunity ON evidence(opportunity_id);
CREATE INDEX idx_evidence_mission     ON evidence(mission_id);

CREATE TABLE contacts (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  role        TEXT,
  email       TEXT,
  phone       TEXT,
  linkedin    TEXT,
  confidence  REAL NOT NULL DEFAULT 0.5,
  evidence_id TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_contacts_company ON contacts(company_id);

-- ─── Opportunities ────────────────────────────────────────────────────────
-- A company considered as a candidate, for one mission, by one department.
CREATE TABLE opportunities (
  id              TEXT PRIMARY KEY,
  mission_id      TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  department_key  TEXT NOT NULL,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  target_type     TEXT NOT NULL,
  stage           TEXT NOT NULL DEFAULT 'discovered',
  score           REAL,
  score_detail    TEXT,
  qualification   TEXT,
  rank            INTEGER,
  justification   TEXT,
  reused_knowledge INTEGER NOT NULL DEFAULT 0,
  discovered_by   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  -- One candidate appears once per mission; discovery re-runs are idempotent.
  UNIQUE (mission_id, company_id)
);
CREATE INDEX idx_opportunities_mission ON opportunities(mission_id, stage);
CREATE INDEX idx_opportunities_rank    ON opportunities(mission_id, rank);
CREATE INDEX idx_opportunities_company ON opportunities(company_id);

-- ─── Skills the intelligence pipeline needs ───────────────────────────────
-- Seeding registers the new skills, but an agent already in the database keeps
-- the skill list it was created with — so the grants are made explicitly here.
-- Each addition matches the role that already owned that part of the work.
UPDATE agents
   SET skills = json_insert(skills, '$[#]', 'company-discovery',
                                    '$[#]', 'company-enrichment',
                                    '$[#]', 'evidence-capture')
 WHERE key = 'explorer'
   AND NOT EXISTS (SELECT 1 FROM json_each(agents.skills) s WHERE s.value = 'company-discovery');

UPDATE agents
   SET skills = json_insert(skills, '$[#]', 'opportunity-qualification',
                                    '$[#]', 'evidence-capture')
 WHERE key = 'ambassador'
   AND NOT EXISTS (SELECT 1 FROM json_each(agents.skills) s WHERE s.value = 'opportunity-qualification');

UPDATE agents
   SET skills = json_insert(skills, '$[#]', 'shortlist-ranking')
 WHERE key = 'analyst'
   AND NOT EXISTS (SELECT 1 FROM json_each(agents.skills) s WHERE s.value = 'shortlist-ranking');

-- The generic scoring skill now also provides the opportunity scorer, so the
-- registry row must be refreshed for agents that already hold it.
UPDATE skills SET tools = '["score_candidates","score_opportunity"]' WHERE key = 'scoring';
`,
  },
  {
    version: 5,
    name: 'human-review-and-contact-discovery',
    sql: `
-- ─── Revue humaine ────────────────────────────────────────────────────────
-- ATLAS produit une shortlist ; un humain décide si elle peut être montrée.
-- Séparé de la qualification et du score, qui sont les jugements du système :
-- confondre les deux rendrait impossible de distinguer ce qu'ATLAS a conclu de
-- ce qu'une personne a accepté.
ALTER TABLE opportunities ADD COLUMN review TEXT;
CREATE INDEX idx_opportunities_review ON opportunities(mission_id, stage, rank);

-- La recherche de contacts publics rejoint le savoir-faire de l'Explorer,
-- qui possède déjà l'enrichissement.
UPDATE agents
   SET skills = json_insert(skills, '$[#]', 'contact-discovery')
 WHERE key = 'explorer'
   AND NOT EXISTS (SELECT 1 FROM json_each(agents.skills) s WHERE s.value = 'contact-discovery');
`,
  },
  {
    version: 6,
    name: 'multi-role-opportunities',
    sql: `
-- ─── Une entreprise, plusieurs rôles ──────────────────────────────────────
-- Une organisation peut réellement être à la fois distributeur et intégrateur.
-- Elle reste UNE opportunité portant plusieurs rôles : la dupliquer fausserait
-- l'entonnoir et ferait apparaître deux fois la même entreprise en shortlist.
ALTER TABLE opportunities ADD COLUMN target_types TEXT NOT NULL DEFAULT '[]';

-- Reprise des missions antérieures : le rôle unique devient un tableau d'un
-- élément, si bien qu'une ancienne shortlist reste lisible telle quelle.
UPDATE opportunities
   SET target_types = json_array(target_type)
 WHERE target_type IS NOT NULL AND target_type <> '';

ALTER TABLE opportunities DROP COLUMN target_type;
`,
  },
  {
    version: 7,
    name: 'economic-safety-and-call-telemetry',
    sql: `
-- ─── Préconditions d'étape ────────────────────────────────────────────────
-- « L'étape amont s'est-elle terminée ? » et « la matière est-elle là ? » sont
-- deux questions différentes. LIVE #001 a répondu oui à la première et lancé
-- l'enrichissement sans aucun candidat ; l'agent a improvisé douze minutes.
-- Une précondition non satisfaite saute l'étape sans le moindre appel au modèle.
ALTER TABLE mission_tasks ADD COLUMN preconditions TEXT NOT NULL DEFAULT '[]';

-- ─── Comptabilité par appel ───────────────────────────────────────────────
-- ATLAS n'agrégeait qu'un total de jetons par étape : assez pour constater
-- qu'une mission avait coûté cher, jamais pour dire quel modèle, quel agent ni
-- quelle intention l'avaient dépensé — ni pour mesurer le gain d'un cache, la
-- répartition entrée/sortie étant perdue à l'écriture.
--
-- Aucune clé, aucun en-tête, aucun contenu de requête n'est stocké ici : la
-- table décrit ce qu'un appel a coûté, jamais ce qu'il contenait.
CREATE TABLE llm_calls (
  id                 TEXT PRIMARY KEY,
  mission_id         TEXT REFERENCES missions(id) ON DELETE CASCADE,
  task_ref           TEXT,
  agent_key          TEXT,
  purpose            TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL,
  duration_ms        INTEGER NOT NULL DEFAULT 0,
  ok                 INTEGER NOT NULL DEFAULT 1,
  error              TEXT,
  tool_calls         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_llm_calls_mission ON llm_calls(mission_id, created_at);
CREATE INDEX idx_llm_calls_model ON llm_calls(mission_id, model);

-- ─── Issue de mission ─────────────────────────────────────────────────────
-- Le statut dit où en est une mission, pas si elle a servi à quelque chose.
-- LIVE #001 est resté « completed » en ayant coûté 9,15 $ pour zéro candidat.
-- Reprise des missions antérieures, dans cet ordre de priorité : un budget
-- épuisé explique mieux une mission vide qu'un simple « aucun résultat ».
UPDATE missions
   SET result = json_set(result, '$.outcome',
         CASE
           WHEN json_extract(result, '$.budgetExhausted') = 1 THEN 'cancelled-budget'
           WHEN status = 'failed' THEN 'failed'
           WHEN (SELECT COUNT(*) FROM opportunities o WHERE o.mission_id = missions.id) = 0
             THEN 'no-result'
           ELSE 'success'
         END)
 WHERE result IS NOT NULL
   AND json_valid(result)
   AND json_extract(result, '$.outcome') IS NULL;
`,
  },
  {
    version: 8,
    name: 'tool-call-telemetry',
    sql: `
-- ─── Comptabilité des appels d'outils ─────────────────────────────────────
-- L'événement « agent.tool » est publié en sévérité debug, et le journal
-- d'événements écarte le debug pour rester lisible. Conséquence : un outil qui
-- *réussissait* ne laissait aucune trace, et l'économie d'une mission ne
-- comptait que les échecs — LIVE #001 affichait « 5 appels externes » parce
-- que les cinq avaient échoué.
--
-- Une table dédiée plutôt qu'une promotion du niveau de log : on mesure sans
-- noyer le journal. Seuls des faits sont conservés — nom, durée, issue — jamais
-- les arguments ni la réponse.
CREATE TABLE tool_calls (
  id          TEXT PRIMARY KEY,
  mission_id  TEXT REFERENCES missions(id) ON DELETE CASCADE,
  task_ref    TEXT,
  agent_key   TEXT,
  tool        TEXT NOT NULL,
  category    TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 1,
  error       TEXT,
  -- Vrai quand l'appel sort d'ATLAS : c'est la part facturée ou dépendante
  -- d'un tiers, celle qui mérite d'être comptée à part.
  external    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_tool_calls_mission ON tool_calls(mission_id, created_at);
CREATE INDEX idx_tool_calls_tool ON tool_calls(mission_id, tool);
`,
  },
  {
    version: 9,
    name: 'failed-search-fingerprint',
    sql: `
-- ─── Empreinte d'un appel, pour ne pas le refaire ─────────────────────────
-- LIVE #004 : la recherche a expiré, l'outil a répondu « ne relancez pas la
-- même recherche, la cause est technique » — et l'agent a relancé deux fois.
-- Une consigne, même explicite, n'est pas un garde-fou.
--
-- L'empreinte permet de refuser un appel identique avant qu'il parte. Elle est
-- calculée à partir des paramètres significatifs, jamais du texte brut : une
-- stratégie réellement différente doit rester possible.
ALTER TABLE tool_calls ADD COLUMN signature TEXT;

-- L'issue métier de l'appel, distincte du simple succès/échec technique :
-- « rien trouvé » et « n'a pas pu chercher » se corrigent différemment.
ALTER TABLE tool_calls ADD COLUMN outcome TEXT;

CREATE INDEX idx_tool_calls_signature ON tool_calls(mission_id, tool, signature);
`,
  },
  {
    version: 10,
    name: 'mission-decisions',
    sql: `
-- ─── Le journal des décisions d'Hermès ────────────────────────────────────
-- Une mission produit un plan, des étapes et un résultat. Ce qui manquait,
-- c'est le *pourquoi* : pourquoi ce plan, pourquoi arrêter cette branche,
-- pourquoi demander une revue humaine. Sans cela, une mission ratée ne se
-- rejoue qu'en relisant du code, et une mission réussie ne s'explique pas.
--
-- Une décision n'est jamais un fait métier. Hermès décide de la stratégie, de
-- l'ordre, de l'allocation, de la poursuite ou de l'arrêt. Il ne décide pas
-- qu'une entreprise existe : cela vient d'une source, et evidence_ids relie
-- la décision aux preuves sur lesquelles elle s'appuie — vide quand il n'y en
-- a pas, ce qui est en soi une information.
CREATE TABLE mission_decisions (
  id           TEXT PRIMARY KEY,
  mission_id   TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_ref     TEXT,
  -- plan | allocation | continue | stop-branch | replan | escalate | budget | conclude
  kind         TEXT NOT NULL,
  decision     TEXT NOT NULL,
  rationale    TEXT NOT NULL,
  -- JSON : les identifiants de preuve invoques. Tableau vide quand la decision ne
  -- s'appuie sur aucune preuve — cas parfaitement légitime pour une décision
  -- d'organisation, et suspect pour une affirmation métier.
  evidence_ids TEXT NOT NULL DEFAULT '[]',
  -- Ce que la décision engageait, au moment où elle a été prise.
  estimated_cost_usd REAL,
  impact       TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_decisions_mission ON mission_decisions(mission_id, created_at);

-- ─── La trace de la revue humaine ─────────────────────────────────────────
-- L'étape existait, la trace non : on savait qu'une opportunité était
-- « approved » sans savoir par qui, quand, ni pourquoi.
ALTER TABLE opportunities ADD COLUMN reviewed_by TEXT;
ALTER TABLE opportunities ADD COLUMN reviewed_at TEXT;
ALTER TABLE opportunities ADD COLUMN review_note TEXT;
`,
  },
  {
    version: 11,
    name: 'company-data-origin',
    sql: `
-- ─── La lignée d'une entreprise ───────────────────────────────────────────
--
-- VAL-003, mission réelle, a rendu dix candidats dont quatre fabriqués lors
-- d'une démonstration cinq jours plus tôt. Le registre de découverte relit la
-- table \`companies\` et rend tout ce qui correspond au pays et au secteur ; il
-- n'avait aucun moyen de savoir d'où venait une fiche. Les preuves produites
-- portaient \`simulated = 0\`, puisque la mission *courante* était réelle : une
-- donnée fabriquée entrait ainsi dans un résultat réel en se blanchissant au
-- passage.
--
-- Le préfixe « [SIMULÉ] » dans le nom existait déjà. Il n'a rien empêché, et
-- ne pouvait rien empêcher : c'est un affichage, pas une contrainte. Un nom
-- se réécrit, se traduit, se tronque — fonder une barrière de sûreté dessus
-- revient à n'en avoir aucune.
--
-- La provenance devient donc une colonne, posée à la création et jamais
-- recalculée depuis le nom :
--
--   live       découverte depuis une source réelle
--   simulated  fabriquée par le fournisseur de simulation
--   unknown    indéterminable — interdit en mode réel jusqu'à résolution
--
-- \`unknown\` est le défaut délibérément : une fiche dont on ne sait rien ne
-- doit pas être présumée bonne. Le sens de l'erreur compte — refuser à tort
-- coûte une question, accepter à tort coûte la confiance dans tout le reste.
ALTER TABLE companies ADD COLUMN data_origin TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX idx_companies_origin ON companies(data_origin);

-- ─── Reclassement des données existantes ──────────────────────────────────
--
-- Deux règles déterministes, dans cet ordre. Aucune heuristique, aucune
-- supposition : ce qui ne tombe sous aucune des deux reste \`unknown\`.

-- 1. Le domaine \`.example\` est réservé par la RFC 2606 et ne peut jamais
--    résoudre. Une fiche qui en porte un n'a pas pu être découverte sur le web
--    réel — c'est le seul marqueur structurel dont on dispose, et il est sûr.
UPDATE companies
   SET data_origin = 'simulated'
 WHERE website LIKE '%.example%'
    OR domain  LIKE '%.example%'
    OR domain  LIKE '%.example';

-- 2. Une fiche dont *toutes* les missions d'origine se sont déclarées réelles
--    est réelle. Le « toutes » compte : une seule mission non déclarée suffit à
--    rendre la lignée douteuse, et le doute se classe \`unknown\`.
UPDATE companies
   SET data_origin = 'live'
 WHERE data_origin = 'unknown'
   AND EXISTS (
     SELECT 1 FROM evidence e JOIN missions m ON m.id = e.mission_id
      WHERE e.company_id = companies.id
        AND m.context LIKE '%"executionMode":"live"%'
   )
   AND NOT EXISTS (
     SELECT 1 FROM evidence e JOIN missions m ON m.id = e.mission_id
      WHERE e.company_id = companies.id
        AND m.context NOT LIKE '%"executionMode":"live"%'
   );
`,
  },
  {
    version: 12,
    name: 'memory-data-origin',
    sql: `
-- ─── La lignée d'une connaissance ─────────────────────────────────────────
--
-- La mémoire est relue par toute mission future *avant* toute recherche. Une
-- connaissance fabriquée pendant une démonstration y devient, au deuxième
-- usage, « ce qu'ATLAS sait » : elle n'est plus une sortie de modèle, elle est
-- un fait établi que le raisonnement suivant tient pour acquis.
--
-- C'est la même faille que pour les entreprises, une couche plus haut, et elle
-- est pire : une fiche fabriquée se repère à son domaine, une phrase fabriquée
-- ne se repère à rien.
--
--   live       tirée de faits réels et sourcés
--   simulated  produite pendant une démonstration
--   unknown    provenance indéterminable — interdite en mode réel
--
-- \`unknown\` est le défaut, comme pour les entreprises et pour la même raison :
-- une connaissance dont on ignore l'origine ne doit pas être présumée bonne.
ALTER TABLE memory_items ADD COLUMN data_origin TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX idx_memory_origin ON memory_items(data_origin, tier);

-- ─── Reclassement des connaissances existantes ────────────────────────────
--
-- Trois règles déterministes, dans cet ordre. Aucune ne lit le texte comme une
-- preuve : le marqueur « [SIMULÉ] » peut servir de signal d'audit, jamais de
-- règle de sûreté — il était déjà là pendant tout l'incident.

-- 1. Une connaissance qui cite une entreprise de lignée simulée est simulée,
--    quelle que soit la mission qui l'a écrite.
UPDATE memory_items
   SET data_origin = 'simulated'
 WHERE EXISTS (
   SELECT 1 FROM companies c
    WHERE c.data_origin = 'simulated'
      AND c.name IS NOT NULL
      AND instr(memory_items.content, c.name) > 0
 );

-- 2. Sinon, la mission d'origine décide — si elle s'est déclarée.
UPDATE memory_items
   SET data_origin = 'live'
 WHERE data_origin = 'unknown'
   AND mission_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM missions m
      WHERE m.id = memory_items.mission_id
        AND m.context LIKE '%"executionMode":"live"%'
   );

UPDATE memory_items
   SET data_origin = 'simulated'
 WHERE data_origin = 'unknown'
   AND mission_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM missions m
      WHERE m.id = memory_items.mission_id
        AND m.context LIKE '%"executionMode":"simulation"%'
   );

-- 3. Tout le reste — sans mission d'origine, ou mission au mode non déclaré —
--    reste \`unknown\`. On ne devine pas : une connaissance orpheline est
--    exactement le cas où l'invention serait la plus tentante et la plus
--    coûteuse.
`,
  },
  {
    version: 13,
    name: 'llm-call-subject-and-context',
    sql: `
-- ─── Ce qu'un candidat a coûté ────────────────────────────────────────────
--
-- La comptabilité s'arrêtait à l'étape. « L'enrichissement a coûté 0,116 $ »
-- ne dit pas si dix candidats ont coûté un centime chacun, ou si l'un d'eux en
-- a mangé neuf — et c'est pourtant la seule décomposition qui permette de
-- décider quoi arrêter.
--
-- VAL-003 l'a payé trois fois : l'entrée de l'enrichissement passait de 5 710
-- jetons au premier candidat à 32 443 au huitième, 178 584 au total pour cinq
-- candidats. Le total par étape était visible ; sa forme ne l'était pas. Un
-- coût qui croît comme le carré du travail ressemble, sur une seule ligne
-- d'agrégat, à un coût simplement élevé.
--
--   subject         sur quoi portait l'appel — un candidat, une unité
--   context_chars   le poids de ce qui est parti, avant l'appel
--   evidence_count  les preuves versées au contexte
--
-- \`context_chars\` est en caractères, pas en jetons : le découpage appartient
-- au fournisseur, et l'estimer donnerait un chiffre inventé là où toute la
-- valeur de la colonne tient à ce qu'elle est mesurée.
--
-- \`evidence_count\` accepte NULL, et \`subject\` aussi. Un plan n'injecte aucune
-- preuve et ne porte sur aucun candidat : \`0\` y affirmerait une mesure qui n'a
-- pas été faite, quand NULL dit ce qui est — la question ne se posait pas.
-- Les lignes antérieures à cette migration sont dans le même cas, et le
-- restent : rien n'est rétro-calculé sur des appels dont on n'a pas gardé le
-- contexte.
ALTER TABLE llm_calls ADD COLUMN subject        TEXT;
ALTER TABLE llm_calls ADD COLUMN context_chars  INTEGER;
ALTER TABLE llm_calls ADD COLUMN evidence_count INTEGER;

-- Lire « ce qu'a coûté ce candidat » doit rester une requête, pas un parcours.
CREATE INDEX idx_llm_calls_subject ON llm_calls(mission_id, subject);
`,
  },
  {
    version: 14,
    name: 'company-identity-status',
    sql: `
-- ─── L'identité d'une entreprise ──────────────────────────────────────────
--
-- REVENUE-001 a produit une fiche nommée « Heidelberg Druckmaschinen AG »
-- portant le domaine \`bhs-corrugated.com\` et la ville de BHS Corrugated. Deux
-- fabricants allemands réels, distincts, tous deux de lignée \`live\`.
--
-- La barrière de lignée ne pouvait rien voir, et n'avait rien à voir : la
-- provenance des deux fiches était irréprochable. Ce qui a cédé est ailleurs —
-- \`enrich()\` remplaçait tous les champs, domaine et ville compris, et la clé
-- canonique est figée à la création. Un enrichissement a donc réécrit
-- l'identité d'une fiche existante sans que rien ne recalcule sa clé.
--
--   ok              rien ne se contredit
--   conflict        deux sources se contredisent sur ce qui établit l'identité
--   pending-review   mis de côté en attendant un arbitrage humain
--
-- \`ok\` est le défaut, contrairement à \`data_origin\` où le défaut est
-- \`unknown\`. La différence est délibérée : une lignée non déclarée est un
-- silence suspect, alors qu'une identité sans contradiction constatée est
-- simplement une identité sans contradiction constatée. On ne met pas en
-- quarantaine tout le registre pour un défaut qui touche une fiche.
--
-- Rien n'est rétro-marqué : les contradictions passées n'ont pas été
-- consignées, et les inventer maintenant reviendrait à fabriquer un audit.
ALTER TABLE companies ADD COLUMN identity_status TEXT NOT NULL DEFAULT 'ok';

CREATE INDEX idx_companies_identity ON companies(identity_status);
`,
  },
  {
    version: 15,
    name: 'client-orders-and-reports',
    sql: `
-- ─── La commande, et le rapport qui en sort ───────────────────────────────
--
-- Le moteur sait produire. Ces deux tables décrivent ce qui entoure la
-- production : qui a commandé, ce qui a été promis, qui a relu, et ce qui est
-- réellement parti.
--
-- La distinction compte parce qu'un rapport conforme à ses contrats techniques
-- peut rester invendable — une source morte, une traduction qui déforme, un
-- contact de standard présenté comme un interlocuteur. Ces défauts ne se
-- détectent qu'en lisant, et \`state\` garde la trace de qui a lu.
CREATE TABLE client_orders (
  id             TEXT PRIMARY KEY,
  client_name    TEXT NOT NULL,
  client_contact TEXT,
  -- Le besoin, dans les mots du client. Ce qui a été promis se relit ici.
  brief          TEXT NOT NULL,
  market         TEXT NOT NULL,
  -- Le prix convenu, en centimes : un montant en flottant finit par dériver.
  price_cents    INTEGER,
  currency       TEXT NOT NULL DEFAULT 'EUR',
  -- Aucun encaissement automatique. Ce drapeau est posé à la main, après
  -- constatation, et rien dans ATLAS ne le pose seul.
  paid_at        TEXT,
  status         TEXT NOT NULL DEFAULT 'teaser-sent',
  mission_id     TEXT REFERENCES missions(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_orders_status ON client_orders(status, created_at DESC);

CREATE TABLE client_reports (
  id                TEXT PRIMARY KEY,
  order_id          TEXT REFERENCES client_orders(id) ON DELETE CASCADE,
  mission_id        TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  -- GENERATED · PENDING_REVIEW · APPROVED_FOR_DELIVERY · REJECTED · DELIVERED
  --
  -- Il n'existe aucune transition de GENERATED vers DELIVERED : c'est tout
  -- l'objet de cette colonne. Un rapport ne part pas sans que quelqu'un ait
  -- engagé sa parole dessus.
  state             TEXT NOT NULL DEFAULT 'GENERATED',
  html_path         TEXT,
  csv_path          TEXT,
  teaser_path       TEXT,
  -- La traçabilité : de quoi refaire le rapport, ou le défendre.
  pipeline_version  TEXT NOT NULL,
  scoring_version   TEXT NOT NULL,
  execution_mode    TEXT NOT NULL,
  evidence_ids      TEXT NOT NULL DEFAULT '[]',
  sources           TEXT NOT NULL DEFAULT '[]',
  cost_usd          REAL,
  candidates        INTEGER NOT NULL DEFAULT 0,
  retained          INTEGER NOT NULL DEFAULT 0,
  reviewer          TEXT,
  review_notes      TEXT,
  review_passed     TEXT NOT NULL DEFAULT '[]',
  approved_at       TEXT,
  delivered_at      TEXT,
  generated_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_reports_state ON client_reports(state, generated_at DESC);
CREATE INDEX idx_reports_mission ON client_reports(mission_id);
`,
  },
  {
    version: 16,
    name: 'order-payment-and-delivery',
    sql: `
-- ─── Le règlement, distingué du statut de commande ────────────────────────
--
-- \`status\` disait où en était la commande ; il ne disait pas si l'argent était
-- arrivé. Confondre les deux fait démarrer une production payante sur un
-- prospect qui hésite encore — et une dépense engagée ne se reprend pas.
--
--   NONE       rien n'a été demandé, l'extrait est parti et c'est tout
--   PENDING    la commande est passée, le règlement attendu
--   CONFIRMED  le règlement a été constaté, à la main
--   REFUNDED · CANCELLED
--
-- \`PENDING\` n'autorise aucune dépense. La nuance entre « on attend le
-- paiement » et « on peut commencer en attendant » est exactement celle qui
-- coûte de l'argent quand on la laisse au jugement.
--
-- \`payment_reference\` porte ce qui a été constaté — virement, lien, espèces.
-- Aucun encaissement n'est branché : cette colonne se remplit à la main, et
-- c'est délibéré.
ALTER TABLE client_orders ADD COLUMN customer_email    TEXT;
ALTER TABLE client_orders ADD COLUMN customer_company  TEXT;
ALTER TABLE client_orders ADD COLUMN payment_status    TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE client_orders ADD COLUMN payment_reference TEXT;
ALTER TABLE client_orders ADD COLUMN delivery_status   TEXT NOT NULL DEFAULT 'NOT_READY';

CREATE INDEX idx_orders_payment ON client_orders(payment_status);
`,
  },
  {
    version: 17,
    name: 'sales-prospects',
    sql: `
-- ─── Nos propres prospects ────────────────────────────────────────────────
--
-- ATLAS a jusqu'ici cherche des entreprises pour des clients. Cette table
-- porte celles qu'il cherche pour nous — et la distinction compte, parce que
-- la sortie n'est pas un rapport mais un message qui partira sous notre nom.
--
-- D'ou \`state\`, et surtout la transition qu'il interdit : rien ne fait passer
-- un prospect de READY_FOR_REVIEW a APPROVED_TO_CONTACT sans qu'un humain
-- l'ait decide. Un rapport mal relu se corrige ; un message envoye ne se
-- reprend pas.
--
-- \`personalization_fact_id\` est la preuve sur laquelle repose le « j'ai vu
-- que… » du message. Sans elle, pas de brouillon : une personnalisation
-- inventee se repere en dix secondes et disqualifie tout le reste.
CREATE TABLE sales_prospects (
  id                  TEXT PRIMARY KEY,
  batch_id            TEXT NOT NULL,
  company_name        TEXT NOT NULL,
  domain              TEXT,
  website             TEXT,
  country             TEXT,
  industry            TEXT,

  -- La tracabilite de la decouverte : de quel moteur, de quelle requete, et
  -- de quelle page ce candidat est sorti.
  source_url          TEXT,
  search_provider     TEXT,
  query               TEXT,
  discovered_at       TEXT NOT NULL,

  -- DISCOVERED · QUALIFIED · READY_FOR_REVIEW · APPROVED_TO_CONTACT
  -- REJECTED · CONTACTED · REPLIED · INTERESTED · ORDERED · PAID · LOST
  state               TEXT NOT NULL DEFAULT 'DISCOVERED',
  -- PRIORITY · GOOD_FIT · WATCH · REJECTED — deduit du score, jamais pose.
  tier                TEXT,
  score               REAL,
  score_detail        TEXT,
  why_fit             TEXT,
  reject_reason       TEXT,

  contact_name        TEXT,
  contact_role        TEXT,
  contact_email       TEXT,
  contact_phone       TEXT,
  contact_page        TEXT,
  contact_source_url  TEXT,
  contact_confidence  REAL,

  personalization_fact_id TEXT,
  message_short       TEXT,
  message_email       TEXT,
  outreach_source_url TEXT,

  reviewer            TEXT,
  approved_at         TEXT,
  contacted_at        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (batch_id, domain)
);
CREATE INDEX idx_prospects_batch ON sales_prospects(batch_id, state);
CREATE INDEX idx_prospects_tier ON sales_prospects(tier, score DESC);

-- Les preuves recueillies sur nos prospects.
--
-- Table distincte de \`evidence\` : celle-la sert les missions clientes et est
-- rattachee a une opportunite. Melanger les deux ferait apparaitre nos propres
-- prospects dans un livrable client, ce qui serait au mieux embarrassant.
CREATE TABLE sales_evidence (
  id           TEXT PRIMARY KEY,
  prospect_id  TEXT NOT NULL REFERENCES sales_prospects(id) ON DELETE CASCADE,
  field        TEXT NOT NULL,
  claim        TEXT NOT NULL,
  -- observed · reported · inferred
  nature       TEXT NOT NULL,
  source_url   TEXT,
  basis        TEXT,
  confidence   REAL NOT NULL DEFAULT 0.6,
  collected_at TEXT NOT NULL
);
CREATE INDEX idx_sales_evidence_prospect ON sales_evidence(prospect_id);
`,
  },
  {
    version: 18,
    name: 'sales-identity',
    sql: `
-- ─── L'identite resolue, distincte du titre de recherche ──────────────────
--
-- Le lot 002 a stocke le titre du resultat de recherche dans
-- \`company_name\` et l'a traite comme une raison sociale. Deux prospects
-- PRIORITY en sont sortis : l'editeur d'une etude de marche, et une agence
-- de communication. Le score etait juste ; ce qu'il notait ne l'etait pas.
--
-- Ces colonnes separent ce qu'une page annonce de ce qu'on a pu etablir.
-- \`page_type\` dit a qui la page appartient, \`identity_confidence\` ce que
-- vaut le nom retenu, \`identity_sources\` sur quoi il repose. Un prospect
-- sans ces trois valeurs n'a pas traverse la resolution, et ne peut donc
-- pas etre PRIORITY.
ALTER TABLE sales_prospects ADD COLUMN page_type TEXT;
ALTER TABLE sales_prospects ADD COLUMN identity_confidence REAL;
ALTER TABLE sales_prospects ADD COLUMN identity_sources TEXT;
ALTER TABLE sales_prospects ADD COLUMN search_title TEXT;
`,
  },
  {
    version: 19,
    name: 'sales-invalidations',
    sql: `
-- ─── Ce qu'un re-audit condamne, sans rien reecrire ───────────────────────
--
-- Le lot 002 doit rester ce qu'il a ete : deux prospects y sont PRIORITY, et
-- le rester. Corriger la ligne effacerait la preuve du defaut en meme temps
-- que le defaut.
--
-- Cette table porte donc le jugement a cote de la ligne, jamais dessus. Elle
-- est consultee par \`effectiveOutreachEligibility\`, qui decide ce qu'on peut
-- faire aujourd'hui d'un prospect ecrit hier. Une invalidation prime sur tout
-- le reste : c'est un jugement porte, pas une absence de preuve.
CREATE TABLE sales_invalidations (
  prospect_id   TEXT PRIMARY KEY REFERENCES sales_prospects(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,
  -- La version de gardes qui a prononce l'invalidation.
  guard_version TEXT NOT NULL,
  recorded_at   TEXT NOT NULL
);

-- Sous quelles gardes chaque ligne a ete resolue. NULL = anterieur a toute
-- resolution d'identite, donc non verifie — ce qui n'est pas « faux », mais
-- suffit a interdire un message.
ALTER TABLE sales_prospects ADD COLUMN guard_version TEXT;

-- Rattrapage precis : \`identity_confidence\` n'existe que depuis la resolution
-- d'identite, et n'est renseignee que par elle. Une ligne qui en porte une a
-- donc traverse ces gardes, meme si la colonne qui les nomme est arrivee
-- apres. Les lignes du lot 002 n'en ont pas : elles restent non verifiees.
UPDATE sales_prospects
   SET guard_version = 'v2-entity-resolution'
 WHERE identity_confidence IS NOT NULL;
`,
  },
  {
    version: 20,
    name: 'sales-contact-channel',
    sql: `
-- ─── Le canal de contact, et ce qu'il vaut ────────────────────────────────
--
-- Le lot 003 a conclu « aucun contact publie » pour deux entreprises qui en
-- publient : la resolution exigeait que l'adresse porte le domaine du site.
-- \`contact@seraap.fr\` releve sur \`seraap.com\` etait jete comme s'il
-- s'agissait de l'adresse d'un hebergeur.
--
-- \`contact_method\` dit par quel canal joindre l'entreprise — EMAIL, FORM,
-- PHONE ou NONE — et \`contact_confidence_label\` ce que vaut la trouvaille.
-- Le libelle est conserve a cote du nombre parce qu'il porte le motif : HIGH
-- ne veut pas dire 0.9, il veut dire « page de contact officielle, marque
-- coherente avec le domaine ».
--
-- \`contact_observed\` reste a 1 pour tout ce qui est ecrit ici : rien dans le
-- resolveur ne produit de coordonnee deduite. La colonne existe pour que la
-- distinction reste lisible si un jour une autre source en produit.
ALTER TABLE sales_prospects ADD COLUMN contact_method TEXT;
ALTER TABLE sales_prospects ADD COLUMN contact_confidence_label TEXT;
ALTER TABLE sales_prospects ADD COLUMN contact_observed INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 21,
    name: 'outreach-ledger',
    sql: `
-- ─── Ce qu'on a deja fait d'une entreprise, quel que soit le lot ──────────
--
-- Les lots sont des passes de prospection ; une entreprise, elle, n'existe
-- qu'une fois. CIRMECA et SERAAP sont ressortis en 003 puis en 004, et rien
-- ne reliait les deux lignes : approuver les deux aurait envoye deux messages
-- a la meme maison.
--
-- Ce registre est donc tenu par domaine canonique, pas par prospect, et vit
-- au-dessus des lots. Il repond a une seule question : a-t-on deja ecrit a
-- cette entreprise, ou a-t-on decide de ne pas le faire ?
--
-- Append-only, deliberement. Un envoi ne se reprend pas ; effacer la ligne
-- qui l'atteste ne le reprendrait pas davantage, cela ferait seulement
-- oublier qu'il a eu lieu. Une decision revisee s'ecrit en ajoutant, jamais
-- en corrigeant — et l'ordre des ecritures reste lisible.
CREATE TABLE outreach_ledger (
  id               TEXT PRIMARY KEY,
  -- Sans www., en minuscules. La cle est l'entreprise, pas l'URL.
  canonical_domain TEXT NOT NULL,
  -- CONTACTED · DO_NOT_CONTACT
  kind             TEXT NOT NULL,
  -- email · telephone · formulaire · salon · introduction — libre.
  channel          TEXT,
  note             TEXT,
  -- Qui l'a decide. Un registre anonyme ne se conteste pas.
  recorded_by      TEXT NOT NULL,
  recorded_at      TEXT NOT NULL
);
CREATE INDEX idx_outreach_ledger_domain ON outreach_ledger(canonical_domain);

-- Aucune ligne ne se modifie ni ne se supprime : la garantie est portee par
-- la base elle-meme, pas par la discipline des appelants.
CREATE TRIGGER outreach_ledger_no_update
BEFORE UPDATE ON outreach_ledger
BEGIN
  SELECT RAISE(ABORT, 'outreach_ledger est append-only : ajoutez une ligne, ne corrigez pas celle-ci.');
END;

CREATE TRIGGER outreach_ledger_no_delete
BEFORE DELETE ON outreach_ledger
BEGIN
  SELECT RAISE(ABORT, 'outreach_ledger est append-only : une trace d''envoi ne s''efface pas.');
END;
`,
  },
  {
    version: 22,
    name: 'sales-contact-channels',
    sql: `
-- ─── Toutes les coordonnees relevees, pas seulement celle retenue ─────────
--
-- Le lot 005 ne gardait qu'un contact par prospect, celui choisi. Deux
-- choix se sont reveles mauvais : \`support@groupe-reval.com\` est le service
-- apres-vente, \`sg@mecapole.fr\` les initiales de la personne chargee des
-- mentions legales. Les deux sont reellement publies — c'etait la question
-- posee, et ce n'etait pas la bonne.
--
-- La seconde question est \`intent\` : a quoi la boite est-elle destinee.
-- \`suitability\` en decoule : peut-on lui ecrire pour prospecter. Une
-- coordonnee peut rester observee, sourcee et affichee sans jamais etre
-- selectionnee — BLOCKED ne veut pas dire fausse, il veut dire « pas pour
-- cet usage ».
--
-- Garder toutes les coordonnees plutot que la seule retenue permet a la
-- revue humaine de voir ce qui a ete ecarte, et pourquoi.
CREATE TABLE sales_contact_channels (
  id           TEXT PRIMARY KEY,
  prospect_id  TEXT NOT NULL REFERENCES sales_prospects(id) ON DELETE CASCADE,
  -- EMAIL · PHONE · FORM
  type         TEXT NOT NULL,
  value        TEXT NOT NULL,
  -- SALES · EXPORT · GENERAL · TECHNICAL_SUPPORT · LEGAL · PRIVACY
  -- WEBMASTER · PERSONAL · UNKNOWN
  intent       TEXT NOT NULL,
  -- HIGH · MEDIUM · LOW · BLOCKED
  suitability  TEXT NOT NULL,
  -- Jamais nulle : une coordonnee sans source est indefendable en revue.
  source_url   TEXT NOT NULL,
  confidence   TEXT NOT NULL,
  observed     INTEGER NOT NULL DEFAULT 1,
  -- Vrai pour celle qui a ete retenue pour l'outreach. Au plus une par
  -- prospect ; zero est un resultat normal.
  selected     INTEGER NOT NULL DEFAULT 0,
  collected_at TEXT NOT NULL,
  UNIQUE (prospect_id, type, value)
);
CREATE INDEX idx_sales_contact_channels_prospect ON sales_contact_channels(prospect_id);

ALTER TABLE sales_prospects ADD COLUMN contact_intent TEXT;
ALTER TABLE sales_prospects ADD COLUMN contact_suitability TEXT;
`,
  },
  {
    version: 23,
    name: 'outreach-ledger-followup',
    sql: `
-- ─── La suite prevue, a cote de ce qui a eu lieu ──────────────────────────
--
-- Groupe JLF a repondu par une absence : l'interlocutrice est en conges
-- jusqu'au 24 aout. C'est une information sur le calendrier, pas sur
-- l'entreprise — elle reste contactee, et la relance a une date.
--
-- La colonne vit dans le registre plutot que sur le prospect parce que la
-- relance porte sur l'entreprise, pas sur la ligne d'un lot : trois lots
-- peuvent la contenir, il n'y a qu'une relance a faire.
ALTER TABLE outreach_ledger ADD COLUMN follow_up_at TEXT;
`,
  },
  {
    version: 24,
    name: 'sales-conversations',
    sql: `
-- ─── La suite de l'envoi : ce qui revient ─────────────────────────────────
--
-- Le registre dit qu'on a ecrit. Il ne dit pas ce qu'on a recu, et sans cela
-- la boucle commerciale s'arrete au premier message : rien ne distingue une
-- entreprise qui n'a pas repondu d'une entreprise dont l'adresse etait
-- fausse.
--
-- Une conversation par entreprise, pas par lot ni par prospect. CIRMECA
-- apparait dans trois lots ; elle n'a qu'une histoire commerciale, et deux
-- fils de discussion pour une meme maison produiraient deux relances.
CREATE TABLE sales_conversations (
  id                       TEXT PRIMARY KEY,
  canonical_domain         TEXT NOT NULL UNIQUE,
  company_name             TEXT NOT NULL,
  -- Le fait d'envoi dont cette conversation decoule. La relance eventuelle
  -- vit la-bas : on la lit, on ne la recopie pas.
  outreach_ledger_entry_id TEXT REFERENCES outreach_ledger(id),
  channel                  TEXT,
  destination              TEXT,
  first_contact_at         TEXT NOT NULL,
  last_activity_at         TEXT NOT NULL,
  -- D'ou vient cette conversation : batch, manuel, import.
  source                   TEXT NOT NULL,
  created_at               TEXT NOT NULL
);
CREATE INDEX idx_sales_conversations_domain ON sales_conversations(canonical_domain);

-- Les evenements, append-only comme le registre et pour la meme raison : un
-- rebond efface est un rebond qu'on refera. L'etat courant se recalcule a la
-- lecture, il n'est jamais stocke — une regle corrigee doit pouvoir revenir
-- sur un verdict qu'elle avait rendu.
CREATE TABLE sales_conversation_events (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES sales_conversations(id) ON DELETE CASCADE,
  -- EMAIL_REPLY · AUTO_REPLY · BOUNCE · FORM_REPLY · MANUAL_NOTE
  kind            TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  source          TEXT NOT NULL,
  raw_subject     TEXT,
  sender          TEXT,
  body_excerpt    TEXT,
  -- BOUNCED · AUTO_REPLY · REPLIED · NEEDS_REVIEW
  classification  TEXT NOT NULL,
  confidence      REAL NOT NULL,
  signals         TEXT,
  return_date     TEXT,
  human_reviewed  INTEGER NOT NULL DEFAULT 0,
  -- L'etat qu'un humain a pose, quand il en a pose un. Les etats commerciaux
  -- — INTERESTED, WON, LOST — ne s'atteignent que par ici.
  declared_status TEXT,
  note            TEXT,
  recorded_at     TEXT NOT NULL
);
CREATE INDEX idx_sales_conversation_events_conv
  ON sales_conversation_events(conversation_id, occurred_at);

CREATE TRIGGER sales_conversation_events_no_update
BEFORE UPDATE ON sales_conversation_events
BEGIN
  SELECT RAISE(ABORT, 'les evenements de conversation sont append-only : ajoutez, ne corrigez pas.');
END;

CREATE TRIGGER sales_conversation_events_no_delete
BEFORE DELETE ON sales_conversation_events
BEGIN
  SELECT RAISE(ABORT, 'un rebond efface est un rebond qu''on refera : suppression interdite.');
END;
`,
  },
  {
    version: 25,
    name: 'mail-import-log',
    sql: `
-- ─── Ce qui a deja ete lu dans la boite ───────────────────────────────────
--
-- Deux synchronisations successives voient les memes messages. Sans registre,
-- la seconde recreerait chaque evenement : une entreprise aurait repondu deux
-- fois, et l'historique commercial deviendrait faux au moment precis ou l'on
-- commence a s'y fier.
--
-- L'unicite porte sur l'identifiant du fournisseur, pas sur le contenu : deux
-- messages peuvent etre identiques — une relance renvoyee a l'identique — et
-- restent deux evenements.
--
-- Les messages non rattaches sont consignes aussi. Ne garder que les reussites
-- ferait rescanner indefiniment ce qu'on a deja examine, et ferait disparaitre
-- la file des reponses qu'un humain doit lire.
CREATE TABLE mail_import_log (
  id                  TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  external_thread_id  TEXT,
  from_address        TEXT,
  to_address          TEXT,
  subject             TEXT,
  received_at         TEXT,
  -- IMPORTED · UNMATCHED · IGNORED
  disposition         TEXT NOT NULL,
  match_method        TEXT,
  conversation_id     TEXT REFERENCES sales_conversations(id),
  event_id            TEXT REFERENCES sales_conversation_events(id),
  reason              TEXT,
  scanned_at          TEXT NOT NULL,
  UNIQUE (provider, external_message_id)
);
CREATE INDEX idx_mail_import_log_disposition ON mail_import_log(disposition);

CREATE TRIGGER mail_import_log_no_update
BEFORE UPDATE ON mail_import_log
BEGIN
  SELECT RAISE(ABORT, 'le registre d''import est append-only : un message lu reste lu.');
END;

CREATE TRIGGER mail_import_log_no_delete
BEFORE DELETE ON mail_import_log
BEGIN
  SELECT RAISE(ABORT, 'effacer un import ferait reimporter le message : suppression interdite.');
END;

-- De quel message externe un evenement provient, pour remonter la trace.
ALTER TABLE sales_conversation_events ADD COLUMN external_message_id TEXT;
ALTER TABLE sales_conversation_events ADD COLUMN external_thread_id TEXT;
`,
  },
  {
    version: 26,
    name: 'autonomous-sales-loop',
    sql: `
-- ─── La machine a etats de la boucle commerciale ──────────────────────────
--
-- Une entreprise traverse la boucle : decouverte, qualification, redaction,
-- approbation, envoi, attente, reponse. Chaque passage est consigne, jamais
-- ecrase : savoir qu'un prospect est aujourd'hui WAITING_REPLY ne dit pas s'il
-- y est arrive apres une approbation humaine ou apres une relance, et c'est
-- precisement ce qu'il faut pouvoir relire quand un envoi se passe mal.
CREATE TABLE sales_loop_transitions (
  id           TEXT PRIMARY KEY,
  domain       TEXT NOT NULL,
  from_state   TEXT,
  to_state     TEXT NOT NULL,
  reason       TEXT,
  -- Qui a provoque la transition : un humain nomme, ou le nom d'une regle.
  actor        TEXT NOT NULL,
  run_id       TEXT,
  occurred_at  TEXT NOT NULL
);
CREATE INDEX idx_loop_transitions_domain ON sales_loop_transitions(domain, occurred_at);
CREATE INDEX idx_loop_transitions_state ON sales_loop_transitions(to_state);

CREATE TRIGGER sales_loop_transitions_no_update
BEFORE UPDATE ON sales_loop_transitions
BEGIN
  SELECT RAISE(ABORT, 'une transition passee ne se reecrit pas.');
END;

CREATE TRIGGER sales_loop_transitions_no_delete
BEFORE DELETE ON sales_loop_transitions
BEGIN
  SELECT RAISE(ABORT, 'effacer une transition effacerait la raison d''un envoi.');
END;

-- ─── La reservation d'un envoi ────────────────────────────────────────────
--
-- Le double envoi ne se previent pas en verifiant avant d'ecrire : entre la
-- verification et l'ecriture, un retry concurrent passe. La place est donc
-- reservee AVANT d'appeler le fournisseur, et c'est la cle primaire qui
-- refuse la seconde tentative — une contrainte que le code appelant ne peut
-- pas oublier de respecter.
--
-- Consequence assumee : si le processus meurt entre la reservation et
-- l'envoi, le message reste bloque. C'est le bon sens de la panne — un
-- message non parti se renvoie sur decision humaine, un message parti deux
-- fois ne se rattrape pas.
CREATE TABLE outbound_sends (
  idempotency_key TEXT PRIMARY KEY,
  domain          TEXT NOT NULL,
  conversation_id TEXT REFERENCES sales_conversations(id),
  recipient       TEXT NOT NULL,
  subject         TEXT NOT NULL,
  -- L'empreinte du corps : deux relances distinctes doivent produire deux
  -- cles, un retry du meme message doit produire la meme.
  body_hash       TEXT NOT NULL,
  purpose         TEXT NOT NULL,
  claimed_at      TEXT NOT NULL,
  claimed_by      TEXT NOT NULL
);
CREATE INDEX idx_outbound_sends_domain ON outbound_sends(domain);

CREATE TRIGGER outbound_sends_no_update
BEFORE UPDATE ON outbound_sends
BEGIN
  SELECT RAISE(ABORT, 'une reservation d''envoi ne se modifie pas.');
END;

CREATE TRIGGER outbound_sends_no_delete
BEFORE DELETE ON outbound_sends
BEGIN
  SELECT RAISE(ABORT, 'liberer une reservation rouvrirait la porte au double envoi.');
END;

-- Ce qu'il est advenu de la reservation. Separe de la reservation elle-meme
-- parce que la table du dessus est immuable : le resultat arrive apres.
CREATE TABLE outbound_send_events (
  id                  TEXT PRIMARY KEY,
  idempotency_key     TEXT NOT NULL REFERENCES outbound_sends(idempotency_key),
  -- SENT · FAILED
  phase               TEXT NOT NULL,
  external_message_id TEXT,
  external_thread_id  TEXT,
  error               TEXT,
  occurred_at         TEXT NOT NULL
);

-- La garantie qui compte, tenue par le moteur et non par l'appelant : une
-- reservation ne peut aboutir qu'une fois. Un second SENT est refuse meme si
-- deux processus l'ecrivent en meme temps.
CREATE UNIQUE INDEX idx_outbound_sent_once
  ON outbound_send_events(idempotency_key) WHERE phase = 'SENT';
CREATE INDEX idx_outbound_send_events_phase ON outbound_send_events(phase);

CREATE TRIGGER outbound_send_events_no_update
BEFORE UPDATE ON outbound_send_events
BEGIN
  SELECT RAISE(ABORT, 'le resultat d''un envoi est un fait : il ne se corrige pas.');
END;

CREATE TRIGGER outbound_send_events_no_delete
BEFORE DELETE ON outbound_send_events
BEGIN
  SELECT RAISE(ABORT, 'effacer un envoi reussi autoriserait a le refaire.');
END;

-- ─── Les brouillons soumis a approbation ──────────────────────────────────
--
-- Un brouillon n'est pas un message : il attend une decision. Le conserver
-- permet de montrer a l'humain ce qu'il approuve exactement, et de verifier
-- apres coup que ce qui est parti est bien ce qui avait ete approuve.
CREATE TABLE outreach_drafts (
  id              TEXT PRIMARY KEY,
  domain          TEXT NOT NULL,
  company_name    TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  body_hash       TEXT NOT NULL,
  purpose         TEXT NOT NULL,
  conversion_score REAL,
  rationale       TEXT,
  -- Les faits cites, en JSON : citation + URL. Un brouillon sans source ne
  -- peut pas etre relu.
  sources         TEXT NOT NULL,
  -- READY_FOR_APPROVAL · APPROVED_TO_SEND · REJECTED · SENT
  state           TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL
);
CREATE INDEX idx_outreach_drafts_state ON outreach_drafts(state);
CREATE INDEX idx_outreach_drafts_domain ON outreach_drafts(domain);

-- Un brouillon approuve puis modifie serait un message jamais relu par
-- personne. L'etat evolue par ajout d'une decision, pas par retouche.
CREATE TABLE outreach_draft_decisions (
  id          TEXT PRIMARY KEY,
  draft_id    TEXT NOT NULL REFERENCES outreach_drafts(id),
  decision    TEXT NOT NULL,
  decided_by  TEXT NOT NULL,
  note        TEXT,
  decided_at  TEXT NOT NULL
);
CREATE INDEX idx_draft_decisions_draft ON outreach_draft_decisions(draft_id);

CREATE TRIGGER outreach_drafts_no_delete
BEFORE DELETE ON outreach_drafts
BEGIN
  SELECT RAISE(ABORT, 'un brouillon soumis reste consultable.');
END;

CREATE TRIGGER outreach_draft_decisions_no_update
BEFORE UPDATE ON outreach_draft_decisions
BEGIN
  SELECT RAISE(ABORT, 'une decision d''approbation ne se reecrit pas.');
END;

CREATE TRIGGER outreach_draft_decisions_no_delete
BEFORE DELETE ON outreach_draft_decisions
BEGIN
  SELECT RAISE(ABORT, 'effacer une approbation effacerait qui a autorise l''envoi.');
END;
`,
  },
  {
    version: 27,
    name: 'durable-task-queue',
    sql: `
-- --- La file de travail durable -------------------------------------------
--
-- Le coeur du fonctionnement permanent. Une tache y survit au processus qui
-- l'execute : c'est la difference entre un programme qui travaille et un
-- programme qu'il faut surveiller.
--
-- La table est mutable, contrairement a la plupart des tables d'ATLAS. C'est
-- assume : l'etat courant d'une tache doit se lire en une ligne, sans rejouer
-- son histoire. L'histoire, elle, vit dans task_transitions, append-only.
CREATE TABLE tasks (
  task_id           TEXT PRIMARY KEY,
  task_type         TEXT NOT NULL,
  -- CRITICAL_CLIENT . CLIENT_REPLY . SALES . ENGINEERING . BACKGROUND . MAINTENANCE
  department        TEXT NOT NULL,
  -- DETERMINISTIC . OPENAI . CLAUDE . HUMAN
  worker_type       TEXT NOT NULL,
  priority          INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  payload_json      TEXT NOT NULL DEFAULT '{}',
  result_json       TEXT,

  created_at        TEXT NOT NULL,
  -- Le moment a partir duquel la tache peut etre prise. Porte a la fois le
  -- differe, la reprise apres quota et le backoff : trois besoins, un champ.
  available_at      TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,

  attempt_count     INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,

  -- Le bail. Un worker qui meurt cesse de le renouveler, et la tache redevient
  -- prenable sans que personne n'ait eu a le declarer.
  lease_owner       TEXT,
  lease_until       TEXT,
  last_heartbeat_at TEXT,

  parent_task_id    TEXT REFERENCES tasks(task_id),
  correlation_id    TEXT,

  -- Deux taches de meme cle ne peuvent pas coexister : c'est ce qui empeche un
  -- planificateur de creer deux fois la meme verification horaire.
  idempotency_key   TEXT UNIQUE,

  estimated_cost    REAL,
  actual_cost       REAL,

  error_code        TEXT,
  error_message     TEXT,

  metadata_json     TEXT NOT NULL DEFAULT '{}'
);

-- L'index qui porte la selection du scheduler. Sans lui, chaque tour de boucle
-- relit la table entiere -- et cette boucle tourne pendant des semaines.
CREATE INDEX idx_tasks_claimable ON tasks(status, available_at, priority DESC);
CREATE INDEX idx_tasks_lease ON tasks(status, lease_until);
CREATE INDEX idx_tasks_correlation ON tasks(correlation_id);
CREATE INDEX idx_tasks_type ON tasks(task_type, status);

-- --- L'histoire d'une tache -----------------------------------------------
--
-- Savoir qu'une tache a echoue ne dit pas si elle a echoue trois fois pour la
-- meme raison ou une fois pour trois raisons. La seconde lecture est celle qui
-- permet de corriger quelque chose.
CREATE TABLE task_transitions (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(task_id),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  reason       TEXT,
  actor        TEXT NOT NULL,
  attempt      INTEGER,
  occurred_at  TEXT NOT NULL
);
CREATE INDEX idx_task_transitions_task ON task_transitions(task_id, occurred_at);

CREATE TRIGGER task_transitions_no_update
BEFORE UPDATE ON task_transitions
BEGIN
  SELECT RAISE(ABORT, 'une transition de tache ne se reecrit pas.');
END;

CREATE TRIGGER task_transitions_no_delete
BEFORE DELETE ON task_transitions
BEGIN
  SELECT RAISE(ABORT, 'effacer une transition effacerait la raison dun echec.');
END;

-- --- Dependances ----------------------------------------------------------
--
-- Volontairement minimal : une tache attend qu'une autre soit DONE. Pas de
-- moteur de workflow -- l'ordre entre deux taches se dit en une ligne, et tout
-- ce qui demande davantage merite d'etre ecrit comme une tache de plus.
CREATE TABLE task_dependencies (
  task_id             TEXT NOT NULL REFERENCES tasks(task_id),
  depends_on_task_id  TEXT NOT NULL REFERENCES tasks(task_id),
  created_at          TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id)
);
CREATE INDEX idx_task_deps_parent ON task_dependencies(depends_on_task_id);

-- --- La sante des fournisseurs --------------------------------------------
--
-- Append-only, comme tout ce qui sert a decider. Un fournisseur qui passe
-- indisponible puis disponible trois fois dans la journee raconte quelque
-- chose qu'un simple champ « etat courant » effacerait.
CREATE TABLE provider_health_events (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  -- AVAILABLE . RATE_LIMITED . QUOTA_EXHAUSTED . BUDGET_EXHAUSTED
  -- AUTH_ERROR . DEGRADED . UNKNOWN
  state         TEXT NOT NULL,
  reason        TEXT,
  -- Quand retenter. Vient de Retry-After quand le fournisseur l'a donne, d'un
  -- backoff borne sinon. Jamais d'une heure de reset supposee.
  retry_at      TEXT,
  -- D'ou vient retry_at : RETRY_AFTER . RATE_LIMIT_HEADER . PROVIDER_METADATA
  -- . BACKOFF. Sans cela on ne sait pas si l'echeance est connue ou devinee.
  retry_source  TEXT,
  observed_at   TEXT NOT NULL
);
CREATE INDEX idx_provider_health_provider ON provider_health_events(provider, observed_at);

CREATE TRIGGER provider_health_no_update
BEFORE UPDATE ON provider_health_events
BEGIN
  SELECT RAISE(ABORT, 'un releve de sante est un fait date : il ne se corrige pas.');
END;

CREATE TRIGGER provider_health_no_delete
BEFORE DELETE ON provider_health_events
BEGIN
  SELECT RAISE(ABORT, 'effacer un releve effacerait la trace dune panne.');
END;

-- --- Les operations externes, reservees avant d'etre faites ----------------
--
-- Generalisation de ce qui protegeait deja l'envoi commercial. Le principe ne
-- change pas : la place est prise AVANT l'appel externe, et c'est la cle
-- primaire qui refuse la seconde tentative. Verifier avant d'ecrire laisse
-- passer un retry concurrent ; deux INSERT sur la meme cle, non.
--
-- Consequence assumee : un plantage entre la reservation et la confirmation
-- laisse l'operation bloquee. C'est le bon sens de la panne -- une operation
-- non faite se refait sur decision, une operation faite deux fois ne se
-- rattrape pas.
CREATE TABLE external_operations (
  idempotency_key TEXT PRIMARY KEY,
  -- EMAIL_SEND . PAYMENT . EXTERNAL_CREATE . EXTERNAL_UPDATE . NOTIFICATION
  kind            TEXT NOT NULL,
  task_id         TEXT REFERENCES tasks(task_id),
  target          TEXT,
  summary         TEXT,
  claimed_at      TEXT NOT NULL,
  claimed_by      TEXT NOT NULL
);
CREATE INDEX idx_external_operations_kind ON external_operations(kind);

CREATE TRIGGER external_operations_no_update
BEFORE UPDATE ON external_operations
BEGIN
  SELECT RAISE(ABORT, 'une reservation doperation externe ne se modifie pas.');
END;

CREATE TRIGGER external_operations_no_delete
BEFORE DELETE ON external_operations
BEGIN
  SELECT RAISE(ABORT, 'liberer une reservation rouvrirait la porte au doublon.');
END;

CREATE TABLE external_operation_events (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL REFERENCES external_operations(idempotency_key),
  -- CONFIRMED . FAILED
  phase           TEXT NOT NULL,
  external_ref    TEXT,
  error           TEXT,
  occurred_at     TEXT NOT NULL
);

-- La garantie tenue par le moteur et non par l'appelant : une reservation ne
-- peut aboutir qu'une fois, meme si deux processus l'ecrivent simultanement.
CREATE UNIQUE INDEX idx_external_confirmed_once
  ON external_operation_events(idempotency_key) WHERE phase = 'CONFIRMED';

CREATE TRIGGER external_operation_events_no_update
BEFORE UPDATE ON external_operation_events
BEGIN
  SELECT RAISE(ABORT, 'le resultat dune operation externe est un fait.');
END;

CREATE TRIGGER external_operation_events_no_delete
BEFORE DELETE ON external_operation_events
BEGIN
  SELECT RAISE(ABORT, 'effacer une operation reussie autoriserait a la refaire.');
END;

-- --- Le journal du daemon -------------------------------------------------
CREATE TABLE daemon_runs (
  id          TEXT PRIMARY KEY,
  host        TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  stopped_at  TEXT,
  stop_reason TEXT
);
CREATE INDEX idx_daemon_runs_started ON daemon_runs(started_at);
`,
  },
  {
    version: 28,
    name: 'dual-ai-workers',
    sql: `
-- --- Les chaines de travail IA --------------------------------------------
--
-- Une revue peut demander une correction, qui peut demander une revue. C'est
-- utile deux fois et ruineux la troisieme : sans borne, deux modeles se
-- renvoient la balle jusqu'a epuisement du budget, et personne ne le voit
-- avant la facture.
--
-- La racine et la profondeur sont portees par la tache elle-meme : compter les
-- ancetres a chaque creation couterait une recursion, et la borne doit etre
-- verifiable en une lecture.
ALTER TABLE tasks ADD COLUMN chain_id TEXT;
ALTER TABLE tasks ADD COLUMN chain_depth INTEGER NOT NULL DEFAULT 0;
-- L'empreinte d'une intention. Deux taches de meme empreinte dans une meme
-- chaine sont la meme demande reformulee : la seconde ne se cree pas.
ALTER TABLE tasks ADD COLUMN fingerprint TEXT;
CREATE INDEX idx_tasks_chain ON tasks(chain_id, chain_depth);
CREATE INDEX idx_tasks_fingerprint ON tasks(fingerprint);

-- --- Ce que chaque appel de modele a reellement coute ---------------------
--
-- Append-only. Le cout est la seule chose qu'un systeme autonome depense sans
-- qu'on le lui redemande : le compteur doit etre un fait date, pas une valeur
-- courante qu'une correction pourrait effacer.
--
-- Le prix peut etre inconnu alors que les jetons sont connus. Les deux colonnes
-- sont donc distinctes, et cost_usd reste NULL plutot que zero -- additionner
-- des zeros et appeler cela « cout connu » serait plus faux que de dire N/A.
CREATE TABLE ai_calls (
  id                TEXT PRIMARY KEY,
  task_id           TEXT REFERENCES tasks(task_id),
  chain_id          TEXT,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  capability        TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL,
  -- KNOWN . UNKNOWN_PRICE . SIMULATED : d'ou vient le cout, ou pourquoi il
  -- manque. Un cout sans provenance ne se verifie pas.
  cost_basis        TEXT NOT NULL,
  duration_ms       INTEGER,
  outcome           TEXT NOT NULL,
  error_code        TEXT,
  occurred_at       TEXT NOT NULL
);
CREATE INDEX idx_ai_calls_occurred ON ai_calls(occurred_at);
CREATE INDEX idx_ai_calls_provider ON ai_calls(provider, occurred_at);
CREATE INDEX idx_ai_calls_chain ON ai_calls(chain_id);

CREATE TRIGGER ai_calls_no_update
BEFORE UPDATE ON ai_calls
BEGIN
  SELECT RAISE(ABORT, 'un appel facture est un fait : il ne se corrige pas.');
END;

CREATE TRIGGER ai_calls_no_delete
BEFORE DELETE ON ai_calls
BEGIN
  SELECT RAISE(ABORT, 'effacer un appel effacerait une depense reelle.');
END;

-- --- Le verrou d'ecriture sur le depot ------------------------------------
--
-- Deux agents qui modifient les memes fichiers en parallele produisent un etat
-- que ni l'un ni l'autre n'a voulu, et que les tests ne decrivent plus. Le
-- verrou est pose par cle primaire : la seconde prise echoue, elle ne se
-- negocie pas.
--
-- Il porte un bail, comme les taches. Un agent qui meurt en tenant le verrou
-- ne doit pas bloquer le depot indefiniment.
CREATE TABLE repo_locks (
  lock_key    TEXT PRIMARY KEY,
  task_id     TEXT REFERENCES tasks(task_id),
  owner       TEXT NOT NULL,
  mode        TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  lease_until TEXT NOT NULL
);
CREATE INDEX idx_repo_locks_lease ON repo_locks(lease_until);
`,
  },
  {
    version: 29,
    name: 'engineering-workspaces',
    sql: `
-- --- L'espace de travail d'une tache d'ingenierie -------------------------
--
-- Une tache qui modifie du code ne travaille jamais dans le depot principal.
-- Elle recoit un worktree git a elle, cree depuis un commit connu, et c'est la
-- qu'elle ecrit. Le depot principal ne bouge qu'apres une decision explicite.
--
-- La separation n'est pas de la prudence decorative : le travail non commite
-- d'une personne et celui d'un agent ne se distinguent plus une fois melanges,
-- et aucune commande git ne sait les demeler apres coup.
--
-- La colonne base_commit est la piece maitresse. Sans lui, on ne peut pas savoir si le
-- depot a bouge entre la creation du workspace et l'application du diff -- et
-- appliquer un patch sur une base differente produit soit un conflit, soit
-- pire, une application partielle qui compile.
CREATE TABLE engineering_workspaces (
  workspace_id  TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(task_id),
  base_commit   TEXT NOT NULL,
  branch        TEXT,
  path          TEXT NOT NULL,
  -- CREATED . IN_USE . READY_FOR_REVIEW . APPLIED . ABANDONED . CLEANED
  state         TEXT NOT NULL,
  -- L'empreinte du diff au moment de la revue. Applique plus tard, un diff qui
  -- ne correspond plus a cette empreinte n'est plus celui qui a ete relu.
  diff_hash     TEXT,
  files_changed INTEGER NOT NULL DEFAULT 0,
  diff_lines    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  cleaned_at    TEXT
);
CREATE INDEX idx_workspaces_task ON engineering_workspaces(task_id);
CREATE INDEX idx_workspaces_state ON engineering_workspaces(state);

-- Une tache n'a qu'un seul workspace mutable. Deux taches qui partageraient un
-- espace d'ecriture produiraient un diff que ni l'une ni l'autre n'a voulu.
CREATE UNIQUE INDEX idx_workspace_one_per_task
  ON engineering_workspaces(task_id) WHERE state IN ('CREATED', 'IN_USE', 'READY_FOR_REVIEW');

-- --- Ce que la tache a produit --------------------------------------------
--
-- Le plan, le diff, le rapport de tests, la revue. Conserves a part et
-- references par le resultat de tache : envoyer un diff entier au modele
-- suivant coute des jetons pour du contexte dont il n'a le plus souvent besoin
-- que par fragments.
CREATE TABLE engineering_artifacts (
  artifact_id  TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(task_id),
  workspace_id TEXT REFERENCES engineering_workspaces(workspace_id),
  -- PLAN . DIFF . TEST_REPORT . BUILD_REPORT . FINAL_REVIEW . SECURITY_REPORT
  kind         TEXT NOT NULL,
  content      TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_artifacts_task ON engineering_artifacts(task_id, kind);

CREATE TRIGGER engineering_artifacts_no_update
BEFORE UPDATE ON engineering_artifacts
BEGIN
  SELECT RAISE(ABORT, 'un artefact est un fait date : il ne se corrige pas.');
END;

CREATE TRIGGER engineering_artifacts_no_delete
BEFORE DELETE ON engineering_artifacts
BEGIN
  SELECT RAISE(ABORT, 'effacer un artefact effacerait ce qui a ete relu.');
END;
`,
  },
  {
    version: 30,
    name: 'mail-sync-checkpoint',
    sql: `
-- --- Jusqu'ou la boite a ete lue -----------------------------------------
--
-- Le journal d'import dit quels messages ont ete vus. Il ne dit pas jusqu'ou
-- on a lu, et la nuance a coute une garantie entiere : la synchronisation
-- demandait les cinquante messages les plus recents, sans curseur, si bien
-- qu'une reponse de prospect arrivee en cinquante-et-unieme position n'etait
-- jamais lue -- et ne l'aurait jamais ete, puisque le passage suivant reprenait
-- lui aussi les cinquante plus recents. Rien ne manquait nulle part : le
-- message n'avait simplement jamais existe pour ATLAS.
--
-- Une ligne par boite et par fournisseur. last_received_at est l'horodatage
-- du message le plus recent REELLEMENT traite -- pas celui du plus recent vu.
-- La distinction est ce qui rend la reprise sure : un plantage en cours de
-- pagination laisse le curseur ou il etait, la fenetre est relue, et le journal
-- d'import ecarte les doublons.
CREATE TABLE mail_sync_checkpoints (
  provider          TEXT NOT NULL,
  mailbox           TEXT NOT NULL,
  -- Horodatage du message le plus recent dont le traitement est termine.
  last_received_at  TEXT NOT NULL,
  -- Quand la synchronisation s'est achevee, pour distinguer « rien de neuf »
  -- de « plus personne ne synchronise ».
  last_synced_at    TEXT NOT NULL,
  messages_seen     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, mailbox)
);
`,
  },
  {
    version: 31,
    name: 'outbound-send-abandonments',
    sql: `
-- --- L'abandon d'une reservation morte -----------------------------------
--
-- Une reservation d'envoi se prend avant l'appel reseau : si le processus meurt
-- entre les deux, la place reste prise et personne ne renvoie le message. C'est
-- voulu -- un doute sur un envoi doit bloquer, jamais se resoudre tout seul.
--
-- Restait un cas sans issue : une reservation prise et jamais suivie d'un
-- envoi. C'est arrive pour de bon -- une simulation reservait la place avant de
-- verifier qu'elle etait une simulation. Quatre relances approuvees se sont
-- retrouvees impossibles a envoyer, sans qu'aucun message ne soit jamais parti.
-- La table etant append-only, rien ne permettait de refermer ces reservations.
--
-- L'abandon est donc consigne, jamais efface. La reservation d'origine reste en
-- place et lisible ; une ligne ici dit qui a decide de la refermer, quand, et
-- pourquoi. Ce qui rend l'operation sure n'est pas ce mecanisme mais l'index
-- unique partiel sur les evenements SENT : la base ne peut pas contenir deux
-- envois pour une meme cle, qu'on abandonne ou non.
CREATE TABLE outbound_send_abandonments (
  idempotency_key TEXT PRIMARY KEY
    REFERENCES outbound_sends(idempotency_key),
  actor           TEXT NOT NULL,
  reason          TEXT NOT NULL,
  abandoned_at    TEXT NOT NULL
);

CREATE TRIGGER outbound_send_abandonments_no_update
BEFORE UPDATE ON outbound_send_abandonments
BEGIN
  SELECT RAISE(ABORT, 'un abandon consigne ne se reecrit pas.');
END;

CREATE TRIGGER outbound_send_abandonments_no_delete
BEFORE DELETE ON outbound_send_abandonments
BEGIN
  SELECT RAISE(ABORT, 'effacer un abandon effacerait la trace de la decision.');
END;
`,
  },
  {
    version: 32,
    name: 'sales-prospect-outreach-subject',
    sql: `
-- --- L'objet du message, la ou vit le message ----------------------------
--
-- Un brouillon de lot portait son corps et rien d'autre. La ligne d'objet
-- n'existait nulle part : la vue d'approbation la rendait nulle faute de
-- colonne, et trois messages par ailleurs complets ne pouvaient pas partir --
-- un courriel sans sujet arrive comme un envoi automatique.
--
-- L'objet est ecrit ici, aupres du corps qu'il annonce. Le stocker ailleurs --
-- dans le fichier de lot passe au script d'envoi, par exemple -- laisserait
-- deux textes approuves ensemble vivre separement, et rien ne garantirait
-- ensuite que l'objet relu est celui qui a ete valide.
ALTER TABLE sales_prospects ADD COLUMN message_subject TEXT;
`,
  },
  {
    version: 33,
    name: 'client-mission-candidates',
    sql: `
-- --- Un candidat de mission client, suivi un par un ------------------------
--
-- Le pipeline client n'avait pas de memoire du travail en cours : les
-- entreprises, preuves et opportunites etaient ecrites, mais rien ne disait
-- ou en etait chaque candidat. Une mission interrompue au soixantieme
-- repartait de zero, repayait les analyses, et un rapport ne pouvait
-- rattacher que les opportunites d'une seule mission.
--
-- Cette table est le journal de bord d'une mission client (run_id = la
-- mission). Chaque candidat y entre a la decouverte, avance etape par etape,
-- et y reste avec son etat final -- retenu, a revoir, ecarte avec sa raison
-- et sa preuve, ou echoue avec son motif. Un lot reprend la ou le precedent
-- s'est arrete en lisant cette table, et le rapport final la lit en entier.
CREATE TABLE IF NOT EXISTS client_candidates (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  domain          TEXT NOT NULL,
  url             TEXT NOT NULL,
  name            TEXT,
  batch           INTEGER NOT NULL,
  brief_version   INTEGER NOT NULL DEFAULT 1,
  stage           TEXT NOT NULL,
  category        TEXT,
  reason          TEXT,
  evidence_quote  TEXT,
  evidence_url    TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  company_id      TEXT,
  opportunity_id  TEXT,
  cost_usd        REAL NOT NULL DEFAULT 0,
  detail          TEXT,
  discovered_at   TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (run_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_client_candidates_run_stage ON client_candidates(run_id, stage);
`,
  },
  {
    version: 34,
    name: 'client-mission-cache',
    sql: `
-- --- Ce qui a deja ete lu ou juge, pour ne pas le relire ni le repayer -----
--
-- Le premier lot suedois reel a fait 265 requetes pour 69 pages ; une reprise
-- relisait toutes les pages d'un candidat en echec, et une seconde mission sur
-- le meme marche repayait chaque qualification. Deux memoires datees :
--
--   page_cache          une page par adresse, HTML compresse ou echec qui l'a
--                       remplacee (un 404 d'hier est un 404 d'aujourd'hui) ;
--   qualification_cache la reponse du modele a (societe, brief, passages) --
--                       la meme question sur les memes passages n'est pas
--                       reposee ; un brief modifie change la cle.
--
-- Ce sont des copies, jamais des verites : au-dela de leur duree de vie elles
-- sont ignorees, et un --no-cache les contourne toutes.
CREATE TABLE IF NOT EXISTS page_cache (
  url         TEXT PRIMARY KEY,
  domain      TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  status      INTEGER,
  kind        TEXT,
  html_gz     BLOB,
  fetched_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_page_cache_domain ON page_cache(domain);
CREATE TABLE IF NOT EXISTS qualification_cache (
  key           TEXT PRIMARY KEY,
  domain        TEXT NOT NULL,
  brief_hash    TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  model         TEXT NOT NULL,
  output        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qualification_cache_domain ON qualification_cache(domain);
`,
  },
  {
    version: 35,
    name: 'client-cache-final-url',
    sql: `
-- L'adresse apres redirections, quand elle differe de celle demandee : une
-- page rangee sous /kontakt mais lue a /kontakt/ doit citer la seconde.
ALTER TABLE page_cache ADD COLUMN final_url TEXT;
`,
  },
  {
    version: 36,
    name: 'sales-engine-production',
    sql: `
-- --- Le moteur commercial en production ------------------------------------
--
-- Ce que la boucle commerciale savait faire existait en pieces : prospects,
-- brouillons, envois exactement-une-fois, conversations, registre. Ce qui lui
-- manquait pour tourner seule et s'ameliorer, c'est la memoire de ce qu'elle
-- essaie et de ce que cela rapporte :
--
--   sales_segments                 un marche cible, avec son statut de vie
--   sales_attributions             a quel segment / persona / angle / variante
--                                  chaque entreprise contactee doit son message
--   sales_outcomes                 rendez-vous, proposition, gagne, perdu, CA —
--                                  toujours saisis par une personne
--   suppression_list               qui ne doit plus jamais etre ecrit, et pourquoi
--   sales_experiments              les variantes en test et leur allocation
--   optimization_recommendations   ce qu'ATLAS propose, et ce qu'on en a fait
--   strategy_versions              chaque reglage commercial change, avant/apres
--   engineering_insights           les frictions repetees, pour l'ingenierie
--   sales_friction_events          la matiere premiere des insights
--   sales_lead_reviews             les reponses chaudes deja traitees
--
-- Aucune de ces tables ne decide d'un envoi : la porte reste outbound_sends
-- et le registre outreach_ledger. Elles rendent la boucle mesurable.
CREATE TABLE IF NOT EXISTS sales_segments (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  countries           TEXT NOT NULL DEFAULT '[]',
  sectors             TEXT NOT NULL DEFAULT '[]',
  company_size        TEXT,
  keywords            TEXT NOT NULL DEFAULT '[]',
  exclusions          TEXT NOT NULL DEFAULT '[]',
  target_personas     TEXT NOT NULL DEFAULT '[]',
  buying_signals      TEXT NOT NULL DEFAULT '[]',
  offer_angle         TEXT,
  status              TEXT NOT NULL DEFAULT 'TESTING',
  exploration_weight  REAL NOT NULL DEFAULT 1.0,
  approved_for_send   INTEGER NOT NULL DEFAULT 0,
  approved_by         TEXT,
  approved_at         TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales_attributions (
  domain              TEXT PRIMARY KEY,
  prospect_id         TEXT,
  segment_id          TEXT REFERENCES sales_segments(id),
  persona             TEXT,
  angle               TEXT,
  message_variant     TEXT,
  subject_variant     TEXT,
  followup_variant    TEXT,
  experiment_id       TEXT,
  discovered_at       TEXT,
  contacted_at        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_attributions_segment ON sales_attributions(segment_id);
CREATE TABLE IF NOT EXISTS sales_outcomes (
  id                  TEXT PRIMARY KEY,
  domain              TEXT NOT NULL,
  kind                TEXT NOT NULL,
  revenue_amount      REAL,
  currency            TEXT,
  occurred_at         TEXT NOT NULL,
  offer               TEXT,
  segment_id          TEXT,
  recorded_by         TEXT NOT NULL,
  note                TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_outcomes_domain ON sales_outcomes(domain);
CREATE INDEX IF NOT EXISTS idx_sales_outcomes_kind ON sales_outcomes(kind, occurred_at);
CREATE TABLE IF NOT EXISTS suppression_list (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,
  value               TEXT NOT NULL,
  reason              TEXT NOT NULL,
  source              TEXT,
  evidence            TEXT,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (kind, value)
);
CREATE TABLE IF NOT EXISTS sales_experiments (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  dimension           TEXT NOT NULL,
  variants            TEXT NOT NULL,
  segment_id          TEXT,
  status              TEXT NOT NULL DEFAULT 'ACTIVE',
  winner              TEXT,
  created_at          TEXT NOT NULL,
  concluded_at        TEXT
);
CREATE TABLE IF NOT EXISTS optimization_recommendations (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,
  title               TEXT NOT NULL,
  reason              TEXT NOT NULL,
  evidence            TEXT NOT NULL DEFAULT '{}',
  sample_size         INTEGER NOT NULL DEFAULT 0,
  expected_impact     TEXT,
  risk                TEXT NOT NULL DEFAULT 'low',
  status              TEXT NOT NULL DEFAULT 'PROPOSED',
  change              TEXT,
  human_required      INTEGER NOT NULL DEFAULT 1,
  fingerprint         TEXT NOT NULL,
  strategy_version_id TEXT,
  decided_by          TEXT,
  decided_at          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_optimization_open
  ON optimization_recommendations(fingerprint)
  WHERE status IN ('PROPOSED', 'TESTING', 'APPROVED');
CREATE TABLE IF NOT EXISTS strategy_versions (
  id                  TEXT PRIMARY KEY,
  version             INTEGER NOT NULL,
  before_json         TEXT NOT NULL,
  after_json          TEXT NOT NULL,
  reason              TEXT NOT NULL,
  recommendation_id   TEXT,
  metrics_before      TEXT,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  rolled_back_at      TEXT,
  rollback_of         TEXT
);
CREATE TABLE IF NOT EXISTS engineering_insights (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  detail              TEXT NOT NULL,
  evidence            TEXT NOT NULL DEFAULT '{}',
  frequency           INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'OPEN',
  fingerprint         TEXT NOT NULL UNIQUE,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales_friction_events (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,
  domain              TEXT,
  segment_id          TEXT,
  detail              TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_friction_kind ON sales_friction_events(kind, created_at);
-- Le daemon date ses tours : un tableau de bord qui lit cette colonne sait
-- distinguer « en marche » de « mort sans avoir pu le dire ».
ALTER TABLE daemon_runs ADD COLUMN last_heartbeat_at TEXT;
CREATE TABLE IF NOT EXISTS sales_lead_reviews (
  domain              TEXT PRIMARY KEY,
  status              TEXT NOT NULL DEFAULT 'OPEN',
  handled_by          TEXT,
  handled_at          TEXT,
  note                TEXT,
  updated_at          TEXT NOT NULL
);
`,
  },
  {
    version: 37,
    name: 'autopilot-control-loop',
    sql: `
-- --- L'Autopilot : la boucle de controle, et sa memoire -------------------
--
-- Un cycle observe l'etat reel, diagnostique, propose, priorise, confie ce
-- qui est sur a un worker, verifie, apprend. Chaque cycle est ecrit pour etre
-- relu : ce qu'il a vu, considere, decide, cree, execute, depense. Une action
-- porte une empreinte stable ; tant qu'elle n'est pas resolue, une seconde
-- action de meme empreinte est refusee par l'index partiel — pas par la
-- vigilance de celui qui ecrit.
--
-- Aucune de ces tables n'envoie, ne paie, ne deploie : l'Autopilot cree des
-- taches dans la file existante, sous ses gardes existantes, et laisse au
-- fondateur ce qui exige une personne.
CREATE TABLE IF NOT EXISTS autopilot_cycles (
  id                   TEXT PRIMARY KEY,
  started_at           TEXT NOT NULL,
  finished_at          TEXT,
  -- RUNNING · DONE · FAILED · INTERRUPTED
  status               TEXT NOT NULL,
  trigger              TEXT NOT NULL,
  observations_json    TEXT NOT NULL DEFAULT '{}',
  opportunities_json   TEXT NOT NULL DEFAULT '[]',
  decisions_json       TEXT NOT NULL DEFAULT '[]',
  actions_created_json TEXT NOT NULL DEFAULT '[]',
  executed_json        TEXT NOT NULL DEFAULT '[]',
  estimated_cost_usd   REAL NOT NULL DEFAULT 0,
  actual_cost_usd      REAL,
  summary              TEXT,
  error                TEXT
);
CREATE INDEX IF NOT EXISTS idx_autopilot_cycles_started ON autopilot_cycles(started_at);
CREATE TABLE IF NOT EXISTS autopilot_actions (
  id                      TEXT PRIMARY KEY,
  fingerprint             TEXT NOT NULL,
  cycle_id                TEXT NOT NULL REFERENCES autopilot_cycles(id),
  objective               TEXT NOT NULL,
  -- REVENUE · BLOCKED_WORK · DISCOVERY · CONVERSION · RELIABILITY · OPTIMIZATION · EXPLORATION
  category                TEXT NOT NULL,
  -- EXPLOIT · OPTIMIZE · EXPLORE
  allocation              TEXT NOT NULL,
  -- PROPOSED · APPROVED · QUEUED · RUNNING · VERIFYING · DONE · REJECTED · BLOCKED · WAITING_HUMAN
  status                  TEXT NOT NULL,
  score                   REAL NOT NULL,
  proposal_json           TEXT NOT NULL,
  recommended_agent       TEXT NOT NULL,
  requires_human_approval INTEGER NOT NULL DEFAULT 1,
  reason                  TEXT NOT NULL,
  task_id                 TEXT,
  result_json             TEXT,
  rejection_reason        TEXT,
  estimated_cost_usd      REAL NOT NULL DEFAULT 0,
  actual_cost_usd         REAL,
  parent_action_id        TEXT,
  depth                   INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  resolved_at             TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_autopilot_actions_open
  ON autopilot_actions(fingerprint)
  WHERE status IN ('PROPOSED', 'APPROVED', 'QUEUED', 'RUNNING', 'VERIFYING', 'BLOCKED', 'WAITING_HUMAN');
CREATE INDEX IF NOT EXISTS idx_autopilot_actions_status ON autopilot_actions(status, score);
CREATE INDEX IF NOT EXISTS idx_autopilot_actions_task ON autopilot_actions(task_id);
`,
  },
  {
    version: 38,
    name: 'prospect-expansion-engine',
    sql: `
-- --- Le moteur d'expansion de prospects ------------------------------------
--
-- Une bonne entreprise en revele d'autres : ses distributeurs, ses
-- concurrents, les exposants du salon ou elle expose, les membres de sa
-- federation, ses semblables. Le moteur part d'une graine, pose des
-- hypotheses d'expansion, cherche, lit, normalise, dedoublonne, relie, qualifie
-- et note — et ne retient JAMAIS une relation sans preuve : une URL, un
-- extrait, une methode, une confiance. Quatre tables :
--
--   prospect_expansion_runs   un tour : graines, strategies, plafonds,
--                             progression (pour reprendre), chiffres
--   expansion_candidates      une entreprise par (tour, cle canonique) : le
--                             meme domaine trouve par quatre chemins est UNE
--                             ligne, avec plusieurs relations et preuves
--   prospect_relationships    source → cible, type, confiance, preuve —
--                             unique par (source, cible, type, url de preuve)
--   prospect_evidence         ce qui a ete vu, ou, et ce qu'on en tire
--
-- Rien ici n'envoie ni n'approuve : un candidat prioritaire entre dans la
-- file commerciale existante comme DISCOVERED, et suit ses gardes.
CREATE TABLE IF NOT EXISTS prospect_expansion_runs (
  id                 TEXT PRIMARY KEY,
  -- RUNNING · DONE · FAILED · INTERRUPTED · CAPPED
  status             TEXT NOT NULL,
  -- SALES (notre acquisition) · CLIENT (une mission facturee)
  purpose            TEXT NOT NULL,
  mission_id         TEXT,
  trigger            TEXT NOT NULL,
  seeds_json         TEXT NOT NULL,
  strategies_json    TEXT NOT NULL,
  limits_json        TEXT NOT NULL,
  icp_json           TEXT,
  progress_json      TEXT NOT NULL DEFAULT '{}',
  stats_json         TEXT NOT NULL DEFAULT '{}',
  search_calls       INTEGER NOT NULL DEFAULT 0,
  search_cost_usd    REAL NOT NULL DEFAULT 0,
  ai_calls           INTEGER NOT NULL DEFAULT 0,
  ai_cost_usd        REAL NOT NULL DEFAULT 0,
  fetches            INTEGER NOT NULL DEFAULT 0,
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  updated_at         TEXT NOT NULL,
  summary            TEXT,
  error              TEXT
);
CREATE INDEX IF NOT EXISTS idx_expansion_runs_started ON prospect_expansion_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_expansion_runs_status ON prospect_expansion_runs(status);

CREATE TABLE IF NOT EXISTS expansion_candidates (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES prospect_expansion_runs(id),
  -- la cle canonique : le domaine canonique, ou name:<nom normalise> sans domaine
  entity_key         TEXT NOT NULL,
  -- COMPANY · EVENT · ASSOCIATION
  entity_kind        TEXT NOT NULL DEFAULT 'COMPANY',
  company_name       TEXT NOT NULL,
  canonical_domain   TEXT,
  website            TEXT,
  country            TEXT,
  aliases_json       TEXT NOT NULL DEFAULT '[]',
  depth              INTEGER NOT NULL DEFAULT 0,
  seed_key           TEXT,
  is_seed            INTEGER NOT NULL DEFAULT 0,
  -- UNIVERSE · RELEVANT · QUALIFIED · HIGH_PRIORITY · REJECTED
  stage              TEXT NOT NULL DEFAULT 'UNIVERSE',
  icp_status         TEXT,
  score              REAL,
  score_detail_json  TEXT,
  reject_reason      TEXT,
  prospect_id        TEXT,
  discovered_at      TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE(run_id, entity_key)
);
CREATE INDEX IF NOT EXISTS idx_expansion_candidates_run ON expansion_candidates(run_id, stage);
CREATE INDEX IF NOT EXISTS idx_expansion_candidates_entity ON expansion_candidates(entity_key);

CREATE TABLE IF NOT EXISTS prospect_relationships (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT,
  source_key          TEXT NOT NULL,
  source_name         TEXT NOT NULL,
  -- COMPANY · EVENT · ASSOCIATION
  source_kind         TEXT NOT NULL DEFAULT 'COMPANY',
  target_key          TEXT NOT NULL,
  target_name         TEXT NOT NULL,
  relationship_type   TEXT NOT NULL,
  confidence          REAL NOT NULL,
  -- VERIFIED (lu sur une page qui fait foi) · INFERRED (deduit, a verifier)
  status              TEXT NOT NULL,
  evidence_url        TEXT NOT NULL,
  evidence_summary    TEXT NOT NULL,
  -- la strategie qui l'a trouvee
  source_method       TEXT NOT NULL,
  -- OFFICIAL · ASSOCIATION_EVENT · SECONDARY
  source_trust        TEXT NOT NULL,
  country             TEXT,
  source_date         TEXT,
  discovered_at       TEXT NOT NULL,
  UNIQUE(source_key, target_key, relationship_type, evidence_url)
);
CREATE INDEX IF NOT EXISTS idx_relationships_source ON prospect_relationships(source_key);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON prospect_relationships(target_key);
CREATE INDEX IF NOT EXISTS idx_relationships_run ON prospect_relationships(run_id);

CREATE TABLE IF NOT EXISTS prospect_evidence (
  id            TEXT PRIMARY KEY,
  run_id        TEXT,
  entity_key    TEXT NOT NULL,
  -- RELATIONSHIP · IDENTITY · ACTIVITY · COUNTRY · MEMBERSHIP
  kind          TEXT NOT NULL,
  claim         TEXT NOT NULL,
  url           TEXT NOT NULL,
  excerpt       TEXT,
  -- OFFICIAL · ASSOCIATION_EVENT · SECONDARY
  trust         TEXT NOT NULL,
  method        TEXT NOT NULL,
  confidence    REAL NOT NULL,
  collected_at  TEXT NOT NULL,
  UNIQUE(entity_key, kind, url, claim)
);
CREATE INDEX IF NOT EXISTS idx_prospect_evidence_entity ON prospect_evidence(entity_key);
CREATE INDEX IF NOT EXISTS idx_prospect_evidence_run ON prospect_evidence(run_id);
`,
  },
];
