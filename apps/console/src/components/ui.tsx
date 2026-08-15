import type { ReactNode } from 'react';
import type { EventSeverity, MissionStatus, TaskStatus, AgentStatus } from '@atlas/contracts';

/** Shared presentational primitives. Colour is meaning, never decoration. */

export function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
  dense = false,
}: {
  title?: ReactNode;
  /** One line saying what the panel is for, when the title alone is terse. */
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-[--color-border] px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight text-[--color-ink]">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-[--color-muted]">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={dense ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'atlas',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'atlas' | 'vital' | 'ember' | 'alert' | 'arcane';
}) {
  const tones: Record<string, string> = {
    atlas: 'text-[--color-atlas]',
    vital: 'text-[--color-vital]',
    ember: 'text-[--color-ember]',
    alert: 'text-[--color-alert]',
    arcane: 'text-[--color-arcane]',
  };
  return (
    <div className="panel px-4 py-3.5">
      <div className="label mb-1">{label}</div>
      <div className={`stat-value ${tones[tone]}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-[--color-faint]">{hint}</div>}
    </div>
  );
}

const SEVERITY_STYLE: Record<EventSeverity, string> = {
  debug: 'bg-slate-500/10 text-slate-400 border-slate-500/25',
  info: 'bg-sky-500/10 text-sky-300 border-sky-500/25',
  success: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25',
  warning: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
  error: 'bg-rose-500/10 text-rose-300 border-rose-500/25',
  critical: 'bg-rose-500/20 text-rose-200 border-rose-400/40',
};

export const SeverityChip = ({ severity }: { severity: EventSeverity }) => (
  <span className={`chip border ${SEVERITY_STYLE[severity]}`}>{severity}</span>
);

const MISSION_STYLE: Record<MissionStatus, string> = {
  created: 'bg-slate-500/10 text-slate-300 border-slate-500/25',
  planned: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/25',
  assigned: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/25',
  running: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  paused: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
  completed: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25',
  validated: 'bg-emerald-500/20 text-emerald-200 border-emerald-400/40',
  failed: 'bg-rose-500/10 text-rose-300 border-rose-500/25',
  archived: 'bg-slate-600/10 text-slate-400 border-slate-600/25',
};

/** Libellés français des statuts, pour que l'écran parle la langue du fondateur. */
export const MISSION_STATUS_FR: Record<MissionStatus, string> = {'created': 'créée', 'planned': 'planifiée', 'assigned': 'affectée', 'running': 'en cours', 'paused': 'en pause', 'completed': 'terminée', 'validated': 'validée', 'failed': 'échouée', 'archived': 'archivée'};
export const TASK_STATUS_FR: Record<TaskStatus, string> = {'pending': 'en attente', 'ready': 'prête', 'running': 'en cours', 'succeeded': 'réussie', 'failed': 'échouée', 'skipped': 'ignorée', 'cancelled': 'annulée'};
export const AGENT_STATUS_FR: Record<AgentStatus, string> = {'available': 'disponible', 'working': 'au travail', 'analyzing': 'en analyse', 'moving': 'en déplacement', 'error': 'en erreur', 'offline': 'hors service'};

export const MissionStatusChip = ({ status }: { status: MissionStatus }) => (
  <span className={`chip border ${MISSION_STYLE[status]}`}>
    {status === 'running' && <span className="size-1.5 rounded-full bg-current animate-pulse-soft" />}
    {MISSION_STATUS_FR[status]}
  </span>
);

const TASK_STYLE: Record<TaskStatus, string> = {
  pending: 'bg-slate-500/10 text-slate-400 border-slate-500/25',
  ready: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/25',
  running: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  succeeded: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25',
  failed: 'bg-rose-500/10 text-rose-300 border-rose-500/25',
  skipped: 'bg-slate-600/10 text-slate-400 border-slate-600/25',
  cancelled: 'bg-slate-600/10 text-slate-400 border-slate-600/25',
};

export const TaskStatusChip = ({ status }: { status: TaskStatus }) => (
  <span className={`chip border ${TASK_STYLE[status]}`}>{TASK_STATUS_FR[status]}</span>
);

const AGENT_STYLE: Record<AgentStatus, string> = {
  available: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25',
  working: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  analyzing: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  moving: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/25',
  error: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  offline: 'bg-slate-600/10 text-slate-400 border-slate-600/25',
};

export const AgentStatusChip = ({ status }: { status: AgentStatus }) => (
  <span className={`chip border ${AGENT_STYLE[status]}`}>
    {(status === 'working' || status === 'analyzing') && (
      <span className="size-1.5 rounded-full bg-current animate-pulse-soft" />
    )}
    {AGENT_STATUS_FR[status]}
  </span>
);

export function ProgressBar({ value, tone = 'atlas' }: { value: number; tone?: 'atlas' | 'vital' | 'alert' }) {
  const colours = {
    atlas: 'from-sky-500 to-cyan-300',
    vital: 'from-emerald-500 to-emerald-300',
    alert: 'from-rose-500 to-rose-300',
  };
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-[--color-deep]"
      role="progressbar"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full bg-gradient-to-r ${colours[tone]} transition-[width] duration-500`}
        style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }}
      />
    </div>
  );
}

export const Empty = ({ icon = '◇', title, hint }: { icon?: string; title: string; hint?: string }) => (
  <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
    <div className="text-2xl text-[--color-faint]">{icon}</div>
    <div className="text-sm font-medium text-[--color-muted]">{title}</div>
    {hint && <div className="max-w-sm text-xs text-[--color-faint]">{hint}</div>}
  </div>
);

export const Spinner = ({ label }: { label?: string }) => (
  <div className="flex items-center justify-center gap-2.5 py-10 text-sm text-[--color-muted]">
    <span className="size-3.5 animate-spin rounded-full border-2 border-[--color-border-bright] border-t-[--color-atlas]" />
    {label ?? 'Loading…'}
  </div>
);

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
      <span aria-hidden>⚠</span>
      <div className="flex-1">{message}</div>
      {onRetry && (
        <button type="button" className="btn !py-1 !px-2.5 !text-xs" onClick={onRetry}>
          Réessayer
        </button>
      )}
    </div>
  );
}

/** Relative time, refreshed by the caller's render cycle. */
export function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const delta = Date.now() - Date.parse(iso);
  if (Number.isNaN(delta)) return '—';
  if (delta < 45_000) return "à l’instant";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `il y a ${days} j`;
  return new Date(iso).toLocaleDateString('fr-FR');
}

/**
 * Une dépense, en dollars, telle qu'on la lit sur une facture.
 *
 * `null` signifie « non chiffrable », et se dit « — » : c'est différent de
 * zéro, qui affirme qu'il n'y a rien eu à payer. Confondre les deux ferait
 * passer une absence de mesure pour une gratuité.
 *
 * Quatre décimales sous le cent, parce qu'un appel isolé coûte souvent moins
 * d'un centime et qu'arrondir à 0,00 $ effacerait précisément ce qu'on cherche
 * à surveiller.
 */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '0,00 $';
  if (value < 0.01) return `${value.toFixed(4).replace('.', ',')} $`;
  return `${value.toFixed(2).replace('.', ',')} $`;
}

export function formatDuration(ms: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const formatNumber = (value: number): string =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}k`
      : String(value);
