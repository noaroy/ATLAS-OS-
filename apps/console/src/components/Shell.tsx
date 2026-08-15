import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAtlas } from '../store.ts';
import { relativeTime } from './ui.tsx';

const NAV = [
  { to: '/', label: 'Vue d’ensemble', glyph: '◈', end: true },
  { to: '/missions', label: 'Missions', glyph: '▶' },
  { to: '/departments', label: 'Départements', glyph: '◫' },
  { to: '/agents', label: 'Agents', glyph: '◇' },
  { to: '/memory', label: 'Mémoire', glyph: '❖' },
  { to: '/automation', label: 'Automatisation', glyph: '⬢' },
  { to: '/evolution', label: 'Évolution', glyph: '◉' },
  { to: '/logs', label: 'Activité', glyph: '≡' },
  { to: '/settings', label: 'Réglages', glyph: '⚙' },
];

/**
 * The Command Center frame (SRS §2.6, mode "professional").
 *
 * Persistent navigation, a live system bar, and an always-visible alert
 * surface — the founder should be able to tell the state of the organisation
 * without opening anything.
 */
export function Shell() {
  const { user, logout, connection, mode, version, alerts, health, refreshHealth, connect, dismissAlert } =
    useAtlas();
  const navigate = useNavigate();
  const [alertsOpen, setAlertesOpen] = useState(false);

  useEffect(() => {
    connect(['event', 'stats']);
  }, [connect]);

  useEffect(() => {
    void refreshHealth();
    const timer = setInterval(() => void refreshHealth(), 30_000);
    return () => clearInterval(timer);
  }, [refreshHealth]);

  const statusTone =
    health?.status === 'critical'
      ? 'text-[--color-alert]'
      : health?.status === 'degraded'
        ? 'text-[--color-ember]'
        : 'text-[--color-vital]';

  return (
    <div className="flex h-full bg-[--color-void]">
      {/* ── Rail ─────────────────────────────────────────────────────────── */}
      <aside className="flex w-[15.5rem] shrink-0 flex-col border-r border-[--color-border] bg-[--color-abyss]">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-sky-600 to-cyan-400 text-[#04121e] shadow-lg">
            <span className="text-lg font-bold">A</span>
          </div>
          <div>
            <div className="font-display text-sm font-semibold tracking-tight">ATLAS OS</div>
            <div className="text-[0.65rem] uppercase tracking-[0.18em] text-[--color-faint]">
              v{version} · {mode}
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-[--color-raised] font-medium text-[--color-ink]'
                    : 'text-[--color-muted] hover:bg-[--color-surface] hover:text-[--color-ink]'
                }`
              }
            >
              <span className="w-4 text-center text-[--color-faint]" aria-hidden>
                {item.glyph}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="p-3">
          <button
            type="button"
            onClick={() => navigate('/village')}
            className="group relative w-full overflow-hidden rounded-xl border border-[--color-border-bright] bg-gradient-to-br from-[#0e1b2e] to-[#101a2c] px-4 py-3.5 text-left transition-all hover:border-sky-500/50 glow-atlas"
          >
            <div className="font-display text-sm font-semibold text-[--color-ink]">Village ATLAS</div>
            <div className="mt-0.5 text-xs text-[--color-muted]">Entrer dans la vue immersive</div>
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-lg text-sky-400 transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </button>
        </div>

        <div className="border-t border-[--color-border] px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-[--color-ink]">{user?.name}</div>
              <div className="truncate text-[0.68rem] text-[--color-faint]">{user?.role}</div>
            </div>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs text-[--color-faint] hover:bg-[--color-surface] hover:text-[--color-ink]"
              onClick={() => void logout()}
            >
              Se déconnecter
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main ─────────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-[--color-border] bg-[--color-abyss]/80 px-6 py-3 backdrop-blur">
          <div className="flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1.5">
              <span
                className={`size-2 rounded-full ${
                  connection === 'live'
                    ? 'bg-emerald-400'
                    : connection === 'connecting'
                      ? 'bg-amber-400 animate-pulse-soft'
                      : 'bg-rose-400'
                }`}
              />
              <span className="text-[--color-muted]">
                {connection === 'live' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Offline'}
              </span>
            </span>

            {health && (
              <>
                <span className="text-[--color-border-bright]">|</span>
                <span className={statusTone}>System {health.status}</span>
                <span className="text-[--color-border-bright]">|</span>
                <span className="text-[--color-faint]">
                  En service {Math.floor(health.uptimeSeconds / 3600)}h{' '}
                  {Math.floor((health.uptimeSeconds % 3600) / 60)}m
                </span>
              </>
            )}

            {mode === 'simulation' && (
              <>
                <span className="text-[--color-border-bright]">|</span>
                <span className="chip border border-amber-500/30 bg-amber-500/10 text-amber-300">
                  Mode simulation
                </span>
              </>
            )}
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setAlertesOpen((open) => !open)}
              className="relative rounded-lg border border-[--color-border] bg-[--color-surface] px-3 py-1.5 text-xs text-[--color-muted] hover:text-[--color-ink]"
              aria-expanded={alertsOpen}
            >
              Alertes
              {alerts.length > 0 && (
                <span className="ml-2 rounded-full bg-rose-500/20 px-1.5 py-0.5 text-[0.65rem] font-semibold text-rose-300">
                  {alerts.length}
                </span>
              )}
            </button>

            {alertsOpen && (
              <div className="absolute right-0 z-30 mt-2 w-96 animate-rise panel p-0">
                <div className="flex items-center justify-between border-b border-[--color-border] px-4 py-2.5">
                  <span className="text-sm font-semibold">Alertes ouvertes</span>
                  <button
                    type="button"
                    className="text-xs text-[--color-faint] hover:text-[--color-ink]"
                    onClick={() => setAlertesOpen(false)}
                  >
                    Fermer
                  </button>
                </div>
                <div className="max-h-96 overflow-y-auto">
                  {alerts.length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-[--color-faint]">
                      Rien ne requiert votre attention.
                    </div>
                  ) : (
                    alerts.map((alert) => (
                      <div key={alert.id} className="border-b border-[--color-border] px-4 py-3 last:border-0">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-[--color-ink]">{alert.title}</div>
                            <div className="mt-0.5 line-clamp-3 text-xs text-[--color-muted]">
                              {alert.detail}
                            </div>
                            <div className="mt-1 text-[0.68rem] text-[--color-faint]">
                              {alert.source} · {relativeTime(alert.createdAt)}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="shrink-0 text-xs text-[--color-faint] hover:text-[--color-ink]"
                            onClick={() => void dismissAlert(alert.id)}
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
