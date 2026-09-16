import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAtlas } from '../store.ts';
import { relativeTime } from './ui.tsx';

/**
 * La navigation, dans l'ordre où l'on se pose les questions le matin.
 *
 * Le commercial d'abord — c'est ce qui rapporte —, puis les opérations, puis la
 * machinerie. Les écrans historiques restent accessibles plus bas : les retirer
 * casserait des habitudes pour un gain d'esthétique.
 */
const NAV = [
  // Quatre entrees, pas quinze : le tableau de bord repond aux questions du
  // jour ; les trois autres sont les endroits ou l'on agit. Le detail
  // technique reste accessible par lien (/cc/system) et par URL.
  { to: '/', label: 'Dashboard', glyph: '◈', end: true },
  { to: '/cc/prospecting', label: 'Prospects', glyph: '⟳' },
  { to: '/cc/inbox', label: 'Messages', glyph: '✉' },
  { to: '/settings', label: 'Settings', glyph: '⚙' },
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
  // Sur un écran étroit, le rail se replie derrière un bouton : la page unique
  // doit se lire d'un téléphone, et treize centimètres de menu l'en empêchaient.
  const [navOpen, setNavOpen] = useState(false);

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

  // Le statut arrive en anglais du serveur ; il s'affichait tel quel au milieu
  // d'une interface française. Traduire à l'affichage plutôt qu'à la source :
  // la valeur reste stable pour les journaux et les tests.
  const statusLabel =
    health?.status === 'critical'
      ? 'Système en alerte'
      : health?.status === 'degraded'
        ? 'Système dégradé'
        : 'Système sain';

  return (
    <div className="flex h-full bg-[--color-void]">
      {/* ── Rail ─────────────────────────────────────────────────────────── */}
      {navOpen ? (
        <button type="button" aria-label="Fermer le menu" className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setNavOpen(false)} />
      ) : null}
      <aside className={`${navOpen ? 'flex' : 'hidden'} fixed inset-y-0 left-0 z-40 w-[13.5rem] shrink-0 flex-col border-r border-[--color-border] bg-[--color-abyss] md:static md:flex`}>
        <div className="flex items-center gap-2.5 px-4 py-3">
          <div className="grid size-7 place-items-center rounded border border-[--color-border-bright] bg-[--color-surface] text-[--color-muted]">
            <span className="text-sm font-semibold">A</span>
          </div>
          <div>
            <div className="font-display text-sm font-semibold tracking-tight">ATLAS OS</div>
            <div className="text-[0.6875rem] uppercase tracking-[0.18em] text-[--color-faint]">
              v{version} · {mode}
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-px overflow-y-auto px-2 py-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setNavOpen(false)}
              className={({ isActive }) =>
                // L'etat actif se marque par un liseret et le texte, pas par
                // un aplat : quinze entrees dont une pleine attire l'oeil sur
                // le fond au lieu du libelle.
                `flex items-center gap-2.5 rounded-sm border-l-2 px-2.5 py-1.5 text-[0.8rem] transition-colors ${
                  isActive
                    ? 'border-l-[--color-atlas] bg-[--color-surface]/60 font-medium text-[--color-ink]'
                    : 'border-l-transparent text-[--color-muted] hover:bg-[--color-surface]/40 hover:text-[--color-ink]'
                }`
              }
            >
              <span className="w-3.5 text-center text-[0.7rem] text-[--color-faint]" aria-hidden>
                {item.glyph}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="p-2">
          <button
            type="button"
            onClick={() => navigate('/village')}
            className="group flex w-full items-center gap-2 rounded-sm border border-[--color-border] bg-[--color-surface]/50 px-2.5 py-2 text-left transition-colors hover:border-[--color-border-bright] hover:text-[--color-ink]"
          >
            <span className="text-[0.7rem] text-[--color-faint]" aria-hidden>◈</span>
            <span className="text-[0.8rem] text-[--color-muted] group-hover:text-[--color-ink]">Village ATLAS</span>
            <span className="ml-auto text-[--color-faint] transition-transform group-hover:translate-x-0.5">→</span>
          </button>
        </div>

        <div className="border-t border-[--color-border] px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-[--color-ink]">{user?.name}</div>
              <div className="truncate text-[0.6875rem] text-[--color-faint]">{user?.role}</div>
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
        <header className="flex h-9 items-center justify-between gap-4 border-b border-[--color-border] bg-[--color-abyss] px-4">
          <div className="flex items-center gap-3 text-[0.72rem]">
            <button
              type="button"
              aria-label="Menu"
              className="rounded border border-[--color-border] px-2 py-0.5 text-[--color-muted] md:hidden"
              onClick={() => setNavOpen((open) => !open)}
            >
              ☰
            </button>
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
              {/*
                « Connecté », pas « Live ».

                Ce point vert dit que le flux temps réel est ouvert — rien de
                plus. Mais dans un produit dont toute la distinction tient entre
                simulation et réel, un voyant vert marqué « Live » en haut de
                l'écran se lit comme le mode d'exécution, et le badge « Mode
                simulation » qui le contredit trois centimètres plus loin ne
                lève pas l'ambiguïté : il la rend inquiétante.
              */}
              <span className="text-[--color-muted]">
                {connection === 'live'
                  ? 'Connecté'
                  : connection === 'connecting'
                    ? 'Connexion…'
                    : 'Hors ligne'}
              </span>
            </span>

            {health && (
              <>
                <span className="text-[--color-border-bright]">|</span>
                <span className={statusTone}>{statusLabel}</span>
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
              className="relative rounded-sm border border-[--color-border] bg-[--color-surface]/60 px-2 py-0.5 text-[0.72rem] text-[--color-muted] hover:text-[--color-ink]"
              aria-expanded={alertsOpen}
            >
              Alertes
              {alerts.length > 0 && (
                <span className="ml-2 rounded-full bg-rose-500/20 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-rose-300">
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
                            <div className="mt-1 text-[0.6875rem] text-[--color-faint]">
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

        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
