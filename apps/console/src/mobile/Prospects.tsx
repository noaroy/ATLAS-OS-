import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cc } from '../lib/api.ts';
import { blockerLabel, stateLabel, tierLabel } from '../lib/mobile-labels.ts';
import { PROSPECT_FILTERS, filterProspects, matchesFilter, parseFilter } from '../lib/mobile-view.ts';
import { useLive } from './live.tsx';
import { TopBar } from './Shell.tsx';
import { Avatar, Badge, Empty, ErrorState, Icon, RowLink, Skeleton, useActiveChipInView } from './ui.tsx';

const PAGE = 60;

/** La liste des prospects : une ligne par entreprise, lisible d'un pouce. */
export function ProspectsScreen() {
  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params.get('f'));
  const chipsRef = useActiveChipInView<HTMLDivElement>(filter);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const live = useLive(() => cc.prospects());
  const rows = live.data?.rows ?? [];
  const visible = useMemo(() => filterProspects(rows, filter, query), [rows, filter, query]);
  const counts = useMemo(() => Object.fromEntries(PROSPECT_FILTERS.map(([k]) => [k, rows.filter((r) => matchesFilter(r, k)).length])), [rows]);

  return (
    <>
      <TopBar title={<>Prospects {live.data ? <span className="mx-top__count">{live.data.total}</span> : null}</>} />
      <div className="mx-toolbar">
        <label className="mx-search">
          <Icon name="search" size={18} />
          <input type="search" inputMode="search" placeholder="Entreprise ou domaine" value={query}
            onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }} aria-label="Rechercher un prospect" />
        </label>
        <div ref={chipsRef} className="mx-chips" role="tablist" aria-label="Filtres">
          {PROSPECT_FILTERS.map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={filter === key}
              className={`mx-chip${filter === key ? ' is-active' : ''}`}
              onClick={() => { setParams(key === 'all' ? {} : { f: key }, { replace: true }); setShown(PAGE); }}>
              {label}{live.data ? <span className="mx-chip__count">{counts[key]}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <main className="mx-main mx-main--list">
        {!live.data ? (
          live.failures > 0 ? <ErrorState message={live.lastError ?? 'Liste indisponible.'} onRetry={live.reload} /> : <Skeleton lines={6} />
        ) : visible.length === 0 ? (
          rows.length === 0
            ? <Empty icon="users" title="Aucun prospect pour l’instant">La découverte et la fabrique les ajouteront ici.</Empty>
            : <Empty icon="search" title="Aucun résultat">Essayez un autre filtre ou une autre recherche.</Empty>
        ) : (
          <>
            <ul className="mx-list">
              {visible.slice(0, shown).map((r) => {
                const tier = tierLabel(r.tier);
                const state = r.commercialState !== 'NONE' ? stateLabel(r.commercialState) : r.factoryClass ? stateLabel(r.factoryClass) : stateLabel('DISCOVERED');
                return (
                  <li key={r.domain}>
                    <RowLink to={`/m/p/${encodeURIComponent(r.domain)}`}>
                      <Avatar name={r.companyName} />
                      <span className="mx-row__body">
                        <span className="mx-row__title">
                          <strong>{r.companyName}</strong>
                          {r.score !== null ? <span className="mx-score">{Math.round(r.score)}</span> : null}
                        </span>
                        <span className="mx-row__sub">{r.domain}</span>
                        <span className="mx-row__meta">
                          <Badge tone={tier.tone}>{tier.text}</Badge>
                          <Badge tone={state.tone}>{state.text}</Badge>
                          <span className={`mx-contact${r.contactReady ? ' is-ready' : ''}`} title={r.contactReady ? 'Email vérifié' : 'Email à trouver'}>
                            <Icon name={r.contactReady ? 'mail' : 'mailOff'} size={14} />
                          </span>
                        </span>
                        {r.mainBlocker && !r.sendEligible ? <span className="mx-row__blocker">{blockerLabel(r.mainBlocker)}</span> : null}
                      </span>
                    </RowLink>
                  </li>
                );
              })}
            </ul>
            {visible.length > shown ? (
              <button type="button" className="mx-btn mx-btn--wide" onClick={() => setShown((n) => n + PAGE)}>
                Afficher {Math.min(PAGE, visible.length - shown)} de plus
              </button>
            ) : null}
          </>
        )}
      </main>
    </>
  );
}
