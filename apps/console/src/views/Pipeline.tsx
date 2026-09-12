import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { cc } from '../lib/api.ts';
import type { CompanyRow, CompanyDetail, Inbox, Approvals } from '../lib/api.ts';
import { CcHead, Panel, Stat, Badge, Empty, useLive, day, moment } from '../components/cc.tsx';

/**
 * Le registre des entreprises.
 *
 * Une entreprise contactée y figure quoi qu'il arrive, y compris sans
 * conversation ouverte : c'est l'absence de cette règle qui avait rendu deux
 * dossiers invisibles pendant des jours — jamais relancés, jamais comptés, et
 * signalés nulle part puisqu'ils n'apparaissaient pas.
 */
export function CompaniesView() {
  const { data, error, reload } = useLive<{ generatedAt: string; companies: CompanyRow[] }>(
    () => cc.companies(),
    { intervalMs: 20_000 },
  );
  const [filter, setFilter] = useState('');
  const [onlyDue, setOnlyDue] = useState(false);

  if (error) {
    return (
      <div className="cc">
        <CcHead title="Entreprises" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="Entreprises" />
        <div className="cc-body"><Empty>Lecture du registre…</Empty></div>
      </div>
    );
  }

  const term = filter.trim().toLowerCase();
  const rows = data.companies
    .filter((r) => (onlyDue ? r.followUpDue : true))
    .filter((r) => (term === '' ? true : `${r.name} ${r.domain} ${r.state}`.toLowerCase().includes(term)));

  return (
    <div className="cc">
      <CcHead title="Entreprises" generatedAt={data.generatedAt} onReload={reload} />
      <div className="cc-body">
        <Panel
          title="Registre global"
          note={`${rows.length} / ${data.companies.length}`}
          actions={
            <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
              <input
                className="cc-btn"
                placeholder="filtrer…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{ width: 180 }}
              />
              <button
                type="button"
                className={`cc-btn${onlyDue ? ' cc-btn--primary' : ''}`}
                onClick={() => setOnlyDue(!onlyDue)}
              >
                relances dues
              </button>
            </div>
          }
        >
          <div className="cc-scroll">
            <table className="cc-table">
              <thead>
                <tr>
                  <th>Entreprise</th><th>Domaine</th><th>État</th>
                  <th>Contacté</th><th>Dernier envoi</th><th>Réponse</th>
                  <th className="cc-num">Relances</th><th>Due</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.domain} className="cc-clickable">
                    <td><Link to={`/cc/companies/${r.domain}`}>{r.name}</Link></td>
                    <td className="cc-dim">{r.domain}</td>
                    <td><Badge state={r.state}>{r.state}</Badge></td>
                    <td className="cc-dim">{r.contactedOn}</td>
                    <td className="cc-dim">{day(r.lastOutboundAt)}</td>
                    <td className="cc-dim">{day(r.lastHumanReplyAt)}</td>
                    <td className="cc-num">{r.followUpsSent}</td>
                    <td>{r.followUpDue ? <Badge state="DEGRADED">oui</Badge> : <span className="cc-faint">non</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && <Empty>Aucune entreprise ne correspond.</Empty>}
        </Panel>
      </div>
    </div>
  );
}

/**
 * Le dossier d'une entreprise : son histoire, jamais réécrite.
 *
 * L'écran lit ; il ne propose aucune action qui modifierait l'historique. Une
 * correction passe par un événement d'audit consigné, avec son auteur et son
 * motif — pas par une retouche silencieuse depuis une page web.
 */
export function CompanyDetailView() {
  const { domain = '' } = useParams();
  const { data, error, reload } = useLive<CompanyDetail>(
    () => cc.company(domain),
    { intervalMs: 20_000, deps: [domain] },
  );

  if (error) {
    return (
      <div className="cc">
        <CcHead title={domain} onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title={domain} />
        <div className="cc-body"><Empty>Lecture du dossier…</Empty></div>
      </div>
    );
  }

  return (
    <div className="cc">
      <CcHead title={data.name} generatedAt={data.generatedAt} onReload={reload} />
      <div className="cc-body">
        <dl className="cc-stats">
          <Stat label="Relances envoyées" value={data.followUpsSent} />
          <Stat label="Événements" value={data.events.length} />
        </dl>

        <Panel title="Registre" note={data.ledger.kind}>
          <table className="cc-table">
            <tbody>
              <tr><td>Domaine</td><td className="cc-dim">{data.domain}</td></tr>
              <tr><td>Consigné par</td><td className="cc-dim">{data.ledger.recordedBy}</td></tr>
              <tr><td>Le</td><td className="cc-dim">{moment(data.ledger.recordedAt)}</td></tr>
              <tr><td>Dernier envoi</td><td className="cc-dim">{moment(data.lastOutboundAt)}</td></tr>
              {data.ledger.note ? (
                <tr><td>Note</td><td className="cc-dim">{data.ledger.note}</td></tr>
              ) : null}
            </tbody>
          </table>
        </Panel>

        <Panel title="Historique" note="append-only — rien ne se réécrit">
          {data.events.length === 0 ? (
            <Empty>Aucun événement. L’entreprise a été contactée hors du système de messagerie.</Empty>
          ) : (
            <div className="cc-scroll">
              {data.events.map((e, i) => (
                <div className="cc-msg" key={`${e.at}-${i}`}>
                  <div className="cc-m-top">
                    <Badge state={e.classification === 'REPLIED' ? 'HEALTHY' : e.classification === 'BOUNCED' ? 'OFFLINE' : 'DEGRADED'}>
                      {e.classification}
                    </Badge>
                    <span className="cc-faint">{moment(e.at)}</span>
                    {e.humanReviewed ? <Badge state="HEALTHY">jugé par un humain</Badge> : null}
                    <span className="cc-spacer" />
                    <span className="cc-faint">{e.source}</span>
                  </div>
                  {e.sender ? <div className="cc-m-subject">de {e.sender}</div> : null}
                  {e.subject ? <div className="cc-m-subject">{e.subject}</div> : null}
                  {e.excerpt ? <div className="cc-m-excerpt">{e.excerpt}</div> : null}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

/**
 * La boîte de réception commerciale.
 *
 * Seulement ce qui touche la prospection. Une boîte personnelle contient
 * surtout autre chose — lettres d'information, factures, démarchage — et les
 * mêler aux réponses de prospects rendrait la vue illisible le jour où elle
 * compte vraiment.
 */
export function InboxView() {
  const { data, error, reload } = useLive<Inbox>(() => cc.inbox(), { intervalMs: 15_000 });
  const [tab, setTab] = useState<'humanReplies' | 'autoReplies' | 'bounces' | 'needsAction'>('humanReplies');

  if (error) {
    return (
      <div className="cc">
        <CcHead title="Inbox" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="Inbox" />
        <div className="cc-body"><Empty>Lecture des conversations…</Empty></div>
      </div>
    );
  }

  const labels: Record<typeof tab, string> = {
    humanReplies: 'Réponses humaines',
    autoReplies: 'Réponses automatiques',
    bounces: 'Non délivrés',
    needsAction: 'À qualifier',
  };
  const messages = data.categories[tab];

  return (
    <div className="cc">
      <CcHead title="Inbox" generatedAt={data.generatedAt} onReload={reload} />
      <div className="cc-body">
        <dl className="cc-stats">
          <Stat label="Réponses humaines" value={data.categories.humanReplies.length} />
          <Stat label="Automatiques" value={data.categories.autoReplies.length} />
          <Stat label="Non délivrés" value={data.categories.bounces.length} />
          <Stat label="À qualifier" value={data.categories.needsAction.length} />
          <Stat label="Non rattachés" value={data.unmatched} hint="hors vue principale" />
        </dl>

        <Panel
          title={labels[tab]}
          note={`${messages.length} message(s)`}
          actions={
            <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.35rem' }}>
              {(Object.keys(labels) as Array<typeof tab>).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`cc-btn${tab === key ? ' cc-btn--primary' : ''}`}
                  onClick={() => setTab(key)}
                >
                  {labels[key]}
                </button>
              ))}
            </div>
          }
        >
          {messages.length === 0 ? (
            <Empty>Rien dans cette catégorie.</Empty>
          ) : (
            <div className="cc-scroll">
              {messages.map((m, i) => (
                <div className="cc-msg" key={`${m.at}-${i}`}>
                  <div className="cc-m-top">
                    <Link to={`/cc/companies/${m.domain}`} className="cc-m-company">{m.company}</Link>
                    <span className="cc-faint">{moment(m.at)}</span>
                    {m.humanReviewed ? <Badge state="HEALTHY">jugé</Badge> : null}
                  </div>
                  {m.sender ? <div className="cc-m-subject">de {m.sender}</div> : null}
                  {m.subject ? <div className="cc-m-subject">{m.subject}</div> : null}
                  {m.excerpt ? <div className="cc-m-excerpt">{m.excerpt}</div> : null}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

/**
 * Les décisions humaines en attente.
 *
 * L'écran montre ce qui partirait et pourquoi. Il n'approuve pas : approuver
 * depuis une page web sans repasser par les gardes du pipeline reviendrait à
 * créer un second chemin d'envoi, et un second chemin finit toujours par être
 * celui qui oublie une vérification. La commande exacte est donnée à la place.
 */
export function ApprovalsView() {
  const { data, error, reload } = useLive<Approvals>(() => cc.approvals(), { intervalMs: 10_000 });

  if (error) {
    return (
      <div className="cc">
        <CcHead title="Approbations" onReload={reload} />
        <div className="cc-body"><p className="cc-alert">{error}</p></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="cc">
        <CcHead title="Approbations" />
        <div className="cc-body"><Empty>Lecture des brouillons…</Empty></div>
      </div>
    );
  }

  return (
    <div className="cc">
      <CcHead
        title="Approbations"
        generatedAt={data.generatedAt}
        onReload={reload}
        extra={<Badge state={data.humanApprovalRequired ? 'HEALTHY' : 'BLOCKED'}>
          {data.humanApprovalRequired ? 'approbation exigée' : 'GARDE DÉSACTIVÉE'}
        </Badge>}
      />
      <div className="cc-body">
        <dl className="cc-stats">
          <Stat label="Actionnables" value={data.pending.length} glyph="⚑" />
          <Stat label="Email" value={data.byChannel.EMAIL} tone={data.byChannel.EMAIL > 0 ? 'ok' : undefined} glyph="✉" />
          <Stat label="Formulaire" value={data.byChannel.FORM} glyph="▤" />
          <Stat label="Téléphone" value={data.byChannel.PHONE} glyph="☏" />
          <Stat label="Manuel" value={data.byChannel.MANUAL} tone={data.byChannel.MANUAL > 0 ? 'warn' : undefined} />
          <Stat label="Sans canal" value={data.byChannel.UNAVAILABLE} tone={data.byChannel.UNAVAILABLE > 0 ? 'bad' : undefined} />
          <Stat
            label="Cross-domain"
            value={data.byDomainMatch.CROSS_DOMAIN}
            tone={data.byDomainMatch.CROSS_DOMAIN > 0 ? 'warn' : undefined}
            hint="à vérifier avant approbation"
          />
          <Stat label="Écartés" value={data.excluded.length} hint="conservés à l'historique" />
        </dl>

        {data.pending.length === 0 ? (
          <Panel title="Rien en attente">
            <Empty>
              Aucun brouillon à relire. Un message ne peut pas partir sans passer par ici.
            </Empty>
          </Panel>
        ) : (
          data.pending.map((d) => (
            <Panel key={d.id} title={d.company} note={d.domain}>
              <table className="cc-table">
                <tbody>
                  <tr>
                    <td>Statut</td>
                    <td>
                      <Badge state="HEALTHY">{d.uiStatus}</Badge>
                      {' '}
                      <span className="cc-faint">état réel : {d.sourceState}</span>
                    </td>
                  </tr>
                  <tr>
                    <td>Action</td>
                    <td>
                      <Badge state={d.actionType === 'EMAIL' ? 'HEALTHY'
                        : d.actionType === 'UNAVAILABLE' ? 'BLOCKED' : 'DEGRADED'}>
                        {d.actionType}
                      </Badge>
                      {' '}
                      <span className="cc-dim">{d.actionLabel}</span>
                    </td>
                  </tr>
                  <tr><td>Source</td><td className="cc-dim">{d.source}</td></tr>
                  <tr>
                    <td>Canal</td>
                    <td className="cc-dim">
                      {d.channelTarget ?? <span className="cc-na">N/A</span>}
                      <span className="cc-faint"> — {d.channelReason}</span>
                    </td>
                  </tr>
                  {d.actionType === 'EMAIL' && (
                    <tr>
                      <td>Domaine</td>
                      <td>
                        <Badge state={d.recipientDomainMatch === 'MATCH' ? 'HEALTHY' : 'DEGRADED'}>
                          {d.recipientDomainMatch === 'MATCH' ? 'DOMAIN MATCH'
                            : d.recipientDomainMatch === 'CROSS_DOMAIN' ? 'CROSS-DOMAIN' : 'UNKNOWN'}
                        </Badge>
                        {d.recipientDomainMatch === 'CROSS_DOMAIN' && (
                          <span className="cc-dim"> CROSS-DOMAIN RECIPIENT — VERIFY BEFORE APPROVAL</span>
                        )}
                        {d.relatedDomainEvidence && (
                          <span className="cc-faint"> · preuve : {d.relatedDomainEvidence}</span>
                        )}
                        <div className="cc-faint" style={{ fontSize: '0.68rem' }}>{d.domainReason}</div>
                      </td>
                    </tr>
                  )}
                  {d.subject ? <tr><td>Objet</td><td>{d.subject}</td></tr> : null}
                  <tr><td>Gardes</td><td className="cc-dim">{d.guards.join(' · ') || '—'}</td></tr>
                  <tr><td>Faits sourcés</td><td className="cc-num">{d.facts.length}</td></tr>
                  <tr><td>Créé</td><td className="cc-dim">{d.createdBy ? d.createdBy + ' · ' : ''}{moment(d.createdAt)}</td></tr>
                </tbody>
              </table>
              <pre style={{
                marginTop: '0.7rem', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-sans)',
                fontSize: '0.78rem', color: 'var(--cc-ink)', background: 'var(--cc-void)',
                border: '1px solid var(--cc-line)', borderRadius: 3, padding: '0.7rem', margin: 0,
              }}>{d.body}</pre>
              {/*
                * Le geste proposé suit le canal réel.
                *
                * Un bouton d'envoi sur un dossier dont le seul canal est un
                * numéro de téléphone annonce une action qui n'existe pas :
                * quatre des dix dossiers en attente sont dans ce cas. Ils
                * portent donc « action manuelle », pas un bouton grisé qui
                * laisserait croire qu'il suffirait de l'activer.
                */}
              <div className="cc-actions">
                {d.actionType === 'EMAIL' ? (
                  <>
                    <button type="button" className="cc-btn cc-btn--ok" disabled title="ACTION ENDPOINT UNAVAILABLE">
                      APPROVE
                    </button>
                    <button type="button" className="cc-btn cc-btn--bad" disabled title="ACTION ENDPOINT UNAVAILABLE">
                      REJECT
                    </button>
                    <Badge state="HEALTHY">EMAIL READY</Badge>
                    <Badge state="DEGRADED">ACTION ENDPOINT UNAVAILABLE</Badge>
                  </>
                ) : (
                  <Badge state={d.actionType === 'UNAVAILABLE' ? 'BLOCKED' : 'DEGRADED'}>
                    {d.actionLabel}
                  </Badge>
                )}
              </div>
              <p className="cc-faint" style={{ fontSize: '0.72rem', marginTop: '0.6rem' }}>
                {d.actionType !== 'EMAIL' && (
                  <>Ce dossier n’a pas de canal électronique : la décision se prend, l’exécution
                  se fait à la main. </>
                )}
                Aucun endpoint de mutation n’existe pour approuver depuis le navigateur, et
                l’écran n’en fabrique pas : une seconde voie d’envoi finirait par être celle
                qui oublie une garde. L’approbation se donne par la commande, qui repasse par
                toutes les vérifications :
              </p>
              <code className="cc-code">npm run sales:approve -- {d.id}</code>
            </Panel>
          ))
        )}
        {data.excluded.length > 0 && (
          <Panel title={`Écartés de la file — ${data.excluded.length}`} note="conservés à l'historique">
            <table className="cc-table">
              <thead>
                <tr><th>Entreprise</th><th>Domaine</th><th>Source</th><th>État réel</th><th>Motif</th></tr>
              </thead>
              <tbody>
                {data.excluded.map((e) => (
                  <tr key={`${e.source}-${e.id}`}>
                    <td>{e.company}</td>
                    <td className="cc-dim">{e.domain}</td>
                    <td className="cc-faint">{e.source}</td>
                    <td className="cc-faint">{e.sourceState}</td>
                    <td className="cc-dim">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </div>
    </div>
  );
}
