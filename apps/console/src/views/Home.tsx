import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { cc, sales, type SalesDashboard, type DashboardRange } from '../lib/api.ts';
import {
  freshnessOf, applyResult, ago, mainResultOf, rankSegments, todoLines, describeRecommendation, systemProblems,
  SEGMENT_STATE_LABEL, type LiveState,
} from '../lib/dashboard-view.ts';
import { useAtlas } from '../store.ts';
import '../home.css';

/**
 * La page d'accueil : trois questions, sept blocs, rien d'autre.
 *
 *   Est-ce qu'ATLAS génère des opportunités ?   → RDV · Clients · CA signé
 *   Où en est la prospection ?                  → l'entonnoir, les segments
 *   Ai-je quelque chose à faire maintenant ?    → À faire, réponses chaudes,
 *                                                  la recommandation du jour
 *
 * Aucun chiffre n'est calculé ici. La page lit `/api/cc/dashboard` — le
 * même objet que `npm run sales:status` — toutes les dix secondes et à
 * chaque événement publié par ATLAS ; une lecture qui échoue garde la
 * dernière valeur connue et le dit. Tout ce qui ne sert pas à décider
 * aujourd'hui vit ailleurs (/cc/system et les écrans détaillés).
 */

const POLL_MS = 10_000;

const eur = (n: number, currency = 'EUR') =>
  new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
const int = (n: number) => new Intl.NumberFormat('fr-FR').format(n);
const pct = (n: number | null) => (n === null ? null : `${Math.round(n * 100)} %`);

const FUNNEL_LABEL: Record<string, string> = {
  discovered: 'découvertes', icpQualified: 'ICP', contactsFound: 'contacts', contacted: 'contactées',
  replied: 'réponses', positiveReplies: 'positives', meetings: 'RDV', clients: 'clients',
};

/**
 * Une lecture vivante : intervalle fixe, relecture à chaque événement du
 * flux, et un état qui survit aux échecs. Une seule requête en vol à la fois.
 */
function useDashboard(range: DashboardRange) {
  const [state, setState] = useState<LiveState<SalesDashboard>>({ data: null, lastOkAt: null, failures: 0, lastError: null });
  const [tick, setTick] = useState(0);
  const inFlight = useRef(false);
  const feedLength = useAtlas((s) => s.feed.length);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await cc.dashboard(range, null);
      setState((prev) => applyResult(prev, { ok: true, data, at: Date.now() }));
    } catch (err) {
      setState((prev) => applyResult(prev, { ok: false, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      inFlight.current = false;
    }
  }, [range]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load, tick, feedLength]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}

export function HomeView() {
  const [range, setRange] = useState<DashboardRange>('30d');
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [moreRecos, setMoreRecos] = useState(false);
  const { user, connection, connect } = useAtlas();
  const founder = user?.role === 'founder';
  const { data, lastOkAt, failures, reload } = useDashboard(range);

  // Le flux d'événements : la page hors du cadre doit l'ouvrir elle-même.
  useEffect(() => { connect(['event']); }, [connect]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const fresh = freshnessOf(lastOkAt, now, failures > 0 || connection === 'offline');
  const online = fresh.state === 'fresh';

  const act = async (key: string, run: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setNotice(null);
    try {
      await run();
      setNotice(done);
      reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const head = (
    <header className="home-head">
      <span className="home-brand">ATLAS</span>
      <nav className="home-nav">
        <Link to="/" aria-current="page">Dashboard</Link>
        <Link to="/cc/prospecting">Prospects</Link>
        <Link to="/cc/inbox">Messages</Link>
        <Link to="/settings">Settings</Link>
      </nav>
      <span className="home-spacer" />
      <span className="home-status">
        <span className={`home-dot ${online ? 'home-dot--ok' : fresh.state === 'dead' ? 'home-dot--bad' : 'home-dot--warn'}`} />
        {online ? 'En ligne' : fresh.state === 'never' ? 'Connexion' : 'Connexion interrompue'}
      </span>
      <span className="home-range" role="group" aria-label="Période">
        {(['7d', '30d', 'all'] as DashboardRange[]).map((r) => (
          <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>
            {r === '7d' ? '7 jours' : r === '30d' ? '30 jours' : 'Tout'}
          </button>
        ))}
      </span>
    </header>
  );

  if (!data) {
    return (
      <div className="home"><div className="home-wrap">{head}
        <p className="home-fresh">{fresh.state === 'never' && failures === 0 ? 'Lecture en cours…' : `Impossible de lire ATLAS — ${fresh.label}`}</p>
      </div></div>
    );
  }

  const { cards, funnel, todo, system } = data;
  const contacted = funnel.find((f) => f.stage === 'contacted')?.count ?? 0;
  const segments = rankSegments(data.segments, 5);
  const todos = todoLines(todo);
  const leads = data.hotLeads.filter((h) => h.status === 'OPEN').slice(0, 5);
  const [primary, ...others] = data.recommendations.filter((r) => r.status === 'PROPOSED');
  const reco = primary ? describeRecommendation(primary) : null;
  const problems = systemProblems(system);
  const light = (state: string) => `home-dot ${state === 'ok' ? 'home-dot--ok' : state === 'warn' ? 'home-dot--warn' : state === 'down' ? 'home-dot--bad' : ''}`;

  return (
    <div className="home">
      <div className="home-wrap">
        {head}
        <p className={`home-fresh${fresh.state === 'stale' ? ' home-fresh--stale' : fresh.state === 'dead' ? ' home-fresh--dead' : ''}`}>
          {fresh.label}{fresh.state !== 'fresh' ? ' — dernières valeurs connues conservées' : ''}
        </p>
        {notice ? <p className="home-notice">{notice}</p> : null}

        {/* 1 — Business */}
        <section className="home-section" aria-label="Business">
          <h2>Business</h2>
          <dl className="home-metrics">
            <div className="home-metric"><dt>RDV</dt><dd>{int(cards.meetings)}</dd></div>
            <div className="home-metric"><dt>Clients</dt><dd>{int(cards.clientsSigned)}</dd></div>
            <div className="home-metric"><dt>CA signé</dt><dd>{eur(cards.revenueSigned, cards.currency)}</dd></div>
          </dl>
          <p className="home-pipeline" title={cards.pipelineExplanation.join(' · ')}>
            Pipeline actif : {cards.pipelinePotential === null ? '— (pas encore de client gagné avec montant)' : eur(cards.pipelinePotential, cards.currency)}
          </p>
        </section>

        {/* 2 — Prospection */}
        <section className="home-section" aria-label="Prospection">
          <h2>Prospection</h2>
          <div className="home-funnel">
            {funnel.map((f, i) => (
              <div key={f.stage} className="home-step">
                {i > 0 ? <span className="home-arrow" aria-hidden>→</span> : null}
                <div className="n">{int(f.count)}</div>
                <div className="l">{FUNNEL_LABEL[f.stage] ?? f.label}</div>
                {f.rate !== null && i > 0 ? <div className="r">{pct(f.rate)}</div> : null}
              </div>
            ))}
          </div>
          {contacted === 0 ? <p className="home-muted" style={{ marginTop: 10 }}>Aucune entreprise contactée sur cette période.</p> : null}
        </section>

        {/* 3 — Segments */}
        <section className="home-section" id="segments" aria-label="Segments">
          <h2>Segments</h2>
          {segments.length === 0 ? (
            <p className="home-empty">Aucun segment défini pour l’instant.</p>
          ) : (
            <ul className="home-list">
              {segments.map((s) => (
                <li key={s.id}>
                  <span className="grow">{s.name}</span>
                  <span className="home-muted">{mainResultOf(s)}</span>
                  <span className={`home-state home-state--${SEGMENT_STATE_LABEL[s.status] ?? s.status}`}>{SEGMENT_STATE_LABEL[s.status] ?? s.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 4 — À faire */}
        <section className="home-section" aria-label="À faire">
          <h2>À faire</h2>
          {todos.length === 0 ? (
            <div className="home-todo home-todo--clear">Tout est à jour.</div>
          ) : (
            <div className="home-todo">
              <ul>
                {todos.map((t) => (
                  <li key={t.key}>
                    {t.href.startsWith('#')
                      ? <a href={t.href}><span className="count">{t.count}</span>{t.label.replace(/^\d+\s/, '')}</a>
                      : <Link to={t.href}><span className="count">{t.count}</span>{t.label.replace(/^\d+\s/, '')}</Link>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* 5 — Hot leads */}
        <section className="home-section" id="hot-leads" aria-label="Réponses chaudes">
          <h2>Hot leads</h2>
          {leads.length === 0 ? (
            <p className="home-empty">Aucune réponse en attente.</p>
          ) : (
            <ul className="home-list">
              {leads.map((h) => (
                <li key={h.domain} className="home-lead">
                  <div className="row">
                    <span className="company">{h.companyName}</span>
                    {h.contact ? <span className="contact">{h.contact}</span> : null}
                  </div>
                  {h.excerpt ? <div className="quote">“{h.excerpt}”</div> : h.subject ? <div className="quote">{h.subject}</div> : null}
                  <div className="meta">
                    <span>{ago(h.receivedAt, now)}</span>
                    <span className="home-spacer" />
                    <Link className="home-btn" to={`/cc/companies/${h.domain}`}>Ouvrir</Link>
                    <button type="button" className="home-btn" disabled={busy !== null}
                      onClick={() => act(`lead-${h.domain}`, () => sales.leadHandled(h.domain), `${h.companyName} : traité`)}>Traité</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data.hotLeadsTotal > leads.length ? <p className="home-muted" style={{ marginTop: 8 }}><Link to="/cc/inbox">Voir toutes les réponses ({data.hotLeadsTotal})</Link></p> : null}
        </section>

        {/* 6 — Amélioration ATLAS */}
        <section className="home-section" id="improvement" aria-label="Amélioration ATLAS">
          <h2>Amélioration ATLAS</h2>
          {!primary || !reco ? (
            <p className="home-empty">
              {data.insufficient.length > 0
                ? `Pas encore assez de données pour proposer quelque chose (${data.insufficient[0]!.subject} : ${data.insufficient[0]!.sample}/${data.insufficient[0]!.needed}).`
                : 'Rien à proposer pour l’instant.'}
            </p>
          ) : (
            <div className="home-reco">
              <div className="eyebrow">{reco.eyebrow}</div>
              <p className="headline">{reco.headline}</p>
              <p className="question">{reco.question}</p>
              {founder ? (
                <div className="actions">
                  <button type="button" className="home-btn home-btn--accent" disabled={busy !== null}
                    onClick={() => act(primary.id, () => sales.decide(primary.id, reco.yesDecision), reco.yesDecision === 'test' ? 'Test lancé : ATLAS ajuste par petits pas et mesure.' : 'Décision consignée.')}>{reco.yes}</button>
                  <button type="button" className="home-btn" disabled={busy !== null}
                    onClick={() => act(primary.id, () => sales.decide(primary.id, 'reject'), 'Mis de côté. ATLAS reviendra si les chiffres le justifient.')}>{reco.no}</button>
                </div>
              ) : <p className="home-muted">Décision réservée au fondateur.</p>}
              {others.length > 0 ? (
                <div className="home-reco-more">
                  <button type="button" className="home-btn home-btn--link" onClick={() => setMoreRecos((v) => !v)}>
                    {moreRecos ? 'Masquer' : `Voir les autres recommandations (${others.length})`}
                  </button>
                  {moreRecos ? (
                    <ul className="home-list">
                      {others.map((r) => { const d = describeRecommendation(r); return <li key={r.id}><span className="grow">{d.headline} <span className="home-muted">{d.question}</span></span></li>; })}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </section>

        {/* 7 — Système */}
        <footer className="home-system" aria-label="Système">
          <span className="light"><span className={light(system.search.state)} /> Recherche</span>
          <span className="light"><span className={light(system.gmail.state)} /> Email</span>
          <span className="light"><span className={light(system.llm.state)} /> IA</span>
          <span className="light"><span className={light(system.workers.state)} /> Workers</span>
          <Link className="details" to="/cc/system">détails →</Link>
        </footer>
        {problems.length > 0 ? (
          <ul className="home-system-problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        ) : null}
      </div>
    </div>
  );
}
