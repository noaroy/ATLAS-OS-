import { Link, useNavigate, useParams } from 'react-router-dom';
import { cc, type ProspectDetail } from '../lib/api.ts';
import { since, stateLabel, tierLabel } from '../lib/mobile-labels.ts';
import { prospectVerdict } from '../lib/mobile-view.ts';
import { useLive, useNow } from './live.tsx';
import { TopBar } from './Shell.tsx';
import { Avatar, Badge, Empty, ErrorState, Icon, Section, Skeleton, SourceLink } from './ui.tsx';

/** La fiche d'un prospect : d'abord le verdict, puis le détail replié. */
export function ProspectScreen() {
  const { domain = '' } = useParams();
  const navigate = useNavigate();
  const live = useLive(() => cc.prospect(domain), [domain]);
  const now = useNow(30_000);
  const d = live.data;

  const back = (
    <button type="button" className="mx-icon-btn" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/m/prospects'))} aria-label="Retour">
      <Icon name="back" size={22} />
    </button>
  );

  return (
    <>
      <TopBar back={back} title={d?.identity.companyName ?? domain} />
      <main className="mx-main">
        {!d ? (
          live.failures > 0
            ? /404|introuvable|not found/i.test(live.lastError ?? '')
              ? <Empty icon="search" title="Prospect introuvable"><Link to="/m/prospects">Retour à la liste</Link></Empty>
              : <ErrorState message={live.lastError ?? 'Fiche indisponible.'} onRetry={live.reload} />
            : <Skeleton hero lines={5} />
        ) : <Detail d={d} now={now} />}
      </main>
    </>
  );
}

function Detail({ d, now }: { d: ProspectDetail; now: number }) {
  const q = d.qualification;
  const tier = tierLabel(q.tier);
  const state = stateLabel(q.state);
  const verdict = prospectVerdict(d);
  const c = d.contact;
  const draft = [...d.drafts].reverse().find((x) => x.state !== 'ABANDONED') ?? d.drafts.at(-1) ?? null;

  return (
    <>
      <section className="mx-identity">
        <Avatar name={d.identity.companyName} size={52} />
        <div>
          <h2>{d.identity.companyName}</h2>
          <p>{d.identity.domain}{d.identity.country ? ` · ${d.identity.country}` : ''}</p>
          <div className="mx-row__meta">
            {q.score !== null ? <span className="mx-score mx-score--lg">{Math.round(q.score)}</span> : null}
            <Badge tone={tier.tone}>{tier.text}</Badge>
            <Badge tone={state.tone}>{state.text}</Badge>
          </div>
        </div>
      </section>

      <section className={`mx-verdict mx-verdict--${verdict.tone}`}>
        <Icon name={verdict.icon} size={22} />
        <div>
          <strong>{verdict.title}</strong>
          {verdict.items.length > 0 ? <ul>{verdict.items.map((m) => <li key={m}>{m}</li>)}</ul> : null}
        </div>
      </section>

      <Section title="Contact" open>
        {c.email || c.phone || c.page ? (
          <dl className="mx-kv">
            {c.name || c.role ? <div><dt>Personne</dt><dd>{[c.name, c.role].filter(Boolean).join(' · ')}</dd></div> : null}
            {c.email ? <div><dt>Email</dt><dd>{c.email} {c.observed ? <Badge tone="good">vérifié</Badge> : <Badge tone="warn">à vérifier</Badge>}</dd></div> : null}
            {c.phone ? <div><dt>Téléphone</dt><dd>{c.phone}</dd></div> : null}
            {c.page ? <div><dt>Formulaire</dt><dd><SourceLink href={c.page} /></dd></div> : null}
            {c.sourceUrl ? <div><dt>Lu sur</dt><dd><SourceLink href={c.sourceUrl} /></dd></div> : null}
          </dl>
        ) : <p className="mx-muted">Aucune coordonnée publiée trouvée pour l’instant.</p>}
      </Section>

      <Section title="Pourquoi ce prospect">
        {q.whyFit ? <p className="mx-prose">{q.whyFit}</p> : <p className="mx-muted">Pas encore évalué.</p>}
        {d.identity.sourceUrl ? <p className="mx-muted">Découvert via <SourceLink href={d.identity.sourceUrl} /> · {since(d.identity.discoveredAt, now)}</p> : null}
      </Section>

      <Section title="Recommandations" count={d.recommendations.length}>
        {d.recommendations.length === 0 ? (
          <p className="mx-muted">Moins de deux partenaires vérifiés publiés par l’entreprise : aucun échantillon, donc aucun message.</p>
        ) : (
          <ul className="mx-cards">
            {d.recommendations.map((r) => (
              <li key={r.domain}>
                <span className="mx-cards__title"><strong>{r.company}</strong><span className="mx-muted">{r.domain}</span></span>
                <q>{r.fitReason}</q>
                <SourceLink href={r.sourceUrl} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Preuves" count={d.evidence.length}>
        {d.evidence.length === 0 ? <p className="mx-muted">Aucune preuve consignée.</p> : (
          <ul className="mx-cards">
            {d.evidence.map((e, i) => (
              <li key={`${e.field}-${i}`}>
                <q>{e.claim}</q>
                {e.sourceUrl ? <SourceLink href={e.sourceUrl} /> : <span className="mx-muted">sans source</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Brouillon" count={d.drafts.length || undefined} open={Boolean(draft && draft.state === 'READY_FOR_APPROVAL')}>
        {!draft ? <p className="mx-muted">Aucun brouillon rédigé.</p> : (
          <article className="mx-mail">
            <header>
              <Badge tone={stateLabel(draft.state).tone}>{stateLabel(draft.state).text}</Badge>
              <dl>
                <div><dt>À</dt><dd>{draft.recipient}</dd></div>
                <div><dt>Objet</dt><dd><strong>{draft.subject}</strong></dd></div>
              </dl>
            </header>
            <pre>{draft.body}</pre>
            {draft.sources.length > 0 ? (
              <footer>
                <span className="mx-muted">Sources citées</span>
                <div className="mx-sources">{[...new Set(draft.sources.map((s) => s.sourceUrl))].map((u) => <SourceLink key={u} href={u} />)}</div>
              </footer>
            ) : null}
            {draft.state === 'READY_FOR_APPROVAL' ? (
              <Link to="/cc/approvals" className="mx-btn mx-btn--wide">Ouvrir l’écran d’approbation</Link>
            ) : null}
          </article>
        )}
      </Section>

      <Section title="Historique" count={d.history.loop.length + d.history.ledger.length || undefined}>
        <Timeline d={d} now={now} />
      </Section>
    </>
  );
}

function Timeline({ d, now }: { d: ProspectDetail; now: number }) {
  const items = [
    ...d.history.loop.map((t) => ({ at: t.at, text: `${stateLabel(t.from ?? 'NONE').text} → ${stateLabel(t.to).text}`, detail: t.reason })),
    ...d.history.ledger.map((l) => ({ at: l.at, text: stateLabel(l.kind).text, detail: l.note })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  if (items.length === 0) return <p className="mx-muted">Aucune transition consignée.</p>;
  return (
    <ol className="mx-timeline">
      {items.map((h, i) => (
        <li key={`${h.at}-${i}`}>
          <strong>{h.text}</strong>
          {h.detail ? <span>{h.detail.length > 90 ? `${h.detail.slice(0, 90)}…` : h.detail}</span> : null}
          <time title={h.at}>{since(h.at, now)}</time>
        </li>
      ))}
    </ol>
  );
}

