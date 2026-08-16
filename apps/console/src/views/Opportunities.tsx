import { useEffect, useMemo, useState } from 'react';
import type { Evidence, MissionEconomics, OpportunityDetail, OpportunityStage } from '@atlas/contracts';
import { api, ApiError } from '../lib/api.ts';
import { Panel, Empty, Spinner, ErrorNote, formatNumber } from '../components/ui.tsx';

/**
 * What a department mission actually produced.
 *
 * The funnel is counted from rows, the scores are shown as their components,
 * and every claim carries how it was obtained. The point of this screen is that
 * "why is this one first?" is answerable without trusting anyone's summary.
 */

const STAGE_ORDER: OpportunityStage[] = [
  'discovered',
  'enriched',
  'qualified',
  'scored',
  'shortlisted',
  'reviewed',
  'approved',
  'rejected',
];

/** Libellés français de l'entonnoir, dans l'ordre du pipeline. */
const STAGE_LABELS: Record<OpportunityStage, string> = {
  discovered: 'découvertes',
  enriched: 'documentées',
  qualified: 'qualifiées',
  scored: 'notées',
  shortlisted: 'retenues',
  reviewed: 'revues',
  approved: 'approuvées',
  rejected: 'écartées',
};

export function MissionOpportunities({ missionId }: { missionId: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.missionOpportunities>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = (): void => {
    setError(null);
    api
      .missionOpportunities(missionId)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Impossible de charger les opportunités.'));
  };

  useEffect(load, [missionId]);

  const shortlist = useMemo(
    () =>
      (data?.opportunities ?? [])
        .filter((d) => d.opportunity.rank !== null)
        .sort((a, b) => (a.opportunity.rank ?? 0) - (b.opportunity.rank ?? 0)),
    [data],
  );
  const others = useMemo(
    () => (data?.opportunities ?? []).filter((d) => d.opportunity.rank === null),
    [data],
  );
  const approvedCount = shortlist.filter(
    (d) => d.opportunity.review?.decision === 'approved',
  ).length;

  if (error) return <ErrorNote message={error} onRetry={load} />;
  if (!data) return <Spinner label="Chargement des opportunités" />;

  const total = Object.values(data.funnel).reduce((sum, n) => sum + n, 0);
  if (total === 0) {
    return (
      <Empty
        icon="◎"
        title="Aucune opportunité pour l’instant"
        hint="Elles apparaissent à mesure que l’étape de découverte enregistre des candidats."
      />
    );
  }

  const simulated = data.economics?.simulated ?? false;

  return (
    <div className="space-y-4">
      {simulated && (
        <p className="rounded border border-[--color-warn]/40 bg-[--color-warn]/10 px-3 py-2 text-xs text-[--color-warn]">
          Cette mission a tourné sur de l’inférence simulée. Les entreprises ci-dessous sont structurellement
          correctes mais ne sont pas des données réelles, et ATLAS a marqué chaque affirmation en conséquence.
        </p>
      )}

      <Panel title="Entonnoir" subtitle="Compté depuis le registre, pas suivi dans un compteur">
        <div className="flex flex-wrap gap-2">
          {STAGE_ORDER.map((stage) => (
            <div
              key={stage}
              className={`flex-1 rounded border px-3 py-2 text-center ${
                stage === 'rejected'
                  ? 'border-[--color-border] text-[--color-faint]'
                  : 'border-[--color-atlas]/30 text-[--color-ink]'
              }`}
            >
              <p className="font-display text-lg">{formatNumber(data.funnel[stage] ?? 0)}</p>
              <p className="text-[0.62rem] uppercase tracking-wide text-[--color-faint]">{STAGE_LABELS[stage]}</p>
            </div>
          ))}
        </div>
        {data.economics && <Economics economics={data.economics} />}
      </Panel>

      <Panel
        title={`Shortlist (${shortlist.length})`}
        subtitle="Classée, avec la raison de chaque position"
        action={
          shortlist.length > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-[0.68rem] text-[--color-faint]">
                {approvedCount}/{shortlist.length} approuvée(s)
              </span>
              {/*
                L'export approuvé est le choix par défaut : un fichier quitte
                ATLAS et se lit ensuite sans son contexte, donc ce qui n'a pas
                été validé ne doit pas être la chose la plus facile à envoyer.
              */}
              <a
                className="btn !py-1 !text-xs"
                href={`/api/missions/${missionId}/export?format=csv&scope=${approvedCount > 0 ? 'approved' : 'shortlist'}`}
              >
                Export CSV
              </a>
              <a
                className="btn !py-1 !text-xs"
                href={`/api/missions/${missionId}/export?format=html&scope=${approvedCount > 0 ? 'approved' : 'shortlist'}`}
                target="_blank"
                rel="noreferrer"
              >
                Rapport
              </a>
            </div>
          ) : null
        }
      >
        {shortlist.length === 0 ? (
          <Empty
            icon="◇"
            title="Aucun candidat n’a franchi le seuil"
            hint="ATLAS annonce une shortlist vide plutôt que d’abaisser la barre."
          />
        ) : (
          <ul className="space-y-2">
            {shortlist.map((detail) => (
              <OpportunityRow
                key={detail.opportunity.id}
                detail={detail}
                open={openId === detail.opportunity.id}
                onToggle={() =>
                  setOpenId(openId === detail.opportunity.id ? null : detail.opportunity.id)
                }
                onReviewed={load}
              />
            ))}
          </ul>
        )}
      </Panel>

      {others.length > 0 && (
        <Panel
          title={`Étudiés mais non retenus (${others.length})`}
          subtitle="Conservés au registre pour que le fondateur puisse être en désaccord"
        >
          <ul className="space-y-2">
            {others.map((detail) => (
              <OpportunityRow
                key={detail.opportunity.id}
                detail={detail}
                open={openId === detail.opportunity.id}
                onToggle={() =>
                  setOpenId(openId === detail.opportunity.id ? null : detail.opportunity.id)
                }
                onReviewed={load}
              />
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function Economics({ economics }: { economics: MissionEconomics }) {
  return (
    <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-[--color-border] pt-3 text-center text-[0.68rem] sm:grid-cols-5">
      <Cell label="Jetons" value={formatNumber(economics.tokensUsed)} />
      <Cell
        label="Coût estimé"
        value={economics.estimatedCostUsd !== null ? `$${economics.estimatedCostUsd.toFixed(4)}` : '—'}
      />
      <Cell label="Appels externes" value={formatNumber(economics.externalCalls)} />
      <Cell label="Savoir réutilisé" value={formatNumber(economics.knowledgeReused)} />
      <Cell
        label="Coût / qualifié"
        value={
          economics.costPerQualifiedOpportunity !== null
            ? `$${economics.costPerQualifiedOpportunity.toFixed(4)}`
            : '—'
        }
      />
    </dl>
  );
}

/** Le libellé d'un rôle, repris de l'évaluation quand elle existe. */
const roleLabel = (opportunity: OpportunityDetail['opportunity'], role: string): string =>
  opportunity.scoreDetail?.roleFits.find((f) => f.role === role)?.label ?? role;

const Cell = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="text-[--color-faint]">{label}</dt>
    <dd className="font-display text-sm text-[--color-ink]">{value}</dd>
  </div>
);

function OpportunityRow({
  detail,
  open,
  onToggle,
  onReviewed,
}: {
  detail: OpportunityDetail;
  open: boolean;
  onToggle: () => void;
  onReviewed: () => void;
}) {
  const { opportunity, company } = detail;

  return (
    <li className="rounded border border-[--color-border]">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[--color-border]/30"
      >
        <span className="w-8 shrink-0 font-display text-sm text-[--color-faint]">
          {opportunity.rank !== null ? `#${opportunity.rank}` : '—'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-[--color-ink]">{company.name}</span>
          <span className="block truncate text-[0.68rem] text-[--color-faint]">
            {[company.city, company.country, company.domain].filter(Boolean).join(' · ') || 'localisation inconnue'}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-display text-sm text-[--color-ink]">
            {opportunity.score !== null ? opportunity.score.toFixed(1) : '—'}
          </span>
          <span className="block text-[0.62rem] text-[--color-faint]">
            {opportunity.scoreDetail
              ? `${(opportunity.scoreDetail.confidence * 100).toFixed(0)}% de confiance`
              : opportunity.stage}
          </span>
        </span>
        {/* Quelle relation proposer est la première question commerciale. */}
        {opportunity.targetTypes.length > 0 && (
          <span className="hidden shrink-0 gap-1 sm:flex">
            {opportunity.targetTypes.map((role) => (
              <span key={role} className="chip border border-[--color-atlas]/40 text-[--color-atlas]">
                {roleLabel(opportunity, role)}
              </span>
            ))}
          </span>
        )}
        {opportunity.reusedKnowledge && (
          <span className="chip text-[--color-vital]" title="Repris du registre d’entreprises">
            reused
          </span>
        )}
        <span className="shrink-0 text-[--color-faint]">{open ? '▾' : '▸'}</span>
      </button>

      {open && <OpportunityDetailPanel detail={detail} onReviewed={onReviewed} />}
    </li>
  );
}

function OpportunityDetailPanel({
  detail,
  onReviewed,
}: {
  detail: OpportunityDetail;
  onReviewed: () => void;
}) {
  const { opportunity, company, evidence, contacts, relations } = detail;

  return (
    <div className="space-y-4 border-t border-[--color-border] px-3 py-3">
      {opportunity.justification && (
        <section>
          <h4 className="label">Pourquoi il est à cette place</h4>
          <p className="whitespace-pre-line text-xs text-[--color-muted]">{opportunity.justification}</p>
        </section>
      )}

      {(opportunity.scoreDetail?.roleFits.length ?? 0) > 0 && (
        <section>
          <h4 className="label">Compatibilité par rôle</h4>
          <ul className="space-y-1 text-xs">
            {[...opportunity.scoreDetail!.roleFits]
              .sort((a, b) => b.value - a.value)
              .map((fit) => (
                <li key={fit.role} className="flex items-start gap-2">
                  <span className="chip shrink-0 border border-[--color-atlas]/40 text-[--color-atlas]">
                    {fit.label}
                  </span>
                  <span className="font-display text-[--color-ink]">{fit.value}/100</span>
                  <span className="text-[0.62rem] text-[--color-faint]">
                    {Math.round(fit.confidence * 100)} %
                  </span>
                  <span className="min-w-0 flex-1 text-[--color-muted]">{fit.rationale}</span>
                </li>
              ))}
          </ul>
        </section>
      )}

      {opportunity.scoreDetail && (
        <section>
          <h4 className="label">Décomposition du score</h4>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[--color-faint]">
                <th className="py-1 font-normal">Dimension</th>
                <th className="py-1 font-normal">Valeur</th>
                <th className="py-1 font-normal">Poids</th>
                <th className="py-1 font-normal">Contribution</th>
                <th className="py-1 font-normal">Raison</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[--color-border]">
              {opportunity.scoreDetail.components.map((component) => (
                <tr key={component.dimension}>
                  <td className="py-1 pr-2 text-[--color-ink]">
                    {component.label}
                    {component.computed && (
                      <span className="ml-1 chip text-[--color-vital]" title="Calculé par ATLAS">
                        computed
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-2">{component.value}</td>
                  <td className="py-1 pr-2 text-[--color-faint]">{component.weight}</td>
                  <td className="py-1 pr-2 font-display">+{component.contribution.toFixed(1)}</td>
                  <td className="py-1 text-[--color-muted]">{component.rationale}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-[--color-border]">
                <td className="py-1 font-display text-[--color-ink]">Total</td>
                <td className="py-1" colSpan={2} />
                <td className="py-1 font-display text-[--color-ink]">
                  {opportunity.scoreDetail.total.toFixed(1)}
                </td>
                <td className="py-1 text-[0.62rem] text-[--color-faint]">
                  modèle {opportunity.scoreDetail.modelVersion} · noté par {opportunity.scoreDetail.scoredBy}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}

      {opportunity.qualification && (
        <section>
          <h4 className="label">Qualification — {opportunity.qualification.verdict}</h4>
          <ul className="space-y-1 text-xs">
            {opportunity.qualification.checks.map((check, index) => (
              <li key={index} className="flex gap-2">
                <span className={check.passed ? 'text-[--color-vital]' : 'text-[--color-alert]'}>
                  {check.passed ? '✓' : '✕'}
                </span>
                <span className="text-[--color-muted]">
                  <span className="text-[--color-ink]">{check.criterion}</span> — {check.detail}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 whitespace-pre-line text-[0.68rem] text-[--color-faint]">
            {opportunity.qualification.rationale}
          </p>
        </section>
      )}

      <section>
        <h4 className="label">Preuves ({evidence.length})</h4>
        {evidence.length === 0 ? (
          <p className="text-xs text-[--color-faint]">Rien n’a été enregistré pour ce candidat.</p>
        ) : (
          <ul className="space-y-1">
            {evidence.map((item) => (
              <EvidenceRow key={item.id} evidence={item} />
            ))}
          </ul>
        )}
      </section>

      {(contacts.length > 0 || relations.length > 0) && (
        <section className="grid gap-4 sm:grid-cols-2">
          {contacts.length > 0 && (
            <div>
              <h4 className="label">Contacts</h4>
              <ul className="space-y-1 text-xs">
                {contacts.map((contact) => (
                  <li key={contact.id} className="text-[--color-muted]">
                    <span className="text-[--color-ink]">{contact.name}</span>
                    {contact.role ? ` — ${contact.role}` : ''}
                    <span className="ml-1 text-[0.62rem] text-[--color-faint]">
                      ({(contact.confidence * 100).toFixed(0)}% de confiance)
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {relations.length > 0 && (
            <div>
              <h4 className="label">Relations</h4>
              <ul className="space-y-1 text-xs text-[--color-muted]">
                {relations.map((relation) => (
                  <li key={relation.id}>
                    <span className="text-[--color-ink]">{relation.kind}</span> {relation.toName} —{' '}
                    {relation.description}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <ReviewControls opportunity={opportunity} onReviewed={onReviewed} />

      <p className="text-[0.62rem] text-[--color-faint]">
        {company.name} · enregistrée le {new Date(company.firstSeenAt).toLocaleDateString()}
        {company.lastVerifiedAt
          ? ` · dernière vérification ${new Date(company.lastVerifiedAt).toLocaleDateString()}`
          : ' · jamais vérifiée à une source'}
      </p>
    </div>
  );
}

/**
 * La décision du fondateur.
 *
 * Tenue à l'écart de la qualification et du score, qui sont les jugements
 * d'ATLAS : rien ne part chez un client sans qu'un humain l'ait approuvé
 * (Article XVI), et l'écran doit rendre visible qui a conclu quoi.
 */
/**
 * Les commandes de revue, réutilisables telles quelles.
 *
 * Exportées pour que le cockpit les affiche sans réécrire la décision : une
 * seconde implémentation de « approuver » finirait par diverger de celle-ci, et
 * deux façons d'approuver une opportunité, c'est une de trop.
 */
export function ReviewControls({
  opportunity,
  onReviewed,
}: {
  opportunity: OpportunityDetail['opportunity'];
  onReviewed: () => void;
}) {
  const [note, setNote] = useState(opportunity.review?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'approved' | 'rejected' | 'pending'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.reviewOpportunity(opportunity.id, { decision, note: note.trim() || undefined });
      onReviewed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'La décision n’a pas pu être enregistrée.');
    } finally {
      setBusy(false);
    }
  };

  const review = opportunity.review;

  return (
    <section className="rounded border border-[--color-border] p-3">
      <h4 className="label">Revue du fondateur</h4>

      {review && review.decision !== 'pending' ? (
        <p
          className={`text-xs ${
            review.decision === 'approved' ? 'text-[--color-vital]' : 'text-[--color-alert]'
          }`}
        >
          {review.decision === 'approved' ? 'Approuvée' : 'Rejetée'} par {review.reviewedBy} le{' '}
          {new Date(review.reviewedAt).toLocaleDateString('fr-FR')}
          {review.note ? ` — « ${review.note} »` : ''}
        </p>
      ) : (
        <p className="text-xs text-[--color-faint]">
          Non décidée. Rien n’est exporté comme livrable tant qu’un humain n’a pas tranché.
        </p>
      )}

      <textarea
        className="input mt-2 min-h-16 resize-y text-xs"
        value={note}
        maxLength={2000}
        placeholder="Votre commentaire — conservé tel quel, jamais résumé."
        onChange={(e) => setNote(e.target.value)}
      />

      <div className="mt-2 flex gap-2">
        <button type="button" className="btn btn-primary !py-1 !text-xs" disabled={busy} onClick={() => decide('approved')}>
          Approuver
        </button>
        <button type="button" className="btn !py-1 !text-xs" disabled={busy} onClick={() => decide('rejected')}>
          Rejeter
        </button>
        <button type="button" className="btn !py-1 !text-xs" disabled={busy} onClick={() => decide('pending')}>
          Annoter seulement
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-[--color-alert]">{error}</p>}
    </section>
  );
}

/**
 * One claim, rendered so its status is unmissable.
 *
 * Observation, report and inference are visually distinct because conflating
 * them is the failure mode this whole system is built to avoid.
 */
function EvidenceRow({ evidence }: { evidence: Evidence }) {
  const tone =
    evidence.nature === 'observed'
      ? 'text-[--color-vital] border-[--color-vital]/40'
      : evidence.nature === 'reported'
        ? 'text-[--color-atlas] border-[--color-atlas]/40'
        : 'text-[--color-warn] border-[--color-warn]/40';

  return (
    <li className="flex gap-2 text-xs">
      <span className={`chip shrink-0 border ${tone}`}>{evidence.nature}</span>
      <span className="min-w-0 flex-1">
        <span className="text-[--color-muted]">
          <span className="text-[--color-faint]">{evidence.field}:</span> {evidence.claim}
        </span>
        <span className="ml-1 text-[0.62rem] text-[--color-faint]">
          {evidence.sourceRef ? (
            <a
              href={evidence.sourceRef}
              target="_blank"
              rel="noreferrer noopener"
              className="underline decoration-dotted"
            >
              {evidence.sourceTitle ?? evidence.sourceRef}
            </a>
          ) : (
            evidence.basis ?? evidence.sourceKey
          )}
          {' · '}
          {(evidence.confidence * 100).toFixed(0)}%{' · '}
          {evidence.agentKey}
          {evidence.simulated && ' · simulated'}
        </span>
      </span>
    </li>
  );
}
