import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { Panel, Spinner, StatCard, Empty, formatNumber } from '../components/ui.tsx';
import type { AtlasOverview } from '../lib/api.ts';

/**
 * L'écran qu'on ouvre le matin.
 *
 * Une contrainte le gouverne : comprendre la situation en moins de trente
 * secondes, traiter ce qui attend, refermer. Ce qui n'aide pas à décider n'y
 * figure pas — les identifiants de tâche, les baux, les numéros de migration
 * existent et restent consultables sous « Avancé », mais les afficher ici ferait
 * que l'écran cesse d'être lu.
 *
 * Deux règles tiennent le reste. Ce qui attend une personne passe en premier,
 * avant les chiffres : un tableau de bord qui commence par des totaux fait lire
 * les totaux et oublier la décision. Et rien n'est estimé — une valeur absente
 * s'affiche N/A, jamais zéro, parce qu'un zéro se lit « rien » là où il faut
 * lire « je ne sais pas ».
 */

const KIND_LABELS: Record<string, string> = {
  CLIENT_REPLY: 'Réponse client',
  OUTREACH: 'Messages à approuver',
  ENGINEERING: 'Changement de code',
  FOLLOW_UP: 'Relance',
  SYSTEM: 'Système',
};

const STATUS_TONE: Record<string, string> = {
  ONLINE: 'atlas-status--online',
  DEGRADED: 'atlas-status--degraded',
  ACTION_REQUIRED: 'atlas-status--action',
};

/**
 * Les états d'agent, en français lisible.
 *
 * `UNAVAILABLE` est distinct d'`AU_REPOS` à dessein : le premier veut dire que
 * rien ne partira tant qu'on n'aura pas agi, le second que tout va bien et
 * qu'il n'y a rien à faire. Les afficher pareil serait la façon la plus simple
 * de laisser des tâches attendre indéfiniment sans que personne le voie.
 */
const AGENT_STATUS: Record<string, string> = {
  WORKING: 'au travail',
  AVAILABLE: 'disponible',
  UNAVAILABLE: 'non installé',
  AU_TRAVAIL: 'au travail',
  EN_PAUSE: 'en pause',
  AU_REPOS: 'au repos',
  ATTEND_VOUS: 'attend vous',
};

const STATUS_LABEL: Record<string, string> = {
  ONLINE: 'EN LIGNE',
  DEGRADED: 'DÉGRADÉ',
  ACTION_REQUIRED: 'ACTION REQUISE',
};

/** N/A plutôt que zéro : l'absence de mesure n'est pas une mesure nulle. */
const orNa = (value: number | null, format: (n: number) => string): string =>
  value === null ? 'N/A' : format(value);

export function AtlasView() {
  const [overview, setOverview] = useState<AtlasOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const data = await api.atlasOverview();
        if (alive) { setOverview(data); setError(null); }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    // Un rafraîchissement lent : l'écran se lit, il ne se surveille pas.
    const timer = setInterval(() => void load(), 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  if (error) {
    return (
      <Panel title="ATLAS">
        <p className="error">{error}</p>
      </Panel>
    );
  }
  if (!overview) return <Spinner />;

  const { today, pipeline, needsYou, agents, system, autonomy } = overview;

  return (
    <div className="atlas-view">
      <header className="atlas-header">
        <div>
          <h1>ATLAS</h1>
          <p className="muted">{overview.statusReason}</p>
        </div>
        <span className={`atlas-status ${STATUS_TONE[overview.status] ?? ''}`}>
          {STATUS_LABEL[overview.status] ?? overview.status}
        </span>
      </header>

      {/* Ce qui attend une personne, avant tout le reste. */}
      <Panel title={`Il faut vous — ${needsYou.length}`}>
        {needsYou.length === 0 && (
          <Empty title="Rien à décider." hint="ATLAS continue seul." />
        )}
        <ul className="needs-list">
          {needsYou.map((item, index) => (
            <li key={`${item.kind}-${index}`} className={`needs-item needs-item--${item.kind.toLowerCase()}`}>
              <span className="needs-kind">{KIND_LABELS[item.kind] ?? item.kind}</span>
              <p className="needs-what">{item.what}</p>
              <dl className="needs-detail">
                <dt>Pourquoi</dt><dd>{item.why}</dd>
                <dt>Recommandé</dt><dd>{item.recommendation}</dd>
              </dl>
              <code className="needs-action">{item.action}</code>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Aujourd’hui">
        <div className="stat-grid">
          <StatCard label="Prospects" value={formatNumber(today.prospects)} />
          <StatCard label="Contactés" value={formatNumber(today.contacted)} />
          <StatCard label="Réponses" value={formatNumber(today.replies)} />
          <StatCard label="Réponses positives" value={formatNumber(today.positiveReplies)} />
          <StatCard label="Clients" value={formatNumber(today.clients)} />
          <StatCard label="Revenu" value={`${today.revenueEur.toFixed(2)} €`} />
          <StatCard
            label="Coût IA"
            value={orNa(today.aiCostUsd, (n) => `${n.toFixed(4)} $`)}
            hint={today.aiCostUnknownCalls > 0
              ? `${today.aiCostUnknownCalls} appel(s) au tarif inconnu`
              : undefined}
          />
        </div>
      </Panel>

      <Panel title="Pipeline">
        <ol className="pipeline">
          {[
            ['Découverts', pipeline.discovered],
            ['Qualifiés', pipeline.qualified],
            ['Contactés', pipeline.contacted],
            ['Intéressés', pipeline.interested],
            ['Aperçus gratuits', pipeline.preview],
            ['Payants', pipeline.paid],
          ].map(([label, value]) => (
            <li key={String(label)}>
              <span className="pipeline-label">{label}</span>
              <span className="pipeline-value">
                {orNa(value as number | null, formatNumber)}
              </span>
            </li>
          ))}
        </ol>
        <p className="muted small">
          Les aperçus gratuits sont produits et transmis à la main : rien en base ne permet
          de les compter, et un zéro se lirait « aucun ».
        </p>
      </Panel>

      <Panel title="Agents">
        <table className="agents-table">
          <thead>
            <tr><th>Agent</th><th>État</th><th>En cours</th><th>Quota</th><th>Dernier résultat</th></tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.name}>
                <td>{agent.name}</td>
                <td><span className={`agent-state agent-state--${agent.status.toLowerCase()}`}>
                  {AGENT_STATUS[agent.status] ?? agent.status.replace('_', ' ').toLowerCase()}
                </span></td>
                <td className="muted">{agent.currentTask ?? '—'}</td>
                <td className="muted">{agent.quota === 'UNKNOWN' ? 'N/A' : agent.quota}</td>
                <td className="muted">{agent.lastResult ?? 'N/A'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Système">
        <ul className="system-list">
          {system.map((item) => (
            <li key={item.name}>
              <span className={`system-dot system-dot--${item.state.toLowerCase()}`} />
              <strong>{item.name}</strong>
              <span className="muted">{item.detail}</span>
            </li>
          ))}
        </ul>
        <p className="muted small">
          Autonomie : niveau {autonomy.level} — {autonomy.label}. {autonomy.description}
        </p>
      </Panel>

      {/* Le détail interne, replié. Il existe pour diagnostiquer, pas pour décider. */}
      <Panel title="Avancé">
        <button type="button" className="link-button" onClick={() => setAdvanced(!advanced)}>
          {advanced ? 'Masquer' : 'Afficher'} le détail interne
        </button>
        {advanced && (
          <div className="advanced">
            <h4>File</h4>
            <ul>
              {Object.entries(overview.advanced.taskStates).map(([state, count]) => (
                <li key={state}>{state} : {count}</li>
              ))}
            </ul>
            <h4>Espaces de travail</h4>
            <ul>
              {Object.entries(overview.advanced.workspaces).map(([state, count]) => (
                <li key={state}>{state} : {count}</li>
              ))}
            </ul>
            <p>
              Verrou d’écriture : {overview.advanced.repoWriteLock ?? 'libre'} ·
              {' '}Mode IA : {overview.advanced.aiLive ? 'RÉEL (facturé)' : 'figé'}
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}
