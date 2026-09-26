import { Link } from 'react-router-dom';
import { useNow, useRevenue } from './live.tsx';
import { TopBar } from './Shell.tsx';
import { Badge, Dot, ErrorState, Icon, Section, Skeleton } from './ui.tsx';
import {
  blockerLabel, headlineLabel, outboundLabel, serviceStateLabel, serviceTone, since, usd,
} from '../lib/mobile-labels.ts';

const RUN_LABEL: Record<string, string> = { RUNNING: 'En cours', DONE: 'Terminée', CAPPED: 'Plafonnée', FAILED: 'Échouée' };

/**
 * Système : tout ce qui est technique, rassemblé ici pour que l'accueil reste
 * court. Même lecture que l'accueil — aucune requête de plus.
 */
export function SystemScreen() {
  const revenue = useRevenue();
  const now = useNow(15_000);
  const d = revenue.data;
  const h = headlineLabel(revenue.status);

  return (
    <>
      <TopBar title="Système" />
      <main className={`mx-main${revenue.fresh.state === 'fresh' || !d ? '' : ' mx-main--stale'}`}>
        {!d ? (
          revenue.failures > 0 ? <ErrorState message={revenue.lastError ?? 'ATLAS ne répond pas.'} onRetry={revenue.reload} /> : <Skeleton lines={6} />
        ) : (
          <>
            <section className={`mx-verdict mx-verdict--${h.tone === 'good' ? 'good' : h.tone === 'bad' ? 'bad' : 'warn'}`}>
              <Icon name={h.tone === 'good' ? 'check' : 'alert'} size={22} />
              <div>
                <strong>{h.text}</strong>
                <span className="mx-muted">{revenue.fresh.label}</span>
                {d.header.reasons.length > 0 ? <ul>{d.header.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
              </div>
            </section>

            <Section title="Envoi" open>
              <dl className="mx-kv">
                <div><dt>Mode</dt><dd><Badge tone={outboundLabel(d.header.outbound).tone}>{outboundLabel(d.header.outbound).text}</Badge></dd></div>
                <div><dt>Coupe-circuit</dt><dd>{d.header.killSwitch.paused ? <Badge tone="warn">Pause active</Badge> : <Badge tone="neutral">Inactif</Badge>}</dd></div>
                {d.header.killSwitch.paused && d.header.killSwitch.reason ? <div><dt>Motif</dt><dd>{d.header.killSwitch.reason}</dd></div> : null}
                <div><dt>Fenêtre</dt><dd>{d.header.sendWindow.window} · {d.header.sendWindow.open ? 'ouverte' : 'fermée'}</dd></div>
                <div><dt>Aujourd’hui</dt><dd>{d.caps.sentToday} / {d.caps.dailyNewOutreach} envois</dd></div>
                <div><dt>Plafond horaire</dt><dd>{d.caps.hourly}</dd></div>
              </dl>
              <Link to="/cc/sales" className="mx-btn mx-btn--wide">Pause et reprise sur l’écran Sales</Link>
            </Section>

            <Section title="Services" open>
              <ul className="mx-services">
                {d.header.services.map((s) => (
                  <li key={s.id}>
                    <Dot tone={serviceTone(s.state)} />
                    <span className="mx-services__name">{s.label}</span>
                    <span className="mx-services__state">{serviceStateLabel(s.state)}</span>
                    <span className="mx-services__detail">{s.detail}</span>
                  </li>
                ))}
              </ul>
              <p className="mx-muted">Dernier cycle commercial : {since(d.header.lastCycleAt, now)} · synchro Gmail : {since(d.header.lastSyncAt, now)}</p>
            </Section>

            <Section title="Coûts du jour">
              <dl className="mx-kv mx-kv--grid">
                <div><dt>OpenAI</dt><dd>{usd(d.costs.todayUsd.openai)}</dd></div>
                <div><dt>Anthropic</dt><dd>{usd(d.costs.todayUsd.anthropic)}</dd></div>
                <div><dt>Recherche</dt><dd>{usd(d.costs.todayUsd.search)}</dd></div>
                <div><dt>Total</dt><dd><strong>{usd(d.costs.todayUsd.total)}</strong></dd></div>
                <div><dt>Plafond IA / jour</dt><dd>{usd(d.costs.caps.aiDailyUsd)}</dd></div>
                <div><dt>Plafond ventes</dt><dd>{usd(d.costs.caps.salesAiDailyUsd)}</dd></div>
                <div><dt>Par qualifié</dt><dd>{usd(d.costs.perQualifiedUsd)}</dd></div>
                <div><dt>Par contact prêt</dt><dd>{usd(d.costs.perContactReadyUsd)}</dd></div>
                <div><dt>Par client</dt><dd>{usd(d.costs.perClientUsd)}</dd></div>
              </dl>
              {d.header.aiCostUnknownCalls > 0 ? <p className="mx-muted">{d.header.aiCostUnknownCalls} appel(s) au tarif inconnu, non comptés.</p> : null}
            </Section>

            <Section title="Fabrique de revenu" count={`${d.loops.factory.processed24h}/${d.loops.factory.target24h}`}>
              <dl className="mx-kv mx-kv--grid">
                <div><dt>Traitées 24 h</dt><dd>{d.loops.factory.processed24h}</dd></div>
                <div><dt>Prêtes à contacter</dt><dd>{d.loops.factory.sendEligible}</dd></div>
                <div><dt>À enrichir</dt><dd>{d.loops.factory.needsEnrichment}</dd></div>
                <div><dt>Tours 24 h</dt><dd>{d.loops.factory.runs24h}</dd></div>
                <div><dt>Entreprises / h</dt><dd>{d.loops.factory.companiesPerHour ?? '—'}</dd></div>
                <div><dt>Coût / entreprise</dt><dd>{usd(d.loops.factory.costPerCompanyUsd)}</dd></div>
              </dl>
              <p className="mx-muted">
                {d.loops.factory.mainBlocker ? `Blocage principal : ${blockerLabel(d.loops.factory.mainBlocker.replace(/\s*\(\d+\)$/, '')).toLowerCase()}. ` : ''}
                Tâches en échec 24 h : {d.loops.tasks.failed24h} · reprises : {d.loops.tasks.recovered24h}.
              </p>
            </Section>

            <Section title="Dernières expansions" count={d.expansions.length || undefined}>
              {d.expansions.length === 0 ? <p className="mx-muted">Aucune expansion consignée.</p> : (
                <ul className="mx-timeline">
                  {d.expansions.map((e) => (
                    <li key={e.id}>
                      <strong>{RUN_LABEL[e.status] ?? e.status} · {e.seeds} graine{e.seeds > 1 ? 's' : ''}</strong>
                      <span>univers {e.universe ?? '—'} · qualifiés {e.qualified ?? '—'} · prioritaires {e.highPriority ?? '—'} · {usd(e.costUsd)}</span>
                      {e.stopReason ? <span className="mx-muted">{e.stopReason}</span> : null}
                      <time>{since(e.startedAt, now)}</time>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Diagnostic">
              <dl className="mx-kv">
                <div><dt>Lecture</dt><dd>{since(d.generatedAt, now)}</dd></div>
                <div><dt>Échecs de lecture</dt><dd>{revenue.failures}</dd></div>
                {Object.entries(d.definitions).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
              </dl>
              <Link to="/cc/system" className="mx-btn mx-btn--wide">Console complète</Link>
            </Section>
          </>
        )}
      </main>
    </>
  );
}
