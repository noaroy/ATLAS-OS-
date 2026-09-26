import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { avatarHue, errorLabel, initials, type Tone } from '../lib/mobile-labels.ts';

/**
 * Les briques de l'application mobile. Aucune dépendance : SVG en ligne et
 * classes `mx-*` (mobile.css). Chaque élément tactile fait au moins 44 px.
 */

// ─── Icônes ─────────────────────────────────────────────────────────────────

const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5v-6h-5v6H4a1 1 0 0 1-1-1z',
  users: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 19v-1a4 4 0 0 0-3-3.87M15.5 3.63a3.5 3.5 0 0 1 0 6.74',
  send: 'M21 3 10 14M21 3l-7 18-4-7-7-4z',
  pulse: 'M3 12h4l2.5-6 5 12 2.5-6H21',
  chevron: 'm9 6 6 6-6 6',
  back: 'm15 6-6 6 6 6',
  check: 'M20 6 9 17l-5-5',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0',
  mail: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1m0 1 8 7 8-7',
  mailOff: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1M3 3l18 18',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14m10 3-4.35-4.35',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  reply: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v4',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8',
  inbox: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  pause: 'M9 5v14M15 5v14',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z',
};

export function Icon({ name, size = 20, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

// ─── Pastilles, avatars, états ─────────────────────────────────────────────

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`mx-badge mx-badge--${tone}`}>{children}</span>;
}

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`mx-dot mx-dot--${tone}`} aria-hidden="true" />;
}

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <span className="mx-avatar" style={{ width: size, height: size, ['--mx-avatar-hue' as string]: avatarHue(name) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function Skeleton({ lines = 3, hero = false }: { lines?: number; hero?: boolean }) {
  return (
    <div className="mx-skeleton" aria-busy="true" aria-label="Chargement">
      {hero ? <div className="mx-skel mx-skel--hero" /> : null}
      {Array.from({ length: lines }, (_, i) => <div key={i} className="mx-skel" style={{ width: `${92 - i * 11}%` }} />)}
    </div>
  );
}

export function Empty({ icon = 'check', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="mx-empty">
      <span className="mx-empty__icon"><Icon name={icon} size={24} /></span>
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mx-empty mx-empty--error" role="alert">
      <span className="mx-empty__icon"><Icon name="alert" size={24} /></span>
      <strong>Lecture impossible</strong>
      <p>{errorLabel(message)}</p>
      <button type="button" className="mx-btn" onClick={onRetry}><Icon name="refresh" size={18} /> Réessayer</button>
    </div>
  );
}

// ─── Sections repliables, liens de source ──────────────────────────────────

export function Section({ title, count, open = false, children }: { title: string; count?: number | string; open?: boolean; children: ReactNode }) {
  return (
    <details className="mx-section" open={open}>
      <summary>
        <span>{title}</span>
        {count !== undefined ? <span className="mx-section__count">{count}</span> : null}
        <Icon name="chevron" size={18} className="mx-section__chev" />
      </summary>
      <div className="mx-section__body">{children}</div>
    </details>
  );
}

export function SourceLink({ href }: { href: string }) {
  if (!/^https?:\/\//i.test(href)) return null;
  // L'hôte et le chemin : deux pages du même site restent distinctes à l'œil.
  let label = href;
  try {
    const u = new URL(href);
    label = u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
  } catch { /* garde l'adresse */ }
  return (
    <a className="mx-source" href={href} target="_blank" rel="noopener noreferrer" title={href}>
      <span>{label}</span><Icon name="external" size={12} />
    </a>
  );
}

export function RowLink({ to, children, tone }: { to: string; children: ReactNode; tone?: 'attention' }) {
  return (
    <Link to={to} className={`mx-row${tone ? ` mx-row--${tone}` : ''}`}>
      {children}
      <Icon name="chevron" size={18} className="mx-row__chev" />
    </Link>
  );
}

// ─── Tendance : une série, sept jours, et sa table ─────────────────────────

/**
 * Une sparkline d'une seule série : trait de 2 px, lavis à 10 %, point final
 * cerclé de la couleur du fond. Un appui déplie les valeurs jour par jour —
 * la table, pour qui ne lit pas les courbes.
 */
export function Sparkline({ values, days, label }: { values: readonly number[]; days: readonly string[]; label: string }) {
  const [open, setOpen] = useState(false);
  const max = Math.max(1, ...values);
  const n = values.length;
  const pts = values.map((v, i) => [n === 1 ? 50 : (i / (n - 1)) * 100, 28 - (v / max) * 24] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L100,30 L0,30 Z`;
  const last = pts[pts.length - 1] ?? [100, 28];
  const empty = values.every((v) => v === 0);
  const summary = `${label} sur 7 jours : ${values.join(', ')}`;
  return (
    <div className="mx-spark">
      <button type="button" className="mx-spark__plot" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={summary}>
        <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1="29.5" x2="100" y2="29.5" className="mx-spark__base" vectorEffect="non-scaling-stroke" />
          {empty ? null : <path d={area} className="mx-spark__area" />}
          <path d={line} className="mx-spark__line" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="mx-spark__dot" style={{ left: `${last[0]}%`, top: `${(last[1] / 30) * 100}%` }} />
      </button>
      {open ? (
        <ol className="mx-spark__table">
          {values.map((v, i) => <li key={days[i] ?? i}><span>{(days[i] ?? '').slice(8, 10)}/{(days[i] ?? '').slice(5, 7)}</span><b>{v}</b></li>)}
        </ol>
      ) : null}
    </div>
  );
}

/**
 * Une rangée de pastilles qui défile : la pastille active reste visible,
 * y compris quand l'onglet vient d'un lien (« /m/outreach?tab=replies »).
 * Défilement horizontal seulement — la page, elle, ne bouge pas.
 */
export function useActiveChipInView<T extends HTMLElement>(activeKey: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const row = ref.current;
    const chip = row?.querySelector<HTMLElement>('.is-active');
    if (!row || !chip) return;
    const r = row.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    if (c.left < r.left + 16 || c.right > r.right - 16) row.scrollTo({ left: row.scrollLeft + c.left - r.left - 16, behavior: 'smooth' });
  }, [activeKey]);
  return ref;
}
