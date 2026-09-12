import { cc } from '../lib/api.ts';
import type { SearchFabricView as SearchData, MultiModelTrace } from '../lib/api.ts';
import { CcHead, Panel, Stat, Badge, Empty, useLive, moment, usd } from '../components/cc.tsx';

/**
 * Les moteurs de recherche, et ce qu'ils ont fait.
 *
 * L'écran sépare deux choses qu'un tableau de bord confond volontiers : l'état
 * — quels moteurs répondent maintenant — et les volumes, qui viennent de la
 * base et survivent au redémarrage. Les compteurs d'un moteur appartiennent au
 * processus qui l'a créé ; affichés sans le dire, un « 0 appel » après un
 * redémarrage se lirait « ce moteur ne sert jamais ».
 */
export function SearchFabricScreen() {
  const { data, error, reload } = useLive<SearchData>(() => cc.searchFabric(), { intervalMs: 10_000 });

  if (error) {
    return (
      <div className="cc">
        <CcHead title="Search Fabric" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="Search Fabric" />
        <div className="cc-body"><Empty>Interrogation des moteurs…</Empty></div>
      </div>
    );
  }

  const l = data.ledger;

  return (
    <div className="cc">
      <CcHead
        title="Search Fabric"
        generatedAt={data.generatedAt}
        onReload={reload}
        extra={
          <Badge state={!data.configured ? 'OFFLINE' : data.blocked ? 'BLOCKED' : 'HEALTHY'}>
            {!data.configured ? 'non configuré' : data.blocked ? 'bloqué' : 'opérationnel'}
          </Badge>
        }
      />
      <div className="cc-body">
        {!data.configured && (
          <p className="cc-alert">
            Aucun moteur n’est configuré (mode « {data.mode} »). Rien n’est en panne : rien
            n’est branché.
          </p>
        )}
        {data.blocked && data.blockedReason && (
          <p className="cc-alert">{data.blockedReason}</p>
        )}

        <Panel
          title="Routage"
          note={data.routingOrder.length > 0 ? data.routingOrder.join(' → ') : 'aucun ordre établi'}
        >
          <table className="cc-table">
            <tbody>
              <tr>
                <td>Moteur principal</td>
                <td>{data.primary ?? <span className="cc-na">N/A</span>}</td>
                <td className="cc-dim">celui qui répondrait maintenant</td>
              </tr>
              <tr>
                <td>Bascule</td>
                <td>
                  {data.fallback ?? <span className="cc-na">aucune</span>}
                </td>
                <td className="cc-dim">
                  {data.fallbackEnabled
                    ? 'la bascule est automatique si le premier échoue'
                    : 'bascule désactivée par configuration'}
                </td>
              </tr>
              <tr>
                <td>Mode</td>
                <td className="cc-dim">{data.mode}</td>
                <td className="cc-dim">—</td>
              </tr>
            </tbody>
          </table>
        </Panel>

        <Panel title="Moteurs">
          <table className="cc-table">
            <thead>
              <tr>
                <th>Moteur</th><th>Santé</th><th>Disponible</th><th>Circuit</th>
                <th className="cc-num">Appels (session)</th><th className="cc-num">Échecs</th>
                <th className="cc-num">Latence</th><th>Dernier succès</th>
              </tr>
            </thead>
            <tbody>
              {data.engines.length === 0 ? (
                <tr><td colSpan={8}><Empty>Aucun moteur enregistré.</Empty></td></tr>
              ) : data.engines.map((e) => (
                <tr key={e.id}>
                  <td>
                    {e.name}
                    {e.inRoutingOrder ? '' : <span className="cc-faint"> · hors routage</span>}
                  </td>
                  <td>
                    <Badge state={e.health === 'HEALTHY' ? 'HEALTHY' : e.health === 'UNHEALTHY' ? 'OFFLINE' : 'UNKNOWN'}>
                      {e.health}
                    </Badge>
                  </td>
                  <td>
                    <Badge state={e.available ? 'HEALTHY' : 'OFFLINE'}>
                      {e.available ? 'oui' : 'non'}
                    </Badge>
                  </td>
                  <td className="cc-dim">{e.circuit ?? '—'}</td>
                  <td className="cc-num">
                    {e.sessionCalls === null ? <span className="cc-na">N/A</span> : e.sessionCalls}
                  </td>
                  <td className="cc-num cc-dim">{e.sessionFailures ?? '—'}</td>
                  <td className="cc-num cc-dim">
                    {e.sessionLatencyMs === null ? 'N/A' : `${Math.round(e.sessionLatencyMs)} ms`}
                  </td>
                  <td className="cc-dim">{moment(e.lastSuccessAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="cc-faint" style={{ fontSize: '0.72rem', marginTop: '0.6rem' }}>
            Ces compteurs sont ceux du processus serveur courant. Un lot lancé en ligne de
            commande a les siens, et un redémarrage les remet à zéro — les volumes durables
            sont ci-dessous.
          </p>
          {data.engines.some((e) => !e.available && e.reason) && (
            <div style={{ marginTop: '0.6rem' }}>
              {data.engines.filter((e) => !e.available && e.reason).map((e) => (
                <p key={e.id} className="cc-faint" style={{ fontSize: '0.74rem', margin: '0.2rem 0' }}>
                  {e.name} — {e.reason}
                </p>
              ))}
            </div>
          )}
        </Panel>

        <dl className="cc-stats">
          <Stat label="Requêtes (total)" value={l.queries} hint={`${l.queriesToday} aujourd’hui`} />
          <Stat label="Requêtes en échec" value={l.queryFailures} />
          <Stat
            label="Latence moyenne"
            value={l.avgQueryMs}
            format={(n) => `${n} ms`}
          />
          <Stat label="Pages visitées" value={l.pagesVisited} hint={`${l.pageFailures} sans réponse`} />
          <Stat label="Latence page" value={l.avgPageMs} format={(n) => `${n} ms`} />
          <Stat label="Entités extraites" value={l.entities} hint="aucun compteur ne les mesure" />
        </dl>

        <Panel title="Par outil" note={`dernière activité ${moment(l.lastActivityAt)}`}>
          <table className="cc-table">
            <thead>
              <tr>
                <th>Outil</th><th>Catégorie</th><th className="cc-num">Appels</th>
                <th className="cc-num">Échecs</th><th className="cc-num">Externes</th>
                <th className="cc-num">Durée moy.</th><th>Dernier</th>
              </tr>
            </thead>
            <tbody>
              {data.byTool.length === 0 ? (
                <tr><td colSpan={7}><Empty>Aucun appel consigné.</Empty></td></tr>
              ) : data.byTool.map((t) => (
                <tr key={`${t.tool}-${t.category ?? ''}`}>
                  <td>{t.tool}</td>
                  <td className="cc-dim">{t.category ?? '—'}</td>
                  <td className="cc-num">{t.calls}</td>
                  <td className="cc-num cc-dim">{t.failures}</td>
                  <td className="cc-num cc-dim">{t.external}</td>
                  <td className="cc-num cc-dim">{t.avgDurationMs} ms</td>
                  <td className="cc-dim">{moment(t.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {data.recentFailures.length > 0 && (
          <Panel title="Derniers échecs">
            <table className="cc-table">
              <tbody>
                {data.recentFailures.map((f, i) => (
                  <tr key={`${f.at}-${i}`}>
                    <td>{f.tool}</td>
                    <td className="cc-dim">{f.error ?? 'motif non consigné'}</td>
                    <td className="cc-dim">{moment(f.at)}</td>
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
 * Les missions où plusieurs modèles sont réellement intervenus.
 *
 * Constaté, jamais mis en scène. Une conversation entre deux modèles se dessine
 * en trois minutes et ne prouve rien ; ce qui figure ici, ce sont des appels
 * facturés, avec leur fournisseur et leur intention. Quand aucune mission n'en
 * compte deux, l'écran le dit — plutôt que d'inventer un second intervenant
 * pour remplir le schéma.
 */
export function MultiModelView() {
  const { data, error, reload } = useLive<MultiModelTrace>(() => cc.multiModel(), { intervalMs: 20_000 });

  if (error) {
    return (
      <div className="cc">
        <CcHead title="Chaîne multi-modèle" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="Chaîne multi-modèle" />
        <div className="cc-body"><Empty>Lecture du registre d’appels…</Empty></div>
      </div>
    );
  }

  return (
    <div className="cc">
      <CcHead title="Chaîne multi-modèle" generatedAt={data.generatedAt} onReload={reload} />
      <div className="cc-body">
        {data.note && <Empty>{data.note}</Empty>}

        {data.missions.map((m) => (
          <Panel
            key={m.missionId}
            title={m.title ?? m.missionId}
            note={`${m.models} modèle(s) · ${m.providers} fournisseur(s) · ${moment(m.startedAt)}`}
          >
            <div className="cc-trace">
              {m.steps.map((s, i) => (
                <div className="cc-trace-row" key={`${s.provider}-${s.model}-${i}`}>
                  <span className="cc-trace-limb">
                    {i === m.steps.length - 1 ? '└─' : '├─'}
                  </span>
                  <span className="cc-trace-provider">{s.provider}</span>
                  <span className="cc-dim">{s.model}</span>
                  <span className="cc-trace-purpose">{s.purpose ?? s.agentKey ?? '—'}</span>
                  <span className="cc-num cc-dim">{s.calls} appel(s)</span>
                  <span className="cc-num">
                    {s.costUsd === null ? <span className="cc-na">N/A</span> : usd(s.costUsd)}
                  </span>
                  {s.failures > 0 && <Badge state="BLOCKED">{s.failures} échec(s)</Badge>}
                  {s.unknownCostCalls > 0 && (
                    <Badge state="DEGRADED">{s.unknownCostCalls} tarif inconnu</Badge>
                  )}
                </div>
              ))}
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}
