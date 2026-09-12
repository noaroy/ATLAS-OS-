/**
 * Trouver par écrit, et seulement par écrit.
 *
 * Le résolveur de contacts range le téléphone après l'adresse et le
 * formulaire, mais il le retient quand rien d'autre n'existe. Pour une
 * première approche commerciale, ce repli ne convient pas : un appel ne laisse
 * aucune trace vérifiable, ne se relit pas, et ne permet pas de joindre une
 * preuve. Ici le téléphone n'est donc pas dernier — il est hors liste.
 *
 * Aucun modèle, aucune recherche : on relit les pages du domaine officiel déjà
 * établi, plus profondément que d'habitude, parce qu'une adresse commerciale
 * se cache souvent une page plus loin que la page de contact.
 */
import { writeFileSync } from 'node:fs';
import { createLogger, loadAtlasEnv } from '../packages/core/src/index.ts';
import { fetchRawPages } from '../packages/intelligence/src/contact-fetch.ts';
import {
  resolveContacts,
  contactPagesFor,
  contactLinksIn,
  type ContactPage,
  type ResolvedContact,
} from '../packages/departments/src/index.ts';

// Avant toute lecture de process.env : sans cet appel, `.env.local` n'existe
// pas pour ce processus et la configuration parait absente sans qu'aucune
// erreur ne le dise.
loadAtlasEnv();

const logger = createLogger({ level: 'error', pretty: false });

/**
 * Les cibles viennent de la ligne de commande — `nom=domaine` — pour qu'une
 * nouvelle paire n'exige pas de modifier ce fichier.
 */
const TARGETS = process.argv
  .slice(2)
  .filter((a) => a.includes('='))
  .map((arg) => {
    const [name, domain] = arg.split('=');
    return { name: name!, domain: domain!, website: `https://${domain}` };
  });

if (TARGETS.length === 0) {
  console.error('usage: written-channel "Nom=domaine.fr" ["Autre=domaine.com"]');
  process.exit(1);
}

/** Des chemins supplémentaires : une adresse commerciale se cache plus loin. */
const EXTRA_PATHS = [
  '/contact', '/contact/', '/contacts', '/nous-contacter', '/contactez-nous',
  '/mentions-legales', '/mentions-legales/', '/legal', '/impressum',
  '/devenir-distributeur', '/distributeurs', '/revendeurs', '/partenaires',
  '/commercial', '/services', '/entreprise', '/a-propos', '/qui-sommes-nous',
  '/en/contact', '/contact-us',
];

/**
 * Le meilleur canal écrit, selon la priorité demandée.
 *
 * Le téléphone est absent de la liste, pas relégué : un canal qu'on ne veut
 * pas doit être impossible à retenir, pas simplement improbable.
 */
function bestWritten(contacts: ResolvedContact[]): { pick: ResolvedContact | null; rank: string } {
  const written = contacts.filter((c) => c.type === 'EMAIL' || c.type === 'FORM');
  const rules: Array<[string, (c: ResolvedContact) => boolean]> = [
    ['email SALES', (c) => c.type === 'EMAIL' && c.intent === 'SALES' && c.suitability !== 'LOW'],
    ['email EXPORT', (c) => c.type === 'EMAIL' && c.intent === 'EXPORT'],
    ['email GENERAL', (c) => c.type === 'EMAIL' && c.intent === 'GENERAL'],
    ['formulaire commercial', (c) => c.type === 'FORM' && c.intent === 'SALES'],
    ['formulaire général', (c) => c.type === 'FORM' && c.intent === 'GENERAL'],
  ];
  for (const [rank, matches] of rules) {
    // Une adresse d'une autre marque passe après celles de la maison, comme
    // partout ailleurs : écrire au groupe n'est pas écrire à l'entreprise.
    const own = written.find((c) => matches(c) && c.sameBrand !== false);
    if (own) return { pick: own, rank };
    const other = written.find(matches);
    if (other) return { pick: other, rank: `${rank} (autre marque du groupe)` };
  }
  return { pick: null, rank: 'NONE' };
}

const lines: string[] = [];
const say = (t = '') => { lines.push(t); console.log(t); };

for (const target of TARGETS) {
  const queue = [...contactPagesFor(target.website, target.domain),
    ...EXTRA_PATHS.map((p) => `https://${target.domain}${p}`)];
  const visited = new Set<string>();
  const pages: ContactPage[] = [];

  for (let pass = 0; pass < 2; pass++) {
    const batch = queue.filter((u) => !visited.has(u));
    for (const u of batch) visited.add(u);
    if (batch.length === 0) break;
    const fetched = await fetchRawPages(batch, {
      logger, timeoutMs: 10_000, maxPages: Math.max(0, 14 - pages.length),
    });
    pages.push(...fetched.pages);
    if (pass === 0) {
      for (const page of fetched.pages) {
        for (const link of contactLinksIn(page.html, page.url, target.domain)) {
          if (!visited.has(link)) queue.push(link);
        }
      }
    }
  }

  const contacts = resolveContacts({ officialDomain: target.domain, pages });
  const all = [
    ...contacts.publicEmails,
    ...(contacts.contactFormUrl ? [contacts.contactFormUrl] : []),
  ];
  const { pick, rank } = bestWritten(all);

  say('═'.repeat(74));
  say(`${target.name}  ·  ${target.website}`);
  say(`pages lues : ${pages.length}`);
  say('canaux écrits relevés :');
  if (all.length === 0) say('  aucun');
  for (const contact of all) {
    say(
      `  ${contact === pick ? '→' : ' '} ${contact.type.padEnd(6)}${contact.value.slice(0, 44).padEnd(46)}` +
        `${contact.intent.padEnd(18)}${contact.suitability}`,
    );
    say(`      source ${contact.sourceUrl}`);
  }
  say(`téléphones relevés (hors liste) : ${contacts.publicPhones.map((p) => p.value).join(', ') || 'aucun'}`);
  say(`RETENU : ${pick ? `${rank} — ${pick.value}` : 'NONE'}`);
  say('');
}

writeFileSync('out/written-channel.txt', lines.join('\n'), 'utf8');
