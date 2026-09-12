import { cc } from '../lib/api.ts';
import type { AiFabric, Costs } from '../lib/api.ts';
import { CcHead, Panel, Stat, Badge, Empty, useLive, moment, usd } from '../components/cc.tsx';

/**
 * Les fournisseurs de modèle, décrits par leur état de connexion.
 *
 * Aucune clé, aucun jeton, aucune valeur d'environnement n'arrive jusqu'ici :
 * le serveur ne les envoie pas. Un fournisseur est joignable ou non, et la
 * façon dont il s'authentifie se dit en un mot — jamais avec le secret.
 *
 * Le solde d'un abonnement n'est exposé par aucune API officielle. On l'écrit
 * donc noir sur blanc plutôt que d'afficher une jauge : une jauge fausse se lit
 * exactement comme une jauge vraie.
 */
export function AiFabricView() {
  const { data, error, reload } = useLive<AiFabric>(() => cc.aiFabric(), { intervalMs: 15_000 });

  if (error) {
    return (
      <div className="cc">
        <CcHead title="AI Fabric" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="AI Fabric" />
        <div className="cc-body"><Empty>Interrogation des fournisseurs…</Empty></div>
      </div>
    );
  }

  return (
    <div className="cc">
      <CcHead
        title="AI Fabric"
        generatedAt={data.generatedAt}
        onReload={reload}
        extra={<Badge state={data.aiLive ? 'DEGRADED' : 'HEALTHY'}>{data.aiLive ? 'mode réel' : 'mode figé'}</Badge>}
      />
      <div className="cc-body">
        <Panel title="Fournisseurs">
          <table className="cc-table">
            <thead>
              <tr>
                <th>Fournisseur</th><th>État</th><th>Authentification</th><th>Modèle</th>
                <th>Tarif</th><th className="cc-num">Appels</th><th className="cc-num">Coût</th>
                <th>Dernier usage</th>
              </tr>
            </thead>
            <tbody>
              {data.providers.map((p) => (
                <tr key={p.id}>
                  <td>{p.label}</td>
                  <td>
                    <Badge state={p.available ? 'HEALTHY' : 'OFFLINE'}>
                      {p.available ? 'disponible' : 'indisponible'}
                    </Badge>
                  </td>
                  <td className="cc-dim">{p.auth}</td>
                  <td className="cc-dim">{p.model}</td>
                  <td>
                    <Badge state={p.priced ? 'HEALTHY' : 'DEGRADED'}>
                      {p.priced ? 'connu' : 'INCONNU'}
                    </Badge>
                  </td>
                  <td className="cc-num">{p.usage.calls}</td>
                  <td className="cc-num">
                    {p.usage.costUsd === null ? <span className="cc-na">N/A</span> : usd(p.usage.costUsd)}
                  </td>
                  <td className="cc-dim">{moment(p.usage.lastUsedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Claude Code">
          <table className="cc-table">
            <tbody>
              <tr>
                <td>Binaire</td>
                <td>
                  <Badge state={data.claudeCode.available ? 'HEALTHY' : 'OFFLINE'}>
                    {data.claudeCode.available ? 'installé' : 'absent'}
                  </Badge>
                </td>
                <td className="cc-dim">{data.claudeCode.detail}</td>
              </tr>
              <tr>
                <td>Authentification</td>
                <td><Badge state={data.claudeCode.auth}>{data.claudeCode.auth}</Badge></td>
                <td className="cc-dim">{data.claudeCode.authDetail}</td>
              </tr>
              <tr>
                <td>Crédits restants</td>
                <td><span className="cc-na">N/A</span></td>
                <td className="cc-dim">{data.claudeCode.remainingCreditsNote}</td>
              </tr>
            </tbody>
          </table>
        </Panel>

        <Panel title="Routage" note={data.routing.multiProviderNote}>
          <p className="cc-dim" style={{ margin: 0, fontSize: '0.78rem' }}>
            Types de worker servis : {data.routing.servedWorkerTypes.join(', ')}
          </p>
          {!data.routing.multiProvider && (
            <p className="cc-faint" style={{ fontSize: '0.74rem', marginTop: '0.5rem' }}>
              Une chaîne multi-modèle suppose deux fournisseurs joignables. Tant qu’un seul
              répond, elle est indisponible — pas simulée.
            </p>
          )}
        </Panel>

        <Panel
          title="Tarifs déclarés"
          note={data.pricing.configuredFile ?? 'aucun fichier déclaré'}
        >
          {data.pricing.rejected.length > 0 && (
            <p className="cc-alert" style={{ marginBottom: '0.6rem' }}>
              {data.pricing.rejected.map((r) => `${r.model} — ${r.reason}`).join(' ; ')}
            </p>
          )}
          {data.pricing.declared.length === 0 ? (
            <Empty>
              Aucun tarif déclaré. Un modèle sans tarif reste bloquant : la chaîne s’arrête
              plutôt que de dépenser en aveugle.
            </Empty>
          ) : (
            <p className="cc-dim" style={{ margin: 0, fontSize: '0.78rem' }}>
              {data.pricing.declared.join(', ')}
            </p>
          )}
        </Panel>
      </div>
    </div>
  );
}

/**
 * La dépense, lue dans les deux registres qui la portent.
 *
 * Un appel dont le tarif est inconnu est compté à part, jamais à zéro. C'est ce
 * comptage qui alimente `COST_UNKNOWN_BLOCKED` : le masquer ici reviendrait à
 * désarmer le garde-fou depuis l'écran.
 */
export function CostsView() {
  const { data, error, reload } = useLive<Costs>(() => cc.costs(), { intervalMs: 15_000 });

  if (error) {
    return (
      <div className="cc">
        <CcHead title="Coûts" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="Coûts" />
        <div className="cc-body"><Empty>Lecture des registres de dépense…</Empty></div>
      </div>
    );
  }

  const w = data.windows;
  const rows: Array<[string, typeof w.today]> = [
    ['Aujourd’hui', w.today],
    ['24 heures', w.last24h],
    ['7 jours', w.last7d],
    ['Ce mois', w.month],
    ['Total historique', w.total],
  ];

  return (
    <div className="cc">
      <CcHead title="Coûts & crédits" generatedAt={data.generatedAt} onReload={reload} />
      <div className="cc-body">
        {data.unknownPriceCalls > 0 && (
          <p className="cc-alert cc-alert--warn">
            {data.unknownPriceCalls} appel(s) au tarif inconnu. Ils ne sont pas comptés comme
            gratuits : toute chaîne sous plafond qui les rencontrerait est arrêtée par
            COST_UNKNOWN_BLOCKED.
          </p>
        )}

        <dl className="cc-stats">
          <Stat label="Coût aujourd’hui" value={w.today.costUsd} format={usd} hint={`${w.today.calls} appel(s)`} />
          <Stat label="24 heures" value={w.last24h.costUsd} format={usd} />
          <Stat label="7 jours" value={w.last7d.costUsd} format={usd} />
          <Stat label="Ce mois" value={w.month.costUsd} format={usd} />
          <Stat label="Total" value={w.total.costUsd} format={usd} hint={`${w.total.calls} appel(s)`} />
          <Stat label="Tarif inconnu" value={data.unknownPriceCalls} hint="jamais comptés à zéro" />
        </dl>

        <Panel title="Par fenêtre">
          <table className="cc-table">
            <thead>
              <tr>
                <th>Fenêtre</th><th className="cc-num">Appels</th>
                <th className="cc-num">Entrée</th><th className="cc-num">Sortie</th>
                <th className="cc-num">Coût</th><th className="cc-num">Inconnus</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, win]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="cc-num">{win.calls}</td>
                  <td className="cc-num cc-dim">{win.inputTokens}</td>
                  <td className="cc-num cc-dim">{win.outputTokens}</td>
                  <td className="cc-num">
                    {win.costUsd === null ? <span className="cc-na">N/A</span> : usd(win.costUsd)}
                  </td>
                  <td className="cc-num cc-dim">{win.unknownCostCalls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Par fournisseur">
          <table className="cc-table">
            <thead><tr><th>Fournisseur</th><th className="cc-num">Appels</th><th className="cc-num">Coût</th><th className="cc-num">Inconnus</th></tr></thead>
            <tbody>
              {data.byProvider.map((p) => (
                <tr key={p.provider}>
                  <td>{p.provider}</td>
                  <td className="cc-num">{p.calls}</td>
                  <td className="cc-num">
                    {p.costUsd === null ? <span className="cc-na">N/A</span> : usd(p.costUsd)}
                  </td>
                  <td className="cc-num cc-dim">{p.unknownCostCalls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Prospection" note={data.salesLoop.purposes.join(', ') || 'aucune intention identifiée'}>
          <table className="cc-table">
            <tbody>
              <tr>
                <td>Appels de la boucle</td>
                <td className="cc-num">{data.salesLoop.calls}</td>
              </tr>
              <tr>
                <td>Coût de la boucle</td>
                <td className="cc-num">
                  {data.salesLoop.costUsd === null
                    ? <span className="cc-na">N/A</span>
                    : usd(data.salesLoop.costUsd)}
                </td>
              </tr>
              <tr>
                <td>Tarif inconnu</td>
                <td className="cc-num cc-dim">{data.salesLoop.unknownCostCalls}</td>
              </tr>
            </tbody>
          </table>
        </Panel>

        {([
          ['Par modèle', data.byModel],
          ['Par agent', data.byAgent],
          ['Par intention', data.byPurpose],
          ['Par mission', data.byMission],
          ['Workers par modèle', data.workerByModel],
          ['Workers par département', data.byDepartment],
        ] as Array<[string, typeof data.byModel]>).map(([title, rows]) => (
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
                  <tr><td colSpan={7}><Empty>Aucun appel consigné.</Empty></td></tr>
                ) : rows.map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td className="cc-num">{r.calls}</td>
                    <td className="cc-num cc-dim">{r.inputTokens}</td>
                    <td className="cc-num cc-dim">{r.outputTokens}</td>
                    <td className="cc-num">
                      {/* Zéro appel n'est pas zéro dollar : c'est une absence de mesure. */}
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

        <Panel title="Plafonds">
          <table className="cc-table">
            <tbody>
              <tr><td>Budget journalier</td><td>{data.budgets.dailyMode}</td></tr>
              <tr><td>Budget mensuel</td><td>{data.budgets.monthlyMode}</td></tr>
              <tr><td>Plafond de chaîne</td><td className="cc-num">{data.budgets.maxChainCostUsd.toFixed(2)} $</td></tr>
              <tr><td>Plafond de mission</td><td className="cc-num">{data.budgets.maxMissionCostUsd.toFixed(2)} $</td></tr>
              <tr><td>Budget de prospection</td><td className="cc-num">{data.budgets.salesBudgetUsd.toFixed(2)} $</td></tr>
              <tr>
                <td>Tarif inconnu</td>
                <td>
                  <Badge state={data.budgets.unknownCostPolicy === 'BLOCK' ? 'HEALTHY' : 'BLOCKED'}>
                    {data.budgets.unknownCostPolicy}
                  </Badge>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="cc-faint" style={{ fontSize: '0.72rem', marginTop: '0.6rem' }}>
            Un budget « UNLIMITED » n’a pas de reste à afficher. Le dire vaut mieux qu’un
            chiffre qui laisserait croire à une limite.
          </p>
        </Panel>
      </div>
    </div>
  );
}
