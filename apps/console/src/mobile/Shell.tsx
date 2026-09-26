import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { RevenueProvider, useNow, useRevenue } from './live.tsx';
import { Icon } from './ui.tsx';
import { headlineLabel, since } from '../lib/mobile-labels.ts';
import { relativeAge } from '../lib/dashboard-view.ts';
import './mobile.css';

/**
 * L'application mobile : une coquille, quatre onglets, une navigation basse
 * toujours accessible. Les écrans sont des routes enfants de `/m`.
 */
export function MobileShell() {
  return (
    <RevenueProvider>
      <ShellFrame />
    </RevenueProvider>
  );
}

function ShellFrame() {
  const revenue = useRevenue();
  const location = useLocation();
  const pull = usePullToReload(() => revenue.reload());

  // Chaque changement d'écran repart du haut : sur téléphone, garder la
  // position d'un autre écran désoriente.
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);

  const todo = revenue.data?.todo;
  const outreachBadge = todo ? todo.approvals + todo.hotLeads : 0;
  const systemAlert = revenue.status === 'DOWN' ? 'bad' : revenue.status === 'DEGRADED' || revenue.status === 'STALE' ? 'warn' : null;

  return (
    <div className="mx" data-status={revenue.status}>
      <div className={`mx-pull${pull.armed ? ' mx-pull--armed' : ''}`} style={{ height: pull.offset }} aria-hidden="true">
        <Icon name="refresh" size={18} className={revenue.loading ? 'mx-spin' : ''} />
      </div>
      <Outlet />
      <nav className="mx-nav" aria-label="Navigation principale">
        <Tab to="/m" end icon="home" label="Accueil" />
        <Tab to="/m/prospects" icon="users" label="Prospects" />
        <Tab to="/m/outreach" icon="send" label="Outreach" badge={outreachBadge > 0 ? String(outreachBadge) : null} />
        <Tab to="/m/system" icon="pulse" label="Système" dot={systemAlert} />
      </nav>
    </div>
  );
}

function Tab({ to, icon, label, end, badge, dot }: { to: string; icon: string; label: string; end?: boolean; badge?: string | null; dot?: 'warn' | 'bad' | null }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `mx-nav__tab${isActive ? ' is-active' : ''}`}>
      <span className="mx-nav__icon">
        <Icon name={icon} size={22} />
        {badge ? <span className="mx-nav__badge">{badge}</span> : dot ? <span className={`mx-nav__dot mx-nav__dot--${dot}`} /> : null}
      </span>
      <span className="mx-nav__label">{label}</span>
    </NavLink>
  );
}

/**
 * La barre du haut. L'état d'ATLAS et la fraîcheur de la dernière lecture y
 * sont toujours visibles ; un appui sur l'horloge relit.
 */
export function TopBar({ title, back, right, brand }: { title?: ReactNode; back?: ReactNode; right?: ReactNode; brand?: boolean }) {
  const revenue = useRevenue();
  const now = useNow();
  const h = headlineLabel(revenue.status);
  // Données vieillies : l'âge exact de la dernière lecture réussie, à la seconde.
  const synced = !revenue.lastOkAt ? 'jamais'
    : revenue.status === 'STALE' || revenue.status === 'DOWN' ? `lu il y a ${relativeAge(revenue.fresh.ageSeconds ?? 0)}`
    : since(new Date(revenue.lastOkAt).toISOString(), now);
  return (
    <header className="mx-top">
      {back}
      {brand ? <span className="mx-brand" aria-label="ATLAS"><span className="mx-brand__mark" />ATLAS</span> : null}
      {title ? <h1 className="mx-top__title">{title}</h1> : null}
      <span className="mx-spacer" />
      {right}
      <button type="button" className={`mx-status mx-status--${h.tone}`} onClick={revenue.reload} aria-label={`${h.text}, synchronisé ${synced}. Actualiser.`}>
        <span className="mx-status__dot" />
        <span className="mx-status__text">{h.text}</span>
        <span className="mx-status__sync">{synced}</span>
      </button>
    </header>
  );
}

/** Tirer vers le bas depuis le haut de la page relit — discret, sans librairie. */
function usePullToReload(onReload: () => void) {
  const start = useRef<number | null>(null);
  const [offset, setOffset] = useState(0);
  const threshold = 64;
  useEffect(() => {
    const down = (e: TouchEvent) => { start.current = window.scrollY <= 0 ? e.touches[0]!.clientY : null; };
    const move = (e: TouchEvent) => {
      if (start.current === null) return;
      const dy = e.touches[0]!.clientY - start.current;
      setOffset(dy > 0 ? Math.min(90, dy * 0.5) : 0);
    };
    const up = () => {
      if (start.current !== null && offset >= threshold * 0.75) onReload();
      start.current = null;
      setOffset(0);
    };
    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', up);
    return () => {
      window.removeEventListener('touchstart', down);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
    };
  }, [offset, onReload]);
  return { offset, armed: offset >= threshold * 0.75 };
}
