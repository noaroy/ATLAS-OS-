# Maintenance

Keeping ATLAS OS healthy in continuous operation.

---

## Backups

A consistent, compacted copy is written:

- **Nightly** at 02:15 UTC
- **On every clean shutdown**
- **On demand** — Settings → *Back up now*

`VACUUM INTO` produces a fully valid database without blocking writers, so
backups never require downtime. Older backups are pruned to
`ATLAS_BACKUP_RETENTION` (default 14).

Backups live in `ATLAS_BACKUP_DIR` (default `data/backups/`).

### Restoring

```bash
systemctl stop atlas                       # or: docker compose stop atlas
cp data/backups/atlas-2026-08-06T02-15-00-000Z.db data/atlas.db
rm -f data/atlas.db-wal data/atlas.db-shm  # discard any stale WAL
systemctl start atlas
```

**Rehearse this once before you need it.** A backup you have never restored is
a hypothesis.

### Off-site copies

The backup directory is a plain folder; sync it anywhere:

```bash
0 4 * * * rsync -az /opt/atlas/data/backups/ backup-host:/atlas/
```

---

## Monitoring

**Health** — `GET /healthz` returns `200` when the process is alive; use it for
uptime checks and container health. `GET /api/health` (authenticated) returns
the full assessment: database, memory, CPU, disk, orchestrator, events,
inference, automation, alerts.

The overall status is the worst individual check, so a degraded subsystem is
visible without masking the rest.

**Alerts** appear in the Command Center header. A persistent fault raises one
actionable item rather than a flood — the same open alert is never duplicated.

**Logs** are structured JSON in production:

```bash
journalctl -u atlas -f                                    # systemd
docker compose -f deployment/docker-compose.yml logs -f atlas
```

---

## Routine jobs

All four appear in **Automation** with their schedule and history, and can be
disabled from the console.

| Job | Schedule | What it does |
|---|---|---|
| Nightly backup | 02:15 daily | Consistent copy, prunes old backups |
| Memory consolidation | every 6h | Expires stale entries, promotes proven knowledge, prunes unused |
| Evolution cycle | hourly | Observes performance, proposes improvements |
| Housekeeping | 03:45 daily | Prunes events and samples older than 30 days, clears expired sessions |

Errors and criticals are never pruned from the event log.

---

## Upgrading

**Docker:**

```bash
git pull
docker compose -f deployment/docker-compose.yml up -d --build
```

**systemd:**

```bash
sudo ./deployment/install.sh     # idempotent; preserves .env and data
```

Migrations run automatically at boot, inside a transaction — a failure leaves
the database at the previous version rather than half-migrated. Take a backup
before a major upgrade regardless.

---

## Troubleshooting

### A mission is stuck in `running`

Check the mission's **Steps** tab for a step in `running`. Steps have a hard
timeout (`ATLAS_TASK_TIMEOUT_MS`, default 5 minutes), so a genuinely stuck step
should fail on its own.

If the process was killed mid-mission, restarting ATLAS re-queues it: in-flight
steps return to the ready pool and the mission resumes.

To intervene: **Pause**, then **Start** to resume, or **Cancel**.

### Missions fail immediately

Read the error on the mission. Common causes:

- **`PROVIDER_ERROR`** — the API key is wrong, or the configured model is not
  reachable by your account. Check `/api/health` → `inference`.
- **`No enabled agents`** — every agent has been disabled.
- **The model declined** — rephrase the objective, or assign it differently.

### The console shows "Offline"

The WebSocket cannot reach `/api/realtime`. Almost always a reverse proxy that
is not forwarding upgrades, or an idle timeout shorter than the heartbeat.
Raise `proxy_read_timeout` (nginx) or use the supplied Caddyfile.

### Memory is growing quickly

Run **Consolidate now**, then raise the operational retention floor in
`memory.retention` — entries below it that were never recalled are pruned.
The evolution loop proposes this automatically once operational memory passes
800 entries.

### Disk filling up

In order of likely size: backups, then artifacts, then the database.

```bash
du -sh data/*
```

Lower `ATLAS_BACKUP_RETENTION`, or move older artifacts out of
`data/artifacts/` — nothing in the running system depends on them once a
mission is archived.

### High token spend

- Lower `ATLAS_LLM_EFFORT` (Settings → Intelligence).
- Use a smaller `ATLAS_AGENT_MODEL`; keep Hermes on the stronger one, since
  planning quality determines everything downstream.
- Lower `ATLAS_MAX_CONCURRENT_MISSIONS`.
- Reduce `maxSteps` on agents that consistently use every turn.

Overview shows today's and lifetime spend; each mission shows its own.

### Reverting a bad self-improvement

Evolution → find the applied improvement → **Revert**. The exact previous value
was snapshotted at apply time and is restored.

To stop ATLAS proposing changes at all, set autonomy to `observe`.

---

## Security maintenance

- Rotate `ATLAS_SESSION_SECRET` periodically — this invalidates all sessions.
- Keep `ANTHROPIC_API_KEY` out of version control; `.env` is gitignored.
- Keep port 4700 off the public internet; terminate TLS in front of it.
- `npm audit` on upgrade.
- Review the founder account after any staff change.

## Capacity

A 2 GB VPS comfortably runs ATLAS with 3 concurrent missions. The practical
limits, in the order you will meet them:

1. **Token budget** — almost always the real constraint.
2. **Provider rate limits** — raise concurrency only as far as these allow.
3. **CPU** — only under heavy parallel dispatch.
4. **SQLite** — not a limit at single-founder scale; it will handle years of
   missions before the repository layer would need to move to Postgres.
