/**
 * Corriger les réponses qui n'en étaient pas — sans effacer l'histoire.
 *
 * Le système classait nos propres courriers de prospection comme des réponses
 * entrantes : la requête Gmail listait toute la boîte sans filtre de direction,
 * le rapprochement se faisait par fil — un fil connu parce que *nous* l'avions
 * ouvert — et la classification lisait le sujet et le corps sans jamais regarder
 * l'expéditeur. Huit événements « entrants » sur dix-sept venaient de notre
 * propre boîte, et quatre entreprises figuraient au tableau des réponses à
 * traiter alors que leur seul message était le nôtre.
 *
 * La cause est corrigée ; restent les événements déjà écrits. Ils ne sont pas
 * modifiés — la table est append-only, et le serait-elle moins qu'il ne faudrait
 * pas y toucher : ce qui a été constaté un jour doit rester lisible, y compris
 * quand c'était faux. On ajoute donc un événement de correction, marqué comme
 * jugement humain, qui porte l'état exact. La dérivation d'état fait primer un
 * jugement humain sur tous les automatismes, quel qu'en soit l'ordre.
 *
 *   npm run sales:repair-directions            montre ce qui serait écrit
 *   npm run sales:repair-directions -- --apply écrit
 */
import { createLogger, loadConfig, loadAtlasEnv, nowIso } from '../packages/core/src/index.ts';
import { createRepositories } from '../packages/data/src/index.ts';
import { directionOf, type ConversationStatus } from '../packages/departments/src/index.ts';
import { GmailInboxProvider } from '../packages/intelligence/src/index.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m',
};

const APPLY = process.argv.includes('--apply');
const config = loadConfig(process.cwd());
const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(config.paths.databaseFile, logger);
const boite = process.env.GMAIL_USER?.trim() ?? '';

if (!boite) {
  console.error('GMAIL_USER absent : impossible de savoir quelle boîte est la nôtre.');
  process.exit(1);
}

console.log(`\n  ${c.bold}CORRECTION DES DIRECTIONS${c.reset}`);
console.log(`  ${c.dim}notre boîte : ${boite}${c.reset}`);
console.log(`  ${c.dim}${APPLY ? 'écriture réelle' : 'simulation — relancez avec --apply pour écrire'}${c.reset}\n`);

let corrigees = 0;
let evenementsFautifs = 0;

/**
 * Le dernier message que nous avons envoye a chaque domaine, d'apres Gmail.
 *
 * Lecture seule, une requete par domaine concerne. C'est la seule source qui
 * dise la verite sur ce que nous avons envoye : nos propres messages ne sont
 * plus importes comme evenements, et c'est tant mieux — mais il faut alors les
 * lire la ou ils sont.
 */
const dernierEnvoiVers = new Map<string, string>();
const inbox = new GmailInboxProvider({ logger });
if (inbox.status().configured) {
  for (const conversation of repos.conversations.all()) {
    try {
      const envoyes = await inbox.list({
        rawFilter: `in:sent to:${conversation.canonicalDomain}`,
        max: 20, includeOwnMessages: true, since: '2026-01-01T00:00:00.000Z',
      });
      if (envoyes.length > 0) {
        dernierEnvoiVers.set(
          conversation.canonicalDomain,
          envoyes.map((m) => m.receivedAt).reduce((a, b) => (a >= b ? a : b)),
        );
      }
    } catch {
      // Un domaine illisible ne bloque pas la correction des autres : sans
      // date d'envoi, on retombe sur ce que les evenements savent.
    }
  }
} else {
  console.log(`  ${c.amber}Gmail non configure${c.reset} — la chronologie des envois vient des seuls evenements.
`);
}

for (const conversation of repos.conversations.all()) {
  const events = repos.conversations.eventsFor(conversation.id);
  if (events.length === 0) continue;

  /**
   * Seuls les evenements venus de Gmail sont juges.
   *
   * Les notes du fondateur n'ont pas d'expediteur, et la garde de direction —
   * prudente a dessein — traiterait cette absence comme « sortant ». Or ce sont
   * des constats humains deliberes : les ecarter reviendrait a effacer le seul
   * endroit ou une reponse recue par telephone ou par un autre canal est
   * consignee. La prudence qui protege l'import se retourne ici contre nous.
   */
  const importes = events.filter((e) => e.source.startsWith('gmail'));
  const nôtres = importes.filter((e) => directionOf({
    from: e.sender ?? '', mailbox: boite,
  }).direction === 'OUTBOUND');
  if (nôtres.length === 0) continue;

  evenementsFautifs += nôtres.length;

  // Ce qui reste une fois nos propres messages écartés.
  const reels = events.filter((e) => !nôtres.includes(e));
  const vraiesReponses = reels.filter((e) => e.classification === 'REPLIED');
  const enRevue = reels.filter((e) => e.classification === 'NEEDS_REVIEW');
  const automatiques = reels.filter((e) => e.classification === 'AUTO_REPLY');

  /**
   * L'état corrigé, déduit de ce qui reste réellement.
   *
   * Une réponse automatique n'est pas une réponse : un accusé de réception de
   * formulaire ou une absence du bureau ne dit rien de l'intérêt commercial de
   * personne. Sans réponse humaine, l'entreprise a simplement été contactée.
   */
  /**
   * Avons-nous deja repondu ?
   *
   * Les messages ecartes portent leur date : s'ils sont posterieurs a tout ce
   * que le prospect nous a ecrit, c'est que la balle est dans son camp. Deduit
   * de la chronologie plutot que decide au cas par cas — la regle vaut pour
   * ACRN comme pour la prochaine entreprise qui repondra.
   *
   * Sans cette distinction, une conversation a laquelle on a repondu reste
   * indefiniment dans la file des decisions a prendre, en reclamant une action
   * qui a deja ete faite. C'est ce qui arrivait a ACRN : l'apercu gratuit etait
   * parti le 24 aout, et l'ecran continuait de demander qu'on s'en occupe.
   */
  const dernierDEux = reels.length > 0
    ? reels.map((e) => e.occurredAt).reduce((a, b) => (a >= b ? a : b))
    : null;

  /**
   * Notre dernier envoi, lu dans Gmail et non dans nos evenements.
   *
   * Le journal d'evenements est incomplet par construction : depuis que la
   * synchronisation ecarte nos propres messages, ils n'y entrent plus. Or c'est
   * exactement la donnee qui manque pour savoir qui doit parler. L'apercu
   * gratuit d'ACRN, parti le 24 aout a 18:29, n'y figurait pas — et l'ecran
   * continuait de reclamer une action deja faite.
   */
  const dernierDeNous = dernierEnvoiVers.get(conversation.canonicalDomain)
    ?? nôtres.map((e) => e.occurredAt).reduce((a, b) => (a >= b ? a : b));
  const nousAvonsRepondu = dernierDEux !== null && dernierDeNous > dernierDEux;

  const statut: ConversationStatus = nousAvonsRepondu
    ? 'FOLLOW_UP_SCHEDULED'
    : vraiesReponses.length > 0
      ? 'REPLIED'
      : enRevue.length > 0
        ? 'NEEDS_REVIEW'
        : automatiques.length > 0
          ? 'AUTO_REPLY'
          : 'CONTACTED';

  const motif = `${nôtres.length} message(s) de notre propre boîte classés à tort comme réponses `
    + `(${nôtres.map((e) => e.classification).join(', ')}). `
    + `Réellement reçu : ${reels.length === 0 ? 'rien' : reels.map((e) => e.classification).join(', ')}.`
    + (nousAvonsRepondu
      ? ` Nous avons répondu le ${dernierDeNous.slice(0, 10)}, après leur dernier message `
        + `du ${dernierDEux!.slice(0, 10)} : la réponse leur appartient désormais.`
      : '');

  console.log(`  ${c.bold}${conversation.canonicalDomain}${c.reset}  ${conversation.companyName}`);
  console.log(`    ${c.red}écartés${c.reset}  ${nôtres.length} · ${nôtres.map((e) => e.classification).join(', ')}`);
  console.log(`    ${c.dim}restant${c.reset}  ${reels.length === 0 ? 'aucun message externe' : reels.map((e) => e.classification).join(', ')}`);
  console.log(`    ${c.green}état${c.reset}     ${statut}`);

  if (APPLY) {
    repos.conversations.recordInboundEvent({
      conversationId: conversation.id,
      kind: 'CORRECTION',
      classification: statut,
      confidence: 1,
      occurredAt: nowIso(),
      source: 'audit-direction',
      rawSubject: 'Correction : direction des messages',
      sender: null,
      bodyExcerpt: motif,
      signals: ['direction-non-verifiee-avant-correctif'],
      // Marqué comme jugement humain : c'est ce qui le fait primer sur les
      // classements automatiques antérieurs, sans en effacer aucun.
      humanReviewed: true,
      declaredStatus: statut,
      note: motif,
    });
    corrigees += 1;
  }
  console.log();
}

console.log(
  `  ${evenementsFautifs} événement(s) fautif(s) sur ${repos.conversations.all().length} conversation(s)`,
);
if (APPLY) {
  console.log(`  ${c.green}${corrigees} correction(s) écrite(s)${c.reset} — aucun événement effacé\n`);
} else {
  console.log(`  ${c.amber}Rien écrit.${c.reset} Relancez avec --apply.\n`);
}
console.log(`  ${c.dim}MESSAGES SENT: 0${c.reset}\n`);
repos.close();
