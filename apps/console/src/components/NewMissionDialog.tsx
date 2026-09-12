import { useEffect, useState, type FormEvent } from 'react';
import type { Department, Mission } from '@atlas/contracts';
import { api, ApiError } from '../lib/api.ts';

/**
 * The founder's primary input (SRS §6.9): state an objective, let Hermes plan.
 *
 * Context is captured as key/value pairs rather than free prose so it reaches
 * the planner as structured data an agent can act on.
 */
export function NewMissionDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (mission: Mission) => void;
}) {
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [priority, setPriority] = useState('normal');
  const [tags, setTags] = useState('');
  const [tokenBudget, setTokenBudget] = useState('');
  const [context, setContext] = useState<Array<{ key: string; value: string }>>([{ key: '', value: '' }]);
  const [autoStart, setAutoStart] = useState(true);

  // Department work is briefed, not just described: the fields below are what
  // Hermes would otherwise have to infer, and a stated field always wins over
  // an inferred one.
  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentKey, setDepartmentKey] = useState('');
  const [targetTypes, setTargetTypes] = useState<string[]>([]);
  const [countries, setCountries] = useState('');
  const [industries, setIndustries] = useState('');
  const [desiredCount, setDesiredCount] = useState('20');
  const [clientName, setClientName] = useState('');
  const [clientCountry, setClientCountry] = useState('');
  const [clientOffering, setClientOffering] = useState('');
  const [mustHave, setMustHave] = useState('');
  const [exclusions, setExclusions] = useState('');

  const department = departments.find((d) => d.key === departmentKey) ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .departments()
      .then((rows) => setDepartments(rows.filter((r) => r.department.enabled).map((r) => r.department)))
      .catch(() => setDepartments([]));
  }, []);

  useEffect(() => {
    // Default to the department's first target type whenever the choice changes,
    // so the form is never in a half-configured state.
    setTargetTypes(department?.targetTypes[0] ? [department.targetTypes[0].key] : []);
  }, [departmentKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const contextObject: Record<string, unknown> = Object.fromEntries(
        context.filter((row) => row.key.trim() && row.value.trim()).map((row) => [row.key.trim(), row.value.trim()]),
      );

      if (department) {
        const list = (value: string): string[] =>
          value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);

        contextObject.targetTypes = targetTypes;
        contextObject.desiredCount = Number(desiredCount) || 10;
        contextObject.markets = {
          countries: list(countries),
          industries: list(industries),
          regions: [],
        };
        if (clientName.trim() || clientOffering.trim()) {
          contextObject.clientProfile = {
            name: clientName.trim() || 'le client',
            country: clientCountry.trim() || 'non précisé',
            industry: industries.split(',')[0]?.trim() || 'non précisé',
            offering: clientOffering.trim() || objective.trim().slice(0, 600),
            differentiators: [],
          };
        }
        if (mustHave.trim()) contextObject.mustHave = list(mustHave);
        if (exclusions.trim()) contextObject.exclusions = list(exclusions);
      }

      const mission = await api.createMission({
        title: title.trim(),
        objective: objective.trim(),
        priority,
        context: contextObject,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        autoStart,
        // Omitted entirely when blank, so the deployment default applies.
        ...(tokenBudget.trim() ? { tokenBudget: Number(tokenBudget) } : {}),
        // '' means "let Hermes recognise it"; an explicit choice always wins.
        ...(departmentKey ? { departmentKey } : {}),
      });
      onCreated(mission);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de créer la mission.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Créer une mission"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form onSubmit={submit} className="panel max-h-[88vh] w-full max-w-2xl animate-rise overflow-y-auto">
        <header className="border-b border-[--color-border] px-5 py-4">
          <h2 className="font-display text-lg font-semibold">Nouvelle mission</h2>
          <p className="mt-0.5 text-xs text-[--color-muted]">
            Décrivez le résultat attendu. Hermès décide des étapes et des spécialistes à mobiliser.
          </p>
        </header>

        <div className="space-y-4 p-5">
          <div>
            <label className="label" htmlFor="mission-title">
              Titre
            </label>
            <input
              id="mission-title"
              className="input"
              value={title}
              required
              minLength={3}
              maxLength={200}
              placeholder="Trouver des distributeurs allemands pour notre ligne de conditionnement"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div>
            <label className="label" htmlFor="mission-objective">
              Objectif
            </label>
            <textarea
              id="mission-objective"
              className="input min-h-32 resize-y"
              value={objective}
              required
              minLength={10}
              maxLength={8000}
              placeholder="Soyez précis sur ce à quoi ressemble un bon résultat. Que doit-il exister à la fin, et pour qui ?"
              onChange={(e) => setObjective(e.target.value)}
            />
            <p className="mt-1 text-[0.6875rem] text-[--color-faint]">
              Un objectif clair dès le départ produit un meilleur plan qu’un objectif vague affiné ensuite.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="mission-department">
              Département
            </label>
            <select
              id="mission-department"
              className="input"
              value={departmentKey}
              onChange={(e) => setDepartmentKey(e.target.value)}
            >
              <option value="">Laisser Hermès le reconnaître depuis l’objectif</option>
              {departments.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[0.6875rem] text-[--color-faint]">
              {department
                ? department.tagline
                : 'Un département fournit la méthode. Sans lui, Hermès planifie la mission lui-même.'}
            </p>
          </div>

          {department && (
            <fieldset className="space-y-4 rounded-lg border border-[--color-atlas]/30 p-4">
              <legend className="px-1 text-xs text-[--color-atlas]">Brief</legend>
              <p className="text-[0.6875rem] text-[--color-faint]">
                Ce que vous indiquez ici fait foi. Hermès lit l’objectif pour le reste, mais ne remplace jamais
                ce que vous avez fixé.
              </p>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <span className="label">Rôles recherchés</span>
                  {/*
                    Cases à cocher plutôt qu'une liste déroulante : une mission
                    peut viser des distributeurs *et* des intégrateurs, et une
                    même entreprise peut correspondre aux deux.
                  */}
                  <div className="space-y-1">
                    {department.targetTypes.map((target) => (
                      <label
                        key={target.key}
                        className="flex items-start gap-2 text-xs text-[--color-muted]"
                        title={target.description}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 size-3.5 accent-sky-500"
                          checked={targetTypes.includes(target.key)}
                          onChange={(e) =>
                            setTargetTypes((current) =>
                              e.target.checked
                                ? [...current, target.key]
                                : current.filter((key) => key !== target.key),
                            )
                          }
                        />
                        <span>
                          <span className="text-[--color-ink]">{target.label}</span>
                          <span className="block text-[0.6875rem] text-[--color-faint]">
                            {target.description}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {targetTypes.length === 0 && (
                    <p className="mt-1 text-[0.6875rem] text-[--color-warn]">
                      Choisissez au moins un rôle.
                    </p>
                  )}
                </div>
                <div>
                  <label className="label" htmlFor="brief-count">
                    Nombre de candidats
                  </label>
                  <input
                    id="brief-count"
                    type="number"
                    min={1}
                    max={100}
                    className="input"
                    value={desiredCount}
                    onChange={(e) => setDesiredCount(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="brief-countries">
                    Marchés visés
                  </label>
                  <input
                    id="brief-countries"
                    className="input"
                    value={countries}
                    placeholder="Germany, Austria"
                    onChange={(e) => setCountries(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="brief-industries">
                    Secteurs à servir
                  </label>
                  <input
                    id="brief-industries"
                    className="input"
                    value={industries}
                    placeholder="Packaging, food processing"
                    onChange={(e) => setIndustries(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label className="label" htmlFor="brief-client">
                    Votre entreprise
                  </label>
                  <input
                    id="brief-client"
                    className="input"
                    value={clientName}
                    placeholder="Acme Machines"
                    onChange={(e) => setClientName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="brief-client-country">
                    Basée en
                  </label>
                  <input
                    id="brief-client-country"
                    className="input"
                    value={clientCountry}
                    placeholder="France"
                    onChange={(e) => setClientCountry(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="brief-offering">
                    Ce que vous vendez
                  </label>
                  <input
                    id="brief-offering"
                    className="input"
                    value={clientOffering}
                    placeholder="Industrial packaging machines"
                    onChange={(e) => setClientOffering(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="brief-must">
                    Indispensable
                  </label>
                  <input
                    id="brief-must"
                    className="input"
                    value={mustHave}
                    placeholder="Own service engineers, national coverage"
                    onChange={(e) => setMustHave(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="brief-exclusions">
                    Disqualifiant
                  </label>
                  <input
                    id="brief-exclusions"
                    className="input"
                    value={exclusions}
                    placeholder="Already distributes a direct competitor"
                    onChange={(e) => setExclusions(e.target.value)}
                  />
                </div>
              </div>
            </fieldset>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="mission-priority">
                Priorité
              </label>
              <select
                id="mission-priority"
                className="input"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="mission-tags">
                Étiquettes
              </label>
              <input
                id="mission-tags"
                className="input"
                value={tags}
                placeholder="expansion, allemagne"
                onChange={(e) => setTags(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="mission-budget">
              Budget de jetons
            </label>
            <input
              id="mission-budget"
              type="number"
              min={0}
              className="input"
              value={tokenBudget}
              placeholder="Laissez vide pour utiliser la valeur par défaut du déploiement"
              onChange={(e) => setTokenBudget(e.target.value)}
            />
            <p className="mt-1 text-[0.6875rem] text-[--color-faint]">
              Si la mission atteint ce plafond, elle s’arrête proprement et conserve ce que les étapes
              achevées ont produit. Saisissez 0 pour aucun plafond.
            </p>
          </div>

          <div>
            <span className="label">Contexte métier</span>
            <div className="space-y-2">
              {context.map((row, index) => (
                <div key={index} className="flex gap-2">
                  <input
                    className="input flex-[0_0_38%]"
                    placeholder="secteur"
                    value={row.key}
                    onChange={(e) =>
                      setContext((rows) => rows.map((r, i) => (i === index ? { ...r, key: e.target.value } : r)))
                    }
                  />
                  <input
                    className="input flex-1"
                    placeholder="machines de conditionnement industriel"
                    value={row.value}
                    onChange={(e) =>
                      setContext((rows) => rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)))
                    }
                  />
                  <button
                    type="button"
                    className="btn !px-2.5"
                    aria-label="Supprimer cette ligne"
                    onClick={() => setContext((rows) => rows.filter((_, i) => i !== index))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="mt-2 text-xs text-[--color-atlas] hover:underline"
              onClick={() => setContext((rows) => [...rows, { key: '', value: '' }])}
            >
              + Ajouter du contexte
            </button>
          </div>

          <label className="flex items-center gap-2.5 text-sm text-[--color-muted]">
            <input
              type="checkbox"
              className="size-4 accent-sky-500"
              checked={autoStart}
              onChange={(e) => setAutoStart(e.target.checked)}
            />
            Démarrer immédiatement (sinon Hermès planifie et attend votre accord)
          </label>

          {error && (
            <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {error}
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-[--color-border] px-5 py-4">
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Création…' : 'Lancer la mission'}
          </button>
        </footer>
      </form>
    </div>
  );
}
