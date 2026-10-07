import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import { createRepositories, sendKey, type Repositories } from '../../data/src/index.ts';
import { FixtureInboxProvider, GmailOutboundProvider, GMAIL_SEND_SCOPE, mailMessage, type MailInboxProvider, type MailMessage, type MailQuery } from '../../intelligence/src/index.ts';
import { evaluateManualSendLot, isIsolatedSelfTest, INTERNAL_TEST_RECIPIENT_BLOCKED, INTERNAL_TEST_RECIPIENT_MESSAGE, SELF_TEST_DOMAIN, sameAddress, type SendPolicy } from '../../departments/src/index.ts';
import { runManualSendLot, type ManualSendItem } from '../src/manual-send.ts';
import { setGlobalPause } from '../src/sales-engine.ts';

/**
 * Le tout premier envoi réel : en INTERNAL_TEST, seulement vers soi.
 *
 * `sales:send-approved --send` vérifiait la porte et le jeton, mais rien ne
 * l'empêchait, en INTERNAL_TEST, de poster à une adresse étrangère : la
 * politique du daemon (INTERNAL_TEST_MODE) ne couvre pas ce chemin manuel.
 *
 * Ici, le chemin complet est joué — garde de lot, registre, boîte, clé,
 * brouillon, approbation, réservation, transport — avec le VRAI transport
 * Gmail dont seul `fetch` est intercepté : l'échange de jeton et l'appel
 * d'envoi sont enregistrés, jamais émis. Chaque test compte ses appels et
 * ses écritures. MESSAGES SENT réels : 0, par construction.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const logger = createLogger({ level: 'error', pretty: false });
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_USER = 'noaroy@gmail.com';
const EPOCH = '1970-01-01T00:00:00.000Z';
const CREDENTIALS = {
  GMAIL_CLIENT_ID: 'identifiant-de-test', GMAIL_CLIENT_SECRET: 'secret-de-test',
  GMAIL_REFRESH_TOKEN: 'jeton-de-test', GMAIL_USER,
} as NodeJS.ProcessEnv;

/** Un transport Gmail réel, porte ouverte ou fermée — dans un environnement objet, jamais process.env. */
const transport = (outboundEnabled: boolean) =>
  new GmailOutboundProvider({ grantedScopes: [READONLY, GMAIL_SEND_SCOPE], env: { ...CREDENTIALS, ATLAS_OUTBOUND_ENABLED: outboundEnabled ? 'true' : 'false' } as NodeJS.ProcessEnv });

const selfTest = (over: Partial<ManualSendItem> = {}): ManualSendItem => ({
  domain: 'selftest.atlas.invalid', companyName: 'ATLAS self-test', recipient: GMAIL_USER,
  subject: 'ATLAS — self-test', bodyText: 'Premier envoi réel, vers moi-même.', purpose: 'FIRST_TOUCH', ...over,
});
const externe = (over: Partial<ManualSendItem> = {}): ManualSendItem => ({
  domain: 'acme-industrie.fr', companyName: 'Acme Industrie', recipient: 'contact@acme-industrie.fr',
  subject: 'Acme — premier contact', bodyText: 'Bonjour.', purpose: 'FIRST_TOUCH', ...over,
});

/**
 * Un premier contact conforme à la porte qualité : l'adresse a été lue sur le
 * site officiel (prospect découvert, coordonnée observée), le fait propre au
 * destinataire est cité, deux recommandations sourcées. Le prospect est
 * inscrit dans `repos` au moment de l'appel.
 */
const conforme = (domain = 'merand.fr', over: Partial<ManualSendItem> = {}): ManualSendItem => {
  const recipient = `commercial@${domain}`;
  const { prospect } = repos.sales.discover({ batchId: 'B1', companyName: `Société ${domain}`, domain, country: 'France', discoveredAt: '2026-09-20T10:00:00.000Z' });
  repos.sales.setContact(prospect.id, { email: recipient, sourceUrl: `https://${domain}/contact`, observed: true });
  return {
    domain, companyName: `Société ${domain}`, recipient, subject: 'Recherche de distributeurs', purpose: 'FIRST_TOUCH',
    sources: [
      { quote: 'Nous recherchons des distributeurs pour commercialiser nos équipements en Europe du Nord', sourceUrl: `https://${domain}/` },
      { quote: 'Bridor distribue les équipements de la société en France.', sourceUrl: `https://${domain}/partenaires` },
      { quote: 'Panamar distribue les équipements de la société en France.', sourceUrl: `https://${domain}/partenaires` },
    ],
    bodyText: `Bonjour,\n\nJ'ai vu sur votre site que vous indiquez rechercher des distributeurs pour commercialiser nos équipements en Europe du Nord.\n\n`
      + `Pour exemple, 2 entreprises relevées :\n- Bridor (bridor.fr) : « Bridor distribue les équipements de la société en France. » — https://${domain}/partenaires\n`
      + `- Panamar (panamar.es) : « Panamar distribue les équipements de la société en France. » — https://${domain}/partenaires\n\n`
      + `Je peux vous en préparer 3 gratuitement, simplement pour que vous jugiez si le résultat est pertinent.`,
    ...over,
  };
};

let dir: string;
let repos: Repositories;
/** Les appels réseau interceptés : URL, et le `To:` du message quand c'est un envoi. */
let reseau: Array<{ url: string; to: string | null }> = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-manual-send-'));
  repos = createRepositories(join(dir, 'atlas.db'), logger);
  reseau = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://oauth2.googleapis.com/token') {
      reseau.push({ url, to: null });
      return new Response(JSON.stringify({ access_token: 'acces-de-test', expires_in: 3600, scope: `${READONLY} ${GMAIL_SEND_SCOPE}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
      const raw = (JSON.parse(String(init?.body)) as { raw: string }).raw;
      const rfc822 = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      reseau.push({ url, to: /^To: (.+)$/m.exec(rfc822)?.[1] ?? null });
      return new Response(JSON.stringify({ id: `fake-gmail-${reseau.length}`, threadId: 'fake-thread' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`appel réseau inattendu : ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

const envois = () => reseau.filter((r) => r.url.includes('gmail.googleapis.com'));
/** La politique par défaut du daemon (config.ts), telle que `sendPolicyOf` la construit. */
const POLICY: SendPolicy = {
  dailyCapPerMailbox: 10, hourlyCap: 3, minDelaySeconds: 120, sendWindow: '09:00-17:30', weekendEnabled: false,
  timezone: 'Europe/Paris', maxFollowUps: 1, bouncePauseRate: 0.05, bounceMinSample: 20,
};
/** Un mercredi, 10 h à Paris : dans la fenêtre — les tests ne dépendent pas de l'heure à laquelle ils tournent. */
const OUVERT = new Date('2026-10-07T08:00:00.000Z');
const run = (lot: ManualSendItem[], options: { engineMode?: 'INTERNAL_TEST' | 'PRODUCTION'; outboundEnabled?: boolean; send?: boolean; mailbox?: string; inbox?: MailInboxProvider; policy?: SendPolicy; now?: Date } = {}) => {
  const outboundEnabled = options.outboundEnabled ?? true;
  return runManualSendLot({
    repos, lot, send: options.send ?? true, engineMode: options.engineMode ?? 'INTERNAL_TEST', outboundEnabled,
    mailbox: options.mailbox ?? GMAIL_USER, policy: options.policy ?? POLICY, now: () => options.now ?? OUVERT,
    inbox: options.inbox ?? new FixtureInboxProvider([]), outbound: transport(outboundEnabled),
  });
};

/**
 * Une boîte qui répond comme Gmail à `from:<domaine>` : les messages dont
 * l'expéditeur porte ce domaine. C'est exactement la requête que la garde
 * « à lire avant de relancer » envoie — et, pour un self-test vers
 * @gmail.com, celle qui ramenait la boîte entière.
 */
class GmailLikeInbox implements MailInboxProvider {
  readonly id = 'gmail';
  readonly requetes: string[] = [];
  constructor(private readonly messages: readonly MailMessage[]) {}
  status() { return { configured: true, code: 'GMAIL_READY', detail: 'boîte test', scopes: [] }; }
  async list(query: MailQuery = {}): Promise<MailMessage[]> {
    this.requetes.push(query.rawFilter ?? '');
    const from = /^from:(\S+)$/.exec(query.rawFilter ?? '')?.[1];
    if (from) return this.messages.filter((m) => m.from.toLowerCase().endsWith(`@${from.toLowerCase()}`) || m.from.toLowerCase().endsWith(`@${from.toLowerCase()}>`));
    return [];
  }
}

/** Dix messages quelconques venus de @gmail.com — la boîte réelle du relevé. */
const boiteGmail = () => new GmailLikeInbox(Array.from({ length: 10 }, (_, i) => mailMessage({
  messageId: `quelconque-${i}`, from: `Personne ${i} <personne${i}@gmail.com>`, subject: `sujet ${i}`, receivedAt: '2026-09-1' + (i % 9) + 'T09:00:00.000Z',
})));

/** Rien n'a été réservé, écrit ni consigné pour ce lot. */
const assertRienEcrit = (lot: ManualSendItem[]) => {
  for (const item of lot) {
    const cle = sendKey({ domain: item.domain, recipient: item.recipient, subject: item.subject, body: item.bodyText, purpose: item.purpose ?? 'FOLLOW_UP' });
    assert.equal(repos.salesLoop.sendOutcome(cle).exists, false, `aucune réservation pour ${item.recipient}`);
    assert.equal(repos.sales.ledgerFor(item.domain), null, `registre intact pour ${item.domain}`);
  }
  assert.equal(repos.salesLoop.draftsInState('READY_FOR_APPROVAL').length + repos.salesLoop.draftsInState('APPROVED_TO_SEND').length, 0, 'aucun brouillon');
  assert.equal(repos.conversations.all().length, 0, 'aucune conversation ouverte');
  assert.equal(repos.salesLoop.sentSince(EPOCH), 0, 'MESSAGES SENT: 0');
};

describe('1. INTERNAL_TEST + destinataire = GMAIL_USER + porte ouverte', () => {
  test('autorisé jusqu’au transport : un échange de jeton, un envoi vers GMAIL_USER, consigné', async () => {
    const rapport = await run([selfTest()]);
    assert.equal(rapport.refused, false);
    assert.equal(rapport.guard.selfTest, true);
    assert.deepEqual(rapport.results.map((r) => r.verdict), ['SENT']);
    assert.deepEqual(envois().map((e) => e.to), [GMAIL_USER], 'le seul message construit va à GMAIL_USER');
    assert.equal(reseau[0]?.url, 'https://oauth2.googleapis.com/token');
    assert.equal(repos.salesLoop.sentSince(EPOCH), 1);
    assert.deepEqual(repos.salesLoop.realSentSince(EPOCH), { real: 1, simulated: 0, unattributed: 0 });
    assert.equal(repos.sales.ledgerFor('selftest.atlas.invalid')?.kind, 'CONTACTED', 'le registre dit ce qui est parti');
  });
});

describe('2. INTERNAL_TEST + destinataire externe', () => {
  test('INTERNAL_TEST_RECIPIENT_BLOCKED : 0 appel réseau, 0 réservation, 0 écriture, 0 message', async () => {
    const lot = [externe()];
    const rapport = await run(lot);
    assert.equal(rapport.refused, true);
    assert.deepEqual(rapport.guard.blocks.map((b) => b.code), [INTERNAL_TEST_RECIPIENT_BLOCKED]);
    assert.equal(rapport.guard.blocks[0]!.message, INTERNAL_TEST_RECIPIENT_MESSAGE);
    assert.equal(rapport.results[0]!.code, INTERNAL_TEST_RECIPIENT_BLOCKED);
    assert.match(rapport.results[0]!.motif, /En mode INTERNAL_TEST, un envoi réel n'est autorisé que vers GMAIL_USER\./);
    assert.deepEqual(reseau, [], '0 appel Gmail — pas même l’échange de jeton');
    assertRienEcrit(lot);
  });

  test('GMAIL_USER absent : aucune destination admise', async () => {
    const lot = [selfTest()];
    const rapport = await run(lot, { mailbox: '' });
    assert.equal(rapport.refused, true);
    assert.match(rapport.guard.blocks[0]!.message, /GMAIL_USER est absent/);
    assert.deepEqual(reseau, []);
    assertRienEcrit(lot);
  });
});

describe('3. INTERNAL_TEST + plusieurs destinataires dont un externe', () => {
  test('tout le lot est refusé avant le premier envoi — y compris la ligne vers GMAIL_USER', async () => {
    const lot = [selfTest(), externe(), selfTest({ domain: 'selftest-2.atlas.invalid', companyName: 'ATLAS self-test 2', subject: 'second' })];
    const rapport = await run(lot);
    assert.equal(rapport.refused, true);
    assert.deepEqual(rapport.results.map((r) => r.verdict), ['BLOCKED', 'BLOCKED', 'BLOCKED']);
    assert.deepEqual(rapport.guard.blocks[0]!.recipients, ['contact@acme-industrie.fr'], 'seule l’adresse étrangère est nommée');
    assert.deepEqual(reseau, []);
    assertRienEcrit(lot);
  });
});

describe('4. la comparaison : trim + minuscules, rien d’autre', () => {
  test('« NoaRoy@GMAIL.com  » est GMAIL_USER ; un affichage « Nom <adresse> » ou un autre alias ne l’est pas', async () => {
    assert.equal(sameAddress('  NoaRoy@GMAIL.com ', GMAIL_USER), true);
    assert.equal(sameAddress('Noa <noaroy@gmail.com>', GMAIL_USER), false);
    assert.equal(sameAddress('noaroy+test@gmail.com', GMAIL_USER), false);
    assert.equal(sameAddress('', ''), false, 'deux vides ne sont pas « la même boîte »');
    const rapport = await run([selfTest({ recipient: '  NoaRoy@GMAIL.com ' })], { mailbox: ' NOAROY@gmail.com' });
    assert.equal(rapport.refused, false);
    assert.equal(rapport.results[0]!.verdict, 'SENT');
    const alias = await run([selfTest({ domain: 'selftest-alias.atlas.invalid', recipient: 'noaroy+test@gmail.com' })]);
    assert.equal(alias.refused, true);
    assert.equal(alias.guard.blocks[0]!.code, INTERNAL_TEST_RECIPIENT_BLOCKED);
  });
});

describe('5. PRODUCTION : la garde de lot inchangée, la porte qualité en plus', () => {
  test('un premier contact conforme vers un destinataire externe passe la garde et va jusqu’au transport', async () => {
    const item = conforme();
    const rapport = await run([item], { engineMode: 'PRODUCTION' });
    assert.equal(rapport.refused, false);
    assert.equal(rapport.guard.selfTest, false);
    assert.deepEqual(rapport.guard.blocks, []);
    assert.deepEqual(rapport.results.map((r) => r.verdict), ['SENT'], JSON.stringify(rapport.results));
    assert.deepEqual(envois().map((e) => e.to), [item.recipient]);
  });

  test('un premier contact sans sources ni adresse observée : QUALITY_GATE, 0 appel, rien d’écrit', async () => {
    const lot = [externe()];
    const rapport = await run(lot, { engineMode: 'PRODUCTION' });
    assert.equal(rapport.results[0]!.verdict, 'BLOCKED');
    assert.equal(rapport.results[0]!.code, 'QUALITY_GATE');
    assert.match(rapport.results[0]!.motif, /QUALITY_GATE:RECIPIENT_UNVERIFIED/);
    assert.match(rapport.results[0]!.motif, /QUALITY_GATE:NOT_PERSONALIZED/);
    assert.deepEqual(reseau, []);
    assertRienEcrit(lot);
  });

  test('la règle pure : PRODUCTION n’a pas de restriction de destinataire', () => {
    const verdict = evaluateManualSendLot({ send: true, engineMode: 'PRODUCTION', outboundEnabled: true, gmailUser: GMAIL_USER, recipients: ['a@b.fr', 'c@d.fr'] });
    assert.deepEqual(verdict, { allowed: true, blocks: [], selfTest: false });
  });
});

describe('6. porte fermée (ATLAS_OUTBOUND_ENABLED=false)', () => {
  test('OUTBOUND_DISABLED reste prioritaire, même vers GMAIL_USER : refusé avant tout, 0 appel, 0 écriture', async () => {
    const lot = [selfTest()];
    const rapport = await run(lot, { outboundEnabled: false });
    assert.equal(rapport.refused, true);
    assert.deepEqual(rapport.guard.blocks.map((b) => b.code), ['OUTBOUND_DISABLED']);
    assert.deepEqual(reseau, []);
    assertRienEcrit(lot);
  });

  test('porte fermée + destinataire externe : la porte d’abord, puis la garde de destinataire — les deux nommés', () => {
    const verdict = evaluateManualSendLot({ send: true, engineMode: 'INTERNAL_TEST', outboundEnabled: false, gmailUser: GMAIL_USER, recipients: ['contact@acme-industrie.fr'] });
    assert.deepEqual(verdict.blocks.map((b) => b.code), ['OUTBOUND_DISABLED', INTERNAL_TEST_RECIPIENT_BLOCKED]);
  });

  test('sans --send, la garde ne juge pas : la simulation reste une simulation, sans écriture ni réseau', async () => {
    const lot = [externe()];
    const rapport = await run(lot, { send: false, outboundEnabled: false });
    assert.equal(rapport.refused, false);
    assert.equal(rapport.results[0]!.verdict, 'BLOCKED', 'la simulation passe par le transport, qui dit OUTBOUND_DISABLED');
    assert.match(rapport.results[0]!.motif, /OUTBOUND_DISABLED/);
    assert.deepEqual(reseau, []);
    assertRienEcrit(lot);
  });
});

describe('7. l’anti-doublon existant, inchangé', () => {
  test('le même self-test rejoué est refusé — un seul message, une seule place', async () => {
    const premier = await run([selfTest()]);
    assert.equal(premier.results[0]!.verdict, 'SENT');
    const second = await run([selfTest()]);
    assert.equal(second.refused, false, 'la garde de lot laisse passer : c’est l’anti-doublon qui refuse');
    assert.equal(second.results[0]!.verdict, 'BLOCKED');
    // Le registre dit CONTACTED depuis le premier envoi : c'est lui qui refuse, avant même la clé.
    assert.match(second.results[0]!.motif, /deja contactee le \d{4}-\d{2}-\d{2} — ce n'est plus un premier contact/);
    assert.equal(envois().length, 1, 'un seul envoi construit');
    assert.equal(repos.salesLoop.sentSince(EPOCH), 1);
    // Même texte, même clé : la place porte déjà un envoi consigné.
    const cle = sendKey({ domain: 'selftest.atlas.invalid', recipient: GMAIL_USER, subject: 'ATLAS — self-test', body: 'Premier envoi réel, vers moi-même.', purpose: 'FIRST_TOUCH' });
    assert.equal(repos.salesLoop.sendOutcome(cle).sent, true);
  });
});

describe('le script, tel qu’il est câblé', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'sales-send-approved.ts'), 'utf8');

  test('la garde de lot est évaluée avant l’échange de jeton, et le chemin d’envoi est celui qui vient d’être éprouvé', () => {
    const garde = source.indexOf('evaluateManualSendLot({\n  send: SEND');
    const jeton = source.indexOf('await expediteur.verifyScopes();');
    const envoi = source.indexOf('runManualSendLot({');
    assert.ok(garde > 0 && jeton > garde && envoi > jeton, 'ordre : garde de lot → échange de jeton → confirmation → envoi');
    assert.ok(!/\.sendEmail\(|claimSend\(|saveDraft\(/.test(source), 'le script ne réserve ni ne poste lui-même : tout passe par runManualSendLot');
  });

  test('la confirmation humaine : destination, nombre, mode, puis [o/N] — --yes seulement en l’absence de terminal, jamais sur la garde', () => {
    assert.match(source, /destination : \$\{destinations\.join\(', '\)\}/);
    assert.match(source, /nombre {6}: \$\{lot\.length\}/);
    assert.match(source, /SELF-TEST — vers GMAIL_USER seulement/);
    assert.match(source, /Confirmer l’envoi réel \? \[o\/N\]/);
    assert.match(source, /CONFIRMATION IMPOSSIBLE/);
    const garde = source.indexOf('if (!garde.allowed)');
    const yes = source.indexOf('if (YES)');
    assert.ok(garde > 0 && yes > garde, '--yes n’est lu qu’après que la garde a tranché');
  });
});

describe('le script, lancé comme l’opérateur le lance (base temporaire, sans identifiants, porte fermée)', () => {
  /**
   * Le processus enfant reçoit des identifiants Gmail VIDES et la porte
   * fermée dans son environnement : « l'environnement réel gagne toujours »
   * sur .env.local, donc aucun jeton, aucun réseau, aucun envoi possible.
   */
  function lancer(lot: ManualSendItem[], args: string[]) {
    const volume = mkdtempSync(join(tmpdir(), 'atlas-send-volume-'));
    mkdirSync(join(volume, 'backups'));
    const fichier = join(volume, 'lot.json');
    writeFileSync(fichier, JSON.stringify(lot));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ATLAS_CLI_CONTEXT: 'docker', ATLAS_DATA_DIR: volume, ATLAS_BACKUP_DIR: join(volume, 'backups'),
      ATLAS_LOG_LEVEL: 'error', ATLAS_ENGINE_MODE: 'INTERNAL_TEST', ATLAS_OUTBOUND_ENABLED: 'false',
      GMAIL_CLIENT_ID: '', GMAIL_CLIENT_SECRET: '', GMAIL_REFRESH_TOKEN: '', GMAIL_USER,
    };
    delete env.ATLAS_DB_PATH;
    const r = spawnSync(process.execPath, ['--import', 'tsx', join('scripts', 'sales-send-approved.ts'), `--file=${fichier}`, ...args], { cwd: ROOT, encoding: 'utf8', env, timeout: 120_000 });
    const db = createRepositories(join(volume, 'atlas.db'), logger, { readonly: true });
    const ecrits = {
      envois: db.salesLoop.sentSince(EPOCH),
      registre: lot.map((i) => db.sales.ledgerFor(i.domain)).filter(Boolean).length,
      brouillons: db.salesLoop.draftsInState('READY_FOR_APPROVAL').length + db.salesLoop.draftsInState('APPROVED_TO_SEND').length,
      reservations: lot.filter((i) => db.salesLoop.sendOutcome(sendKey({ domain: i.domain, recipient: i.recipient, subject: i.subject, body: i.bodyText, purpose: i.purpose ?? 'FOLLOW_UP' })).exists).length,
    };
    db.close();
    rmSync(volume, { recursive: true, force: true });
    // Les couleurs ANSI ne font pas partie de ce qu'on lit.
    return { ...r, out: `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, ''), ecrits };
  }

  test('--send vers une adresse externe : LOT REFUSÉ, INTERNAL_TEST_RECIPIENT_BLOCKED, code 3, rien d’écrit', () => {
    const r = lancer([externe()], ['--send', '--yes']);
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /LOT REFUSÉ/);
    assert.match(r.out, /INTERNAL_TEST_RECIPIENT_BLOCKED {2}En mode INTERNAL_TEST, un envoi réel n'est autorisé que vers GMAIL_USER\./);
    assert.match(r.out, /TOTAL NEW SENDS {7}0/);
    assert.ok(!/CONFIRMATION/.test(r.out), 'refusé avant même la confirmation');
    assert.deepEqual(r.ecrits, { envois: 0, registre: 0, brouillons: 0, reservations: 0 });
  });

  test('--send --yes vers GMAIL_USER, porte fermée : OUTBOUND_DISABLED prioritaire, code 3, rien d’écrit', () => {
    const r = lancer([selfTest()], ['--send', '--yes']);
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /OUTBOUND_DISABLED {2}ATLAS_OUTBOUND_ENABLED n’est pas vrai/);
    assert.ok(!/INTERNAL_TEST_RECIPIENT_BLOCKED/.test(r.out), 'vers GMAIL_USER, seule la porte refuse');
    assert.deepEqual(r.ecrits, { envois: 0, registre: 0, brouillons: 0, reservations: 0 });
  });

  test('sans --send : simulation, et la NOTE annonce ce que --send refuserait', () => {
    const r = lancer([externe()], []);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /NOTE avec --send, INTERNAL_TEST_RECIPIENT_BLOCKED refuserait tout le lot/);
    assert.match(r.out, /BLOCKED {2}Acme Industrie — envoi non autorisé : OUTBOUND_DISABLED/);
    assert.deepEqual(r.ecrits, { envois: 0, registre: 0, brouillons: 0, reservations: 0 });
  });
});

describe('8. l’unique exception : le self-test isolé face à une boîte pleine de @gmail.com (relevé v4.5.4)', () => {
  test('la règle pure : quatre conditions exactes, et aucune de moins', () => {
    const item = { domain: SELF_TEST_DOMAIN, recipient: GMAIL_USER, purpose: 'FIRST_TOUCH' as const };
    assert.equal(isIsolatedSelfTest({ engineMode: 'INTERNAL_TEST', gmailUser: GMAIL_USER, item }), true);
    assert.equal(isIsolatedSelfTest({ engineMode: 'INTERNAL_TEST', gmailUser: ' NOAROY@gmail.com ', item: { ...item, recipient: 'NoaRoy@GMAIL.com' } }), true, 'trim + minuscules sur l’adresse');
    assert.equal(isIsolatedSelfTest({ engineMode: 'PRODUCTION', gmailUser: GMAIL_USER, item }), false, 'PRODUCTION : aucune exception');
    assert.equal(isIsolatedSelfTest({ engineMode: 'INTERNAL_TEST', gmailUser: GMAIL_USER, item: { ...item, recipient: 'contact@acme-industrie.fr' } }), false);
    assert.equal(isIsolatedSelfTest({ engineMode: 'INTERNAL_TEST', gmailUser: GMAIL_USER, item: { ...item, domain: 'gmail.com' } }), false, 'un autre domaine : pas d’exception');
    assert.equal(isIsolatedSelfTest({ engineMode: 'INTERNAL_TEST', gmailUser: GMAIL_USER, item: { ...item, domain: 'Selftest.atlas.invalid' } }), false, 'le domaine est exact, pas normalisé');
    assert.equal(isIsolatedSelfTest({ engineMode: 'INTERNAL_TEST', gmailUser: GMAIL_USER, item: { ...item, purpose: 'FOLLOW_UP' } }), false);
    assert.equal(isIsolatedSelfTest({ engineMode: 'INTERNAL_TEST', gmailUser: GMAIL_USER, item: { domain: SELF_TEST_DOMAIN, recipient: GMAIL_USER } }), false, 'sans purpose explicite : pas d’exception');
    assert.equal(isIsolatedSelfTest({ engineMode: 'INTERNAL_TEST', gmailUser: '', item }), false);
  });

  test('self-test + dix messages de gmail.com dans la boîte : la recherche par domaine est ignorée, tout le reste joue, SENT', async () => {
    const boite = boiteGmail();
    const rapport = await run([selfTest()], { inbox: boite });
    assert.equal(rapport.refused, false);
    assert.deepEqual(rapport.results.map((r) => r.verdict), ['SENT'], JSON.stringify(rapport.results));
    assert.match(rapport.results[0]!.motif, /self-test isolé$/);
    assert.ok(!boite.requetes.includes('from:gmail.com'), 'la requête générique from:gmail.com n’a pas été posée');
    assert.deepEqual(envois().map((e) => e.to), [GMAIL_USER]);
    assert.equal(repos.salesLoop.sentSince(EPOCH), 1);
    assert.equal(repos.sales.ledgerFor(SELF_TEST_DOMAIN)?.kind, 'CONTACTED', 'registre : inchangé dans son rôle');
    const cle = sendKey({ domain: SELF_TEST_DOMAIN, recipient: GMAIL_USER, subject: 'ATLAS — self-test', body: 'Premier envoi réel, vers moi-même.', purpose: 'FIRST_TOUCH' });
    assert.equal(repos.salesLoop.sendOutcome(cle).sent, true, 'réservation + issue consignées : l’idempotence n’est pas contournée');
    assert.equal(repos.salesLoop.draftsInState('SENT').length, 1, 'brouillon approuvé puis parti');
  });

  test('un prospect réel en @gmail.com : la garde des messages reçus reste active — en PRODUCTION comme avant', async () => {
    const boite = boiteGmail();
    // Une relance : un premier contact vers une adresse hors domaine serait
    // déjà refusé par la porte qualité, avant la boîte.
    repos.sales.recordOutreach({ domain: 'acme-industrie.fr', kind: 'CONTACTED', recordedBy: 'test', channel: 'EMAIL', recordedAt: '2026-09-01T09:00:00.000Z' });
    const lot = [externe({ domain: 'acme-industrie.fr', recipient: 'jean.acme@gmail.com', purpose: 'FOLLOW_UP' })];
    const rapport = await run(lot, { engineMode: 'PRODUCTION', inbox: boite });
    assert.equal(rapport.refused, false);
    assert.equal(rapport.results[0]!.verdict, 'BLOCKED');
    assert.match(rapport.results[0]!.motif, /^10 message\(s\) reçu\(s\) de gmail\.com — à lire avant de relancer$/);
    assert.ok(boite.requetes.includes('from:gmail.com'), 'la requête générique a bien été posée');
    assert.deepEqual(envois(), []);
    assert.equal(repos.salesLoop.sentSince(EPOCH), 0, 'MESSAGES SENT: 0');
  });

  test('domaine selftest.atlas.invalid mais destinataire ≠ GMAIL_USER : INTERNAL_TEST_RECIPIENT_BLOCKED, avant tout', async () => {
    const boite = boiteGmail();
    const lot = [selfTest({ recipient: 'contact@acme-industrie.fr' })];
    const rapport = await run(lot, { inbox: boite });
    assert.equal(rapport.refused, true);
    assert.deepEqual(rapport.guard.blocks.map((b) => b.code), [INTERNAL_TEST_RECIPIENT_BLOCKED]);
    assert.deepEqual(boite.requetes, [], 'la boîte n’a même pas été lue');
    assert.deepEqual(reseau, []);
    assertRienEcrit(lot);
  });

  test('GMAIL_USER mais domaine ≠ selftest.atlas.invalid : pas d’exception — porte qualité pour un premier contact', async () => {
    const boite = boiteGmail();
    const lot = [selfTest({ domain: 'gmail.com', companyName: 'moi, sous un autre domaine' })];
    const rapport = await run(lot, { inbox: boite });
    assert.equal(rapport.refused, false, 'la garde de lot laisse passer : destinataire = GMAIL_USER');
    assert.equal(rapport.results[0]!.verdict, 'BLOCKED');
    assert.equal(rapport.results[0]!.code, 'QUALITY_GATE', 'traité comme un vrai prospect, pas comme le self-test');
    assert.deepEqual(boite.requetes, [], 'refusé avant même la lecture de la boîte');
    assert.deepEqual(envois(), []);
    assertRienEcrit(lot);
  });

  test('GMAIL_USER mais domaine ≠ selftest.atlas.invalid, en relance : la garde des messages reçus bloque', async () => {
    const boite = boiteGmail();
    repos.sales.recordOutreach({ domain: 'gmail.com', kind: 'CONTACTED', recordedBy: 'test', channel: 'EMAIL', recordedAt: '2026-09-01T09:00:00.000Z' });
    const lot = [selfTest({ domain: 'gmail.com', companyName: 'moi, sous un autre domaine', purpose: 'FOLLOW_UP' })];
    const rapport = await run(lot, { inbox: boite });
    assert.equal(rapport.results[0]!.verdict, 'BLOCKED');
    assert.match(rapport.results[0]!.motif, /10 message\(s\) reçu\(s\) de gmail\.com/);
    assert.ok(boite.requetes.includes('from:gmail.com'));
    assert.deepEqual(envois(), []);
    assert.equal(repos.salesLoop.sentSince(EPOCH), 0, 'MESSAGES SENT: 0');
  });

  test('self-test en FOLLOW_UP : pas d’exception — et le registre le refuse de toute façon', async () => {
    const boite = boiteGmail();
    const rapport = await run([selfTest({ purpose: 'FOLLOW_UP' })], { inbox: boite });
    assert.equal(rapport.results[0]!.verdict, 'BLOCKED');
    assert.match(rapport.results[0]!.motif, /absente du registre/);
    assert.deepEqual(envois(), []);
  });

  test('porte fermée : OUTBOUND_DISABLED avant tout, boîte jamais lue', async () => {
    const boite = boiteGmail();
    const lot = [selfTest()];
    const rapport = await run(lot, { outboundEnabled: false, inbox: boite });
    assert.equal(rapport.refused, true);
    assert.deepEqual(rapport.guard.blocks.map((b) => b.code), ['OUTBOUND_DISABLED']);
    assert.deepEqual(boite.requetes, []);
    assert.deepEqual(reseau, []);
    assertRienEcrit(lot);
  });

  test('le self-test envoyé deux fois : un seul envoi, MESSAGES SENT reste 1, second lancement BLOCKED', async () => {
    const premier = await run([selfTest()], { inbox: boiteGmail() });
    assert.equal(premier.results[0]!.verdict, 'SENT');
    const second = await run([selfTest()], { inbox: boiteGmail() });
    assert.equal(second.refused, false);
    assert.equal(second.results[0]!.verdict, 'BLOCKED');
    assert.match(second.results[0]!.motif, /deja contactee le \d{4}-\d{2}-\d{2}/);
    assert.equal(envois().length, 1);
    assert.equal(repos.salesLoop.sentSince(EPOCH), 1);
    assert.deepEqual(repos.salesLoop.realSentSince(EPOCH), { real: 1, simulated: 0, unattributed: 0 });
  });
});

describe('SEC-09 : le chemin manuel applique la politique du daemon', () => {
  /** Rien n'a été réservé ni envoyé ; le registre n'a pas bougé. */
  const assertAucunEnvoi = () => {
    assert.deepEqual(envois(), [], 'aucun appel d’envoi');
    assert.equal(repos.salesLoop.sentSince(EPOCH), 0, 'MESSAGES SENT: 0');
    assert.equal(repos.salesLoop.draftsInState('APPROVED_TO_SEND').length + repos.salesLoop.draftsInState('SENT').length, 0, 'aucun brouillon approuvé');
  };

  test('SEC-T13 : suppression manuelle DOMAIN (sans DO_NOT_CONTACT au registre) → SUPPRESSED, 0 message', async () => {
    const item = conforme();
    repos.salesEngine.suppress({ kind: 'DOMAIN', value: item.domain, reason: 'MANUAL', createdBy: 'proprietaire' });
    assert.equal(repos.sales.ledgerFor(item.domain), null, 'le registre ne dit rien : seule la liste de suppression protège');
    const rapport = await run([item], { engineMode: 'PRODUCTION' });
    assert.equal(rapport.refused, false);
    assert.equal(rapport.results[0]!.verdict, 'BLOCKED');
    assert.equal(rapport.results[0]!.code, 'SUPPRESSED');
    assert.match(rapport.results[0]!.motif, /SUPPRESSED/);
    assertAucunEnvoi();
  });

  test('suppression EMAIL et COMPANY : même refus', async () => {
    const parEmail = conforme('alpha.fr');
    repos.salesEngine.suppress({ kind: 'EMAIL', value: parEmail.recipient, reason: 'OPT_OUT', createdBy: 'proprietaire' });
    const parSociete = conforme('beta.fr');
    repos.salesEngine.suppress({ kind: 'COMPANY', value: parSociete.companyName, reason: 'LEGAL', createdBy: 'proprietaire' });
    const rapport = await run([parEmail, parSociete], { engineMode: 'PRODUCTION' });
    assert.deepEqual(rapport.results.map((r) => r.code), ['SUPPRESSED', 'SUPPRESSED']);
    assertAucunEnvoi();
  });

  test('suppression posée sur le domaine réel de l’adresse, différent de celui du dossier → SUPPRESSED', async () => {
    const item = conforme('merand.fr', { recipient: 'commercial@merand-groupe.fr' });
    repos.salesEngine.suppress({ kind: 'DOMAIN', value: 'merand-groupe.fr', reason: 'OPT_OUT', createdBy: 'proprietaire' });
    const rapport = await run([item], { engineMode: 'PRODUCTION' });
    assert.equal(rapport.results[0]!.code, 'SUPPRESSED');
    assert.match(rapport.results[0]!.motif, /merand-groupe\.fr/);
    assertAucunEnvoi();
  });

  test('le self-test isolé lui-même respecte la liste de suppression', async () => {
    repos.salesEngine.suppress({ kind: 'EMAIL', value: GMAIL_USER, reason: 'MANUAL', createdBy: 'proprietaire' });
    const rapport = await run([selfTest()]);
    assert.equal(rapport.results[0]!.code, 'SUPPRESSED');
    assertAucunEnvoi();
  });

  test('SEC-T14 : coupe-circuit actif → GLOBAL_PAUSE, boîte jamais lue, 0 appel réseau', async () => {
    setGlobalPause(repos, true, 'proprietaire', 'incident délivrabilité');
    const boite = boiteGmail();
    const rapport = await run([conforme()], { engineMode: 'PRODUCTION', inbox: boite });
    assert.equal(rapport.results[0]!.verdict, 'BLOCKED');
    assert.equal(rapport.results[0]!.code, 'GLOBAL_PAUSE');
    assert.match(rapport.results[0]!.motif, /incident délivrabilité/);
    assert.deepEqual(boite.requetes, []);
    assert.deepEqual(reseau, []);
    assertAucunEnvoi();
  });

  test('le coupe-circuit arrête aussi le self-test isolé, et il est nommé en premier', async () => {
    setGlobalPause(repos, true, 'proprietaire', 'arrêt');
    const rapport = await run([selfTest()], { now: new Date('2026-10-04T20:00:00.000Z') });
    assert.equal(rapport.results[0]!.code, 'GLOBAL_PAUSE', 'la pause prime sur la fenêtre et le week-end');
    assertAucunEnvoi();
  });

  test('la reprise lève le refus : même lot, SENT', async () => {
    setGlobalPause(repos, true, 'proprietaire', 'arrêt');
    setGlobalPause(repos, false, 'proprietaire', null);
    const rapport = await run([selfTest()]);
    assert.deepEqual(rapport.results.map((r) => r.verdict), ['SENT']);
  });

  test('hors fenêtre (mercredi 20 h à Paris) → OUTSIDE_SEND_WINDOW ; dimanche → WEEKEND', async () => {
    const soir = await run([conforme('alpha.fr')], { engineMode: 'PRODUCTION', now: new Date('2026-10-07T18:00:00.000Z') });
    assert.equal(soir.results[0]!.code, 'OUTSIDE_SEND_WINDOW');
    const dimanche = await run([conforme('beta.fr')], { engineMode: 'PRODUCTION', now: new Date('2026-10-04T09:00:00.000Z') });
    assert.equal(dimanche.results[0]!.code, 'WEEKEND');
    assertAucunEnvoi();
  });

  test('plafond quotidien atteint → DAILY_CAP_REACHED ; plafond horaire → HOURLY_CAP_REACHED', async () => {
    const jour = await run([conforme('alpha.fr')], { engineMode: 'PRODUCTION', policy: { ...POLICY, dailyCapPerMailbox: 0 } });
    assert.equal(jour.results[0]!.code, 'DAILY_CAP_REACHED');
    const heure = await run([conforme('beta.fr')], { engineMode: 'PRODUCTION', policy: { ...POLICY, hourlyCap: 0 } });
    assert.equal(heure.results[0]!.code, 'HOURLY_CAP_REACHED');
    assertAucunEnvoi();
  });

  test('un lot de deux : le premier part, le second attend le délai minimal — l’état est relu à chaque ligne', async () => {
    const rapport = await run([conforme('alpha.fr'), conforme('beta.fr')], { engineMode: 'PRODUCTION' });
    assert.deepEqual(rapport.results.map((r) => r.verdict), ['SENT', 'BLOCKED']);
    assert.equal(rapport.results[1]!.code, 'MIN_DELAY_NOT_ELAPSED');
    assert.equal(envois().length, 1);
    assert.equal(repos.salesLoop.sentSince(EPOCH), 1);
  });

  test('une réponse déjà consignée (même en NEEDS_REVIEW) → REPLY_RECEIVED', async () => {
    repos.sales.recordOutreach({ domain: 'acme-industrie.fr', kind: 'CONTACTED', recordedBy: 'test', channel: 'EMAIL', recordedAt: '2026-09-01T09:00:00.000Z' });
    const { conversation } = repos.conversations.open({ domain: 'acme-industrie.fr', companyName: 'Acme Industrie', channel: 'email', destination: 'contact@acme-industrie.fr', source: 'test' });
    repos.conversations.recordInboundEvent({
      conversationId: conversation.id, kind: 'REPLY', classification: 'NEEDS_REVIEW', confidence: 0.5,
      occurredAt: '2026-09-02T09:00:00.000Z', source: 'test',
    });
    const rapport = await run([externe({ purpose: 'FOLLOW_UP' })], { engineMode: 'PRODUCTION' });
    assert.equal(rapport.results[0]!.code, 'REPLY_RECEIVED');
    assertAucunEnvoi();
  });

  test('la simulation (sans --send) dit aussi le refus de politique, sans rien écrire', async () => {
    const item = conforme();
    repos.salesEngine.suppress({ kind: 'DOMAIN', value: item.domain, reason: 'MANUAL', createdBy: 'proprietaire' });
    const rapport = await run([item], { engineMode: 'PRODUCTION', send: false });
    assert.equal(rapport.results[0]!.code, 'SUPPRESSED');
    assert.deepEqual(reseau, []);
    assertAucunEnvoi();
  });

  test('le script passe la politique du daemon (`sendPolicyOf(config)`) à runManualSendLot', () => {
    const source = readFileSync(join(ROOT, 'scripts', 'sales-send-approved.ts'), 'utf8');
    assert.match(source, /policy: sendPolicyOf\(config\)/);
  });
});
