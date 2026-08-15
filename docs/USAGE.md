# Using ATLAS OS

How to run the organisation day to day.

---

## The two views

**Command Center** is where you work: create missions, read results, supervise
agents, search memory, review proposed improvements.

**ATLAS Village** is where you see the organisation. Everything on the map is
real state — a walking inhabitant means an agent was genuinely dispatched, a
red building means a step there actually failed. Use it to understand what is
happening at a glance; use the Command Center to act on it.

Switch between them from the rail on the left.

---

## Running a mission

### Write a good objective

This is the single highest-leverage thing you do. Hermes plans from the
objective, and every agent sees it. Compare:

> ❌ *"Research German distributors."*

> ✅ *"Identify and qualify potential distribution partners in Germany for our
> industrial packaging machinery. We are an 80-person French manufacturer,
> €14M revenue, selling to food and beverage producers. Assess commercial fit
> for each candidate and produce a shortlist briefing I can take into a
> partner conversation."*

The second says who you are, what "good" looks like, and what should exist when
it is done. It produces a materially better plan.

**Add business context** as key/value pairs — sector, target market, company
size, constraints. It reaches the planner as structured data agents can act on.

### What happens next

1. Hermes analyses the objective and decides the steps and who runs each.
2. Independent steps run in parallel; dependent ones wait for their inputs.
3. Each agent works its step with only the tools it is permitted to use.
4. Hermes reviews the whole run and writes you a report with a quality score.
5. The outcome — and any failure pattern — goes into memory.

Watch it in the village, or open the mission and follow the **Steps** tab.

### Reading the result

- **Result** — the report Hermes wrote for you, plus any deliverables to open.
- **Steps** — every step, who ran it, how long it took, and its raw output.
- **Hermes' plan** — *why* it was decomposed this way. Read this when a result
  disappoints; the reasoning usually shows where the objective was ambiguous.
- **Trail** — every message and event, in order.

### Controlling a mission

| Action | When |
|---|---|
| **Pause** | Stop after in-flight steps settle; resume later. |
| **Cancel** | Stop and mark failed. |
| **Retry** | Re-plan and re-run a failed mission from scratch. |
| **Validate** | Sign off a good result. Raises the quality score of the agents involved. |
| **Archive** | Remove from the active list, keep the record. |

Validating matters: it is how you teach ATLAS which work was actually good.

### Plan first, run later

Untick **Start immediately** when creating a mission. Hermes plans it and
waits. Review the plan, then press **Start**. Useful for expensive or
consequential objectives.

---

## Agents

**Agents** shows the team, grouped by role, with live status and real
performance — success rate, average step time, quality score, tokens used.

Metrics are derived from the task log, so they can never drift from what
actually happened.

**Disable** an agent to take it out of Hermes' roster without losing its
history. **Details** shows its skills, tools, and recent activity.

To add a specialist of your own, see [AGENTS.md](AGENTS.md).

---

## Memory

Everything ATLAS has learned, in three tiers:

- **Operational** — what current missions need. Expires unless it proves useful.
- **Strategic** — durable lessons about how the organisation works best.
- **Business** — domain knowledge: companies, markets, partners.

Agents search memory before researching anything, so the library directly
reduces duplicated work. Search it yourself to find what ATLAS knows.

**Consolidate now** expires stale entries, promotes proven operational
knowledge into strategic memory, and prunes what was never used. It also runs
automatically every six hours.

**Forget** removes an entry — use it when ATLAS has learned something wrong.

---

## Automation

Two kinds of recurring work, in one list:

- **ATLAS maintenance jobs** — backup, memory consolidation, evolution
  analysis, housekeeping. Built in; disable any of them without touching code.
- **External workflows** — delegated to n8n.

**Run now** triggers one immediately. **History** shows past runs and their
outcomes.

### Connecting n8n

1. Set `ATLAS_N8N_ENABLED=true` and `ATLAS_N8N_BASE_URL` in `.env`.
2. Build a workflow in n8n starting with a **Webhook** node; note its path.
3. Register it:

```bash
curl -X POST https://your-atlas/api/workflows \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "key": "enrich-company",
    "name": "Enrich company record",
    "description": "Looks up a company in our CRM and returns the enriched record.",
    "webhookPath": "enrich-company",
    "trigger": { "type": "manual" }
  }'
```

Agents holding the `trigger_workflow` tool can now call it by key, and it
appears in the Command Center.

Triggers can also be `schedule` (5-field cron) or `event` (any ATLAS event
type) — so a workflow can fire whenever, say, a mission fails.

---

## Evolution

ATLAS studies its own performance and proposes changes.

Each proposal shows the **evidence** that motivated it and the **exact change**
it would make. Nothing is applied without your approval unless you have raised
autonomy to `apply-low-risk`.

- **Approve & apply** — the change takes effect immediately, with the previous
  value stored.
- **Revert** — restores exactly what was there before.
- **Reject** — dismisses it. The same idea can be raised again later if the
  evidence recurs.

ATLAS can only change agent settings, orchestration limits, workflow toggles
and memory retention. It cannot modify its own code.

**Run analysis now** triggers a cycle immediately; otherwise it runs hourly.
Nothing to propose is a valid and common outcome.

---

## Activity

The complete event log. Filter by severity or search by message, type or
source. **Follow live** streams new events as they happen.

This is the place to answer "what actually happened at 03:12".

---

## Settings

Orchestration limits, models, reasoning effort, evolution autonomy, and
backups. Changes take effect without a restart.

Raising **concurrent missions** increases throughput and token spend together.
Raising **reasoning effort** improves quality on hard objectives and costs more.
Both are worth tuning against your own workload rather than left at defaults.

---

## Practical notes

**Start with your hardest real objective.** ATLAS is most useful on work that
is genuinely multi-step. A single-lookup task is not worth a mission.

**Validate good results.** It is the only signal that distinguishes "finished"
from "actually good".

**Read the plan when a result disappoints.** Nine times out of ten the
decomposition reveals that the objective was ambiguous, not that an agent
underperformed.

**Watch token spend early.** The Overview shows today and lifetime. Effort and
concurrency are the two levers.

**In simulation mode, judge the shape, not the content.** The plan structure,
dispatch behaviour, memory and evolution are all real; the findings are not.
