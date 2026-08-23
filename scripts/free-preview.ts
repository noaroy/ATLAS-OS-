/**
 * L'échantillon gratuit : trois prospects, pour un client qui n'a encore rien payé.
 *
 * C'est la pièce qui décide de la vente. Elle est lue en deux minutes par
 * quelqu'un qui connaît son marché mieux que nous, et un seul nom hors sujet
 * suffit à conclure que le reste ne vaut pas 49 €. La contrainte n'est donc pas
 * d'en trouver trois, c'est de n'en montrer aucun qui soit faux.
 *
 * Rien n'est produit par un modèle. Chaque prospect a un domaine officiel
 * résolu, au moins deux phrases relevées littéralement sur son site avec leur
 * adresse, et un canal de contact lu sur ses pages. La raison du rapprochement
 * est le mot que l'on a effectivement trouvé chez lui — pas une appréciation.
 */
import { writeFileSync } from 'node:fs';
import { createLogger, loadConfig } from '../packages/core/src/index.ts';
import { createSearchFabric } from '../packages/intelligence/src/search/fabric/factory.ts';
import { fetchRawPages } from '../packages/intelligence/src/contact-fetch.ts';
import {
  classifyPageType,
  resolveCompanyIdentity,
  icpStatus,
  resolveContacts,
  contactPagesFor,
  contactLinksIn,
  cleanQuote,
  readsAsSentence,
  type ContactPage,
} from '../packages/departments/src/index.ts';

const c = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', amber: '\x1b[33m' };

/**
 * Ce que chaque client vend, et donc qui sont ses clients à lui.
 *
 * Les mots-clés ne décrivent pas le prospect en général : ils décrivent ce
 * qu'il doit dire sur son propre site pour qu'on puisse affirmer, preuve à
 * l'appui, qu'il a besoin de ce que notre client fabrique.
 */
const BRIEFS = [
  {
    client: 'Ardes Solution',
    clientDomain: 'ardes-solution.com',
    sells: 'identification animale, boucles RFID, materiel d’injection et marquage laser',
    fit: 'ce sont exactement les circuits par lesquels ses produits se vendent',
    header:
      'Ces trois entreprises distribuent du materiel d’elevage ou veterinaire en France. ' +
      'Chacune le dit sur son propre site.',
    queries: [
      'negoce agricole distribution materiel elevage France',
      'centrale achat veterinaire distribution France',
      'cooperative agricole distribution materiel elevage adherents',
      'grossiste produits veterinaires elevage France',
    ],
    proof: [
      'elevage', 'eleveur', 'veterinaire', 'boucle', 'identification animale',
      'bovin', 'ovin', 'caprin', 'porcin', 'agricole', 'cheptel', 'troupeau',
      'materiel d elevage', 'sante animale',
    ],
  },
  {
    client: 'AeroXSense',
    clientDomain: 'aeroxsense.com',
    sells: 'protection incendie par aerosol condense pour tableaux et armoires electriques',
    fit: 'ce sont exactement les equipements que ses generateurs protegent',
    header:
      'Ces trois entreprises fabriquent ou distribuent des tableaux et armoires electriques. ' +
      'Chacune le dit sur son propre site.',
    queries: [
      'tableautier armoires electriques industrielles France',
      'fabricant tableaux electriques basse tension France',
      'distributeur materiel electrique industriel France',
      'installateur armoires electriques automatisme France',
    ],
    proof: [
      'tableau electrique', 'tableaux electriques', 'armoire electrique',
      'armoires electriques', 'tableautier', 'basse tension', 'coffret electrique',
      'materiel electrique', 'installation electrique', 'automatisme',
    ],
  },
  {
    client: 'Deleo',
    clientDomain: 'deleo.fr',
    sells: 'appareils de soins esthetiques et dispositifs medicaux — cryolipolyse, lasers, radiofrequence',
    fit: 'ce sont exactement les etablissements qui achetent ses appareils',
    header:
      'Ces trois entreprises distribuent ou installent du materiel esthetique professionnel ' +
      'en France. Chacune le dit sur son propre site.',
    queries: [
      'distributeur materiel esthetique professionnel France',
      'fournisseur appareils medecine esthetique France',
      'grossiste equipement institut de beaute France',
      'distributeur laser esthetique dispositif medical France',
    ],
    proof: [
      'esthetique', 'institut de beaute', 'medecine esthetique', 'dermatologie',
      'cabine', 'soin du corps', 'amincissement', 'epilation', 'laser',
      'dispositif medical', 'materiel esthetique', 'spa',
    ],
  },
];

const fold = (t: string) => t.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

const strip = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&(?:e|E)acute;/g, 'é')
    .replace(/&(?:e|E)grave;/g, 'è')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();

/** Les phrases du site qui contiennent une preuve du besoin. */
function provingSentences(
  pages: readonly ContactPage[],
  proof: readonly string[],
): Array<{ quote: string; marker: string; sourceUrl: string }> {
  const found: Array<{ quote: string; marker: string; sourceUrl: string }> = [];
  const used = new Set<string>();

  for (const page of pages) {
    const text = strip(page.html);
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      const quote = cleanQuote(sentence);
      if (quote.length < 40 || quote.length > 240) continue;
      // Une phrase qui commence par une ponctuation est un fragment arraché
      // au milieu d'un témoignage : « , Directeur, Les Câblages de l'Ouest ».
      if (!/^[A-ZÀ-Ü]/.test(quote)) continue;
      if (!readsAsSentence(quote)) continue;
      const folded = fold(quote);
      const marker = proof.find((p) => folded.includes(fold(p)));
      if (!marker || used.has(quote)) continue;
      used.add(quote);
      found.push({ quote, marker, sourceUrl: page.url });
      if (found.length >= 4) return found;
    }
  }
  return found;
}

const logger = createLogger({ level: 'error', pretty: false });
const config = loadConfig(process.cwd());
const fabric = createSearchFabric(config.search, {
  need: { countries: ['FR'], languages: ['fr'], commercial: true },
});
if (!fabric) {
  console.error('Aucun moteur de recherche configuré : cet aperçu en dépend.');
  process.exit(1);
}

const lines: string[] = [];
const say = (text = '') => { lines.push(text.replace(/\x1b\[\d+m/g, '')); console.log(text); };

for (const brief of BRIEFS) {
  say(`\n${'═'.repeat(74)}`);
  say(`${brief.client.toUpperCase()} FREE PREVIEW`);
  say(`${'═'.repeat(74)}`);
  say(`Ce que ${brief.client} vend : ${brief.sells}.`);
  say(`${brief.header}\n`);

  const seenDomains = new Set<string>([brief.clientDomain]);
  const kept: string[] = [];
  let index = 0;

  for (const query of brief.queries) {
    if (kept.length >= 3) break;
    let results: Awaited<ReturnType<typeof fabric.search>>;
    try {
      results = await fabric.search(
        { query, country: 'FR', language: 'fr', count: 10 },
        { logger, timeoutMs: 20_000 },
      );
    } catch {
      continue;
    }

    for (const result of results.results ?? []) {
      if (kept.length >= 3) break;
      let domain: string;
      try {
        domain = new URL(result.url).hostname.replace(/^www\./, '');
      } catch {
        continue;
      }
      if (seenDomains.has(domain)) continue;
      seenDomains.add(domain);

      // Les mêmes gardes que pour nos propres prospects : la page doit
      // appartenir à l'entreprise, et l'entreprise doit être nommable.
      const page = classifyPageType({ url: result.url, domain, title: result.title, snippet: result.snippet });
      if (!page.ownerIsCandidate) continue;
      const identity = resolveCompanyIdentity({
        searchTitle: result.title ?? '', url: result.url, domain, page,
      });
      if (!identity.identity) continue;

      // Un titre de résultat long est une accroche, pas une raison sociale :
      // « CERA électronique, leader sous-traitance de carte électronique ».
      // Au-delà de quatre mots, on prend la marque avant le séparateur, ou le
      // domaine — la même règle que pour nos propres prospects.
      let name = identity.identity.companyName;
      const head = name.split(/[,:|–—]/)[0]!.trim();
      if (head.split(/\s+/).length <= 4 && head.length >= 3) name = head;
      if (name.split(/\s+/).length > 4) {
        const root = domain.split('.')[0]!;
        name = root.charAt(0).toUpperCase() + root.slice(1);
      }
      if (icpStatus({ companyName: identity.identity.companyName, snippet: result.snippet }).status === 'OUT_OF_ICP') {
        continue;
      }

      // Lecture du site : preuves et coordonnées, en une seule passe.
      const queue = contactPagesFor(identity.identity.officialWebsite, domain);
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
          const home = fetched.pages.find((p) => {
            try { return new URL(p.url).pathname === '/'; } catch { return false; }
          });
          if (home) for (const link of contactLinksIn(home.html, home.url, domain)) {
            if (!visited.has(link)) queue.push(link);
          }
        }
      }
      if (pages.length === 0) continue;

      const proofs = provingSentences(pages, brief.proof);
      // Deux faits sourcés au minimum : un seul se conteste, deux montrent
      // qu'on a lu le site.
      if (proofs.length < 2) continue;

      const contacts = resolveContacts({ officialDomain: domain, pages });
      if (!contacts.primary) continue;

      index += 1;
      kept.push(domain);
      say(`${index}. ${name}`);
      say(`   Site officiel : ${identity.identity.officialWebsite}`);
      say(`   Pourquoi ce prospect : son site mentionne « ${proofs[0]!.marker} » — ${brief.fit}.`);
      say(`   Fait 1 : « ${proofs[0]!.quote} »`);
      say(`            ${proofs[0]!.sourceUrl}`);
      say(`   Fait 2 : « ${proofs[1]!.quote} »`);
      say(`            ${proofs[1]!.sourceUrl}`);
      say(`   Contact public : ${contacts.primary.type} — ${contacts.primary.value}`);
      say(`            relevé sur ${contacts.primary.sourceUrl}`);
      say('');
    }
  }

  if (kept.length < 3) {
    say(`${c.amber}Seulement ${kept.length} prospect(s) tiennent les conditions.${c.reset}`);
    say('Aucun nom n’a été ajouté pour compléter : un exemple faux coûte la vente.');
    say('');
  }
}

say('─'.repeat(74));
say('Aucun contact inventé. Chaque fait est cité mot pour mot, avec son adresse.');
say('MESSAGES SENT: 0');

writeFileSync('out/free-preview.txt', lines.join('\n'), 'utf8');
console.log(`\n  ${c.dim}Écrit : out/free-preview.txt${c.reset}\n`);
