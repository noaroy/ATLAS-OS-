/**
 * La fiche que le fondateur lit avant de décider.
 *
 * Entièrement déterministe : tout sort de la base, rien n'est reformulé, aucun
 * appel modèle. Ce qui manque est écrit comme manquant — un contact absent
 * s'affiche NONE, jamais reconstruit. Une adresse inventée se repère en dix
 * secondes et disqualifie tout le reste de la fiche.
 */
import { createLogger } from '../packages/core/src/logger.ts';
import { createRepositories } from '../packages/data/src/index.ts';

const batchId = process.argv[2];
if (!batchId) throw new Error('usage: founder-pack <batch-id> [domaine…]');
const only = process.argv.slice(3).filter((a) => !a.startsWith('--'));

const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(process.env.ATLAS_DB_PATH ?? 'data/atlas.db', logger);

const prospects = repos.sales
  .forBatch(batchId)
  .filter((p) => (only.length === 0 ? p.tier === 'PRIORITY' : only.includes(p.domain ?? '')))
  .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

if (prospects.length === 0) throw new Error(`aucun prospect retenu pour « ${batchId} »`);

const line = (label: string, value: string) => console.log(`${label.padEnd(24)}${value}`);

console.log(`FOUNDER REVIEW PACK — ${batchId} — ${prospects.length} fiche(s)`);
console.log('Aucun message envoyé. Aucune donnée reformulée.\n');

for (const p of prospects) {
  const evidence = repos.sales.evidenceFor(p.id);
  const observed = evidence.filter((e) => e.nature === 'observed' && e.sourceUrl);
  const verdict = repos.sales.outreachEligibility(p.id);
  const perso = evidence.find((e) => e.id === p.personalizationFactId) ?? null;

  console.log('─'.repeat(76));
  line('COMPANY', p.companyName);
  line('OFFICIAL WEBSITE', p.website ?? '—');
  line('IDENTITY CONFIDENCE', p.identityConfidence != null ? p.identityConfidence.toFixed(2) : 'non résolue');
  line('IDENTITY SOURCES', p.identitySources?.join(' · ') ?? '—');
  line('ICP MATCH REASON', p.whyFit?.trim() || '— (aucune justification enregistrée)');

  // Trois faits observés au plus. Les places vides restent vides.
  for (let i = 0; i < 3; i++) {
    const fact = observed[i];
    if (!fact && i >= 2) break;
    line(
      `OBSERVED FACT ${i + 1}`,
      fact ? fact.claim : '— (aucun fait observé supplémentaire)',
    );
    if (fact) line('  URL', fact.sourceUrl!);
  }

  // Le canal de contact : ce qui a été trouvé publié, et rien d'autre.
  const channel = p.contactEmail
    ? `EMAIL · ${p.contactEmail}`
    : p.contactPhone
      ? `PHONE · ${p.contactPhone}`
      : p.contactPage
        ? `WEBSITE_FORM · ${p.contactPage}`
        : 'NONE';
  line('PUBLIC CONTACT CHANNEL', channel);
  if (channel === 'NONE') {
    line('  CONTACT METHOD', 'NONE — aucun canal public relevé. Rien n’a été reconstruit.');
  }
  if (p.contactName) line('  NAMED CONTACT', `${p.contactName}${p.contactRole ? ` · ${p.contactRole}` : ''}`);

  line('PERSONALIZATION', perso ? perso.claim : '— (aucune personnalisation sourcée)');
  if (perso?.sourceUrl) line('  SOURCE', perso.sourceUrl);
  line('SCORE', `${p.score ?? '—'} · ${p.tier ?? '—'}`);
  line('OUTREACH ELIGIBILITY', verdict.eligibility);
  if (verdict.eligibility !== 'ELIGIBLE') {
    for (const blocker of verdict.blockers) console.log(`  ✗ ${blocker}`);
  } else {
    console.log(`  ${verdict.reason}`);
  }
  console.log(`STATE                 ${p.state} · approbation réservée à un humain nommé`);
  console.log('');
}

console.log('─'.repeat(76));
console.log('MESSAGES SENT: 0');
repos.close();
