/**
 * Reclasser les faits dont la source sort du domaine officiel.
 *
 * Le lot 005 a attribué « PME française fondée en 1976 à La Rochelle » à
 * `groupe-ravel.com` pour une entreprise dont le domaine est
 * `groupe-reval.com`. Une lettre d'écart suffit à rendre le fait invérifiable :
 * on ne sait plus si c'est une faute de frappe du modèle ou une autre société.
 *
 * La règle appliquée est celle du pipeline corrigé : un fait « observé » l'est
 * sur le site de l'entreprise, ou il ne l'est pas. Rien n'est supprimé — le
 * fait devient rapporté, sa source revient à celle qu'on connaît, et le motif
 * est écrit dans `basis`. Aucun appel modèle.
 */
import { createLogger, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { isOfficialPage } from '../packages/departments/src/index.ts';

// Avant toute lecture de process.env : sans cet appel, `.env.local` n'existe
// pas pour ce processus et la configuration parait absente sans qu'aucune
// erreur ne le dise.
loadAtlasEnv();

const batchId = process.argv[2];
const apply = process.argv.includes('--apply');
if (!batchId) throw new Error('usage: repair-evidence-sources <batch-id> [--apply]');

const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(process.env.ATLAS_DB_PATH ?? 'data/atlas.db', logger);

let reclassified = 0;
for (const prospect of repos.sales.forBatch(batchId)) {
  for (const evidence of repos.sales.evidenceFor(prospect.id)) {
    if (evidence.nature !== 'observed' || !evidence.sourceUrl) continue;
    if (isOfficialPage(evidence.sourceUrl, prospect.domain ?? '')) continue;

    reclassified += 1;
    console.log(`${prospect.companyName} — ${prospect.domain}`);
    console.log(`  « ${evidence.claim.slice(0, 80)} »`);
    console.log(`  source annoncée : ${evidence.sourceUrl}  → hors domaine`);
    if (apply) {
      repos.sales.reclassifyEvidence(evidence.id, {
        nature: 'reported',
        sourceUrl: prospect.sourceUrl ?? prospect.website,
        basis: `Source annoncée « ${evidence.sourceUrl} » hors du domaine officiel : le fait n'est pas constaté sur le site.`,
        confidence: 0.5,
      });
      console.log('  → reclassé « rapporté »');
    }
    console.log('');
  }
}

console.log(`${reclassified} fait(s) concerné(s).`);
if (!apply) console.log('Rien écrit. Ajoutez --apply.');

// Le reclassement peut faire passer un prospect sous les deux faits observés
// exigés : l'éligibilité est donc relue, jamais supposée.
if (apply) {
  for (const prospect of repos.sales.forBatch(batchId)) {
    if (prospect.tier !== 'PRIORITY') continue;
    const verdict = repos.sales.outreachEligibility(prospect.id);
    console.log(`  ${prospect.companyName.slice(0, 32).padEnd(34)}${verdict.eligibility}`);
    if (verdict.eligibility !== 'ELIGIBLE') {
      for (const blocker of verdict.blockers) console.log(`    ✗ ${blocker}`);
    }
  }
}

repos.close();
