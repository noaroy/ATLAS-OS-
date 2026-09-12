/**
 * Consigner un envoi ou une mise à l'écart, au niveau de l'entreprise.
 *
 * Le registre vit au-dessus des lots : une entreprise n'existe qu'une fois,
 * même si trois passes de prospection la retrouvent. Il n'écrit rien dans les
 * lots eux-mêmes et n'appelle ni modèle ni recherche.
 *
 *   record-outreach contacted seraap.com --by=noaroy --channel=email
 *   record-outreach skip semso.com --by=noaroy --note="abandonné volontairement"
 *   record-outreach show seraap.com
 */
import { createLogger, canonicalDomainOf, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';

// Avant toute lecture de process.env : sans cet appel, `.env.local` n'existe
// pas pour ce processus et la configuration parait absente sans qu'aucune
// erreur ne le dise.
loadAtlasEnv();

const [action, domain] = process.argv.slice(2);
const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

if (!action || (!domain && action !== 'ledger')) {
  throw new Error(
    'usage: record-outreach <contacted|skip|show|ledger> <domaine> ' +
      '[--by=] [--channel=] [--note=] [--follow-up=AAAA-MM-JJ]',
  );
}

const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(process.env.ATLAS_DB_PATH ?? 'data/atlas.db', logger);
const canonical = canonicalDomainOf(domain ?? '');

if (action === 'ledger') {
  // Le registre entier : une ligne par entreprise, et ce qu'ATLAS en fera.
  const domains = repos.sales.ledgerDomains();
  console.log(`REGISTRE GLOBAL — ${domains.length} entreprise(s)
`);
  console.log(
    `${'DOMAINE'.padEnd(24)}${'STATUT'.padEnd(17)}${'RELANCE'.padEnd(13)}${'ENTRÉES'.padEnd(9)}NOTE`,
  );
  for (const entry of domains) {
    console.log(
      `${entry.domain.padEnd(24)}${entry.kind.padEnd(17)}` +
        `${(entry.followUpAt ?? '—').padEnd(13)}${String(entry.entries).padEnd(9)}${entry.note ?? ''}`,
    );
  }

  console.log();
  console.log('EFFET SUR LES PROSPECTS');
  const seen = new Set<string>();
  for (const batchId of repos.sales.batchIds()) {
    for (const p of repos.sales.forBatch(batchId)) {
      const key = canonicalDomainOf(p.domain ?? '');
      if (!key || seen.has(key)) continue;
      const verdict = repos.sales.outreachEligibility(p.id);
      if (verdict.eligibility === 'ELIGIBLE' || verdict.eligibility === 'BLOCKED') continue;
      if (verdict.eligibility === 'PENDING_RESOLUTION') continue;
      seen.add(key);
      console.log(`  ${p.companyName.slice(0, 28).padEnd(30)}${key.padEnd(24)}${verdict.eligibility}`);
    }
  }
} else if (action === 'show') {
  const history = repos.sales.ledgerHistory(canonical);
  const verdict = repos.sales.ledgerFor(canonical);
  console.log(`REGISTRE — ${canonical}`);
  if (history.length === 0) console.log('  aucune entrée.');
  for (const entry of history) {
    console.log(
      `  ${entry.recordedAt.slice(0, 19).replace('T', ' ')}  ${entry.kind.padEnd(15)}` +
        `${(entry.channel ?? '—').padEnd(12)}${entry.recordedBy}` +
        `${entry.note ? `  « ${entry.note} »` : ''}` +
        `${entry.followUpAt ? `  relance ${entry.followUpAt}` : ''}`,
    );
  }
  console.log(`  verdict courant : ${verdict?.kind ?? 'aucun'}`);
} else {
  const by = flag('by');
  if (!by) throw new Error('--by= est obligatoire : une décision anonyme ne se conteste pas.');
  const kind = action === 'contacted' ? 'CONTACTED' : action === 'skip' ? 'DO_NOT_CONTACT' : null;
  if (!kind) throw new Error(`action inconnue : « ${action} ». Attendu contacted, skip ou show.`);

  const outcome = repos.sales.recordOutreach({
    domain: canonical,
    kind,
    recordedBy: by,
    channel: flag('channel'),
    note: flag('note'),
    followUpAt: flag('follow-up'),
  });
  console.log(outcome.recorded ? `${canonical} → ${kind}  (par ${by})` : `${outcome.reason}`);

  // L'effet immédiat, sur toutes les lignes de tous les lots.
  for (const batchId of repos.sales.batchIds()) {
    for (const p of repos.sales.forBatch(batchId)) {
      if (canonicalDomainOf(p.domain ?? '') !== canonical) continue;
      console.log(
        `  ${batchId}  ${p.companyName.slice(0, 32).padEnd(34)}` +
          `${(p.tier ?? '—').padEnd(9)} → ${repos.sales.outreachEligibility(p.id).eligibility}`,
      );
    }
  }
}

repos.close();
