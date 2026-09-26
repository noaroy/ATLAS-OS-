import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { cc, type RevenueMobile } from '../lib/api.ts';
import {
  applyResult, freshnessOf, headlineStatus, relativeAge, type HeadlineStatus, type LiveState,
} from '../lib/dashboard-view.ts';

/**
 * Le revenu, depuis un téléphone.
 *
 * Complète la page d'accueil sans la répéter : l'accueil sert à décider, cet
 * écran sert à vérifier d'un coup d'œil que la machine tourne — état d'envoi,
 * coupe-circuit, dépense du jour, activité de la boucle revenue.
 *
 * Une seule lecture (`/api/cc/revenue`), toutes les dix secondes, suspendue
 * quand l'onglet est caché : un téléphone en poche n'a pas à interroger ATLAS.
 * Aucune commande n'est émise d'ici ; les décisions restent sur les écrans qui
 * les portent déjà, liés en bas de page. La fraîcheur suit les règles de
 * l'accueil (`dashboard-view.ts`) : une lecture qui échoue garde les derniers
 * chiffres, marqués périmés — les effacer ferait lire « zéro » là où il faut
 * lire « ancien ».
 */

const POLL_MS = 10_000;

const pct = (rate: number | null) =>
  rate === null || !Number.isFinite(rate) ? '' : `${rate * 100 >= 10 ? Math.round(rate * 100) : (rate * 100).toFixed(1)} %`;
/** Les dollars d'IA gardent des centimes de centime ; une absence reste N/A. */
const usd = (v: number | null) =>
  v === null || !Number.isFinite(v) ? 'N/A' : `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;
const since = (iso: string, now: number) =>
  `il y a ${relativeAge(Math.max(0, Math.round((now - Date.parse(iso)) / 1000)))}`;

export function MobileView() {
  const [live, setLive] = useState<LiveState<RevenueMobile>>({ data: null, lastOkAt: null, failures: 0, lastError: null });
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await cc.revenue();
      setLive((prev) => applyResult(prev, { ok: true, data, at: Date.now() }));
    } catch (err) {
      setLive((prev) => applyResult(prev, { ok: false, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void load();
      timer = setInterval(() => void load(), POLL_MS);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const { data, lastOkAt, failures, lastError } = live;
  const fresh = freshnessOf(lastOkAt, now, failures > 0);
  const status = headlineStatus(fresh, failures, data?.header.status ?? null);

  return (
    <div className="m-root">
      <Header data={data} status={status} label={fresh.label} onReload={() => void load()} />
      {lastError && failures > 0 ? <p className="m-error" role="alert">Lecture impossible : {lastError}</p> : null}
      {!data ? (
        <p className="m-empty">{status === 'DOWN' ? 'ATLAS ne répond pas. Nouvel essai toutes les 10 s.' : 'Chargement…'}</p>
      ) : (
        <main className={fresh.state === 'fresh' ? '' : 'm-stale'}>
          <Todo data={data} />
          <Kpis data={data} />
          <Funnel data={data} />
          <HotLeads data={data} />
          <Loop data={data} now={now} />
          <Costs data={data} />
          <Services data={data} />
          <nav className="m-links">
            <Link to="/">Accueil</Link>
            <Link to="/cc/approvals">Approbations</Link>
            <Link to="/cc/outreach">Outreach</Link>
            <Link to="/cc/prospecting">Prospection</Link>
            <Link to="/cc/costs">Coûts</Link>
            <Link to="/cc/system">Système</Link>
          </nav>
        </main>
      )}
    </div>
  );
}

function Header({ data, status, label, onReload }: {
  data: RevenueMobile | null; status: HeadlineStatus; label: string; onReload: () => void;
}) {
  const h = data?.header;
  return (
    <header className="m-head">
      <div className="m-row">
        <span className={`m-pill m-pill--${status.toLowerCase()}`}>{status === 'LOADING' ? '…' : status}</span>
        <button type="button" className="m-time" onClick={onReload} aria-label="Actualiser">{label}</button>
      </div>
      {h ? (
        <div className="m-row m-row--wrap">
          <span className={`m-tag m-tag--${h.outbound === 'ACTIVE' ? 'hot' : h.outbound === 'OFF' ? 'off' : 'test'}`}>
            outbound {h.outbound}
          </span>
          <span className={`m-tag ${h.killSwitch.paused ? 'm-tag--hot' : 'm-tag--off'}`}>
            kill switch {h.killSwitch.paused ? 'ON' : 'off'}
          </span>
          <span className="m-tag">IA auj. {usd(h.aiCostTodayUsd)}{h.aiCostUnknownCalls > 0 ? ` +${h.aiCostUnknownCalls}?` : ''}</span>
          <span className="m-tag">fenêtre {h.sendWindow.window} {h.sendWindow.open ? '●' : '○'}</span>
        </div>
      ) : null}
      {h && h.reasons.length > 0 ? (
        <ul className="m-reasons">{h.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      ) : null}
    </header>
  );
}

function Todo({ data }: { data: RevenueMobile }) {
  const t = data.todo;
  const items: Array<[string, number, string]> = [
    ['Leads chauds', t.hotLeads, '/cc/inbox'],
    ['À approuver', t.approvals, '/cc/approvals'],
    ['Relances dues', t.followUps, '/cc/follow-ups'],
    ['Approuvés non envoyés', t.approvedToSend, '/cc/outreach'],
  ];
  return (
    <section className="m-card">
      <h2>À faire</h2>
      <div className="m-grid m-grid--4">
        {items.map(([label, n, to]) => (
          <Link key={label} to={to} className={`m-stat ${n > 0 ? 'm-stat--act' : ''}`}>
            <b>{n}</b><span>{label}</span>
          </Link>
        ))}
      </div>
      <p className="m-note">Envois aujourd’hui : {t.sentToday} / {t.dailyCap} · cap horaire {t.hourlyCap}</p>
    </section>
  );
}

function Kpis({ data }: { data: RevenueMobile }) {
  const k = data.kpis;
  const money = (v: number | null) => (v === null ? 'N/A' : `${Math.round(v).toLocaleString('fr-FR')} ${k.currency}`);
  const cells: Array<[string, string | number]> = [
    ['Découverts auj.', k.discoveredToday],
    ['Qualifiés auj.', k.qualifiedToday],
    ['PRIORITY auj.', k.highPriorityToday],
    ['Contact-ready auj.', k.contactReadyToday],
    ['Envoyés auj.', k.sentToday],
    ['Réponses auj.', k.repliesToday],
    ['Positives auj.', k.positiveRepliesToday],
    ['RDV', k.meetings],
    ['Propositions', k.proposals ?? 'N/A'],
    ['Clients', k.clientsWon],
    ['CA signé', money(k.revenueSigned)],
    ['Pipeline', money(k.pipelinePotential)],
  ];
  return (
    <section className="m-card">
      <h2>KPIs</h2>
      <div className="m-grid m-grid--3">
        {cells.map(([label, v]) => <div key={label} className="m-stat"><b>{v}</b><span>{label}</span></div>)}
      </div>
    </section>
  );
}

function Funnel({ data }: { data: RevenueMobile }) {
  const max = Math.max(1, ...data.funnel.map((s) => s.count ?? 0));
  return (
    <section className="m-card">
      <h2>Funnel <small>{data.definitions.funnel}</small></h2>
      <ol className="m-funnel">
        {data.funnel.map((s) => (
          <li key={s.key}>
            <span className="m-funnel__label">{s.label}</span>
            <span className="m-funnel__bar"><i style={{ width: `${((s.count ?? 0) / max) * 100}%` }} /></span>
            <b>{s.count ?? 'N/A'}</b>
            <span className="m-funnel__rate">{pct(s.rate)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function HotLeads({ data }: { data: RevenueMobile }) {
  if (data.hotLeads.length === 0) return null;
  return (
    <section className="m-card">
      <h2>Leads chauds</h2>
      <ul className="m-list">
        {data.hotLeads.map((l) => (
          <li key={l.domain}>
            <Link to={`/cc/companies/${encodeURIComponent(l.domain)}`}>
              <b>{l.companyName}</b> <span className="m-tag m-tag--hot">{l.intent}</span>
              <small>{l.receivedAt.slice(0, 16).replace('T', ' ')} · {l.subject ?? '(sans objet)'}</small>
              {l.excerpt ? <em>{l.excerpt}</em> : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Loop({ data, now }: { data: RevenueMobile; now: number }) {
  const { loop } = data;
  const last = loop.lastRevenueActionAt ? Date.parse(loop.lastRevenueActionAt) : null;
  const e = loop.lastExpansion;
  return (
    <section className="m-card">
      <h2>Boucle revenue</h2>
      <p className="m-line">
        Dernière action : {last !== null ? <><b>{loop.lastRevenueAction}</b> {since(loop.lastRevenueActionAt!, now)}</> : <b>aucune consignée</b>}
      </p>
      {e ? (
        <p className="m-line">
          Expansion <b>{e.status}</b> · {e.startedAt.slice(0, 16).replace('T', ' ')} · univers {e.universe ?? 'N/A'} ·
          qualifiés {e.qualified ?? 'N/A'} · PRIORITY {e.highPriority ?? 'N/A'} · {usd(e.costUsd)}
          {e.stopReason ? <small> — {e.stopReason}</small> : null}
        </p>
      ) : <p className="m-line">Aucune expansion consignée.</p>}
    </section>
  );
}

function Costs({ data }: { data: RevenueMobile }) {
  const c = data.costs;
  const rows: Array<[string, string]> = [
    ['OpenAI auj.', usd(c.todayUsd.openai)],
    ['Anthropic auj.', usd(c.todayUsd.anthropic)],
    ['Search auj.', usd(c.todayUsd.search)],
    ['Total auj.', usd(c.todayUsd.total)],
    ['Cap IA / jour', usd(c.caps.aiDailyUsd)],
    ['Cap ventes IA / jour', usd(c.caps.salesAiDailyUsd)],
    ['/ qualifié', usd(c.perQualifiedUsd)],
    ['/ contact-ready', usd(c.perContactReadyUsd)],
    ['/ client', usd(c.perClientUsd)],
  ];
  return (
    <section className="m-card">
      <h2>Coûts</h2>
      <dl className="m-dl">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </section>
  );
}

function Services({ data }: { data: RevenueMobile }) {
  return (
    <section className="m-card">
      <h2>Système</h2>
      <ul className="m-services">
        {data.header.services.map((s) => (
          <li key={s.id}>
            <span className={`m-dot m-dot--${s.state}`} />
            <b>{s.label}</b>
            <small>{s.detail}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
