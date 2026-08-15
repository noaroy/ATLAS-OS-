# Installation

## Requirements

| | Minimum | Recommended |
|---|---|---|
| Node.js | 22 | 24 LTS |
| RAM | 1 GB | 2 GB |
| Disk | 5 GB | 20 GB |
| OS | Linux, macOS, Windows | Debian 12 / Ubuntu 24.04 |

No database server is needed — ATLAS uses embedded SQLite.

---

## Local development

```bash
npm install
cp .env.example .env
```

Edit `.env` and set at minimum:

```bash
ATLAS_SESSION_SECRET=<32+ random characters>
ATLAS_FOUNDER_PASSWORD=<your password>
```

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then:

```bash
npm run dev
```

- Console → http://localhost:5173
- API → http://localhost:4700

Sign in with `ATLAS_FOUNDER_EMAIL` / `ATLAS_FOUNDER_PASSWORD`.

### Verify the installation

```bash
npm test        # 100 tests across orchestration, agents, evolution, persistence
npm run demo    # drives a real mission end to end
```

---

## Configuration

Every setting lives in `.env`. The ones that matter:

### Essential

| Variable | Purpose |
|---|---|
| `ATLAS_SESSION_SECRET` | Signs sessions. **Must** be changed from the example. |
| `ATLAS_FOUNDER_EMAIL` | Founder account, created on first boot. |
| `ATLAS_FOUNDER_PASSWORD` | Founder password. Change it. |
| `ATLAS_PORT` | HTTP port (default `4700`). |
| `ATLAS_DATA_DIR` | Where the database, artifacts and backups live. |

### Intelligence

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Leave empty for simulation mode. Set it for live intelligence. |
| `ATLAS_HERMES_MODEL` | Planning and synthesis. Default `claude-opus-5`. |
| `ATLAS_AGENT_MODEL` | Step execution. Default `claude-sonnet-5`. |
| `ATLAS_LLM_EFFORT` | `low` … `max`. Default `high`. |
| `ATLAS_LLM_MAX_TOKENS` | Output ceiling per call. Default `16000`. |

### Orchestration

| Variable | Purpose |
|---|---|
| `ATLAS_MAX_CONCURRENT_MISSIONS` | Missions running at once. Default `3`. |
| `ATLAS_MAX_CONCURRENT_TASKS` | Parallel steps per mission. Default `4`. |
| `ATLAS_TASK_TIMEOUT_MS` | Ceiling for one step. Default 5 minutes. |
| `ATLAS_TASK_MAX_ATTEMPTS` | Retries for a transient failure. Default `3`. |
| `ATLAS_MISSION_TOKEN_BUDGET` | Default token ceiling per mission; `0` disables. Default `400000`. |
| `ATLAS_MAX_REPLANS_PER_MISSION` | Times Hermes may replan one mission; `0` disables. Default `1`. |

All of these except the step timeout can also be changed live in **Settings**
without a restart, and a mission may carry its own token budget that overrides
the default.

### Automation, evolution, operations

| Variable | Purpose |
|---|---|
| `ATLAS_N8N_ENABLED` | Turn on the n8n integration. |
| `ATLAS_N8N_BASE_URL` | e.g. `http://n8n:5678`. |
| `ATLAS_EVOLUTION_AUTONOMY` | `observe` \| `propose` \| `apply-low-risk`. |
| `ATLAS_BACKUP_RETENTION` | Backups to keep. Default `14`. |
| `ATLAS_HEARTBEAT_MS` | Supervisor interval. Default `30000`. |
| `ATLAS_CORS_ORIGINS` | Browser origins allowed to call the API. |

---

## Production build

```bash
npm run build     # dist/server/atlas.mjs + dist/console/
npm start
```

The server serves the console from the same port, so a deployment is one
service behind one reverse proxy.

---

## VPS deployment

### Option A — Docker (recommended)

Brings up ATLAS, n8n, and Caddy for automatic TLS.

```bash
git clone <your-repo> atlas && cd atlas
cp .env.example .env
```

Set in `.env`:

```bash
ATLAS_SESSION_SECRET=<random>
ATLAS_FOUNDER_PASSWORD=<yours>
ATLAS_DOMAIN=atlas.example.com     # must already point at this server
N8N_PASSWORD=<yours>
ANTHROPIC_API_KEY=<yours>
ATLAS_N8N_ENABLED=true
```

Then:

```bash
docker compose -f deployment/docker-compose.yml up -d
docker compose -f deployment/docker-compose.yml logs -f atlas
```

- ATLAS → `https://atlas.example.com`
- n8n → `https://atlas.example.com/n8n/`

State lives in named volumes (`atlas-data`, `n8n-data`), so the stack can be
rebuilt without losing the organisation's memory.

### Option B — systemd, no Docker

```bash
sudo ./deployment/install.sh
```

The script installs Node, creates an `atlas` service account, builds the
project, generates secrets, installs the unit, and starts the service. It
prints the generated founder password — record it.

```bash
systemctl status atlas
journalctl -u atlas -f
```

The unit restarts on failure with backoff, starts at boot, and gives ATLAS 60
seconds on `SIGTERM` so its graceful shutdown (drain, checkpoint, final backup)
can finish.

**Put TLS in front of it before exposing the port.** A minimal Caddy setup:

```
atlas.example.com {
	reverse_proxy localhost:4700
}
```

The realtime channel is a long-lived WebSocket — if you use nginx, raise
`proxy_read_timeout` well above the heartbeat interval or the village's live
feed will be cut every few minutes.

---

## Post-installation checklist

- [ ] `ATLAS_SESSION_SECRET` changed from the example
- [ ] Founder password changed and recorded
- [ ] TLS terminating in front of ATLAS
- [ ] Port 4700 **not** reachable from the public internet directly
- [ ] `ANTHROPIC_API_KEY` set (or simulation mode accepted deliberately)
- [ ] `ATLAS_CORS_ORIGINS` set to your real domain
- [ ] A backup restore rehearsed once — see [MAINTENANCE.md](MAINTENANCE.md)

---

## Troubleshooting

**`Invalid configuration`** — the message lists exactly which variables are
wrong. Usually `ATLAS_SESSION_SECRET` is too short.

**`better-sqlite3` fails to install** — a prebuilt binary was unavailable for
your platform. Install build tools (`apt install python3 make g++`) and retry.

**Console shows "Offline"** — the WebSocket cannot connect. Check that your
reverse proxy forwards WebSocket upgrades on `/api/realtime`.

**Port already in use** — change `ATLAS_PORT`, or stop the other process.

**Missions never leave `created`** — check the logs for a planning error. In
simulation mode this should never happen; with a live key, verify the API key
and that `ATLAS_HERMES_MODEL` is a model your account can reach.
