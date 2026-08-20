/**
 * La file d'attente : à qui écrire ensuite, dans quel ordre.
 *
 * Deux conditions au-delà du score. Un signal de croissance relevé
 * littéralement sur le site — sans quoi il n'y a rien à dire d'utile — et un
 * canal **écrit**. Le téléphone n'est pas relégué en fin de liste : il est
 * exclu, parce qu'une première approche qui ne laisse pas de trace ne se relit
 * pas et ne se défend pas.
 *
 * Rien n'est produit ici. Tout est déjà en base : les signaux ont été relevés
 * en lisant les sites, les canaux en résolvant les contacts, le score par la
 * règle. Cette commande ne fait que trancher l'ordre.
 */
import { writeFileSync } from 'node:fs';
import { createLogger, canonicalDomainOf } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import {
  scoreConversion,
  isForeignDomain,
  SIGNAL_LABELS,
  cleanQuote,
  type ObservedFact,
  type GrowthSignalKind,
} from '../packages/departments/src/index.ts';

const flag = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(process.env.ATLAS_DB_PATH ?? 'data/atlas.db', logger);
const limit = Number(flag('top') ?? 10);

/** Un signal explicite, dans l'ordre où il ouvre une conversation. */
const SIGNAL_PRIORITY: GrowthSignalKind[] = [
  'DISTRIBUTION', 'SALES_HIRING', 'EXPORT', 'NEW_CAPACITY', 'NAMED_MARKETS',
];

/** Le meilleur canal écrit parmi ceux déjà relevés. Le téléphone est absent. */
function writtenChannel(channels: ReturnType<typeof repos.sales.channelsFor>) {
  const written = channels.filter(
    (channel) => (channel.type === 'EMAIL' || channel.type === 'FORM') && channel.suitability !== 'BLOCKED',
  );
  const rules: Array<[string, (c: (typeof written)[number]) => boolean]> = [
    ['email SALES', (c) => c.type === 'EMAIL' && c.intent === 'SALES'],
    ['email EXPORT', (c) => c.type === 'EMAIL' && c.intent === 'EXPORT'],
    ['email GENERAL', (c) => c.type === 'EMAIL' && c.intent === 'GENERAL'],
    ['formulaire commercial', (c) => c.type === 'FORM' && c.intent === 'SALES'],
    ['formulaire général', (c) => c.type === 'FORM' && c.intent === 'GENERAL'],
  ];
  for (const [rank, matches] of rules) {
    const hit = written.find(matches);
    if (hit) return { pick: hit, rank };
  }
  return { pick: null, rank: 'NONE' };
}

const seen = new Set<string>();
const queue = repos.sales
  .batchIds()
  .flatMap((batchId) => repos.sales.forBatch(batchId))
  .filter((prospect) => {
    const domain = canonicalDomainOf(prospect.domain ?? '');
    if (!domain || seen.has(domain)) return false;
    // Jamais contactée, jamais écartée, jamais invalidée, jamais non vérifiée.
    if (repos.sales.ledgerFor(domain)) return false;
    if (repos.sales.invalidationFor(prospect.id)) return false;
    if (!prospect.guardVersion) return false;
    if (isForeignDomain(domain)) return false;
    seen.add(domain);
    return true;
  })
  .map((prospect) => {
    const evidence = repos.sales.evidenceFor(prospect.id);
    const facts: ObservedFact[] = evidence.map((e) => ({
      claim: e.claim, sourceUrl: e.sourceUrl, nature: e.nature,
    }));
    const score = scoreConversion({
      companyName: prospect.companyName,
      facts,
      contactIntent: prospect.contactIntent,
      contactSuitability: prospect.contactSuitability,
      qualificationScore: prospect.score,
      qualificationTier: prospect.tier,
    });

    const signals = evidence
      .filter((e) => e.field.startsWith('signal:') && e.nature === 'observed' && e.sourceUrl)
      .map((e) => ({
        kind: e.field.slice('signal:'.length) as GrowthSignalKind,
        quote: cleanQuote(e.claim),
        sourceUrl: e.sourceUrl!,
      }))
      .sort((a, b) => SIGNAL_PRIORITY.indexOf(a.kind) - SIGNAL_PRIORITY.indexOf(b.kind));

    const channel = writtenChannel(repos.sales.channelsFor(prospect.id));
    return { prospect, score, signal: signals[0] ?? null, channel };
  })
  // Les deux conditions : un signal explicite, et de quoi écrire.
  // Un plancher : sous quarante, le dossier n'a pas de quoi soutenir une
  // conversation, et compléter la liste jusqu'à dix la rendrait plus longue
  // sans la rendre meilleure.
  .filter((entry) => entry.signal !== null && entry.channel.pick !== null && entry.score.total >= 40)
  .sort((a, b) => b.score.total - a.score.total)
  .slice(0, limit);

const lines: string[] = [];
const say = (t = '') => { lines.push(t); console.log(t); };

say(`FILE D'ATTENTE — ${queue.length} prospect(s)`);
say(`Jamais contactés · canal écrit uniquement · signal relevé sur leur site`);
say('');

let rank = 0;
for (const { prospect, score, signal, channel } of queue) {
  rank += 1;
  const best = score.components
    .filter((component) => component.points > 0 && component.basis && component.key !== 'contactQuality')
    .sort((a, b) => b.points - a.points)[0];

  say('─'.repeat(78));
  say(`${rank}. COMPANY               ${prospect.companyName}`);
  say(`   WEBSITE               ${prospect.website ?? '—'}`);
  say(`   OBSERVED GROWTH SIGNAL ${SIGNAL_LABELS[signal!.kind]}`);
  say(`     « ${signal!.quote.slice(0, 180)} »`);
  say(`     ${signal!.sourceUrl}`);
  say(`   WHY BUYER NOW         ${best?.label ?? '—'} · ${best?.basis?.slice(0, 110) ?? ''}`);
  say(`   BEST WRITTEN CHANNEL  ${channel.rank} — ${channel.pick!.value}`);
  say(`     ${channel.pick!.sourceUrl}`);
  say(`   PERSONALIZATION       « ${signal!.quote.slice(0, 150)} »`);
  say(`   CONVERSION SCORE      ${score.total}`);
  say('');
}

say('─'.repeat(78));
say('MESSAGES SENT: 0');
writeFileSync(flag('out') ?? 'out/outreach-queue.txt', lines.join('\n'), 'utf8');
repos.close();
