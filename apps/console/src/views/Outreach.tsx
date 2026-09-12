import { cc } from '../lib/api.ts';
import type { OutreachView as OutreachData, FollowUpsView, AnalyticsView } from '../lib/api.ts';
import { CcHead, Panel, Stat, Badge, Empty, useLive, moment, day, usd, pct } from '../components/cc.tsx';

/**
 * Ce qui est parti, et ce qui attend de partir.
 *
 * Une réservation sans issue consignée n'est pas un envoi : c'est une place
 * prise dont personne ne sait le sort. Quatre d'entre elles ont un jour bloqué
 * autant de relances approuvées, sans qu'aucun message ne parte et sans que
 * rien ne le signale. Elles ont donc leur propre tableau, avec leur âge.
 */
export function OutreachScreen() {
  const { data, error, reload } = useLive<OutreachData>(() => cc.outreach(), { intervalMs: 10_000 });

  if (error) {
    return (
      <div className="cc">
        <CcHead title="Outreach" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="Outreach" />
        <div className="cc-body"><Empty>Lecture du registre d’envois…</Empty></div>
      </div>
    );
  }

  const m = data.metrics;

  return (
    <div className="cc">
      <CcHead title="Outreach" generatedAt={data.generatedAt} onReload={reload} />
      <div className="cc-body">
        <dl className="cc-stats">
          <Stat label="Messages envoyés" value={m.messagesSent} hint="depuis toujours" />
          <Stat label="Aujourd’hui" value={m.sentToday} hint={`plafond ${m.dailyCap}`} />
          <Stat label="Quota restant" value={m.dailyRemaining} />
          <Stat label="En attente d’approbation" value={m.readyForApproval} />
          <Stat label="Approuvés non partis" value={m.approvedNotSent} />
          <Stat label="Places sans issue" value={m.reservedWithoutOutcome} />
        </dl>

        {m.reservedWithoutOutcome > 0 && (
          <p className="cc-alert cc-alert--warn">
            {m.reservedWithoutOutcome} réservation(s) sans issue consignée. Tant qu’elles ne sont
            pas tranchées par une personne, le message correspondant ne peut plus partir — c’est
            voulu : un doute sur un envoi bloque, il ne se résout pas tout seul.
          </p>
        )}

        <Panel title="Par intention">
          <table className="cc-table">
            <tbody>
              {data.byPurpose.length === 0 ? (
                <tr><td><Empty>Aucun envoi consigné.</Empty></td></tr>
              ) : data.byPurpose.map((p) => (
                <tr key={p.purpose}>
                  <td>{p.purpose}</td>
                  <td className="cc-num">{p.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title={`Envois consignés — ${data.sent.length}`}>
          <table className="cc-table">
            <thead>
              <tr>
                <th>Entreprise</th><th>Destinataire</th><th>Objet</th>
                <th>Intention</th><th>Envoyé</th><th>Par</th>
              </tr>
            </thead>
            <tbody>
              {data.sent.length === 0 ? (
                <tr><td colSpan={6}><Empty>Aucun message n’est parti.</Empty></td></tr>
              ) : data.sent.map((s) => (
                <tr key={`${s.domain}-${s.at}-${s.subject}`}>
                  <td>{s.domain}</td>
                  <td className="cc-dim">{s.recipient}</td>
                  <td className="cc-dim">{s.subject.slice(0, 48)}</td>
                  <td><Badge state="HEALTHY">{s.purpose}</Badge></td>
                  <td className="cc-dim">{moment(s.at)}</td>
                  <td className="cc-dim">{s.by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {data.reserved.length > 0 && (
          <Panel title="Places prises sans issue" note="décision humaine requise">
            <table className="cc-table">
              <thead>
                <tr><th>Entreprise</th><th>Destinataire</th><th>Objet</th><th>Prise le</th><th>Par</th><th>Clé</th></tr>
              </thead>
              <tbody>
                {data.reserved.map((r) => (
                  <tr key={r.key}>
                    <td>{r.domain}</td>
                    <td className="cc-dim">{r.recipient}</td>
                    <td className="cc-dim">{r.subject.slice(0, 40)}</td>
                    <td className="cc-dim">{moment(r.claimedAt)}</td>
                    <td className="cc-dim">{r.claimedBy}</td>
                    <td className="cc-faint">{r.key}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}

        {data.abandonments.length > 0 && (
          <Panel title="Abandons consignés" note="append-only, jamais réécrit">
            <table className="cc-table">
              <thead><tr><th>Clé</th><th>Décidé par</th><th>Motif</th><th>Le</th></tr></thead>
              <tbody>
                {data.abandonments.map((a) => (
                  <tr key={a.idempotencyKey}>
                    <td className="cc-faint">{a.idempotencyKey.slice(0, 16)}…</td>
                    <td>{a.actor}</td>
                    <td className="cc-dim">{a.reason.slice(0, 80)}</td>
                    <td className="cc-dim">{moment(a.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </div>
    </div>
  );
}

/**
 * Les relances dues.
 *
 * La décision d'échéance vient de la même fonction que la ligne de commande
 * interroge. Recalculer ici produirait un second avis sur la même question, et
 * deux avis finissent toujours par diverger — c'est précisément ce qui avait
 * fait afficher sept réponses quand il n'y en avait aucune.
 */
export function FollowUpsScreen() {
  const { data, error, reload } = useLive<FollowUpsView>(() => cc.followUps(), { intervalMs: 15_000 });

  if (error) {
    return (
      <div className="cc">
        <CcHead title="Relances" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="Relances" />
        <div className="cc-body"><Empty>Lecture des échéances…</Empty></div>
      </div>
    );
  }

  return (
    <div className="cc">
      <CcHead
        title="Relances"
        generatedAt={data.generatedAt}
        onReload={reload}
        extra={<Badge state={data.metrics.due > 0 ? 'DEGRADED' : 'HEALTHY'}>{data.metrics.due} due(s)</Badge>}
      />
      <div className="cc-body">
        <dl className="cc-stats">
          <Stat label="Relances dues" value={data.metrics.due} />
          <Stat label="En attente" value={data.metrics.waiting} hint={`délai ${data.afterBusinessDays} j ouvrés`} />
          <Stat label="Ont répondu" value={data.metrics.replied} />
          <Stat label="Contactées" value={data.metrics.contacted} />
        </dl>

        <Panel title={`Dues — ${data.due.length}`}>
          <table className="cc-table">
            <thead>
              <tr>
                <th>Entreprise</th><th>Domaine</th><th>État</th><th>Contactée</th>
                <th>Dernier envoi</th><th className="cc-num">Relances</th><th>Motif</th>
              </tr>
            </thead>
            <tbody>
              {data.due.length === 0 ? (
                <tr><td colSpan={7}><Empty>Aucune relance due.</Empty></td></tr>
              ) : data.due.map((d) => (
                <tr key={d.domain}>
                  <td>{d.name}</td>
                  <td className="cc-dim">{d.domain}</td>
                  <td><Badge state={d.state}>{d.state}</Badge></td>
                  <td className="cc-dim">{day(d.contactedOn)}</td>
                  <td className="cc-dim">{moment(d.lastOutboundAt)}</td>
                  <td className="cc-num">{d.followUpsSent}</td>
                  <td className="cc-dim">{d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title={`En attente — ${data.waiting.length}`}>
          <table className="cc-table">
            <thead>
              <tr><th>Entreprise</th><th>État</th><th>Contactée</th><th className="cc-num">Relances</th><th>Motif</th></tr>
            </thead>
            <tbody>
              {data.waiting.length === 0 ? (
                <tr><td colSpan={5}><Empty>Aucun dossier en attente.</Empty></td></tr>
              ) : data.waiting.map((d) => (
                <tr key={d.domain}>
                  <td>{d.name}</td>
                  <td><Badge state={d.state}>{d.state}</Badge></td>
                  <td className="cc-dim">{day(d.contactedOn)}</td>
                  <td className="cc-num">{d.followUpsSent}</td>
                  <td className="cc-dim">{d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}

/** Une barre proportionnelle, sans bibliothèque : la valeur reste lisible en texte. */
function Bar({ value, max }: { value: number; max: number }) {
  const width = max <= 0 ? 0 : Math.max(1, Math.round((value / max) * 100));
  return <span className="cc-bar"><span className="cc-bar-fill" style={{ width: `${width}%` }} /></span>;
}

/**
 * Les tendances.
 *
 * Un jour sans appel n'apparaît pas comme un zéro : il n'apparaît pas. C'est la
 * seule façon honnête de représenter une absence de mesure — un point à zéro se
 * lit « ce jour-là, rien n'a coûté », ce qui n'est pas ce qu'on sait.
 */
export function AnalyticsScreen() {
  const { data, error, reload } = useLive<AnalyticsView>(() => cc.analytics(), { intervalMs: 30_000 });

  if (error) {
    return (
      <div className="cc">
        <CcHead title="Analytics" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="Analytics" />
        <div className="cc-body"><Empty>Agrégation des registres…</Empty></div>
      </div>
    );
  }

  const c = data.conversion;
  const maxCost = Math.max(0, ...data.daily.map((d) => d.costUsd ?? 0));
  const slices: Array<[string, AnalyticsView['costByProvider']]> = [
    ['Par fournisseur', data.costByProvider],
    ['Par modèle', data.costByModel],
    ['Par agent', data.costByAgent],
    ['Par intention', data.costByPurpose],
    ['Workers par modèle', data.workerByModel],
    ['Workers par département', data.workerByDepartment],
  ];

  return (
    <div className="cc">
      <CcHead title="Analytics" generatedAt={data.generatedAt} onReload={reload} />
      <div className="cc-body">
        <dl className="cc-stats">
          <Stat label="Contactées" value={c.contacted} />
          <Stat label="Taux de réponse" value={c.replyRate} format={pct} hint={`${c.replied} réponse(s)`} />
          <Stat label="Réponses positives" value={c.positiveRate} format={pct} hint={`${c.positive}`} />
          <Stat label="Clients payants" value={c.paidClients} />
          <Stat label="Revenu" value={c.revenueEur} format={(n) => `${n.toFixed(2)} €`} />
          <Stat label="Coût par client" value={c.costPerClientUsd} format={usd} hint="exige un client payant" />
        </dl>

        <Panel title={`Dépense et envois — ${data.windowDays} jours`}>
          <table className="cc-table">
            <thead>
              <tr>
                <th>Jour</th><th className="cc-num">Appels</th><th className="cc-num">Coût</th>
                <th style={{ width: '30%' }} /><th className="cc-num">Envois</th><th className="cc-num">Tarif inconnu</th>
              </tr>
            </thead>
            <tbody>
              {data.daily.length === 0 ? (
                <tr><td colSpan={6}><Empty>Aucun appel sur la fenêtre.</Empty></td></tr>
              ) : data.daily.map((d) => (
                <tr key={d.day}>
                  <td>{day(d.day)}</td>
                  <td className="cc-num">{d.calls}</td>
                  <td className="cc-num">
                    {d.costUsd === null ? <span className="cc-na">N/A</span> : usd(d.costUsd)}
                  </td>
                  <td><Bar value={d.costUsd ?? 0} max={maxCost} /></td>
                  <td className="cc-num">{d.sent}</td>
                  <td className="cc-num cc-dim">{d.unknownCostCalls}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="cc-faint" style={{ fontSize: '0.72rem', marginTop: '0.6rem' }}>
            Un jour sans appel n’a pas de ligne. Un zéro se lirait « rien n’a coûté » là où il
            faut lire « rien n’a été mesuré ».
          </p>
        </Panel>

        <Panel title="Entonnoir">
          <table className="cc-table">
            <tbody>
              {data.funnel.filter((f) => f.count > 0).map((f) => (
                <tr key={f.state}>
                  <td>{f.state}{f.unexpected ? <span className="cc-faint"> · état inattendu</span> : ''}</td>
                  <td className="cc-num">{f.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {slices.map(([title, rows]) => (
          <Panel key={title} title={title}>
            <table className="cc-table">
              <thead>
                <tr>
                  <th>Libellé</th><th className="cc-num">Appels</th>
                  <th className="cc-num">Entrée</th><th className="cc-num">Sortie</th>
                  <th className="cc-num">Coût</th><th className="cc-num">Inconnus</th><th>Dernier</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={7}><Empty>Aucune donnée.</Empty></td></tr>
                ) : rows.map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td className="cc-num">{r.calls}</td>
                    <td className="cc-num cc-dim">{r.inputTokens}</td>
                    <td className="cc-num cc-dim">{r.outputTokens}</td>
                    <td className="cc-num">
                      {r.calls === 0 ? <span className="cc-na">N/A</span> : usd(r.knownCostUsd)}
                    </td>
                    <td className="cc-num cc-dim">{r.unknownCostCalls}</td>
                    <td className="cc-dim">{moment(r.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ))}
      </div>
    </div>
  );
}
