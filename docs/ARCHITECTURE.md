# Architecture

How ATLAS OS is put together, and the reasoning behind the choices that were
not obvious.

---

## 1. Shape of the system

```
                        Founder
                           │
              ┌────────────┴────────────┐
              │                         │
       ATLAS Village            Command Center        ← apps/console
              └────────────┬────────────┘
                           │  REST + WebSocket
                  ┌────────▼────────┐
                  │  Server / API   │                 ← packages/server
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │     HERMES      │  plan · assign · supervise · synthesise
                  └────────┬────────┘                 ← packages/hermes
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
   Agent runtime      Automation         Evolution
   + tools            (n8n + jobs)       (observe → propose → apply)
   packages/agents    packages/automation packages/evolution
        │                  │                  │
        └──────────────────┼──────────────────┘
                           │
              ┌────────────▼────────────┐
              │  Memory  ·  Data  ·  Events │       ← packages/memory, data, core
              └────────────┬────────────┘
                           │
                  ┌────────▼────────┐
                  │ Runtime supervisor │  health · backup · recovery · schedule
                  └─────────────────┘                ← packages/runtime
```

Dependencies point in one direction only: `contracts → core → data → memory →
llm → intelligence → agents → departments → hermes → server`. No package imports a package above it, which
is what allows any layer to be tested or replaced on its own.

## 2. Packages

| Package | Owns | Depends on |
|---|---|---|
| `contracts` | Domain types, lifecycle rules, API schemas | — |
| `core` | Config, logging, event bus, errors, ids, retry | contracts |
| `data` | SQLite schema, migrations, repositories | core |
| `memory` | Three-tier memory, recall ranking, consolidation | data |
| `llm` | Provider abstraction, Anthropic + simulation | core |
| `agents` | Agent runtime, tool registry, the eight specialists | llm, memory, data |
| `hermes` | Planning, dispatch, supervision, synthesis, learning | agents |
| `automation` | n8n client, cron, workflow registry | data |
| `evolution` | Observation, detection, reversible application | data, memory |
| `runtime` | Supervisor, health, backups, village projection | all of the above |
| `server` | HTTP API, auth, realtime, composition root | all of the above |

`apps/console` is the React client. It imports `contracts` directly, so a
change to a domain type breaks the frontend build rather than surfacing as a
runtime surprise.

---

## 3. Decisions worth explaining

### SQLite, not Postgres

ATLAS is a single-writer system: one orchestrator process, one founder, a
read-heavy console. SQLite in WAL mode gives concurrent reads during writes,
backups that are a file copy, and no external service to keep alive on the VPS
— which serves the 24/7 requirement directly. The repository layer is the only
code that touches SQL, so migrating to Postgres later is a contained change.

Full-text search uses FTS5 with an external-content table, so `memory_items`
stays the single source of truth and triggers keep the index in step.

### The event bus is the nervous system

Everything observable publishes an event. Three consumers subscribe:

1. **Storage** — every event is persisted, so the log and the live stream can
   never disagree.
2. **The realtime channel** — pushes to connected consoles.
3. **Automation** — event-triggered workflows.

Handlers run detached and their failures are logged rather than propagated, so
one bad listener can never stall a mission.

### Planning is validated, not trusted

A plan is model output. The planner's JSON schema enumerates the agents that
actually exist, so a plan cannot address a specialist ATLAS does not employ.
Everything else — invented actions, dangling dependencies, cycles — is repaired
or dropped in `#validateSteps` before a single task is written. Dependencies
resolve backwards only, which makes cycles unrepresentable rather than merely
unlikely.

When planning fails entirely, a deterministic three-stage decomposition takes
over. A degraded plan is still a working mission; the founder is told.

### Dispatch is dependency-driven

The orchestrator does not run steps in sequence. It repeatedly promotes tasks
whose dependencies have succeeded and runs up to `maxConcurrentTasks` at once.
Independent steps genuinely run in parallel — which is what the simultaneous
journeys in the village are showing.

Only a **succeeded** dependency satisfies a step. A step whose prerequisite
failed, was cancelled, or was itself skipped is *skipped*, so the cascade
propagates the whole way down a chain rather than stopping after one level and
running a step without the input it declared it needed.

### Who may do what is a declared mandate

Every agent carries a `mandates` set. Hermes plans against the agents holding
`mission-execution`; the evolution loop consults the agent holding
`system-analysis` and `advisory`. Nothing infers eligibility from an agent's
tier or key, so a future transverse specialist is included or excluded by its
own definition rather than by editing the orchestrator.

### What an agent can do is a declared skill

A **skill** is a reusable technical know-how owned by the platform — `web-research`,
`scoring`, `document-production` — and it names the tools that provide it
(Constitution, Article VII). An agent declares skills; its tool allow-list is
*derived* from them on every read, never stored. That gives one place to grant a
skill across the whole organisation and one place to withdraw it: disabling
a skill removes its tools from every holder at the next tool call.

The two sets answer different questions and are deliberately separate: a mandate
says what kind of work an agent may be given, a skill says what it can technically
do. Neither is inferred from the other.

### Cost and replanning are both bounded

A mission carries a token budget (its own, or the deployment default). It is
checked before each step is dispatched — never mid-step, so work already
running is allowed to finish. Reaching the ceiling is a **clean stop**: pending
steps are cancelled, what completed is kept, and Hermes still synthesises a
result marked as partial.

When a step that other steps depended on fails permanently, the remaining plan
is built on a result that will never arrive. Hermes therefore reconsiders the
remainder — keeping everything that succeeded, capped by
`maxReplansPerMission`, and recorded as an event so the founder can see that it
changed its mind and why. A failed *leaf* step does not trigger this: that is a
gap in the result, not a broken plan.

### Memory has three tiers with different lifecycles

- **Operational** — what a running mission needs. Self-expiring.
- **Strategic** — durable lessons about how the organisation works best.
- **Business** — domain knowledge: companies, markets, partners.

The tier is inferred from the *kind* of knowledge, so an agent records what it
learned without reasoning about storage. Recall blends text relevance (BM25),
curated importance, and recency — a perfect keyword match on a stale, ignored
note should not outrank a weaker match on a strategic lesson.

Storing a title that already exists reinforces the existing entry instead of
duplicating it: repetition is evidence of importance, not a reason to grow the
library.

### Self-improvement is bounded by the type system

`ImprovementChange` is a closed union of declarative changes — agent settings,
orchestration limits, workflow toggles, memory retention. There is no variant
that executes code, so "ATLAS modifies itself" cannot escalate beyond adjusting
its own dials. Every application snapshots the prior value first, so a revert
restores exactly what was there rather than guessing at a default.

Autonomy never extends past low-risk changes; anything that could alter
judgement quality waits for a human decision.

The threshold detectors produce *signals*, not conclusions. The Evolution
Manager — a real agent, looked up by mandate — reads the observation report
and those signals and decides what, if anything, they mean. It fills a flat,
enumerated form rather than writing a change directly; that form is then
translated into the closed union, with agent and workflow names checked against
what exists and every numeric value range-checked. A recommendation that does
not survive translation is discarded rather than clamped, so the founder is
never asked to approve a value the agent did not actually propose. Its
recommendation is recorded as a message to Hermes, which puts it in the same
communication trail as any other handoff.

### Simulation is a supported mode, not a stub

Without an API key ATLAS still plans, dispatches, executes, remembers and
evolves. The simulation provider generates output from the actual request — it
walks the requested JSON schema, honours `enum` and length constraints, and
exercises the real tool loop — so the shape of what flows through the system is
genuine. Everything it produces is labelled `[simulated]`.

This is what makes the product demonstrable, testable and developable offline.

### The village renders state, never decoration

Building height is accumulated department activity. The status ring is the
department's real condition. An inhabitant walks only when an agent was
genuinely dispatched, along the actual route, for the duration the server
reported. Sparks appear above an agent that is really working.

Canvas 2D rather than DOM, because the scene redraws every frame with dozens of
moving parts — and it keeps the whole village dependency-free.

---

## 4. Request and mission flow

**A mission, end to end:**

1. `POST /api/missions` → Hermes records the objective and the founder's
   assignment message.
2. Hermes queues the mission; the pump starts it when a slot is free.
3. **Plan** — the planner reads relevant memory, produces a validated plan, and
   writes one assignment message per step.
4. **Dispatch** — ready steps run concurrently. Each agent gets its own
   instruction, the outputs of the steps it depends on, and a memory briefing.
5. **Execute** — the agent runtime drives an explicit tool loop. Every tool call
   becomes an event, a village journey, and an audit-trail entry.
6. **Supervise** — transient failures retry with backoff; permanent ones fail
   the step, raise an alert, and put the department into alert state.
7. **Synthesise** — Hermes reviews the whole run and writes the founder's report
   with a quality score.
8. **Learn** — the outcome, and any failure pattern, go into memory.

**Recovery.** On boot, missions left `running`/`assigned`/`planned` are
re-queued and their in-flight steps returned to the ready pool, so an unclean
stop costs at most the work that was actually in progress.

---

## 5. Security boundaries

- **Authentication** guards the API, not the static console shell — the shell is
  useless without a session, and gating it would prevent the login screen from
  loading at all.
- **Sessions live in an httpOnly, `SameSite=Strict` cookie** the console cannot
  read, so an XSS flaw cannot exfiltrate the token. `SameSite=Strict` also means
  the cookie is never attached cross-site, which removes the need for a separate
  CSRF token. Expiry slides server-side: past the halfway point of its life the
  session is **rotated**, not merely extended, so a leaked token's usefulness is
  bounded by the refresh interval. Bearer tokens remain supported for scripts
  and integrations, which hold their own token and are not rotated.
- **Passwords** are scrypt-hashed with a per-user salt. **Session tokens** are
  stored hashed, so a database leak cannot be replayed as a login.
- **Rate limiting** is sliding-window. The login limiter keys on source address
  *and* the email being tried: keying on the address alone would let one
  attacker lock out a shared office, and on the email alone would let a botnet
  lock out a specific founder. A successful sign-in clears the counter.
- **Tool permissions** are enforced at execution time against the agent's
  allow-list, not merely by omitting the tool from the prompt.
- **`http_fetch`** refuses non-HTTPS URLs and blocks private, loopback and
  metadata addresses — an agent cannot be talked into probing the VPS.
- **Artifacts** are served behind auth; a mission report may contain
  commercially sensitive analysis.
- **Role gates** (`viewer` < `operator` < `founder`) protect anything that
  changes how the organisation runs.

## 6. Extending ATLAS

- **A new agent** — `POST /api/agents`, or add to `AGENT_DEFINITIONS`. It joins
  the village and the planner's roster immediately.
- **A new tool** — implement `AtlasTool` and register it. Add its name to the
  agents allowed to use it; nothing else needs to change.
- **A new workflow** — `POST /api/workflows` for n8n, or
  `automation.registerInternal()` for an in-process job. Both appear in the same
  Command Center list with schedule, history and last outcome.
- **A new product on the platform** — the agent framework, memory, orchestration
  and console are product-agnostic. A new product is a new set of agents and
  tools over the same foundation.
