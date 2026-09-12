import { Link } from 'react-router-dom';
import { cc } from '../lib/api.ts';
import type { WarRoom as WarRoomData, Prospecting, AgentsView } from '../lib/api.ts';
import {
  CcHead, Panel, Stat, Badge, Empty, useLive, day, moment, pct, usd,
} from '../components/cc.tsx';

/**
 * La salle de guerre commerciale.
 *
 * Tout part du registre global, jamais d'une machine à états parallèle. La
 * distinction n'est pas théorique : l'entonnoir a longtemps compté les
 * transitions de la boucle pendant que l'audit comptait le registre, et deux
 * entreprises contactées ont disparu de l'écran sans que rien ne le signale.
 *
 * D'où le total affiché sous l'entonnoir, et l'alerte quand il ne retombe pas
 * sur celui du registre. Un tableau dont la somme ne se vérifie pas ne se lit
 * plus, il se devine.
 *
 * L'écran tient au-dessus de la ligne de flottaison : mesures, entonnoir,
 * décisions en attente et état de la boucle sans défiler. Cela vaut d'être dit
 * parce que la version précédente demandait de descendre pour voir le pipeline,
 * et qu'un tableau de bord qu'on fait défiler pour savoir si le système va bien
 * ne le dit pas.
 *
 * Les trois lectures viennent de trois routes existantes. Aucune n'est nouvelle
 * et aucune n'est agrégée ici : l'écran compose, il ne calcule pas.
 */

/** L'accent d'une mesure : porté par un liseret, jamais par un aplat. */
const accentQuota = (restant: number, plafond: number): 'ok' | 'warn' | 'bad' =>
  restant === 0 ? 'bad' : restant <= Math.max(1, Math.floor(plafond * 0.25)) ? 'warn' : 'ok';

/** La teinte d'une barre d'entonnoir, selon ce que l'état signifie. */
function fillOf(state: string): string {
  if (state === 'WON') return 'cc-f-fill cc-f-fill--won';
  if (state === 'LOST' || state === 'NOT_INTERESTED' || state === 'BOUNCED') return 'cc-f-fill cc-f-fill--lost';
  if (state.startsWith('FOLLOW_UP') || state === 'NEEDS_REVIEW' || state === 'NEEDS_INFO') {
    return 'cc-f-fill cc-f-fill--wait';
  }
  return 'cc-f-fill';
}

export function WarRoomView() {
  const { data, error, reload } = useLive<WarRoomData>(() => cc.warRoom());
  const loop = useLive<Prospecting>(() => cc.prospecting(), { intervalMs: 8000 });
  const agents = useLive<AgentsView>(() => cc.agents(), { intervalMs: 8000 });

  if (error) {
    return (
      <div className="cc">
        <CcHead title="Sales War Room" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="Sales War Room" />
        <div className="cc-body"><Empty>Lecture du registre…</Empty></div>
      </div>
    );
  }

  const m = data.metrics;
  const max = Math.max(1, ...data.funnel.map((f) => f.count));
  const workers = agents.data?.workers ?? [];
  const running = workers.filter((w) => w.status === 'RUNNING').length;
  const idle = workers.filter((w) => w.status === 'IDLE').length;
  const blocked = workers.filter((w) => w.status === 'BLOCKED' || w.status === 'UNAVAILABLE').length;
  const needs = agents.data?.needsYou ?? [];

  return (
    <div className="cc">
      <CcHead
        title="Sales War Room"
        generatedAt={data.generatedAt}
        onReload={reload}
        extra={
          <Badge state={data.consistent ? 'HEALTHY' : 'BLOCKED'}>
            {data.ledgerTotal} au registre
          </Badge>
        }
      />
      <div className="cc-body">
        {!data.consistent && (
          <p className="cc-alert">
            Incohérence : l’entonnoir totalise {data.funnelTotal} dossier(s) pour{' '}
            {data.ledgerTotal} au registre. Un dossier manque à l’écran.
          </p>
        )}

        <dl className="cc-stats">
          <Stat label="Contactées" value={m.contacted} glyph="▤" />
          <Stat
            label="Taux de réponse"
            value={m.replyRate}
            format={pct}
            hint={`${m.everReplied} ayant répondu`}
            tone={m.everReplied > 0 ? 'ok' : undefined}
            glyph="↩"
          />
          <Stat label="Réponses positives" value={m.positiveReplies} glyph="✦" />
          <Stat label="Clients payants" value={m.paidClients} glyph="€" />
          <Stat label="Revenu" value={m.revenueEur} format={(n) => `${n.toFixed(2)} €`} glyph="∑" />
          <Stat
            label="Relances dues"
            value={m.followUpsDue}
            tone={m.followUpsDue > 0 ? 'warn' : undefined}
            glyph="↺"
          />
          <Stat label="Messages envoyés" value={m.messagesSent} hint={`${m.sentToday} aujourd’hui`} glyph="↗" />
          <Stat
            label="Quota du jour"
            value={m.dailyRemaining}
            hint={`sur ${m.dailyCap}`}
            tone={accentQuota(m.dailyRemaining, m.dailyCap)}
            glyph="◷"
          />
          <Stat
            label="Coût IA aujourd’hui"
            value={m.aiCostToday}
            format={usd}
            hint={m.aiCostUnknownCalls > 0 ? `${m.aiCostUnknownCalls} au tarif inconnu` : undefined}
            tone={m.aiCostUnknownCalls > 0 ? 'warn' : undefined}
            glyph="$"
          />
          <Stat label="Aperçus gratuits" value={m.freePreviews} hint="livrés à la main" glyph="◇" />
        </dl>

        {/* ── Au-dessus de la ligne de flottaison ─────────────────────────── */}
        <div className="cc-fold">
          <Panel title="Entonnoir" note={`${data.funnelTotal} / ${data.ledgerTotal}`}>
            <div className="cc-funnel">
              {data.funnel.map((row) => (
                <div
                  key={row.state}
                  className={`cc-f-row${row.count === 0 ? ' cc-f-row--empty' : ''}`}
                >
                  <span className="cc-f-label">
                    {row.state}
                    {row.unexpected ? ' · non prévu' : ''}
                  </span>
                  <span className="cc-f-track">
                    <span
                      className={fillOf(row.state)}
                      style={{ width: `${Math.round((row.count / max) * 100)}%` }}
                    />
                  </span>
                  <span className="cc-f-count">{row.count}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title={`Il faut vous — ${needs.length}`}>
            {needs.length === 0 ? (
              <Empty>Rien à décider.</Empty>
            ) : (
              <div className="cc-needs">
                {needs.slice(0, 4).map((item, i) => (
                  <div className="cc-need" key={`${item.kind}-${i}`}>
                    <div className="cc-n-kind">{item.kind}</div>
                    <p className="cc-n-what">{item.what}</p>
                    <div className="cc-n-why">{item.recommendation}</div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title="Boucle"
            note={loop.data ? (loop.data.running ? 'en cours' : 'au repos') : '…'}
          >
            {!loop.data ? (
              <Empty>Lecture du pipeline…</Empty>
            ) : (
              <table className="cc-table">
                <tbody>
                  <tr>
                    <td>État</td>
                    <td>
                      <Badge state={loop.data.running ? 'RUNNING' : 'IDLE'}>
                        {loop.data.running ? 'cycle en cours' : 'au repos'}
                      </Badge>
                    </td>
                  </tr>
                  <tr><td>Cycles</td><td className="cc-num">{loop.data.cycles}</td></tr>
                  <tr>
                    <td>Dernier lot</td>
                    <td className="cc-dim">{loop.data.latestBatch ?? <span className="cc-na">N/A</span>}</td>
                  </tr>
                  <tr>
                    <td>Démarré</td>
                    <td className="cc-dim">{moment(loop.data.latestBatchStartedAt)}</td>
                  </tr>
                  <tr>
                    <td>Brouillons</td>
                    <td className="cc-num">{loop.data.lastCycle?.drafts ?? <span className="cc-na">N/A</span>}</td>
                  </tr>
                  <tr>
                    <td>Coût du lot</td>
                    <td className="cc-num">
                      {loop.data.lastCycle?.costUsd == null
                        ? <span className="cc-na">N/A</span>
                        : usd(loop.data.lastCycle.costUsd)}
                    </td>
                  </tr>
                  <tr>
                    <td>Approbation</td>
                    <td>
                      <Badge state={loop.data.guards.humanApprovalRequired ? 'HEALTHY' : 'BLOCKED'}>
                        {loop.data.guards.humanApprovalRequired ? 'exigée' : 'DÉSACTIVÉE'}
                      </Badge>
                    </td>
                  </tr>
                </tbody>
              </table>
            )}

            {/* Aperçu des agents : le détail complet vit dans /cc/agents. */}
            <div className="cc-agents-mini" style={{ marginTop: '0.5rem' }}>
              <div className="cc-am-row">
                <span className="cc-am-dot cc-am-dot--run" />RUNNING<strong>{running}</strong>
              </div>
              <div className="cc-am-row">
                <span className="cc-am-dot cc-am-dot--idle" />IDLE<strong>{idle}</strong>
              </div>
              <div className="cc-am-row">
                <span className="cc-am-dot cc-am-dot--need" />NEEDS YOU<strong>{needs.length}</strong>
              </div>
              {blocked > 0 && (
                <div className="cc-am-row">
                  <span className="cc-am-dot" style={{ background: 'var(--cc-bad)' }} />BLOQUÉS<strong>{blocked}</strong>
                </div>
              )}
            </div>
          </Panel>
        </div>

        {/* ── Sous la ligne : le détail ───────────────────────────────────── */}
        <div className="cc-two">
          <Panel title="Ont répondu" note={`${data.repliedCompanies.length}`}>
            {data.repliedCompanies.length === 0 ? (
              <Empty>Aucune réponse humaine à ce jour.</Empty>
            ) : (
              <table className="cc-table">
                <tbody>
                  {data.repliedCompanies.map((r) => (
                    <tr key={r.domain}>
                      <td><Link to={`/cc/companies/${r.domain}`}>{r.name}</Link></td>
                      <td className="cc-dim">{day(r.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Relances dues" note={`${data.followUps.length}`}>
            {data.followUps.length === 0 ? (
              <Empty>Aucune échéance atteinte.</Empty>
            ) : (
              <table className="cc-table">
                <tbody>
                  {data.followUps.map((f) => (
                    <tr key={f.domain}>
                      <td><Link to={`/cc/companies/${f.domain}`}>{f.name}</Link></td>
                      <td className="cc-dim">{f.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
