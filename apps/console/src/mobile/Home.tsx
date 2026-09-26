import { Link } from 'react-router-dom';
import { useNow, useRevenue } from './live.tsx';
import { TopBar } from './Shell.tsx';
import { Badge, Empty, ErrorState, Icon, Skeleton, Sparkline } from './ui.tsx';
import { compact, money, since } from '../lib/mobile-labels.ts';
import { funnelSteps, heroMetric, homeActions } from '../lib/mobile-view.ts';

/**
 * L'accueil : cinq questions, un seul écran.
 *   1. ATLAS fonctionne-t-il ?            → la barre du haut
 *   2. Qu'a-t-il produit aujourd'hui ?    → le chiffre héros et trois tuiles
 *   3. Où en est le funnel ?              → sept étapes compactes
 *   4. Réponses, RDV, opportunités ?      → le funnel et « À faire »
 *   5. Qu'est-ce qui demande mon attention ? → trois cartes au plus
 * Tout le reste vit dans Système.
 */
export function HomeScreen() {
  const revenue = useRevenue();
  const now = useNow(15_000);
  const { data } = revenue;

  return (
    <>
      <TopBar brand />
      <main className={`mx-main${revenue.fresh.state === 'fresh' || !data ? '' : ' mx-main--stale'}`}>
        {!data ? (
          revenue.failures > 0 ? <ErrorState message={revenue.lastError ?? 'ATLAS ne répond pas.'} onRetry={revenue.reload} /> : <Skeleton hero lines={4} />
        ) : (
          <>
            {revenue.status === 'STALE' || revenue.status === 'DOWN' ? (
              <p className="mx-banner mx-banner--warn" role="status">
                <Icon name="alert" size={16} /> Derniers chiffres connus — {revenue.fresh.label.toLowerCase()}.
              </p>
            ) : null}
            <Hero />
            <Funnel />
            <Todo />
            <Activity now={now} />
          </>
        )}
      </main>
    </>
  );
}

function Hero() {
  const data = useRevenue().data!;
  const hero = heroMetric(data);
  const k = data.kpis;
  const pipeline = k.revenueSigned > 0 ? { v: money(k.revenueSigned, k.currency), l: 'CA signé' } : { v: money(k.pipelinePotential, k.currency), l: 'Pipeline' };
  return (
    <section className="mx-hero" aria-label="Aujourd’hui">
      <div className="mx-hero__main">
        <span className="mx-hero__value">{compact(hero.value)}</span>
        <span className="mx-hero__label">{hero.label}</span>
        {hero.delta ? <Badge tone={hero.delta.tone}>{hero.delta.text}</Badge> : null}
      </div>
      <Sparkline values={hero.series} days={data.trends.days} label={hero.seriesLabel} />
      <dl className="mx-tiles">
        <div><dt>Trouvés auj.</dt><dd>{compact(k.discoveredToday)}</dd></div>
        <div><dt>Contact prêt</dt><dd>{compact(k.contactReady)}</dd></div>
        <div><dt>{pipeline.l}</dt><dd>{pipeline.v}</dd></div>
      </dl>
    </section>
  );
}

function Funnel() {
  const data = useRevenue().data!;
  const { steps, replyRate } = funnelSteps(data);
  return (
    <section className="mx-block" aria-label="Funnel">
      <header className="mx-block__head">
        <h2>Funnel</h2>
        <span className="mx-block__meta">{replyRate === null ? 'depuis l’origine' : `${Math.round(replyRate * 100)} % de réponses`}</span>
      </header>
      <ol className="mx-funnel">
        {steps.map((s, i) => (
          <li key={s.key} className={s.count ? '' : 'is-zero'}>
            <b>{s.count === null ? '—' : compact(s.count)}</b>
            <span className="mx-funnel__label">{s.label}</span>
            <span className="mx-funnel__meter" aria-hidden="true"><i style={{ width: `${Math.max(s.count ? 6 : 0, s.share * 100)}%` }} /></span>
            {i < steps.length - 1 ? <Icon name="chevron" size={12} className="mx-funnel__arrow" /> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Todo() {
  const actions = homeActions(useRevenue().data!);
  return (
    <section className="mx-block" aria-label="À faire">
      <header className="mx-block__head"><h2>À faire</h2></header>
      {actions.length === 0 ? (
        <Empty icon="check" title="ATLAS travaille — aucune action requise." />
      ) : (
        <div className="mx-actions">
          {actions.map((a) => (
            <Link key={a.key} to={a.to} className={`mx-action mx-action--${a.tone}`}>
              <span className="mx-action__icon"><Icon name={a.icon} size={20} /></span>
              <span className="mx-action__text"><strong>{a.title}</strong><span>{a.hint}</span></span>
              <Icon name="chevron" size={18} className="mx-row__chev" />
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

const KIND_ICON: Record<string, string> = { FACTORY: 'spark', DRAFT: 'mail', SENT: 'send', REPLY: 'reply', OUTCOME: 'calendar' };

function Activity({ now }: { now: number }) {
  const data = useRevenue().data!;
  const items = data.activity.slice(0, 3);
  return (
    <section className="mx-block" aria-label="Activité">
      <header className="mx-block__head">
        <h2>Activité</h2>
        <span className="mx-block__meta">
          {data.header.lastRevenueActionAt ? `${data.header.lastRevenueAction} · ${since(data.header.lastRevenueActionAt, now)}` : 'aucune action consignée'}
        </span>
      </header>
      {items.length === 0 ? (
        <Empty icon="spark" title="Pas encore d’activité">La fabrique écrira ici ses premiers résultats.</Empty>
      ) : (
        <ul className="mx-feed">
          {items.map((a, i) => {
            const body = (
              <>
                <span className="mx-feed__icon"><Icon name={KIND_ICON[a.kind] ?? 'spark'} size={16} /></span>
                <span className="mx-feed__text"><strong>{a.title}</strong>{a.detail ? <span>{a.detail}</span> : null}</span>
                <time>{since(a.at, now)}</time>
              </>
            );
            return <li key={`${a.at}-${i}`}>{a.domain ? <Link to={`/m/p/${encodeURIComponent(a.domain)}`}>{body}</Link> : <div>{body}</div>}</li>;
          })}
        </ul>
      )}
    </section>
  );
}
