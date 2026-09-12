/**
 * Le classement d'acquisition : qui démarcher en premier, et avec quelle phrase.
 *
 * Ne dépense rien. Les contacts sont relevés par lecture des sites officiels,
 * le score de conversion est déterministe, et les brouillons sont assemblés à
 * partir de faits déjà constatés. Aucun appel modèle, aucune recherche.
 *
 * Le tri est celui de l'achat, pas celui de l'adéquation : un équipementier
 * parfaitement qualifié mais sans besoin visible, sans canal propre et dont on
 * ne saurait pas démontrer trois prospects passe derrière une PME moins bien
 * notée qui coche ces trois cases.
 */
import { writeFileSync } from 'node:fs';
import { createLogger, canonicalDomainOf, loadAtlasEnv } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { fetchRawPages } from '../packages/intelligence/src/contact-fetch.ts';
import {
  resolveContacts,
  contactPagesFor,
  contactLinksIn,
  scoreConversion,
  isConversionReady,
  findGrowthSignals,
  cleanQuote,
  readsAsSentence,
  SIGNAL_LABELS,
  type ContactPage,
  type ObservedFact,
} from '../packages/departments/src/index.ts';

// Avant toute lecture de process.env : sans cet appel, `.env.local` n'existe
// pas pour ce processus et la configuration parait absente sans qu'aucune
// erreur ne le dise.
loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', amber: '\x1b[33m', red: '\x1b[31m',
};
const has = (name: string) => process.argv.includes(`--${name}`);
const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(process.env.ATLAS_DB_PATH ?? 'data/atlas.db', logger);
const top = Number(flag('top') ?? 20);

// ── Le vivier : tout ce qui n'a été ni contacté, ni écarté, ni invalidé ──────
const seen = new Set<string>();
const pool = repos.sales
  .batchIds()
  .flatMap((batchId) => repos.sales.forBatch(batchId))
  .filter((p) => {
    const domain = canonicalDomainOf(p.domain ?? '');
    if (!domain || seen.has(domain)) return false;
    // Le registre tranche au niveau de l'entreprise : déjà contactée ou
    // volontairement écartée, elle ne revient pas dans une liste d'acquisition.
    const ledger = repos.sales.ledgerFor(domain);
    if (ledger) return false;
    if (repos.sales.invalidationFor(p.id)) return false;
    // Une ligne jamais passée par la résolution d'identité n'est pas fausse,
    // elle est non vérifiée — et on ne démarche pas sur du non vérifié.
    if (!p.guardVersion) return false;
    seen.add(domain);
    return true;
  });

console.log(`\n  ${c.bold}WAR ROOM — CLASSEMENT D'ACQUISITION${c.reset}`);
console.log(`  ${c.dim}${pool.length} entreprise(s) au vivier · 0 appel modèle · 0 recherche${c.reset}\n`);

// ── Contacts : lus sur les sites officiels, gratuits ─────────────────────────
if (!has('skip-contacts')) {
  console.log(`  ${c.bold}Contacts${c.reset}`);
  for (const prospect of pool) {
    if (has('contacts-only') && prospect.contactObserved && prospect.contactIntent) continue;
    const domain = prospect.domain!;
    const queue = contactPagesFor(prospect.website, domain);
    const visited = new Set<string>();
    const pages: ContactPage[] = [];

    for (let pass = 0; pass < 2; pass++) {
      const batch = queue.filter((u) => !visited.has(u));
      for (const u of batch) visited.add(u);
      if (batch.length === 0) break;
      const fetched = await fetchRawPages(batch, {
        logger, timeoutMs: 10_000, maxPages: Math.max(0, 6 - pages.length),
      });
      pages.push(...fetched.pages);
      if (pass === 0) {
        const home = fetched.pages.find((page) => {
          try { return new URL(page.url).pathname === '/'; } catch { return false; }
        });
        if (home) {
          for (const link of contactLinksIn(home.html, home.url, domain)) {
            if (!visited.has(link)) queue.push(link);
          }
        }
      }
    }

    // Les mêmes pages servent deux fois : les coordonnées, et les signaux
    // commerciaux. La qualification n'en avait relevé aucun — elle cherchait
    // l'adéquation au profil, pas le besoin de clients.
    const known = new Set(repos.sales.evidenceFor(prospect.id).map((e) => e.claim));
    for (const signal of findGrowthSignals(pages)) {
      if (known.has(signal.quote)) continue;
      repos.sales.addEvidence({
        prospectId: prospect.id,
        field: `signal:${signal.kind}`,
        claim: signal.quote,
        nature: 'observed',
        sourceUrl: signal.sourceUrl,
        basis: `relevé littéralement sur la page — motif « ${signal.marker} » (${SIGNAL_LABELS[signal.kind]})`,
        confidence: 0.85,
      });
      known.add(signal.quote);
    }

    const contacts = resolveContacts({ officialDomain: domain, pages });
    if (contacts.primary) {
      repos.sales.setChannels(
        prospect.id,
        [...contacts.publicEmails, ...(contacts.contactFormUrl ? [contacts.contactFormUrl] : []), ...contacts.publicPhones]
          .map((contact) => ({
            type: contact.type, value: contact.value, intent: contact.intent,
            suitability: contact.suitability, sourceUrl: contact.sourceUrl,
            confidence: contact.confidence, selected: contact === contacts.primary,
          })),
      );
      repos.sales.setContact(prospect.id, {
        name: contacts.contactPersonName,
        role: contacts.contactPersonRole,
        email: contacts.primary.type === 'EMAIL' ? contacts.primary.value : null,
        phone: contacts.primary.type === 'PHONE' ? contacts.primary.value : null,
        contactPage: contacts.primary.type === 'FORM' ? contacts.primary.value : null,
        sourceUrl: contacts.primary.sourceUrl,
        confidence: contacts.primary.confidence === 'HIGH' ? 0.9
          : contacts.primary.confidence === 'MEDIUM' ? 0.7 : 0.5,
        method: contacts.method,
        confidenceLabel: contacts.primary.confidence,
        intent: contacts.primary.intent,
        suitability: contacts.primary.suitability,
        observed: true,
      });
    }
    console.log(
      `    ${contacts.primary ? `${c.green}✓${c.reset}` : `${c.dim}·${c.reset}`} ` +
        `${prospect.companyName.slice(0, 30).padEnd(32)}${contacts.method.padEnd(6)} ` +
        `${c.dim}${(contacts.primary?.intent ?? 'aucun canal').slice(0, 20)}${c.reset}`,
    );
  }
  console.log('');
}

// ── Classement ──────────────────────────────────────────────────────────────
const ranked = pool
  .map((prospect) => {
    const fresh = repos.sales.require(prospect.id);
    const evidence = repos.sales.evidenceFor(prospect.id);
    const facts: ObservedFact[] = evidence.map((e) => ({
      claim: e.claim, sourceUrl: e.sourceUrl, nature: e.nature,
    }));

    // La phrase de personnalisation vient d'abord d'une citation littérale du
    // site. Les résumés produits par la qualification sont à la troisième
    // personne — « Propose un programme… » — et donnent « J'ai vu que propose
    // un programme », qui annonce la machine dès la deuxième ligne.
    const quoted =
      evidence
        .filter((e) => e.field.startsWith('signal:') && e.nature === 'observed' && e.sourceUrl)
        .map((e) => ({ ...e, claim: cleanQuote(e.claim) }))
        // Une citation qui commence par une norme ou un fragment de menu
        // n'ouvre pas une conversation : on veut une phrase.
        .filter((e) => readsAsSentence(e.claim))
        // L'ordre des natures compte plus que la longueur : « nous cherchons
        // des distributeurs » ouvre mieux qu'une liste de secteurs, même
        // courte.
        .sort((a, b) => {
          const rank = (field: string) =>
            ['signal:DISTRIBUTION', 'signal:SALES_HIRING', 'signal:EXPORT',
             'signal:NEW_CAPACITY', 'signal:NAMED_MARKETS'].indexOf(field);
          const byKind = rank(a.field) - rank(b.field);
          return byKind !== 0 ? byKind : b.claim.length - a.claim.length;
        })[0] ?? null;
    const score = scoreConversion({
      companyName: fresh.companyName,
      facts,
      contactIntent: fresh.contactIntent,
      contactSuitability: fresh.contactSuitability,
      qualificationScore: fresh.score,
      qualificationTier: fresh.tier,
      whyFit: fresh.whyFit,
    });
    return {
      prospect: fresh,
      quoted,
      score,
      verdict: isConversionReady(score, {
        domain: fresh.domain,
        contactValue: fresh.contactEmail,
      }),
    };
  })
  .sort((a, b) => b.score.total - a.score.total);

const OFFER = {
  preview: 3,
  priceEur: 49,
  signature: 'Noa Roy',
};

const lines: string[] = [];
const say = (text = '') => { lines.push(text); console.log(text); };

say(`  ${c.bold}TOP ${Math.min(top, ranked.length)}${c.reset}  ${c.dim}trié par score de conversion${c.reset}\n`);

let rank = 0;
for (const { prospect, quoted, score, verdict } of ranked.slice(0, top)) {
  rank += 1;
  const best = score.components
    .filter((component) => component.points > 0 && component.basis)
    .sort((a, b) => b.points - a.points)[0];

  const method = prospect.contactMethod ?? 'NONE';
  const destination = prospect.contactEmail ?? prospect.contactPage ?? prospect.contactPhone ?? '—';

  say('─'.repeat(78));
  say(`RANK                 ${rank}`);
  say(`COMPANY              ${prospect.companyName}`);
  say(`WEBSITE              ${prospect.website ?? '—'}`);
  say(`WHY THEY ARE A GOOD BUYER`);
  for (const component of score.components.filter((x) => x.points > 0).slice(0, 3)) {
    say(`  · ${component.label} (${component.points})`);
  }
  say(`OBSERVED SIGNAL      ${best?.basis ?? '— aucun signal constaté'}`);
  say(`  SOURCE             ${best?.sourceUrl ?? '—'}`);
  say(`BEST CONTACT METHOD  ${method}${prospect.contactIntent ? ` · ${prospect.contactIntent}` : ''} · ${destination}`);
  const personal = quoted
    ? { line: quoted.claim, sourceUrl: quoted.sourceUrl }
    : score.personalization;
  say(`PERSONALIZATION LINE ${personal?.line ?? '— aucune, ne pas écrire'}`);
  say(`  PERSO SOURCE       ${personal?.sourceUrl ?? '—'}`);
  say(`CONVERSION SCORE     ${score.total}${verdict.ready ? '' : `   ${c.amber}non prêt : ${verdict.blockers.join(' · ')}${c.reset}`}`);
  say('');

  if (verdict.ready && personal) {
    // Le brouillon n'existe que si la personnalisation est sourcée : un
    // « j'ai vu que… » inventé se repère en dix secondes.
    say('BROUILLON');
    say('  Bonjour,');
    say('');
    // La citation est encadrée plutôt que reformulée : elle reste vraie mot
    // pour mot, et l'encadrement fonctionne quelle que soit la phrase.
    say(`  En parcourant votre site, j'ai relevé : « ${cleanQuote(personal.line)} »`);
    say('');
    say('  Je développe un service qui identifie et qualifie des entreprises B2B');
    say('  sur un marché précis, avec les sources associées.');
    say('');
    say('  Si vous me donnez le type de clients que vous recherchez actuellement,');
    say(`  je peux vous préparer gratuitement ${OFFER.preview} entreprises qualifiées afin que`);
    say('  vous puissiez juger directement la qualité du résultat.');
    say('');
    say(`  Si cela vous convient, le rapport complet est à ${OFFER.priceEur} €, paiement unique.`);
    say('');
    say('  Si vous préférez ne plus recevoir de message de ma part, répondez');
    say('  simplement « stop » : je n\'insisterai pas.');
    say('');
    say('  Bien cordialement,');
    say(`  ${OFFER.signature}`);
    say('');
  }
}

say('─'.repeat(78));
const ready = ranked.filter((r) => r.verdict.ready).length;
say(`vivier ${ranked.length} · prêts à démarcher ${ready} · brouillons ${ready}`);
say('MESSAGES SENT: 0');

writeFileSync(
  flag('out') ?? 'out/war-room.txt',
  lines.join('\n').replace(/\x1b\[\d+m/g, ''),
  'utf8',
);
console.log(`\n  ${c.dim}Écrit : ${flag('out') ?? 'out/war-room.txt'}${c.reset}\n`);
repos.close();
