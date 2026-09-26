import { useState } from 'react';
import { Link } from 'react-router-dom';
import { cc, sales, type SalesDashboard, type DashboardRange, type SystemLight } from '../lib/api.ts';
import { CcHead, Panel, Stat, Badge, Empty, useLive, moment, pct } from '../components/cc.tsx';
import { systemVerdict, opportunitySummary } from '../lib/dashboard-view.ts';
import { useAtlas } from '../store.ts';
import '../home.css';

/**
 * La page unique du moteur commercial.
 *
 * Sept sections, dans l'ordre où l'on se pose les questions : combien ça
 * rapporte, où ça coince, quel marché marche, que propose ATLAS, qui a
 * répondu, est-ce que ça tourne. Rien n'est calculé ici : la page lit un
 * objet que la ligne de commande lit aussi, et affiche `N/A` là où rien n'a
 * été mesuré — un CAC sans client n'est pas zéro, c'est un tiret.
 *
 * Les gestes sont ceux d'un opérateur, pas d'un CRM : mettre en pause,
 * reprendre, tester ou valider une recommandation, marquer une réponse
 * traitée, consigner un rendez-vous ou un client. Tout le reste est lecture.
 */

const eur = (n: number, currency = 'EUR') =>
  new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
const money = (n: number | null, currency = 'EUR') => (n === null ? '—' : eur(n, currency));

const LIGHT: Record<SystemLight['state'], { glyph: string; tone: 'ok' | 'warn' | 'bad' | 'idle' }> = {
  ok: { glyph: '●', tone: 'ok' },
  warn: { glyph: '●', tone: 'warn' },
  down: { glyph: '●', tone: 'bad' },
  off: { glyph: '○', tone: 'idle' },
};

const INTENT_LABEL: Record<string, string> = {
  POSITIVE: 'Positive', QUESTION: 'Question', INTERESTED_LATER: 'Plus tard', NEUTRAL: 'Neutre',
  NEGATIVE: 'Négative', NOT_RELEVANT: 'Hors sujet', OPT_OUT: 'Opt-out', BOUNCE: 'Rebond', OUT_OF_OFFICE: 'Absence',
};

export function SalesView() {
  const [range, setRange] = useState<DashboardRange>('30d');
  const [segment, setSegment] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const user = useAtlas((s) => s.user);
  const founder = user?.role === 'founder';

  const { data, error, reload } = useLive<SalesDashboard>(
    () => cc.dashboard(range, segment),
    { intervalMs: 20_000, deps: [range, segment] },
  );

  const act = async (key: string, run: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setMessage(null);
    try {
      await run();
      setMessage(done);
      reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const filters = (
    <span className="cc-filters">
      {(['7d', '30d', 'all'] as DashboardRange[]).map((r) => (
        <button
          key={r}
          type="button"
          className={`cc-btn${range === r ? ' cc-btn--primary' : ''}`}
          onClick={() => setRange(r)}
        >
          {r === '7d' ? '7 jours' : r === '30d' ? '30 jours' : 'Tout'}
        </button>
      ))}
      {data && data.segments.length > 0 ? (
        <select className="cc-select" value={segment ?? ''} onChange={(e) => setSegment(e.target.value || null)}>
          <option value="">Tous les segments</option>
          {data.segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      ) : null}
    </span>
  );

  if (error) {
    return (
      <div className="cc">
        <CcHead title="ATLAS — Ventes" onReload={reload} extra={filters} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="ATLAS — Ventes" extra={filters} />
        <div className="cc-body"><Empty>Lecture de l’entonnoir…</Empty></div>
      </div>
    );
  }

  const { cards, funnel, performance: perf, system } = data;
  const contactedTotal = funnel.find((f) => f.stage === 'contacted')?.count ?? 0;
  const verdict = systemVerdict(system);

  return (
    <div className="cc">
      <CcHead title="ATLAS — Ventes" generatedAt={data.generatedAt} onReload={reload} extra={filters} />
      <div className="cc-body">
        {message ? <p className="cc-alert cc-alert--warn">{message}</p> : null}
        {system.outbound.paused ? (
          <p className="cc-alert cc-alert--warn">
            ATLAS est en PAUSE — {system.outbound.pauseReason ?? 'sans motif'}. Aucun message ne part.
          </p>
        ) : null}
        <p className={`cc-alert${verdict.tone === 'ok' ? '' : ' cc-alert--warn'}`} role="status">
          <strong>{verdict.headline}</strong>{verdict.blockers.length > 0 ? ` — ${verdict.blockers.join(' · ')}` : ''}
        </p>

        {/* 1 — Ce que ça rapporte */}
        <dl className="cc-stats">
          <Stat label="RDV cette semaine" value={cards.meetingsThisWeek} />
          <Stat label="Clients signés" value={cards.clientsSigned} hint={data.range === 'all' ? 'depuis toujours' : `sur ${data.range === '7d' ? '7' : '30'} jours`} />
          <Stat label="CA signé" value={cards.revenueSigned} format={(n) => eur(n, cards.currency)} />
          <Stat
            label="Pipeline potentiel"
            value={cards.pipelinePotential}
            format={(n) => eur(n, cards.currency)}
            hint={cards.pipelineExplanation[0]}
          />
        </dl>

        {/* 2 — L'entonnoir */}
        <Panel title="Entonnoir" note={`${contactedTotal} contactés · ${perf.spendUsd === null ? 'dépense IA N/A' : `${perf.spendUsd.toFixed(2)} $ d’IA`}`}>
          <table className="cc-table">
            <thead><tr><th>Étape</th><th className="cc-num">Nombre</th><th className="cc-num">Taux</th></tr></thead>
            <tbody>
              {funnel.map((f) => (
                <tr key={f.stage}>
                  <td>{f.label}</td>
                  <td className="cc-num">{f.count}</td>
                  <td className="cc-num">{f.rate === null ? '—' : pct(f.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* Les opportunités — lecture du registre, aucun geste d'ici */}
        <Panel title={`Opportunités — ${data.opportunitiesTotal} ouvertes`} note="jamais contactées, ni rejetées, ni conclues">
          {data.opportunities.length === 0 ? (
            <Empty>Aucune opportunité ouverte dans le registre.</Empty>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="cc-table">
                <thead><tr><th>Entreprise</th><th>Profil</th><th>Pourquoi</th><th>Contact</th></tr></thead>
                <tbody>
                  {data.opportunities.map((o) => {
                    const s = opportunitySummary(o);
                    return (
                      <tr key={o.prospectId}>
                        <td><Link to={`/cc/companies/${o.domain}`}>{o.companyName}</Link><div className="cc-meta">{o.domain} · {o.state}</div></td>
                        <td><Badge state={s.ready ? 'ok' : 'warn'}>{s.tier}</Badge></td>
                        <td className="cc-excerpt">{o.whyFit ?? '—'}</td>
                        <td className="cc-meta">{s.contact}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* 3 — La performance */}
        <dl className="cc-stats">
          <Stat label="Réponses positives" value={perf.positiveReplyRate} format={pct} hint="par contacté" />
          <Stat label="RDV / contact" value={perf.meetingPerContact} format={pct} />
          <Stat label="Client / contact" value={perf.clientPerContact} format={pct} />
          <Stat label="CAC" value={perf.cac} format={(n) => `${n.toFixed(2)} $`} hint={perf.cac === null ? 'aucun client : —' : 'dépense IA / clients'} />
          <Stat label="CA / 100 contactés" value={perf.revenuePer100} format={(n) => eur(n, cards.currency)} />
        </dl>

        {/* 4 — Les segments */}
        <Panel
          title="Segments"
          note={data.best.segment ? `meilleur : ${data.best.segment.name} (${pct(data.best.segment.positiveRate)})` : 'aucun segment avec 10 contactés'}
        >
          {data.segments.length === 0 ? (
            <Empty>Aucun segment. Créez-en un : <code>npm run sales:campaign -- create --name=…</code></Empty>
          ) : (
            <table className="cc-table">
              <thead>
                <tr>
                  <th>Segment</th><th>Statut</th><th className="cc-num">Contactés</th><th className="cc-num">Réponses +</th>
                  <th className="cc-num">RDV</th><th className="cc-num">Clients</th><th className="cc-num">CA / 100</th><th>Décision</th>
                  {founder ? <th className="atlas-write" /> : null}
                </tr>
              </thead>
              <tbody>
                {data.segments.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}{s.approvedForSend ? '' : <span className="cc-meta"> · envoi non approuvé</span>}</td>
                    <td><Badge state={s.status}>{s.status}</Badge></td>
                    <td className="cc-num">{s.contacted}</td>
                    <td className="cc-num">{s.positiveReplies}</td>
                    <td className="cc-num">{s.meetings}</td>
                    <td className="cc-num">{s.clients}</td>
                    <td className="cc-num">{money(s.revenuePer100, cards.currency)}</td>
                    <td title={s.decisionReason}>{s.decision}</td>
                    {founder ? (
                      <td className="cc-actions atlas-write">
                        {!s.approvedForSend ? (
                          <button type="button" className="cc-btn" disabled={busy !== null}
                            onClick={() => act(`seg-${s.id}`, () => sales.segmentAction(s.id, 'approve'), `${s.name} approuvé pour l’envoi`)}>
                            Approuver l’envoi
                          </button>
                        ) : null}
                        {s.status !== 'PAUSED' && s.status !== 'STOPPED' ? (
                          <button type="button" className="cc-btn" disabled={busy !== null}
                            onClick={() => act(`seg-${s.id}`, () => sales.segmentAction(s.id, 'pause'), `${s.name} en pause`)}>
                            Pause
                          </button>
                        ) : (
                          <button type="button" className="cc-btn" disabled={busy !== null}
                            onClick={() => act(`seg-${s.id}`, () => sales.segmentAction(s.id, 'resume'), `${s.name} repris`)}>
                            Reprendre
                          </button>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.best.messageVariant ? (
            <p className="cc-meta">
              Meilleur message : variante {data.best.messageVariant.key} — {pct(data.best.messageVariant.positiveRate)} sur {data.best.messageVariant.contacted} contactés.
            </p>
          ) : null}
        </Panel>

        {/* 5 — L'auto-optimisation */}
        <Panel title="Auto-optimisation" note={system.openInsights > 0 ? `${system.openInsights} insight(s) d’ingénierie ouverts` : undefined}>
          {data.recommendations.length === 0 ? (
            <Empty>
              Aucune recommandation.{' '}
              {data.insufficient.length > 0
                ? `INSUFFICIENT_DATA : ${data.insufficient.slice(0, 3).map((i) => `${i.subject} ${i.sample}/${i.needed}`).join(' · ')}`
                : 'ATLAS propose dès que l’échantillon le permet.'}
            </Empty>
          ) : (
            <ul className="cc-list">
              {data.recommendations.map((r) => (
                <li key={r.id} className="cc-reco">
                  <div>
                    <strong>{r.title}</strong> <Badge state={r.status}>{r.status}</Badge> <Badge state={r.risk === 'high' ? 'bad' : r.risk === 'medium' ? 'warn' : 'ok'}>risque {r.risk}</Badge>
                    <div className="cc-meta">{r.reason} · échantillon {r.sampleSize}{r.expectedImpact ? ` · ${r.expectedImpact}` : ''}</div>
                  </div>
                  {founder ? (
                    <span className="cc-actions atlas-write">
                      {r.status === 'PROPOSED' && r.hasChange ? (
                        <button type="button" className="cc-btn" disabled={busy !== null}
                          onClick={() => act(r.id, () => sales.decide(r.id, 'test'), 'Test lancé (demi-pas, versionné)')}>TESTER</button>
                      ) : null}
                      <button type="button" className="cc-btn cc-btn--primary" disabled={busy !== null}
                        onClick={() => act(r.id, () => sales.decide(r.id, 'approve'), 'Recommandation validée')}>VALIDER</button>
                      <button type="button" className="cc-btn" disabled={busy !== null}
                        onClick={() => act(r.id, () => sales.decide(r.id, 'reject'), 'Recommandation refusée')}>REFUSER</button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* 6 — Les réponses chaudes */}
        <Panel title={`Réponses chaudes — ${data.hotLeadsTotal} à traiter`} note="aucune réponse automatique : c’est vous qui répondez">
          {data.hotLeads.length === 0 ? (
            <Empty>Aucune réponse chaude. <Link to="/cc/inbox">Voir la boîte</Link>.</Empty>
          ) : (
            <table className="cc-table">
              <thead><tr><th>Entreprise</th><th>Intention</th><th>Reçue</th><th>Extrait</th><th /></tr></thead>
              <tbody>
                {data.hotLeads.map((h) => (
                  <tr key={h.domain} className={h.status === 'HANDLED' ? 'cc-muted' : undefined}>
                    <td><Link to={`/cc/companies/${h.domain}`}>{h.companyName}</Link><div className="cc-meta">{h.domain}</div></td>
                    <td title={`confiance ${Math.round(h.confidence * 100)} %`}><Badge state={h.intent === 'POSITIVE' ? 'ok' : 'warn'}>{INTENT_LABEL[h.intent] ?? h.intent}</Badge></td>
                    <td>{moment(h.receivedAt)}</td>
                    <td className="cc-excerpt">{h.subject ? <strong>{h.subject} — </strong> : null}{h.excerpt ?? ''}</td>
                    <td className="cc-actions atlas-write">
                      {h.status === 'OPEN' ? (
                        <button type="button" className="cc-btn" disabled={busy !== null}
                          onClick={() => act(`lead-${h.domain}`, () => sales.leadHandled(h.domain), `${h.companyName} marqué traité`)}>Traité</button>
                      ) : <span className="cc-meta">traité</span>}
                      {founder ? (
                        <button type="button" className="cc-btn" disabled={busy !== null}
                          onClick={() => act(`rdv-${h.domain}`, () => sales.outcome({ domain: h.domain, kind: 'MEETING_BOOKED' }), `Rendez-vous consigné pour ${h.companyName}`)}>RDV</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.hotLeadsTotal > data.hotLeads.length ? <p className="cc-meta"><Link to="/cc/inbox">Voir tous</Link></p> : null}
        </Panel>

        {/* 7 — Le système */}
        <Panel
          title="Système"
          note={system.lastCycleAt ? `dernier cycle ${moment(system.lastCycleAt)}` : 'aucun cycle planifié encore'}
          actions={founder ? (
            system.outbound.paused ? (
              <button type="button" className="cc-btn cc-btn--primary atlas-write" disabled={busy !== null}
                onClick={() => act('resume', () => sales.resume(), 'ATLAS reprend')}>RESUME</button>
            ) : (
              <button type="button" className="cc-btn atlas-write" disabled={busy !== null}
                onClick={() => act('pause', () => sales.pause('pause depuis le tableau de bord'), 'ATLAS en pause')}>PAUSE ATLAS</button>
            )
          ) : undefined}
        >
          <p className="cc-system-line">
            {(['search', 'llm', 'gmail', 'workers', 'database'] as const).map((key) => {
              const light = system[key];
              const l = LIGHT[light.state];
              return (
                <span key={key} title={light.detail} className={`cc-light cc-light--${l.tone}`}>
                  {key === 'search' ? 'Search' : key === 'llm' ? 'LLM' : key === 'gmail' ? `Gmail ${system.gmail.code}` : key === 'workers' ? 'Workers' : 'Database'} {l.glyph}
                </span>
              );
            })}
            <span className="cc-meta">
              · Outbound {system.outbound.enabled && !system.outbound.paused ? 'ACTIVE' : 'PAUSED'} · {system.outbound.mode} · fenêtre {system.outbound.window} {system.outbound.windowOpen ? '(ouverte)' : '(fermée)'}
            </span>
          </p>
          {system.detail.length > 0 ? <ul className="cc-meta">{system.detail.map((d) => <li key={d}>{d}</li>)}</ul> : null}
        </Panel>
      </div>
    </div>
  );
}
