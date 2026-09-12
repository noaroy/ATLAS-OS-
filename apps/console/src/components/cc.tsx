import { useEffect, useState, type ReactNode } from 'react';
import { useAtlas } from '../store.ts';

/**
 * Les briques du centre de commande.
 *
 * Une seule règle les gouverne, et elle explique tout le reste : ce qui n'a pas
 * de valeur mesurée s'affiche `N/A`, jamais `0`. Un zéro se lit « rien » là où
 * il faut lire « je ne sais pas », et c'est la seule erreur de tableau de bord
 * qui se propage sans bruit — celle qui a fait annoncer « coût IA : N/A »
 * pendant que sept dollars avaient réellement été dépensés.
 *
 * Le typage y aide : chaque champ nullable l'est aussi dans le contrat, si bien
 * qu'un `?? 0` devient visible à la relecture au lieu de se fondre dans le code.
 */

/** Un nombre, ou N/A. Jamais un zéro de remplacement. */
export function Num({ value, format, hint }: {
  value: number | null | undefined;
  format?: (n: number) => string;
  hint?: string;
}) {
  if (value === null || value === undefined) {
    return <span className="cc-na">N/A</span>;
  }
  return (
    <>
      {format ? format(value) : new Intl.NumberFormat('fr-FR').format(value)}
      {hint ? <span className="cc-hint">{hint}</span> : null}
    </>
  );
}

/**
 * Une mesure : libellé discret, chiffre fort, précision en dessous.
 *
 * `tone` ne peint que le liseret d'un pixel sur le bord gauche. Colorer la
 * carte entière ferait lire la teinte avant le chiffre, et dix cartes teintées
 * côte à côte ne se lisent plus du tout — c'est ce que la version précédente
 * commençait à faire.
 *
 * `glyph` est un repère visuel, jamais une information : la carte reste
 * complète si on le retire.
 */
export function Stat({ label, value, hint, format, tone: accent, glyph }: {
  label: string;
  value: number | null | undefined;
  hint?: string;
  format?: (n: number) => string;
  tone?: 'ok' | 'warn' | 'bad' | 'run';
  glyph?: string;
}) {
  const absent = value === null || value === undefined;
  return (
    <div className={`cc-stat${accent ? ` cc-stat--${accent}` : ''}`}>
      {glyph ? <span className="cc-glyph" aria-hidden>{glyph}</span> : null}
      <dt>{label}</dt>
      <dd className={absent ? 'cc-na' : undefined}>
        {absent ? 'N/A' : format ? format(value) : new Intl.NumberFormat('fr-FR').format(value)}
      </dd>
      {hint ? <span className="cc-hint">{hint}</span> : null}
    </div>
  );
}

export function Panel({ title, note, children, actions }: {
  title: string;
  note?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="cc-panel">
      <header>
        <h2>{title}</h2>
        {note ? <span className="cc-note">{note}</span> : null}
        {actions}
      </header>
      <div className="cc-content">{children}</div>
    </section>
  );
}

/**
 * L'état d'un composant, traduit en une des trois couleurs de sens.
 *
 * `UNKNOWN` prend le ton de l'attention, pas celui du calme : ne pas savoir
 * n'est pas rassurant, et le peindre en gris neutre reviendrait à le confondre
 * avec « tout va bien ».
 */
export function tone(state: string): 'ok' | 'warn' | 'bad' | 'idle' | 'run' {
  switch (state) {
    /*
     * « En cours » n'est pas « tout va bien ».
     *
     * Les deux partageaient le vert, et un agent qui tourne se lisait donc
     * comme un composant sain. Ce sont deux questions differentes : l'une dit
     * l'etat de sante, l'autre dit qu'il se passe quelque chose maintenant.
     * L'acier repond a la seconde, et a elle seule.
     */
    case 'RUNNING':
      return 'run';
    case 'HEALTHY': case 'READY': case 'DONE': case 'ok':
      return 'ok';
    case 'DEGRADED': case 'UNKNOWN': case 'QUEUED': case 'WAITING':
    case 'NEEDS_APPROVAL': case 'MANUAL_ACTION_REQUIRED':
      return 'warn';
    case 'OFFLINE': case 'BLOCKED': case 'FAILED': case 'UNAVAILABLE':
      return 'bad';
    default:
      return 'idle';
  }
}

export function Badge({ children, state }: { children: ReactNode; state?: string }) {
  return <span className={`cc-badge cc-badge--${tone(state ?? '')}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="cc-empty">{children}</p>;
}

/** Une durée lisible. Les millisecondes n'aident personne à décider. */
export const duration = (ms: number | null): string => {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
};

export const day = (iso: string | null | undefined): string =>
  (iso ? iso.slice(0, 10) : '—');

export const moment = (iso: string | null | undefined): string =>
  (iso ? iso.slice(0, 16).replace('T', ' ') : '—');

export const usd = (n: number): string => `${n.toFixed(4)} $`;
export const pct = (n: number): string => `${Math.round(n * 100)} %`;

/**
 * Charge une vue et la garde vivante.
 *
 * Le rafraîchissement suit deux signaux. Un intervalle lent, parce qu'un écran
 * de supervision doit rester juste même quand rien ne bouge. Et le flux
 * d'événements du serveur : dès qu'ATLAS publie quelque chose, la vue se
 * recharge, ce qui évite d'interroger en boucle pour découvrir qu'il ne s'est
 * rien passé.
 *
 * L'erreur est rendue telle quelle plutôt qu'avalée : une page vide sans motif
 * est la pire réponse possible à une panne.
 */
export function useLive<T>(
  load: () => Promise<T>,
  options: { intervalMs?: number; deps?: unknown[] } = {},
): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const feedLength = useAtlas((s) => s.feed.length);
  const interval = options.intervalMs ?? 15_000;

  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const next = await load();
        if (alive) { setData(next); setError(null); }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void run();
    const timer = setInterval(() => void run(), interval);
    return () => { alive = false; clearInterval(timer); };
    // `feedLength` est la dépendance qui rend l'écran vivant : chaque événement
    // publié par ATLAS déclenche une relecture ciblée.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, feedLength, interval, ...(options.deps ?? [])]);

  return { data, error, reload: () => setTick((t) => t + 1) };
}

/** L'en-tête commun : ce qu'on regarde, quand, et si le flux est vivant. */
export function CcHead({ title, generatedAt, onReload, extra }: {
  title: string;
  generatedAt?: string | null;
  onReload?: () => void;
  extra?: ReactNode;
}) {
  const connection = useAtlas((s) => s.connection);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <header className="cc-head">
      <h1>{title}</h1>
      {extra}
      <span className="cc-spacer" />
      {generatedAt ? <span className="cc-meta">lu à {moment(generatedAt)}</span> : null}
      <time>{now.toLocaleTimeString('fr-FR')}</time>
      <span className="cc-live">
        <span className={`cc-dot cc-dot--${connection}`} />
        {connection === 'live' ? 'en direct' : connection === 'connecting' ? 'connexion' : 'hors ligne'}
      </span>
      {onReload ? (
        <button type="button" className="cc-btn" onClick={onReload}>Actualiser</button>
      ) : null}
    </header>
  );
}
