import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cc, type ProspectDetail, type RevenueMobile } from '../lib/api.ts';
import {
  applyResult, freshnessOf, headlineStatus, relativeAge, type LiveState,
} from '../lib/dashboard-view.ts';

/**
 * Le revenu, depuis un téléphone.
 *
 * Complète la page d'accueil sans la répéter : l'accueil sert à décider, cet
 * écran à vérifier d'un coup d'œil que la machine tourne — état d'envoi,
 * coupe-circuit, dépense du jour, dernière action revenue — puis à ouvrir la
 * fiche d'un prospect.
 *
 * Une seule lecture (`/api/cc/revenue`), toutes les dix secondes, suspendue
 * quand l'onglet est caché. Aucune commande n'est émise d'ici : les décisions
 * restent sur les écrans qui les portent déjà. La fraîcheur suit les règles de
 * l'accueil (`dashboard-view.ts`) : une lecture qui échoue garde les derniers
 * chiffres, marqués périmés — les effacer ferait lire « zéro » là où il faut
 * lire « ancien ».
 */

const POLL_MS = 10_000;

const pct = (rate: number | null) =>
  rate === null || !Number.isFinite(rate) ? '' : `${rate * 100 >= 10 ? Math.round(rate * 100) : (rate * 100).toFixed(1)} %`;
/** Les dollars d'IA gardent des centimes de centime ; une absence reste N/A. */
const usd = (v: number | null) => (v === null || !Number.isFinite(v) ? 'N/A' : `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`);
const since = (iso: string | null, now: number) =>
  iso ? `il y a ${relativeAge(Math.max(0, Math.round((now - Date.parse(iso)) / 1000)))}` : 'jamais';
const stamp = (iso: string) => iso.slice(0, 16).replace('T', ' ');

const FUNNEL_LABEL: Record<string, string> = {
  DISCOVERED: 'Discovered', QUALIFIED: 'Qualified', CONTACT_READY: 'Contact-ready', SENT: 'Sent',
  REPLY: 'Reply', MEETING: 'Meeting', PROPOSAL: 'Proposal', WON: 'Won',
};

/** Une lecture vivante, suspendue quand l'onglet est caché. Une seule requête en vol. */
function useMobileLive<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [live, setLive] = useState<LiveState<T>>({ data: null, lastOkAt: null, failures: 0, lastError: null });
  const inFlight = useRef(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await load();
      setLive((prev) => applyResult(prev, { ok: true, data, at: Date.now() }));
    } catch (err) {
      setLive((prev) => applyResult(prev, { ok: false, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      inFlight.current = false;
    }
  }, deps);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void run();
      timer = setInterval(() => void run(), POLL_MS);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [run]);

  return { ...live, reload: () => void run() };
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function MobileView() {
  const now = useNow();
  const { data, lastOkAt, failures, lastError, reload } = useMobileLive(() => cc.revenue());
  const fresh = freshnessOf(lastOkAt, now, failures > 0);
  const status = headlineStatus(fresh, failures, data?.header.status ?? null);

  return (
    <div className="m-root">
      <header className="m-head">
        <div className="m-row">
          <span className={`m-pill m-pill--${status.toLowerCase()}`}>{status === 'LOADING' ? '…' : status}</span>
          {data ? <OutboundTag mode={data.header.outbound} /> : null}
          {data?.header.killSwitch.paused ? <span className="m-tag m-tag--hot">kill switch ON</span> : null}
          <button type="button" className="m-time" onClick={reload} aria-label="Actualiser">{fresh.label}</button>
        </div>
        {data ? (
          <div className="m-row m-row--wrap m-sub">
            <span>IA auj. <b>{usd(data.header.aiCostTodayUsd)}</b>{data.header.aiCostUnknownCalls > 0 ? ` +${data.header.aiCostUnknownCalls} non chiffré(s)` : ''}</span>
            <span>Revenue : <b>{data.header.lastRevenueAction ?? 'aucune action'}</b> {data.header.lastRevenueActionAt ? since(data.header.lastRevenueActionAt, now) : ''}</span>
            <span>Synchro Gmail : {since(data.header.lastSyncAt, now)}</span>
          </div>
        ) : null}
        {data && data.header.reasons.length > 0 ? (
          <ul className="m-reasons">{data.header.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        ) : null}
      </header>
      {lastError && failures > 0 ? <p className="m-error" role="alert">Lecture impossible : {lastError}</p> : null}
      {!data ? (
        <p className="m-empty">{status === 'DOWN' ? 'ATLAS ne répond pas. Nouvel essai toutes les 10 s.' : 'Chargement…'}</p>
      ) : (
        <main className={fresh.state === 'fresh' ? '' : 'm-stale'}>
          <Kpis data={data} />
          <Funnel data={data} />
          <Todo data={data} />
          <Priority data={data} />
          <Drafts data={data} now={now} />
          <Expansions data={data} />
          <Costs data={data} />
          <Services data={data} />
          <nav className="m-links">
            <Link to="/">Accueil</Link>
            <Link to="/cc/sales">Sales</Link>
            <Link to="/cc/approvals">Approbations</Link>
            <Link to="/cc/outreach">Outreach</Link>
            <Link to="/cc/prospecting">Prospection</Link>
            <Link to="/cc/costs">Coûts</Link>
          </nav>
        </main>
      )}
    </div>
  );
}

function OutboundTag({ mode }: { mode: RevenueMobile['header']['outbound'] }) {
  const tone = mode === 'ACTIVE' ? 'hot' : mode === 'OFF' ? 'off' : 'test';
  return <span className={`m-tag m-tag--${tone}`}>outbound {mode}</span>;
}

function Kpis({ data }: { data: RevenueMobile }) {
  const k = data.kpis;
  const money = (v: number | null) => (v === null ? 'N/A' : `${Math.round(v).toLocaleString('fr-FR')} ${k.currency}`);
  const cells: Array<[string, string | number]> = [
    ['Discovered auj.', k.discoveredToday], ['Qualified auj.', k.qualifiedToday], ['High priority', k.highPriority],
    ['Contact-ready', k.contactReady], ['Sent auj.', k.sentToday], ['Replies auj.', k.repliesToday],
    ['Positives auj.', k.positiveRepliesToday], ['Meetings', k.meetings], ['Proposals', k.proposals ?? 'N/A'],
    ['Won', k.won], ['CA signé', money(k.revenueSigned)], ['Pipeline', money(k.pipelinePotential)],
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
      <h2>Funnel <small>depuis l’origine</small></h2>
      <ol className="m-funnel">
        {data.funnel.map((s) => (
          <li key={s.key}>
            <span className="m-funnel__label">{FUNNEL_LABEL[s.key] ?? s.key}</span>
            <span className="m-funnel__bar"><i style={{ width: `${((s.count ?? 0) / max) * 100}%` }} /></span>
            <b>{s.count ?? 'N/A'}</b>
            <span className="m-funnel__rate">{pct(s.rate)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Todo({ data }: { data: RevenueMobile }) {
  const t = data.todo;
  const items: Array<[string, number, string]> = [
    ['Leads chauds', t.hotLeads, '/cc/inbox'],
    ['À approuver', t.approvals, '/cc/approvals'],
    ['Relances dues', t.followUps, '/cc/follow-ups'],
    ['Approuvés, non partis', data.drafts.approvedToSend, '/cc/outreach'],
  ];
  return (
    <section className="m-card">
      <h2>Blocages et à faire</h2>
      <div className="m-grid m-grid--4">
        {items.map(([label, n, to]) => (
          <Link key={label} to={to} className={`m-stat ${n > 0 ? 'm-stat--act' : ''}`}><b>{n}</b><span>{label}</span></Link>
        ))}
      </div>
      <p className="m-note">
        Envois auj. {data.caps.sentToday} / {data.caps.dailyNewOutreach} · cap horaire {data.caps.hourly} ·
        fenêtre {data.header.sendWindow.window} {data.header.sendWindow.open ? '(ouverte)' : '(fermée)'}
      </p>
    </section>
  );
}

function Priority({ data }: { data: RevenueMobile }) {
  return (
    <section className="m-card">
      <h2>Prospects prioritaires</h2>
      {data.priorityProspects.length === 0 ? <p className="m-line">Aucune opportunité ouverte.</p> : (
        <ul className="m-list">
          {data.priorityProspects.map((p) => {
            const tier = p.tier ? `${p.tier}${p.score !== null ? ` · ${p.score}` : ''}` : 'non évalué';
            return (
              <li key={p.domain}>
                <Link to={`/m/p/${encodeURIComponent(p.domain)}`}>
                  <span className="m-row"><b>{p.companyName}</b><span className="m-tag">{tier}</span>
                    <span className={`m-dot m-dot--${p.contactReady ? 'ok' : 'warn'}`} title={p.contactReady ? 'contact-ready' : 'contact à trouver'} /></span>
                  <small>{p.domain}</small>
                  {p.whyFit ? <em>{p.whyFit}</em> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Drafts({ data, now }: { data: RevenueMobile; now: number }) {
  const d = data.drafts;
  return (
    <section className="m-card">
      <h2>Drafts en attente d’approbation · {d.awaitingApproval}</h2>
      {d.items.length === 0 ? <p className="m-line">Aucun brouillon en attente.</p> : (
        <ul className="m-list">
          {d.items.map((x) => (
            <li key={x.id}>
              <Link to={`/m/p/${encodeURIComponent(x.domain)}`}>
                <b>{x.companyName}</b>
                <small>{x.recipient} · {since(x.createdAt, now)}</small>
                <em>{x.subject}</em>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Expansions({ data }: { data: RevenueMobile }) {
  return (
    <section className="m-card">
      <h2>Dernières expansions</h2>
      {data.expansions.length === 0 ? <p className="m-line">Aucune expansion consignée.</p> : (
        <ul className="m-list m-list--plain">
          {data.expansions.map((e) => (
            <li key={e.id}>
              <span className="m-row"><b>{e.status}</b><small>{stamp(e.startedAt)} · {e.seeds} graine(s) · {usd(e.costUsd)}</small></span>
              <small>univers {e.universe ?? 'N/A'} · qualifiés {e.qualified ?? 'N/A'} · priorité {e.highPriority ?? 'N/A'}</small>
              {e.stopReason ? <em>{e.stopReason}</em> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Costs({ data }: { data: RevenueMobile }) {
  const c = data.costs;
  const rows: Array<[string, string]> = [
    ['OpenAI auj.', usd(c.todayUsd.openai)], ['Anthropic auj.', usd(c.todayUsd.anthropic)],
    ['Search auj.', usd(c.todayUsd.search)], ['Total auj.', usd(c.todayUsd.total)],
    ['Cap IA / jour', usd(c.caps.aiDailyUsd)], ['Cap ventes IA', usd(c.caps.salesAiDailyUsd)],
    ['/ qualifié', usd(c.perQualifiedUsd)], ['/ contact-ready', usd(c.perContactReadyUsd)], ['/ client', usd(c.perClientUsd)],
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
          <li key={s.id}><span className={`m-dot m-dot--${s.state}`} /><b>{s.label}</b><small>{s.detail}</small></li>
        ))}
      </ul>
    </section>
  );
}

// ─── La fiche prospect ──────────────────────────────────────────────────────

export function MobileProspectView() {
  const { domain = '' } = useParams();
  const now = useNow();
  const { data, lastOkAt, failures, lastError, reload } = useMobileLive(() => cc.prospect(domain), [domain]);
  const fresh = freshnessOf(lastOkAt, now, failures > 0);

  return (
    <div className="m-root">
      <header className="m-head">
        <div className="m-row">
          <Link to="/m" className="m-back">‹ Revenue</Link>
          <b className="m-title">{data?.identity.companyName ?? domain}</b>
          <button type="button" className="m-time" onClick={reload} aria-label="Actualiser">{fresh.label}</button>
        </div>
      </header>
      {lastError && failures > 0 ? <p className="m-error" role="alert">Lecture impossible : {lastError}</p> : null}
      {!data ? <p className="m-empty">{failures > 0 ? 'Fiche indisponible.' : 'Chargement…'}</p> : <Detail d={data} />}
    </div>
  );
}

function Detail({ d }: { d: ProspectDetail }) {
  const q = d.qualification;
  const c = d.contact;
  return (
    <main>
      <section className="m-card">
        <h2>Identité</h2>
        <p className="m-line"><b>{d.identity.companyName}</b> · {d.identity.domain}{d.identity.country ? ` · ${d.identity.country}` : ''}</p>
        <p className="m-line">{q.tier ?? 'non évalué'}{q.score !== null ? ` · score ${q.score}` : ''} · état {q.state}{d.history.currentLoopState ? ` · boucle ${d.history.currentLoopState}` : ''}</p>
        {q.whyFit ? <p className="m-line">Pourquoi : {q.whyFit}</p> : null}
        {d.identity.sourceUrl ? <p className="m-line"><Ext href={d.identity.sourceUrl} /></p> : null}
      </section>

      <section className="m-card">
        <h2>Premier contact {d.firstTouchReady ? '— prêt' : '— bloqué'}</h2>
        {d.blockers.length === 0 ? <p className="m-line">Aucun blocage.</p> : (
          <ul className="m-reasons">{d.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        )}
      </section>

      <section className="m-card">
        <h2>Contact</h2>
        <p className="m-line">
          {[c.name, c.role].filter(Boolean).join(' · ') || 'Personne non nommée'}<br />
          {c.email ?? 'aucune adresse'} {c.email ? <span className={`m-tag ${c.observed ? '' : 'm-tag--hot'}`}>{c.observed ? 'observée' : 'non observée'}</span> : null}
        </p>
        {c.sourceUrl ? <p className="m-line">Provenance : <Ext href={c.sourceUrl} /></p> : null}
      </section>

      <section className="m-card">
        <h2>Recommandations du mail · {d.recommendations.length}</h2>
        {d.recommendations.length === 0 ? <p className="m-line">Moins de 2 relations commerciales VERIFIED / OFFICIAL : aucun échantillon, aucun mail.</p> : (
          <ul className="m-list m-list--plain">
            {d.recommendations.map((r) => (
              <li key={r.domain}><b>{r.company}</b> <small>{r.domain}</small><em>« {r.fitReason} »</em><Ext href={r.sourceUrl} /></li>
            ))}
          </ul>
        )}
      </section>

      <section className="m-card">
        <h2>Preuves · {d.evidence.length}</h2>
        <ul className="m-list m-list--plain">
          {d.evidence.map((e, i) => (
            <li key={`${e.field}-${i}`}><small>{e.field} · {e.nature}</small><em>{e.claim}</em>{e.sourceUrl ? <Ext href={e.sourceUrl} /> : null}</li>
          ))}
        </ul>
      </section>

      <section className="m-card">
        <h2>Brouillons · {d.drafts.length}</h2>
        {d.drafts.length === 0 ? <p className="m-line">Aucun brouillon.</p> : d.drafts.map((x) => (
          <details key={x.id} className="m-draft">
            <summary><span className="m-tag">{x.state}</span> {x.purpose} · {x.subject}</summary>
            <p className="m-line">À : {x.recipient} · {stamp(x.createdAt)} · {x.createdBy}</p>
            <pre>{x.body}</pre>
            {x.sources.length > 0 ? <ul className="m-list m-list--plain">{x.sources.map((s) => <li key={s.sourceUrl + s.quote}><em>{s.quote}</em><Ext href={s.sourceUrl} /></li>)}</ul> : null}
          </details>
        ))}
      </section>

      <section className="m-card">
        <h2>Historique</h2>
        {d.history.loop.length + d.history.ledger.length === 0 ? <p className="m-line">Aucune transition consignée.</p> : (
          <ol className="m-list m-list--plain">
            {[...d.history.loop.map((t) => ({ at: t.at, text: `${t.from ?? '∅'} → ${t.to}${t.reason ? ` — ${t.reason}` : ''}`, by: t.actor })),
              ...d.history.ledger.map((l) => ({ at: l.at, text: `registre ${l.kind}${l.note ? ` — ${l.note}` : ''}`, by: l.by }))]
              .sort((a, b) => a.at.localeCompare(b.at))
              .map((h, i) => <li key={`${h.at}-${i}`}><small>{stamp(h.at)} · {h.by}</small><em>{h.text}</em></li>)}
          </ol>
        )}
      </section>
    </main>
  );
}

/** Un lien vers une source, jamais autre chose qu'une adresse web. */
function Ext({ href }: { href: string }) {
  if (!/^https?:\/\//i.test(href)) return null;
  return <a className="m-ext" href={href} target="_blank" rel="noopener noreferrer">{href.replace(/^https?:\/\//i, '').slice(0, 70)}</a>;
}
