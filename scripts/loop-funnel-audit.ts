/**
 * Où la boucle de prospection perd ses prospects.
 *
 * Un lot annonce « 10 qualifiés, 0 brouillon » sans dire ce qui s'est passé
 * entre les deux. Chaque garde franchie est invisible ; seule la dernière
 * refusée se voit, et on la corrige en croyant avoir trouvé la cause — alors
 * qu'une garde en amont éliminait déjà quatre fois plus de dossiers.
 *
 * Ce script compte. Il ne corrige rien et n'écrit rien : il rejoue les gardes
 * réelles sur les données déjà collectées, étape par étape, et attribue chaque
 * perte à une cause. Les gardes ne sont pas réimplémentées — `checkPriorityEligibility`
 * et `classifyActionChannel` sont appelées, pas recopiées, sans quoi l'audit
 * finirait par valider sa propre version de la règle.
 *
 *   npm run loop:funnel                 les 5 derniers lots
 *   npm run loop:funnel -- --batches=8  davantage
 */
import { loadConfig, loadAtlasEnv, createLogger } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  checkPriorityEligibility, SALES_TIER_THRESHOLDS, classifyActionChannel,
} from '../packages/departments/src/index.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m',
};

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const COMBIEN = Number(arg('batches') ?? 5);

const config = loadConfig(process.cwd());
const repos = createRepositories(config.paths.databaseFile, createLogger({ level: 'error', pretty: false }));

/**
 * Les causes de perte, nommées.
 *
 * `EXPECTED_FILTER` n'est pas un échec : un prospect hors cible éliminé tôt est
 * exactement ce que la boucle doit faire, et le compter comme une panne ferait
 * chercher un bug là où le système fonctionne.
 */
type Cause =
  | 'EXPECTED_FILTER' | 'MISSING_DATA' | 'FETCH_FAILURE' | 'IDENTITY_FAILURE'
  | 'CONTACT_FAILURE' | 'ENRICHMENT_FAILURE' | 'BUG' | 'OTHER';

interface Etape { nom: string; passe: number }

/*
 * Les lots, du plus ancien au plus recent — par leur date reelle.
 *
 * `batchIds` trie sur l'identifiant, c'est-a-dire alphabetiquement : le suffixe
 * aleatoire departage deux lots du meme jour, et un lot nomme `HISTORIQUE-`
 * passe avant tous les `BATCH-`. Deux tris successifs ont ainsi designe cinq
 * lots qui n'etaient pas les cinq derniers, et l'entonnoir decrivait un systeme
 * qui n'existait plus. La date de decouverte, elle, ne ment pas.
 */
const lots = repos.sales
  .batchIds()
  .map((id) => {
    const p = repos.sales.forBatch(id);
    const dernier = p.length === 0
      ? ''
      : p.map((x) => x.discoveredAt).reduce((a, b) => (a >= b ? a : b));
    return { id, dernier };
  })
  .filter((b) => b.dernier !== '')
  .sort((a, b) => (a.dernier < b.dernier ? -1 : 1))
  .slice(-COMBIEN)
  .map((b) => b.id);

console.log(`\n  ${c.bold}${c.cyan}ENTONNOIR DE LA BOUCLE${c.reset}`);
console.log(`  ${c.dim}${lots.length} lot(s) · lecture seule · aucune écriture${c.reset}\n`);

const pertesGlobales = new Map<string, { cause: Cause; n: number }>();
const perdu = (etape: string, cause: Cause, n = 1) => {
  const cle = `${etape} · ${cause}`;
  const e = pertesGlobales.get(cle) ?? { cause, n: 0 };
  e.n += n;
  pertesGlobales.set(cle, e);
};

const total: Record<string, number> = {
  DISCOVER: 0, QUALIFIED: 0, PRIORITY: 0, CONTACTABLE: 0,
  IDENTITY_VERIFIED: 0, FACTS_2: 0, DRAFT_ELIGIBLE: 0, READY_FOR_REVIEW: 0,
};

for (const batch of lots) {
  const prospects = repos.sales.forBatch(batch);
  const etapes: Etape[] = [];
  const ajoute = (nom: string, passe: number) => {
    etapes.push({ nom, passe });
    total[nom] = (total[nom] ?? 0) + passe;
  };

  ajoute('DISCOVER', prospects.length);

  const qualifies = prospects.filter((p) => p.score !== null && p.state !== 'DISCOVERED');
  ajoute('QUALIFIED', qualifies.length);
  // Un candidat écarté avant la qualification l'a été par le tri : c'est le
  // travail de la boucle, pas une perte.
  perdu('DISCOVER→QUALIFIED', 'EXPECTED_FILTER', prospects.length - qualifies.length);

  const priority = qualifies.filter((p) => (p.score ?? 0) >= SALES_TIER_THRESHOLDS.priority);
  ajoute('PRIORITY', priority.length);
  perdu('QUALIFIED→PRIORITY', 'EXPECTED_FILTER', qualifies.length - priority.length);

  const contactables = priority.filter((p) => {
    const v = classifyActionChannel({
      email: p.contactEmail, phone: p.contactPhone, formUrl: p.contactPage,
      recordedMethod: p.contactMethod, observed: p.contactObserved,
    });
    return v.channel !== 'UNAVAILABLE' && v.channel !== 'MANUAL';
  });
  ajoute('CONTACTABLE', contactables.length);
  for (const p of priority) {
    if (contactables.includes(p)) continue;
    // Aucun canal relevé : soit le site n'en publie pas, soit les pages n'ont
    // pas pu être lues. La distinction se fait sur la présence d'une preuve.
    const aLuDesPages = repos.sales.evidenceFor(p.id).some((e) => e.sourceUrl);
    perdu('PRIORITY→CONTACTABLE', aLuDesPages ? 'CONTACT_FAILURE' : 'FETCH_FAILURE');
  }

  const identites = contactables.filter((p) => {
    if (p.identityConfidence === null || !p.domain) return false;
    const check = checkPriorityEligibility({
      identity: {
        companyName: p.companyName, canonicalDomain: p.domain,
        officialWebsite: p.website ?? `https://${p.domain}`, country: p.country,
        identityConfidence: p.identityConfidence, identitySources: p.identitySources ?? [],
      },
      pageType: (p.pageType as 'OFFICIAL_COMPANY_SITE') ?? 'UNKNOWN',
      icp: 'MATCH',
      // On isole l'identité : les faits sont comptés à l'étape suivante.
      observedFacts: 2, score: p.score ?? 0,
      scoreThreshold: SALES_TIER_THRESHOLDS.priority, hasSourcedPersonalization: true,
    });
    return !check.blockers.some((b) => /identit|nom et domaine|page de type/.test(b));
  });
  ajoute('IDENTITY_VERIFIED', identites.length);
  perdu('CONTACTABLE→IDENTITY', 'IDENTITY_FAILURE', contactables.length - identites.length);

  const avecFaits = identites.filter((p) => {
    const n = repos.sales
      .evidenceFor(p.id)
      .filter((e) => e.nature === 'observed' && e.sourceUrl && !e.field.startsWith('identite:'))
      .length;
    return n >= 2;
  });
  ajoute('FACTS_2', avecFaits.length);
  perdu('IDENTITY→FACTS', 'ENRICHMENT_FAILURE', identites.length - avecFaits.length);

  const eligibles = avecFaits.filter((p) => {
    const faits = repos.sales
      .evidenceFor(p.id)
      .filter((e) => e.nature === 'observed' && e.sourceUrl && !e.field.startsWith('identite:'))
      .length;
    const check = checkPriorityEligibility({
      identity: p.identityConfidence !== null && p.domain
        ? {
            companyName: p.companyName, canonicalDomain: p.domain,
            officialWebsite: p.website ?? `https://${p.domain}`, country: p.country,
            identityConfidence: p.identityConfidence, identitySources: p.identitySources ?? [],
          }
        : null,
      pageType: (p.pageType as 'OFFICIAL_COMPANY_SITE') ?? 'UNKNOWN',
      icp: 'MATCH', observedFacts: faits, score: p.score ?? 0,
      scoreThreshold: SALES_TIER_THRESHOLDS.priority, hasSourcedPersonalization: faits > 0,
    });
    return check.eligible;
  });
  ajoute('DRAFT_ELIGIBLE', eligibles.length);
  perdu('FACTS→ELIGIBLE', 'OTHER', avecFaits.length - eligibles.length);

  const prets = prospects.filter((p) => p.state === 'READY_FOR_REVIEW');
  ajoute('READY_FOR_REVIEW', prets.length);
  /*
   * Un dossier éligible qui n'est jamais devenu READY_FOR_REVIEW n'a pas été
   * refusé par une garde : il a été perdu. C'est la signature d'un défaut, et
   * c'est la seule catégorie où le mot « bug » est justifié.
   */
  if (eligibles.length > prets.length) {
    perdu('ELIGIBLE→READY', 'BUG', eligibles.length - prets.length);
  }

  const debut = prospects.length > 0
    ? prospects.map((p) => p.discoveredAt).reduce((a, b) => (a <= b ? a : b)).slice(0, 10)
    : '—';
  console.log(`  ${c.bold}${batch}${c.reset} ${c.dim}${debut}${c.reset}`);
  console.log('    ' + etapes.map((e) => `${e.nom} ${e.passe}`).join(`  ${c.dim}→${c.reset}  `));
}

// ── L'entonnoir cumulé ────────────────────────────────────────────────────
console.log(`\n  ${c.bold}CUMUL SUR ${lots.length} LOTS${c.reset}`);
const ordre = ['DISCOVER', 'QUALIFIED', 'PRIORITY', 'CONTACTABLE', 'IDENTITY_VERIFIED', 'FACTS_2', 'DRAFT_ELIGIBLE', 'READY_FOR_REVIEW'];
let precedent: number | null = null;
for (const nom of ordre) {
  const n = total[nom] ?? 0;
  const chute = precedent === null || precedent === 0 ? '' :
    `${c.dim}−${precedent - n} (${Math.round(((precedent - n) / precedent) * 100)} %)${c.reset}`;
  console.log(`    ${nom.padEnd(20)}${String(n).padStart(4)}  ${chute}`);
  precedent = n;
}

// ── Les goulots ───────────────────────────────────────────────────────────
console.log(`\n  ${c.bold}CAUSES DE PERTE${c.reset}`);
const totalPertes = [...pertesGlobales.values()].reduce((s, e) => s + e.n, 0);
const classees = [...pertesGlobales.entries()]
  .filter(([, e]) => e.n > 0)
  .sort((a, b) => b[1].n - a[1].n);
for (const [cle, e] of classees) {
  const part = totalPertes === 0 ? 0 : Math.round((e.n / totalPertes) * 100);
  const teinte = e.cause === 'EXPECTED_FILTER' ? c.dim : e.cause === 'BUG' ? c.red : c.amber;
  console.log(`    ${teinte}${String(e.n).padStart(4)}  ${String(part).padStart(3)} %  ${cle}${c.reset}`);
}

console.log(`\n  ${c.bold}GOULOTS HORS FILTRAGE ATTENDU${c.reset}`);
const reels = classees.filter(([, e]) => e.cause !== 'EXPECTED_FILTER');
const totalReels = reels.reduce((s, [, e]) => s + e.n, 0);
if (reels.length === 0) {
  console.log(`    ${c.green}aucune perte hors filtrage${c.reset}`);
} else {
  reels.slice(0, 3).forEach(([cle, e], i) => {
    const part = totalReels === 0 ? 0 : Math.round((e.n / totalReels) * 100);
    console.log(`    #${i + 1} ${cle} = ${part} %  ${c.dim}(${e.n} dossier(s))${c.reset}`);
  });
}

console.log(`\n  ${c.dim}MESSAGES SENT : ${repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z')} — ce script n'envoie rien${c.reset}\n`);
repos.close();
