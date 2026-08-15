import { useCallback, useEffect, useState } from 'react';
import { api, type RuntimeSettingsView } from '../lib/api.ts';
import { useAtlas } from '../store.ts';
import { ErrorNote, Panel, Spinner, relativeTime } from '../components/ui.tsx';

/**
 * Runtime configuration (SRS §6.5).
 *
 * Only genuinely mutable settings appear here. Secrets and paths stay in the
 * environment, where they can be rotated without a running system's help.
 */
export function SettingsView() {
  const user = useAtlas((s) => s.user);
  const [settings, setSettings] = useState<RuntimeSettingsView | null>(null);
  const [draft, setDraft] = useState<RuntimeSettingsView['runtime'] | null>(null);
  const [backups, setBackups] = useState<Awaited<ReturnType<typeof api.backups>> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isFounder = user?.role === 'founder';

  const load = useCallback(async (): Promise<void> => {
    const result = await api.settings();
    setSettings(result);
    setDraft(result.runtime);
    try {
      setBackups(await api.backups());
    } catch {
      setBackups([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.updateSettings(draft);
      await load();
      setMessage('Settings saved. They take effect on the next mission dispatched.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not save settings');
    } finally {
      setBusy(false);
    }
  };

  const backup = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.backup();
      setMessage(`Backup written — ${(result.bytes / 1024 / 1024).toFixed(1)} MB.`);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Backup failed');
    } finally {
      setBusy(false);
    }
  };

  if (!settings || !draft) return <Spinner />;

  const update = <K extends keyof RuntimeSettingsView['runtime']>(
    key: K,
    value: RuntimeSettingsView['runtime'][K],
  ): void => setDraft((current) => (current ? { ...current, [key]: value } : current));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Réglages</h1>
        <p className="mt-1 text-sm text-[--color-muted]">
          How ATLAS operates. Changes are recorded and take effect without a restart.
        </p>
      </header>

      {message && <ErrorNote message={message} />}
      {!isFounder && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Settings are read-only for your role. Only the founder can change how the organisation runs.
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Orchestration">
          <div className="space-y-4">
            <NumberField
              label="Missions simultanées"
              hint="Combien de missions Hermès mène de front."
              value={draft.maxConcurrentMissions}
              min={1}
              max={20}
              disabled={!isFounder}
              onChange={(v) => update('maxConcurrentMissions', v)}
            />
            <NumberField
              label="Étapes simultanées par mission"
              hint="Les étapes indépendantes s’exécutent en parallèle jusqu’à cette limite."
              value={draft.maxConcurrentTasks}
              min={1}
              max={20}
              disabled={!isFounder}
              onChange={(v) => update('maxConcurrentTasks', v)}
            />
            <NumberField
              label="Tentatives par étape"
              hint="Une panne passagère est réessayée ce nombre de fois avant que l’étape échoue."
              value={draft.taskMaxAttempts}
              min={1}
              max={10}
              disabled={!isFounder}
              onChange={(v) => update('taskMaxAttempts', v)}
            />
            <NumberField
              label="Budget de jetons par mission"
              hint="Une mission qui atteint ce plafond s’arrête proprement en conservant le travail déjà fait. 0 = sans plafond."
              value={draft.missionTokenBudget}
              min={0}
              max={10_000_000}
              disabled={!isFounder}
              onChange={(v) => update('missionTokenBudget', v)}
            />
            <NumberField
              label="Replanifications par mission"
              hint="Combien de fois Hermès peut revoir les étapes restantes après l’échec d’une dont le plan dépendait. 0 désactive la replanification."
              value={draft.maxReplansPerMission}
              min={0}
              max={5}
              disabled={!isFounder}
              onChange={(v) => update('maxReplansPerMission', v)}
            />
          </div>
        </Panel>

        <Panel title="Intelligence">
          <div className="space-y-4">
            <div>
              <label className="label" htmlFor="hermes-model">
                Modèle d’Hermès
              </label>
              <input
                id="hermes-model"
                className="input"
                value={draft.hermesModel}
                disabled={!isFounder}
                onChange={(e) => update('hermesModel', e.target.value)}
              />
              <p className="mt-1 text-xs text-[--color-faint]">
                Sert à la planification et à la synthèse — les décisions qui donnent sa forme à chaque mission.
              </p>
            </div>

            <div>
              <label className="label" htmlFor="agent-model">
                Modèle des agents
              </label>
              <input
                id="agent-model"
                className="input"
                value={draft.agentModel}
                disabled={!isFounder}
                onChange={(e) => update('agentModel', e.target.value)}
              />
              <p className="mt-1 text-xs text-[--color-faint]">
                Sert à l’exécution des étapes. Un agent peut le remplacer individuellement.
              </p>
            </div>

            <div>
              <label className="label" htmlFor="effort">
                Effort de raisonnement
              </label>
              <select
                id="effort"
                className="input"
                value={draft.llmEffort}
                disabled={!isFounder}
                onChange={(e) => update('llmEffort', e.target.value as typeof draft.llmEffort)}
              >
                <option value="low">Faible — rapide et économique</option>
                <option value="medium">Moyen — équilibré</option>
                <option value="high">Élevé — valeur recommandée</option>
                <option value="xhigh">Très élevé — travaux les plus ardus</option>
                <option value="max">Maximum — la justesse avant le coût</option>
              </select>
            </div>

            <div className="rounded-lg border border-[--color-border] bg-[--color-deep] px-3 py-2 text-xs text-[--color-muted]">
              Mode d’inférence : <strong className="text-[--color-ink]">{settings.mode === 'simulation' ? 'simulation' : 'réel (facturé)'}</strong>
              {settings.mode === 'simulation' &&
                " — aucun appel n’est facturé. Définissez ANTHROPIC_API_KEY pour passer en inférence réelle."}
            </div>
          </div>
        </Panel>

        <Panel title="Auto-amélioration">
          <div className="space-y-4">
            <label className="flex items-start gap-2.5 text-sm text-[--color-muted]">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-sky-500"
                checked={draft.evolutionEnabled}
                disabled={!isFounder}
                onChange={(e) => update('evolutionEnabled', e.target.checked)}
              />
              <span>
                <span className="text-[--color-ink]">Activer la boucle d’évolution</span>
                <span className="mt-0.5 block text-xs text-[--color-faint]">
                  ATLAS observe ses propres performances et cherche à mieux travailler.
                </span>
              </span>
            </label>

            <div>
              <label className="label" htmlFor="autonomy">
                Autonomie
              </label>
              <select
                id="autonomy"
                className="input"
                value={draft.evolutionAutonomy}
                disabled={!isFounder}
                onChange={(e) => update('evolutionAutonomy', e.target.value as typeof draft.evolutionAutonomy)}
              >
                <option value="observe">Observer seulement — mesurer, ne jamais proposer</option>
                <option value="propose">Proposer — vous approuvez chaque changement</option>
                <option value="apply-low-risk">Appliquer seuls les changements à faible risque</option>
              </select>
              <p className="mt-1 text-xs text-[--color-faint]">
                Même au réglage le plus permissif, ATLAS ne peut modifier que des réglages déclaratifs, et
                chaque changement est journalisé et réversible.
              </p>
            </div>
          </div>
        </Panel>

        <Panel title="Sauvegardes">
          <div className="space-y-3">
            <p className="text-sm text-[--color-muted]">
              Une copie cohérente est écrite chaque nuit et à chaque arrêt propre. Restaurer revient à copier
              un fichier : arrêtez ATLAS, remplacez <code className="text-xs">data/atlas.db</code>, relancez-le.
            </p>
            <button type="button" className="btn" disabled={busy || !isFounder} onClick={() => void backup()}>
              Sauvegarder maintenant
            </button>

            {backups && backups.length > 0 && (
              <ul className="divide-y divide-[--color-border] rounded-lg border border-[--color-border]">
                {backups.slice(0, 6).map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="truncate font-mono text-[--color-muted]">{entry.path}</span>
                    <span className="shrink-0 text-[--color-faint]">
                      {(entry.bytes / 1024 / 1024).toFixed(1)} Mo · {relativeTime(entry.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      </div>

      {isFounder && (
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={() => setDraft(settings.runtime)}>
            Abandonner les modifications
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Enregistrement…' : 'Enregistrer les réglages'}
          </button>
        </div>
      )}

      <Panel title="À propos">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="label">Version</dt>
            <dd className="text-[--color-ink]">ATLAS OS {settings.version}</dd>
          </div>
          <div>
            <dt className="label">Automatisation</dt>
            <dd className="text-[--color-ink]">{settings.n8nEnabled ? 'n8n connecté' : 'tâches internes uniquement'}</dd>
          </div>
          <div>
            <dt className="label">Connecté en tant que</dt>
            <dd className="text-[--color-ink]">
              {user?.name} ({user?.role})
            </dd>
          </div>
        </dl>
      </Panel>
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label className="label" htmlFor={label}>
        {label}
      </label>
      <input
        id={label}
        type="number"
        className="input"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
      />
      <p className="mt-1 text-xs text-[--color-faint]">{hint}</p>
    </div>
  );
}
