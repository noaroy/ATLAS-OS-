# The agent system

One agent, one responsibility. Specialisation produces better results, is
easier to reason about, and makes failures diagnosable.

---

## The founding team

### Hermes — operations director

Not an agent in the roster; the orchestrator itself. Hermes receives an
objective, decides what must happen and who does it, dispatches, supervises,
synthesises the result, and records what was learned. Agents never talk to each
other directly — every handoff passes through Hermes, which is what makes the
organisation auditable.

| Agent | Responsibility | Skills |
|---|---|---|
| **Explorer** | Find relevant information: companies, markets, sources, signals | `memory-recall`, `memory-curation`, `web-research` |
| **Analyst** | Turn material into judgement: comparison, scoring, recommendation | `memory-recall`, `memory-curation`, `scoring` |
| **Ambassador** | Judge whether two businesses actually fit | `memory-recall`, `memory-curation`, `web-research`, `scoring` |
| **Messenger** | Write the message that earns a reply | `memory-recall`, `memory-curation`, `document-production` |
| **Architect** | Build the deliverable the founder hands to someone else | `memory-recall`, `memory-curation`, `document-production` |
| **Archivist** | Decide what ATLAS should still know in a year | `memory-recall`, `memory-curation`, `mission-inspection` |
| **Engineer** | Keep the organisation running; report its true state | `system-diagnostics`, `mission-inspection`, `workflow-execution`, `memory-curation` |
| **Evolution Manager** | Improve the organisation, not the current mission | `system-diagnostics`, `mission-inspection`, `memory-recall`, `memory-curation` |

Agents holding `web-research` are additionally granted provider-side web search
and fetch when a live API key is configured.

---

## Skills and tools

A **skill** is a reusable technical know-how owned by the platform, not by any
one agent or department (Constitution, Article VII). An agent declares the
skills it holds; the tools it may call follow from that. Nothing anywhere stores
a per-agent tool list, so a declared skill and a granted tool cannot disagree.

| Skill | Category | Tool it grants |
|---|---|---|
| `memory-recall` | knowledge | `memory_search` — search everything ATLAS has learned |
| `memory-curation` | knowledge | `memory_remember` — record durable knowledge |
| `web-research` | research | `http_fetch` — fetch a public HTTPS page as text |
| `scoring` | analysis | `score_candidates` — weighted scoring and ranking |
| `document-production` | production | `create_document` — write a deliverable to the artifact store |
| `workflow-execution` | automation | `trigger_workflow` — run a registered automation and wait |
| `system-diagnostics` | observation | `system_status` — live resource, throughput and failure data |
| `mission-inspection` | observation | `inspect_mission` — full record of a mission and its steps |

Because the catalogue is shared, a skill can be withdrawn once and it disappears
from every agent holding it — `PATCH /api/skills/:key {"enabled": false}`. That
is a founder action, and it takes effect at the next tool call, not at restart.

### The permission boundary

An agent may only call the tools its skills grant, and this is enforced at
execution time — not merely by omitting the tool from the prompt. A model that
invents a tool name, or reaches for a tool whose skill was withdrawn, gets a
clear refusal it can correct from, rather than an escalation.

`http_fetch` additionally refuses non-HTTPS URLs and blocks private, loopback
and cloud-metadata addresses, so an agent cannot be talked into probing the
host it runs on.

---

## How a step executes

1. Hermes assigns a step with an instruction and the outputs it depends on.
2. The runtime builds a briefing: the objective, the instruction, upstream
   results, and relevant knowledge recalled from memory.
3. The agent runs a tool loop, up to `maxSteps` turns. Each tool call becomes an
   event, a village journey, and an audit-trail entry.
4. On the last permitted turn the agent is asked for a conclusion, so a step
   never ends on a dangling tool call.
5. The result, artifacts and token usage are recorded; the agent returns home.

**Failures.** Transient errors (rate limits, timeouts, provider faults) retry
with jittered backoff. Permanent ones fail the step, raise an alert, and put
the department into alert state in the village. Steps that depended on it are
skipped rather than retried.

---

## Adding a specialist

Agents are stored in the database, so a new one is available immediately — no
redeploy.

```bash
curl -X POST https://your-atlas/api/agents \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "key": "legal-scout",
    "name": "Legal Scout",
    "role": "Regulatory and compliance specialist",
    "tier": "business",
    "building": "research-tower",
    "mission": "Identify regulatory requirements and compliance risks affecting a market entry.",
    "skills": ["regulatory research", "compliance analysis", "risk assessment"],
    "tools": ["memory_search", "memory_remember", "http_fetch"],
    "actions": ["assess-compliance", "map-regulation", "flag-risk"],
    "systemPrompt": "You are the Legal Scout. You identify what the law actually requires, and you separate a hard requirement from a common practice. You cite the instrument behind every requirement, and you say plainly when something needs a qualified local opinion rather than guessing.",
    "maxSteps": 8
  }'
```

The new agent joins the village, appears in the Command Center, and enters
Hermes' planning roster — the planner's schema enumerates registered agents, so
it can be assigned work from the next mission onwards.

### Designing a good agent

- **One responsibility.** If you find yourself writing "and also" in the
  mission, it is two agents.
- **The `mission` field is what the planner reads.** Make it precise about what
  this agent does and does not cover.
- **The system prompt sets judgement, not procedure.** State what the agent
  cares about and how it decides. Current models follow a system prompt closely;
  listing step-by-step procedure fights the specialist judgement you want.
- **Declare the fewest skills that make the job possible.** If no existing
  skill fits, add one to the catalogue rather than a bespoke tool grant — a
  skill only justifies its existence if more than one department could use it.
- **`actions` are what Hermes may assign.** Name them for outcomes, not verbs
  in the abstract.

## Adding a tool

Implement the `AtlasTool` interface in `packages/agents/src/tools.ts`:

```ts
const myTool: AtlasTool<{ query: string }> = {
  name: 'my_tool',
  description: 'What it does, and when to call it — be prescriptive about the trigger.',
  category: 'research',   // matches the category of the skill that grants it
  inputSchema: {           // what the model sees
    type: 'object',
    properties: { query: { type: 'string', maxLength: 500 } },
    required: ['query'],
    additionalProperties: false,
  },
  parse: z.object({ query: z.string().max(500) }),   // what ATLAS trusts
  async execute(input, ctx) {
    return ok(`Result for ${input.query}`, { structured: true });
  },
};
```

Register it in `ALL_TOOLS`, then grant it through a skill in
`packages/agents/src/skills.ts` — either an existing one or a new entry — and
declare that skill on the agents that should have it. A tool no skill grants can
never be called; `packages/agents/test/skills.test.ts` fails if you forget.

Keep `inputSchema` and `parse` in agreement — the first is the model's
contract, the second is the runtime's guarantee.

Return `fail(message)` rather than throwing: a clear failure teaches the model
to correct itself, whereas an exception fails the whole step.
