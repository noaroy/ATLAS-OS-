# ATLAS OS

**The operating system of an autonomous digital organisation.**

ATLAS OS lets one person direct an organisation of specialised AI agents. You
state an objective; Hermes — the operations director — analyses it, decides
what must happen and who should do it, dispatches specialists, supervises their
work, and returns a synthesised result. Everything the organisation learns is
kept, and it studies its own performance to work better over time.

It has two faces over one system:

- **ATLAS Village** — an immersive, living map of the organisation, where every
  building, inhabitant and movement corresponds to something real.
- **Command Center** — the professional surface: missions, agents, memory,
  automation, logs, and control.

---

## Quick start

```bash
npm install
cp .env.example .env          # then set ATLAS_SESSION_SECRET and a password
npm run dev
```

Open **http://localhost:5173** and sign in with the credentials from your
`.env`.

To watch the whole organisation work end to end:

```bash
npm run demo
```

> **No API key?** ATLAS runs fully in **simulation mode** — planning, dispatch,
> memory, evolution, the village, all of it. Agents simply have no external
> data, so their findings are labelled as simulated. Set `ANTHROPIC_API_KEY` in
> `.env` for live intelligence.

---

## What is in the box

| Capability | Where it lives | SRS |
|---|---|---|
| Mission lifecycle, planning, dispatch, supervision | `packages/hermes` | §2.7, §4.4, §5.6 |
| Eight specialist agents, tools, permissions | `packages/agents` | §4.5–4.12 |
| Three-tier memory with ranked recall | `packages/memory` | §2.11, §5.11 |
| n8n automation + internal scheduled jobs | `packages/automation` | §2.12, §5.12 |
| Self-improvement, reversible changes | `packages/evolution` | §3.12, §6.8 |
| 24/7 supervision, health, backups, recovery | `packages/runtime` | §2.15, §5.15 |
| REST API, realtime channel, auth | `packages/server` | §5.5 |
| ATLAS Village + Command Center | `apps/console` | §3, §2.6 |

## The team

| Agent | Responsibility | Home |
|---|---|---|
| **Hermes** | Operations director — plans, assigns, supervises, synthesises | Command Center |
| **Explorer** | Research and discovery | Research Tower |
| **Analyst** | Analysis, comparison, scoring | Analysis Laboratory |
| **Ambassador** | Partner intelligence and qualification | Partnership Center |
| **Messenger** | Commercial communication | Communication Tower |
| **Architect** | Deliverable production | Production Workshop |
| **Archivist** | Knowledge curation | Central Library |
| **Engineer** | Technical health and operations | Automation Factory |
| **Evolution Manager** | Continuous improvement | Evolution Observatory |

New specialists can be added at runtime through the API — no redeploy.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API on :4700 and console on :5173, both hot-reloading |
| `npm run build` | Bundles the server and builds the console into `dist/` |
| `npm start` | Runs the production bundle |
| `npm test` | Runs the test suite (100 tests) |
| `npm run typecheck` | Typechecks every package |
| `npm run demo` | Drives a real mission end to end and narrates it |

## Documentation

- **[Architecture](docs/ARCHITECTURE.md)** — how the layers fit together and why
- **[Installation](docs/INSTALLATION.md)** — local setup and VPS deployment
- **[Usage](docs/USAGE.md)** — running the organisation day to day
- **[Agents](docs/AGENTS.md)** — the team, their skills, and adding your own
- **[Departments](docs/DEPARTMENTS.md)** — the products, the pipeline, and what the platform guarantees
- **[Maintenance](docs/MAINTENANCE.md)** — backups, upgrades, troubleshooting
- **[Live](docs/LIVE.md)** — leaving simulation: real spend, real sources, and what is never done
- **[Économie](docs/ECONOMIE.md)** — what each failed mission cost, and what now prevents it

## Deployment

```bash
# Docker (recommended — ATLAS + n8n + TLS proxy)
docker compose -f deployment/docker-compose.yml up -d

# Or directly on a VPS with systemd
sudo ./deployment/install.sh
```

See [docs/INSTALLATION.md](docs/INSTALLATION.md) for details.

---

## Design principles

1. **One agent, one responsibility.** Specialisation beats a generalist.
2. **Nothing important is invisible.** Every decision, message and failure is
   recorded and answerable after the fact.
3. **The village shows the truth.** No animation exists that does not represent
   real state.
4. **Self-improvement is bounded.** ATLAS can only propose changes from a
   fixed, declarative set, and every applied change can be reverted exactly.
5. **It must survive a restart.** Interrupted missions resume; state is backed
   up on a schedule and on every clean shutdown.

## Licence

Proprietary. All rights reserved.
