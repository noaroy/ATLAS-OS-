import { Link, useSearchParams } from 'react-router-dom';
import { cc, type OutreachInboxRow } from '../lib/api.ts';
import { blockerLabel, outboundLabel, since, stateLabel } from '../lib/mobile-labels.ts';
import { OUTREACH_TABS, parseTab, type OutreachTab } from '../lib/mobile-view.ts';
import { useLive, useNow, useRevenue } from './live.tsx';
import { TopBar } from './Shell.tsx';
import { Avatar, Badge, Empty, ErrorState, Icon, RowLink, Skeleton, useActiveChipInView } from './ui.tsx';

const KEY: Record<OutreachTab, 'toApprove' | 'ready' | 'sent' | 'replies' | 'blocked'> = {
  approve: 'toApprove', ready: 'ready', sent: 'sent', replies: 'replies', blocked: 'blocked',
};

const EMPTY: Record<OutreachTab, { icon: string; title: string; text: string }> = {
  approve: { icon: 'check', title: 'Rien à approuver', text: 'Les prochains brouillons apparaîtront ici.' },
  ready: { icon: 'inbox', title: 'Aucun message en file', text: 'Un brouillon approuvé attend ici le cycle d’envoi.' },
  sent: { icon: 'send', title: 'Aucun message envoyé', text: 'L’envoi réel est coupé tant qu’il n’est pas activé.' },
  replies: { icon: 'reply', title: 'Aucune réponse', text: 'Les réponses reçues arriveront ici.' },
  blocked: { icon: 'shield', title: 'Aucun brouillon bloqué', text: 'Les brouillons écartés et leur motif s’affichent ici.' },
};

/**
 * La boîte d'envoi : cinq onglets, une ligne par message. Rien ne s'envoie
 * d'ici — l'approbation reste sur son écran existant.
 */
export function OutreachScreen() {
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));
  const chipsRef = useActiveChipInView<HTMLDivElement>(tab);
  const live = useLive(() => cc.outreachInbox());
  const revenue = useRevenue();
  const now = useNow(30_000);
  const outbound = revenue.data ? outboundLabel(revenue.data.header.outbound) : null;
  const rows = live.data ? live.data[KEY[tab]] : [];

  return (
    <>
      <TopBar title="Outreach" />
      <div className="mx-toolbar">
        {revenue.data && outbound ? (
          <p className="mx-banner">
            <Icon name="shield" size={16} />
            <span><Badge tone={outbound.tone}>{outbound.text}</Badge>{' '}
              {revenue.data.header.outbound === 'ACTIVE'
                ? 'Seuls les messages approuvés partent, dans la fenêtre d’envoi.'
                : 'Aucun message ne part tant que l’envoi n’est pas activé.'}</span>
          </p>
        ) : null}
        <div ref={chipsRef} className="mx-chips mx-chips--tabs" role="tablist" aria-label="Onglets">
          {OUTREACH_TABS.map(([key, label]) => {
            const n = live.data ? live.data[KEY[key]].length : null;
            return (
              <button key={key} type="button" role="tab" aria-selected={tab === key}
                className={`mx-chip${tab === key ? ' is-active' : ''}${key === 'approve' && n ? ' mx-chip--attention' : ''}`}
                onClick={() => setParams({ tab: key }, { replace: true })}>
                {label}{n !== null ? <span className="mx-chip__count">{n}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      <main className="mx-main mx-main--list">
        {!live.data ? (
          live.failures > 0 ? <ErrorState message={live.lastError ?? 'Boîte indisponible.'} onRetry={live.reload} /> : <Skeleton lines={6} />
        ) : rows.length === 0 ? (
          <Empty icon={EMPTY[tab].icon} title={EMPTY[tab].title}>{EMPTY[tab].text}</Empty>
        ) : (
          <>
            <ul className="mx-list">
              {rows.map((r) => <InboxRow key={r.id} r={r} tab={tab} now={now} />)}
            </ul>
            {tab === 'approve' ? (
              <Link to="/cc/approvals" className="mx-btn mx-btn--wide">Approuver sur l’écran d’approbation</Link>
            ) : null}
          </>
        )}
      </main>
    </>
  );
}

function InboxRow({ r, tab, now }: { r: OutreachInboxRow; tab: OutreachTab; now: number }) {
  const state = stateLabel(r.state);
  return (
    <li>
      <RowLink to={`/m/p/${encodeURIComponent(r.domain)}`} tone={tab === 'approve' ? 'attention' : undefined}>
        <Avatar name={r.company} />
        <span className="mx-row__body">
          <span className="mx-row__title">
            <strong>{r.company}</strong>
            <time className="mx-row__age">{since(r.at, now)}</time>
          </span>
          {r.recipient ? <span className="mx-row__sub">{r.recipient}</span> : null}
          {r.subject ? <span className="mx-row__subject">{r.subject}</span> : null}
          <span className="mx-row__meta">
            <Badge tone={state.tone}>{state.text}</Badge>
            {tab === 'blocked' && r.detail ? <span className="mx-row__blocker">{r.detail.split(',').map((x) => blockerLabel(x.trim())).join(' · ')}</span> : null}
            {tab === 'approve' && r.detail ? <span className="mx-muted">{r.detail}</span> : null}
          </span>
          {tab === 'replies' && r.detail ? <span className="mx-row__excerpt">« {r.detail} »</span> : null}
        </span>
      </RowLink>
    </li>
  );
}
