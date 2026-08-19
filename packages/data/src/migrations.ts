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
];
