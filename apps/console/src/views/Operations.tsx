import { cc } from '../lib/api.ts';
import type { AgentsView as AgentsData, SystemView, Organization } from '../lib/api.ts';
import {
  CcHead, Panel, Stat, Badge, Empty, useLive, duration, moment,
} from '../components/cc.tsx';

/**
 * Le plateau des opérations.
 *
 * Ce qu'on doit voir en trois secondes : qui travaille, sur quoi, depuis
 * combien de temps, et qui attend une décision. Le reste — identifiants de
 * tâche, baux, codes d'erreur — existe et reste consultable ailleurs, mais
 * l'afficher ici ferait que l'écran cesse d'être lu.
 *
 * « Il faut vous » passe avant les chiffres. Un tableau qui commence par des
 * totaux fait lire les totaux et oublier la décision.
 */
export function AgentsView() {
  const { data, error, reload } = useLive<AgentsData>(() => cc.agents(), { intervalMs: 5000 });

  if (error) {
    return (
      <div className="cc">
        <CcHead title="Agents" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="Agents" />
        <div className="cc-body"><Empty>Lecture du plateau…</Empty></div>
      </div>
    );
  }

  return (
    <div className="cc">
      <CcHead title="Agents" generatedAt={data.generatedAt} onReload={reload} />
      <div className="cc-body">
        <Panel title={`Il faut vous — ${data.needsYou.length}`}>
          {data.needsYou.length === 0 ? (
            <Empty>Rien à décider. ATLAS continue seul.</Empty>
          ) : (
            <div className="cc-needs">
              {data.needsYou.map((item, i) => (
                <div className="cc-need" key={`${item.kind}-${i}`}>
                  <div className="cc-n-kind">{item.kind}</div>
                  <p className="cc-n-what">{item.what}</p>
                  <div className="cc-n-why">{item.why} — {item.recommendation}</div>
                  <code>{item.action}</code>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Postes de travail">
          <table className="cc-table">
            <thead>
              <tr>
                <th>Agent</th><th>État</th><th>En cours</th>
                <th>Durée</th><th>Quota</th><th>Dernier résultat</th>
              </tr>
            </thead>
            <tbody>
              {data.workers.map((w) => (
                <tr key={w.name}>
                  <td>{w.name}</td>
                  <td><Badge state={w.status}>{w.status.toLowerCase()}</Badge></td>
                  <td className="cc-dim">{w.currentTask ?? w.detail ?? '—'}</td>
                  <td className="cc-num cc-dim">{duration(w.runningMs)}</td>
                  <td className="cc-dim">{w.quota === 'UNKNOWN' ? 'N/A' : w.quota}</td>
                  <td className="cc-dim">
                    {w.lastResult ? `${w.lastResult.outcome} · ${moment(w.lastResult.at)}` : 'N/A'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <dl className="cc-stats">
          <Stat label="En cours" value={data.queue.running} />
          <Stat label="En file" value={data.queue.queued} />
          <Stat label="Attendent une personne" value={data.queue.waitingHuman} />
        </dl>

        {data.waiting.length > 0 && (
          <Panel title="Tâches bloquées">
            <table className="cc-table">
              <thead><tr><th>Type</th><th>Département</th><th>Motif</th></tr></thead>
              <tbody>
                {data.waiting.map((t) => (
                  <tr key={t.taskId}>
                    <td>{t.taskType}</td>
                    <td className="cc-dim">{t.department}</td>
                    <td className="cc-dim">{t.reason}</td>
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
 * L'organisation, lue en base.
 *
 * Rien n'est écrit en dur : si un département gagne une équipe ou un agent
 * change de bâtiment, l'écran suit sans qu'on y touche. Une hiérarchie recopiée
 * dans le frontend deviendrait fausse au premier changement, et personne ne
 * s'en apercevrait avant longtemps.
 */
export function OrganizationView() {
  const { data, error, reload } = useLive<Organization>(() => cc.organization(), { intervalMs: 20_000 });

  if (error) {
    return (
      <div className="cc">
        <CcHead title="Organisation" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="Organisation" />
        <div className="cc-body"><Empty>Lecture de la hiérarchie…</Empty></div>
      </div>
    );
  }

  return (
    <div className="cc">
      <CcHead title="Organisation" generatedAt={data.generatedAt} onReload={reload} />
      <div className="cc-body">
        <Panel title="Hermes" note={`${data.hermes.departments} département(s) · ${data.hermes.agents} agent(s)`}>
          <p className="cc-dim" style={{ fontSize: '0.78rem', margin: 0 }}>
            Hermes orchestre : il décide qui fait quoi, jamais ce qui part.
          </p>
        </Panel>

        {data.departments.map((d) => (
          <Panel key={d.key} title={d.name} note={d.tagline}>
            <table className="cc-table">
              <thead><tr><th>Équipe</th><th>Étapes</th><th>Agents</th></tr></thead>
              <tbody>
                {d.teams.map((t) => (
                  <tr key={t.key}>
                    <td>{t.key}</td>
                    <td className="cc-dim">{t.stages.map((s) => s.title).join(' · ')}</td>
                    <td className="cc-dim">
                      {[...new Set(t.stages.map((s) => s.agentKey))].join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {d.agents.length > 0 && (
              <table className="cc-table" style={{ marginTop: '0.8rem' }}>
                <thead><tr><th>Agent</th><th>Rôle</th><th>État</th><th>Modèle</th><th>Dernière activité</th></tr></thead>
                <tbody>
                  {d.agents.map((a) => (
                    <tr key={a.key}>
                      <td>{a.name}</td>
                      <td className="cc-dim">{a.role}</td>
                      <td><Badge state={a.status}>{a.status.toLowerCase()}</Badge></td>
                      <td className="cc-dim">{a.model ?? 'N/A'}</td>
                      <td className="cc-dim">{moment(a.lastActiveAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        ))}

        {data.unassigned.length > 0 && (
          <Panel title="Agents non rattachés" note={`${data.unassigned.length}`}>
            <table className="cc-table">
              <tbody>
                {data.unassigned.map((a) => (
                  <tr key={a.key}>
                    <td>{a.name}</td>
                    <td className="cc-dim">{a.role}</td>
                    <td><Badge state={a.status}>{a.status.toLowerCase()}</Badge></td>
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

/** La barre de santé : données réelles, `UNKNOWN` quand rien ne permet de dire. */
export function SystemHealthView() {
  const { data, error, reload } = useLive<SystemView>(() => cc.system(), { intervalMs: 10_000 });

  if (error) {
    return (
      <div className="cc">
        <CcHead title="Système" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="Système" />
        <div className="cc-body"><Empty>Interrogation des composants…</Empty></div>
      </div>
    );
  }

  return (
    <div className="cc">
      <CcHead
        title="Système"
        generatedAt={data.generatedAt}
        onReload={reload}
        extra={<Badge state={data.overall}>{data.overall}</Badge>}
      />
      <div className="cc-body">
        <Panel title="Composants">
          <div className="cc-health">
            {data.components.map((comp) => (
              <div key={comp.id}>
                <div className="cc-h-label">{comp.label}</div>
                <div className={`cc-h-state cc-badge--${comp.state === 'HEALTHY' ? 'ok' : comp.state === 'OFFLINE' || comp.state === 'BLOCKED' ? 'bad' : 'warn'}`}
                  style={{ background: 'none', border: 'none', padding: 0 }}>
                  {comp.state}
                </div>
                <div className="cc-h-detail" title={comp.detail}>{comp.detail}</div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Mode">
          <table className="cc-table">
            <tbody>
              <tr>
                <td>Dépense de modèle</td>
                <td>
                  <Badge state={data.aiLive ? 'DEGRADED' : 'HEALTHY'}>
                    {data.aiLive ? 'RÉEL — facturé' : 'figé'}
                  </Badge>
                </td>
              </tr>
              <tr>
                <td>Autonomie</td>
                <td>niveau {data.autonomy.level} — {data.autonomy.label}</td>
              </tr>
              <tr>
                <td colSpan={2} className="cc-dim">{data.autonomy.description}</td>
              </tr>
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}
