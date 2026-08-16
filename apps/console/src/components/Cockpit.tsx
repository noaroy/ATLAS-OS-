import { useCallback, useEffect, useState } from 'react';
import type { MissionCockpit, MissionDecision, OpportunityDetail } from '@atlas/contracts';
import { api } from '../lib/api.ts';
import { ReviewControls } from '../views/Opportunities.tsx';
import { formatNumber, formatUsd } from './ui.tsx';

/**
 * Le poste de pilotage d'une mission.
 *
 * Chaque valeur affichée ici vient du serveur. Rien n'est recalculé, estimé ni
 * arrondi côté navigateur : un chiffre inventé par l'interface a exactement la
 * même apparence qu'un chiffre mesuré, et plus rien ensuite ne permet de
 * distinguer les deux. Sur un écran qui pilote une dépense réelle, c'est
 * inacceptable — d'où l'absence totale d'arithmétique dans ce fichier.
 *
 * Deux choses y sont mises en avant plus que les autres, parce que ce sont
 * celles qui ont coûté de l'argent : le budget restant, et l'écart entre un
 * moteur qui répond et un moteur qui sait répondre.
 */

export function LiveBanner({ cockpit }: { cockpit: MissionCockpit }) {
  const live = cockpit.mode === 'live';

  if (!live) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200">
        <strong className="font-semibold">MODE SIMULATION</strong> · aucun appel facturé, aucune
        donnée externe. Les résultats sont des jalons de structure, pas des faits.
      </div>
    );
  }

  return (
    <div className="rounded-lg border-2 border-rose-500/50 bg-rose-500/10 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="font-display text-base font-bold tracking-wide text-rose-300">
          ● LIVE — APPELS EXTERNES AUTORISÉS
        </span>
        <span className="text-sm text-rose-100">
          BUDGET MAX <strong>{formatUsd(cockpit.budget.maxUsd)}</strong>
        </span>
        <span className="text-sm text-rose-100">
          DÉPENSÉ <strong>{formatUsd(cockpit.budget.spentUsd)}</strong>
        </span>
        <span className="text-sm text-rose-100">
          RESTE <strong>{formatUsd(cockpit.budget.remainingUsd)}</strong>
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/40">
        <div
          className="h-full rounded-full bg-rose-400 transition-[width] duration-500"
          style={{
            width: `${
              cockpit.budget.maxUsd > 0
                ? Math.min(100, (cockpit.budget.spentUsd / cockpit.budget.maxUsd) * 100)
                : 0
            }%`,
          }}
        />
      </div>
    </div>
  );
}

export function Cockpit({
  missionId,
  cockpit,
  decisions,
  unsupportedClaims,
}: {
  missionId: string;
  cockpit: MissionCockpit;
  decisions: MissionDecision[];
  unsupportedClaims: MissionDecision[];
}) {
  const { search, pipeline, inference, reliability, budget } = cockpit;

  return (
    <div className="space-y-4">
      <LiveBanner cockpit={cockpit} />

      {/* ── Le moteur : répond-il, et sait-il répondre ? ─────────────────── */}
      <Section title="Moteur de recherche">
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip border border-[--color-border-bright] text-[--color-muted]">
            {search.provider ?? 'aucun'}
          </span>
          <HealthChip health={search.health} />
          <SuitabilityChip verdict={search.suitability} />
        </div>

        {/*
          La distinction qui a coûté le plus cher : un moteur peut répondre en
          trois cents millisecondes sans rien contenir du marché visé. Les deux
          états sont donc affichés côte à côte, jamais fondus en un seul voyant.
        */}
        {search.suitabilityGaps.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-amber-300/90">
            {search.suitabilityGaps.map((gap) => (
              <li key={gap}>· {gap}</li>
            ))}
          </ul>
        )}
        {search.caveat && (
          <p className="mt-1.5 text-[0.7rem] leading-relaxed text-[--color-faint]">{search.caveat}</p>
        )}

        <dl className="mt-3 grid grid-cols-3 gap-2">
          <Cell label="Requêtes" value={search.queries} />
          <Cell label="Bridages" value={search.rateLimited} tone={search.rateLimited > 0 ? 'warn' : undefined} />
          <Cell label="Échecs" value={search.failures} tone={search.failures > 0 ? 'warn' : undefined} />
        </dl>
      </Section>

      {/* ── L'entonnoir ──────────────────────────────────────────────────── */}
      <Section title="Entonnoir">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Cell label="Candidats" value={pipeline.candidates} />
          <Cell label="Retenus" value={pipeline.shortlisted} />
          <Cell label="Approuvés" value={pipeline.approved} tone="good" />
          <Cell label="Rejetés" value={pipeline.rejected} />
          <Cell label="Pages lues" value={pipeline.pagesFetched} />
          <Cell label="Preuves" value={pipeline.evidence.total} />
          <Cell label="Sourcées" value={pipeline.evidence.sourced} tone="good" />
          <Cell label="Opportunités" value={pipeline.candidates} />
        </dl>

        {/*
          La nature d'une preuve sépare un fait d'une conclusion. Une shortlist
          bâtie sur des inférences n'est pas une shortlist bâtie sur des
          observations, et le rapport doit permettre de le voir d'un coup d'œil.
        */}
        <div className="mt-3 flex flex-wrap gap-2 text-[0.68rem]">
          <NatureChip label="observed" count={pipeline.evidence.observed} tone="text-emerald-300" />
          <NatureChip label="reported" count={pipeline.evidence.reported} tone="text-sky-300" />
          <NatureChip label="inferred" count={pipeline.evidence.inferred} tone="text-amber-300" />
        </div>
      </Section>

      {/* ── L'inférence ──────────────────────────────────────────────────── */}
      <Section title="Inférence">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Cell label="Appels" value={inference.calls} />
          <Cell label="En échec" value={inference.failedCalls} tone={inference.failedCalls > 0 ? 'warn' : undefined} />
          <Cell label="Jetons entrée" value={formatNumber(inference.inputTokens)} />
          <Cell label="Jetons sortie" value={formatNumber(inference.outputTokens)} />
        </dl>
        <p className="mt-2 text-[0.7rem] text-[--color-faint]">
          {inference.models.length > 0 ? inference.models.join(' · ') : 'aucun modèle appelé'}
          {' · '}
          {formatNumber(budget.tokensUsed)} / {formatNumber(budget.maxTokens)} jetons
        </p>
      </Section>

      {/* ── La fiabilité ─────────────────────────────────────────────────── */}
      <Section title="Fiabilité">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Cell label="Réessais" value={reliability.retries} tone={reliability.retries > 0 ? 'warn' : undefined} />
          <Cell label="Timeouts" value={reliability.timeouts} tone={reliability.timeouts > 0 ? 'warn' : undefined} />
          <Cell label="Avertissements" value={reliability.warnings} />
          <Cell label="Erreurs" value={reliability.errors} tone={reliability.errors > 0 ? 'bad' : undefined} />
        </dl>
      </Section>

      {/* ── Les décisions d'Hermès ───────────────────────────────────────── */}
      <Section title={`Décisions d’Hermès (${decisions.length})`}>
        {unsupportedClaims.length > 0 && (
          <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <strong>{unsupportedClaims.length} conclusion(s) sans preuve sourcée.</strong> Recevable
            si la mission n’a rien trouvé — à ne pas lire comme un constat de marché.
          </div>
        )}

        {decisions.length === 0 ? (
          <p className="text-xs text-[--color-faint]">Aucune décision enregistrée.</p>
        ) : (
          <ul className="space-y-2">
            {decisions.map((decision) => (
              <li key={decision.id} className="rounded-lg border border-[--color-border] px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip border border-[--color-border-bright] text-[0.6rem] uppercase tracking-wider text-[--color-muted]">
                    {decision.kind}
                  </span>
                  {decision.taskRef && (
                    <span className="font-mono text-[0.66rem] text-[--color-faint]">{decision.taskRef}</span>
                  )}
                  {decision.evidenceIds.length > 0 && (
                    <span className="text-[0.62rem] text-emerald-300">
                      {decision.evidenceIds.length} preuve(s)
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-[--color-ink]">{decision.decision}</div>
                <div className="mt-0.5 text-[0.68rem] leading-relaxed text-[--color-muted]">
                  {decision.rationale}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ── La revue humaine, décidable sans quitter le cockpit ──────────── */}
      <ReviewSection missionId={missionId} />
    </div>
  );
}

/**
 * La revue humaine, tranchée depuis le cockpit.
 *
 * La décision elle-même est déléguée à `ReviewControls`, celui de l'onglet
 * Opportunités. Une seconde implémentation d'« approuver » finirait par
 * diverger de la première, et deux façons d'approuver une opportunité, c'est
 * une de trop.
 *
 * Ce qui est ajouté ici, c'est le contexte nécessaire pour trancher sans
 * changer de vue : le score, les preuves ventilées par nature, la source
 * consultable. Approuver une opportunité sans voir sur quoi elle repose est
 * précisément ce que ce système existe pour empêcher.
 */
function ReviewSection({ missionId }: { missionId: string }) {
  const [items, setItems] = useState<OpportunityDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const page = await api.missionOpportunities(missionId);
      setItems(page.opportunities);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Opportunités indisponibles.');
      setItems([]);
    }
  }, [missionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <Section title="Revue humaine">
        <p className="text-xs text-[--color-faint]">{error}</p>
      </Section>
    );
  }

  if (!items) {
    return (
      <Section title="Revue humaine">
        <p className="text-xs text-[--color-faint]">Chargement…</p>
      </Section>
    );
  }

  if (items.length === 0) {
    return (
      <Section title="Revue humaine">
        <p className="text-xs text-[--color-faint]">
          Aucune opportunité à relire. Rien ne sort comme livrable tant qu’un humain n’a pas tranché.
        </p>
      </Section>
    );
  }

  return (
    <Section title={`Revue humaine (${items.length})`}>
      <ul className="space-y-3">
        {items.map((item) => {
          const natures = {
            observed: item.evidence.filter((e) => e.nature === 'observed').length,
            reported: item.evidence.filter((e) => e.nature === 'reported').length,
            inferred: item.evidence.filter((e) => e.nature === 'inferred').length,
          };
          const source = item.evidence.find((e) => Boolean(e.sourceRef))?.sourceRef ?? null;
          const decided = item.opportunity.review && item.opportunity.review.decision !== 'pending';

          return (
            <li key={item.opportunity.id} className="rounded-lg border border-[--color-border] p-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium text-[--color-ink]">{item.company.legalName}</span>
                <span
                  className={`chip ${
                    item.opportunity.stage === 'approved'
                      ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : item.opportunity.stage === 'rejected'
                        ? 'border border-rose-500/30 bg-rose-500/10 text-rose-300'
                        : 'border border-white/10 text-[--color-faint]'
                  }`}
                >
                  {item.opportunity.stage}
                </span>
                {item.opportunity.score !== null && (
                  <span className="text-xs text-[--color-muted]">{item.opportunity.score}/100</span>
                )}
                {/*
                  Une opportunité non décidée ne doit jamais ressembler à une
                  opportunité validée : l'absence de décision est écrite, pas
                  laissée à l'interprétation du lecteur.
                */}
                {!decided && (
                  <span className="text-[0.62rem] uppercase tracking-wider text-amber-300">
                    non décidée
                  </span>
                )}
              </div>

              <div className="mt-1.5 flex flex-wrap gap-2 text-[0.66rem]">
                <NatureChip label="observed" count={natures.observed} tone="text-emerald-300" />
                <NatureChip label="reported" count={natures.reported} tone="text-sky-300" />
                <NatureChip label="inferred" count={natures.inferred} tone="text-amber-300" />
              </div>

              {source ? (
                <a
                  href={source}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1.5 block truncate text-[0.68rem] text-[--color-atlas] hover:underline"
                >
                  {source}
                </a>
              ) : (
                <p className="mt-1.5 text-[0.68rem] text-[--color-faint]">
                  Aucune source consultable — à ne pas approuver en l’état.
                </p>
              )}

              <div className="mt-2">
                <ReviewControls opportunity={item.opportunity} onReviewed={() => void load()} />
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ─── Éléments ───────────────────────────────────────────────────────────────

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="panel p-4">
    <h3 className="mb-2.5 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-[--color-faint]">
      {title}
    </h3>
    {children}
  </section>
);

const Cell = ({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: 'good' | 'warn' | 'bad';
}) => (
  <div className="rounded-lg border border-[--color-border] bg-[--color-deep] px-2.5 py-2">
    <dt className="text-[0.58rem] uppercase tracking-wider text-[--color-faint]">{label}</dt>
    <dd
      className={`mt-0.5 font-display text-base ${
        tone === 'good'
          ? 'text-emerald-300'
          : tone === 'warn'
            ? 'text-amber-300'
            : tone === 'bad'
              ? 'text-rose-300'
              : 'text-[--color-ink]'
      }`}
    >
      {value}
    </dd>
  </div>
);

const NatureChip = ({ label, count, tone }: { label: string; count: number; tone: string }) => (
  <span className="chip border border-white/10">
    <span className={tone}>{label}</span>
    <span className="ml-1 text-[--color-faint]">{count}</span>
  </span>
);

const HealthChip = ({ health }: { health: MissionCockpit['search']['health'] }) => (
  <span
    className={`chip ${
      health === 'healthy'
        ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
        : health === 'unhealthy'
          ? 'border border-rose-500/30 bg-rose-500/10 text-rose-300'
          : 'border border-white/10 text-[--color-faint]'
    }`}
    title="Le moteur répond-il ? Déduit du dernier appel réel, jamais mesuré à l’affichage."
  >
    santé · {health}
  </span>
);

const SuitabilityChip = ({ verdict }: { verdict: MissionCockpit['search']['suitability'] }) => (
  <span
    className={`chip ${
      verdict === 'suitable'
        ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
        : verdict === 'degraded'
          ? 'border border-amber-500/30 bg-amber-500/10 text-amber-300'
          : verdict === 'unsuitable'
            ? 'border border-rose-500/30 bg-rose-500/10 text-rose-300'
            : 'border border-white/10 text-[--color-faint]'
    }`}
    title="Ce moteur peut-il répondre à cette mission ? Un moteur sain peut ne rien contenir du marché visé."
  >
    adéquation · {verdict}
  </span>
);
