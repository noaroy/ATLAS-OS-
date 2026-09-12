import { cc } from '../lib/api.ts';
import type { Prospecting as ProspectingData } from '../lib/api.ts';
import { CcHead, Panel, Stat, Badge, Empty, useLive, moment, usd } from '../components/cc.tsx';

/**
 * La boucle de prospection, telle qu'elle tourne.
 *
 * Chaque étape affiche ce que la base en sait, et `N/A` quand rien ne permet de
 * répondre. C'est délibéré : une étape peinte en vert sans mesure derrière est
 * une décoration, et une décoration sur un écran de supervision finit par être
 * lue comme une mesure.
 *
 * L'étape « en cours » n'est marquée que si une tâche tourne réellement. Une
 * animation qui laisserait croire à une activité inexistante serait pire que
 * l'absence d'animation.
 */
export function ProspectingView() {
  const { data, error, reload } = useLive<ProspectingData>(() => cc.prospecting(), { intervalMs: 6000 });

  if (error) {
    return (
      <div className="cc">
        <CcHead title="Prospecting Loop" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="Prospecting Loop" />
        <div className="cc-body"><Empty>Lecture du pipeline…</Empty></div>
      </div>
    );
  }

  const c = data.lastCycle;

  return (
    <div className="cc">
      <CcHead
        title="Prospecting Loop"
        generatedAt={data.generatedAt}
        onReload={reload}
        extra={
          <Badge state={data.running ? 'RUNNING' : 'IDLE'}>
            {data.running ? 'cycle en cours' : 'au repos'}
          </Badge>
        }
      />
      <div className="cc-body">
        <Panel
          title="Pipeline"
          note={`${data.latestBatch ? `dernier lot ${data.latestBatch}` : 'aucun lot'} · registre ${data.registryDomains} domaine(s) connus`}
        >
          <div className="cc-pipeline">
            {data.stages.map((stage) => (
              <div
                key={stage.id}
                className={`cc-stage${data.running && stage.id === 'QUALIFICATION' ? ' cc-stage--active' : ''}`}
              >
                <div className="cc-s-label">{stage.label}</div>
                <div className={`cc-s-count${stage.count === null ? ' cc-na' : ''}`}>
                  {stage.count === null ? 'N/A' : stage.count}
                </div>
                {stage.count === null && (
                  <div className="cc-faint" style={{ fontSize: '0.62rem' }}>non mesuré</div>
                )}
              </div>
            ))}
          </div>
        </Panel>

        <dl className="cc-stats">
          <Stat label="Cycles exécutés" value={data.cycles} />
          <Stat label="Découverts" value={c?.discovered ?? null} />
          <Stat label="Qualifiés" value={c?.qualified ?? null} />
          <Stat label="Contactables" value={c?.contactable ?? null} />
          <Stat label="Brouillons" value={c?.drafts ?? null} />
          <Stat label="Appels de modèle" value={c?.modelCalls ?? null} />
          <Stat
            label="Coût du dernier lot"
            value={c?.costUsd ?? null}
            format={usd}
            hint={c?.inputTokens !== null && c?.inputTokens !== undefined
              ? `${c.inputTokens} entrée · ${c.outputTokens} sortie`
              : undefined}
          />
        </dl>

        <Panel title="Gardes de la boucle">
          <table className="cc-table">
            <tbody>
              <tr>
                <td>Approbation humaine</td>
                <td>
                  <Badge state={data.guards.humanApprovalRequired ? 'HEALTHY' : 'BLOCKED'}>
                    {data.guards.humanApprovalRequired ? 'exigée' : 'DÉSACTIVÉE'}
                  </Badge>
                </td>
                <td className="cc-dim">aucun message ne part sans décision</td>
              </tr>
              <tr>
                <td>Seuil de conversion</td>
                <td className="cc-num">{data.guards.minConversionScore}/100</td>
                <td className="cc-dim">en dessous, aucun brouillon n’est rédigé</td>
              </tr>
              <tr>
                <td>Plafond quotidien</td>
                <td className="cc-num">{data.guards.maxNewOutreachPerDay}</td>
                <td className="cc-dim">nouveaux contacts par jour</td>
              </tr>
              <tr>
                <td>Budget de cycle</td>
                <td className="cc-num">{data.guards.budgetUsd.toFixed(2)} $</td>
                <td className="cc-dim">le cycle s’arrête au plafond</td>
              </tr>
            </tbody>
          </table>
        </Panel>

        {data.latestBatchStartedAt ? (
          <p className="cc-faint" style={{ fontSize: '0.72rem' }}>
            Dernier lot démarré le {moment(data.latestBatchStartedAt)}. Le coût est borné à cette
            fenêtre : les lots ne portent pas leur coût, il est consigné appel par appel.
          </p>
        ) : null}
      </div>
    </div>
  );
}
