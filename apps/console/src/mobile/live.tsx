import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { cc, type RevenueMobile } from '../lib/api.ts';
import {
  applyResult, freshnessOf, headlineStatus, type Freshness, type HeadlineStatus, type LiveState,
} from '../lib/dashboard-view.ts';

/**
 * Les lectures vivantes de l'application mobile.
 *
 * Une seule lecture de `/api/cc/revenue`, toutes les dix secondes, partagée
 * par toute l'application : l'accueil, la barre d'état, les pastilles de la
 * navigation et l'écran Système lisent le même objet. Les écrans secondaires
 * lisent leur propre point d'accès, à la même cadence, seulement pendant qu'ils
 * sont affichés. Tout s'arrête quand l'onglet est caché.
 *
 * Une lecture qui échoue garde les derniers chiffres et le dit — les effacer
 * ferait lire « zéro » là où il faut lire « ancien ».
 */

export const POLL_MS = 10_000;

export interface Live<T> extends LiveState<T> {
  reload: () => void;
  loading: boolean;
}

export function useLive<T>(load: () => Promise<T>, deps: unknown[] = [], intervalMs = POLL_MS): Live<T> {
  const [live, setLive] = useState<LiveState<T>>({ data: null, lastOkAt: null, failures: 0, lastError: null });
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const data = await load();
      setLive((prev) => applyResult(prev, { ok: true, data, at: Date.now() }));
    } catch (err) {
      setLive((prev) => applyResult(prev, { ok: false, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, deps);

  useEffect(() => {
    setLive({ data: null, lastOkAt: null, failures: 0, lastError: null });
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void run();
      timer = setInterval(() => void run(), intervalMs);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [run, intervalMs]);

  return { ...live, reload: () => void run(), loading };
}

export interface RevenueLive extends Live<RevenueMobile> {
  fresh: Freshness;
  status: HeadlineStatus;
}

const RevenueContext = createContext<RevenueLive | null>(null);

/** Une horloge à la seconde, pour que « il y a 12 s » avance sans relire l'API. */
export function useNow(stepMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return now;
}

export function RevenueProvider({ children }: { children: ReactNode }) {
  const live = useLive(() => cc.revenue());
  const now = useNow(5000);
  const fresh = freshnessOf(live.lastOkAt, now, live.failures > 0);
  const status = headlineStatus(fresh, live.failures, live.data?.header.status ?? null);
  return <RevenueContext.Provider value={{ ...live, fresh, status }}>{children}</RevenueContext.Provider>;
}

export function useRevenue(): RevenueLive {
  const ctx = useContext(RevenueContext);
  if (!ctx) throw new Error('useRevenue hors de RevenueProvider');
  return ctx;
}
