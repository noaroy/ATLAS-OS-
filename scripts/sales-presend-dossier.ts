/**
 * Le dossier complet d'un message, avant qu'il ne parte.
 *
 * Un envoi se décide sur des faits, pas sur une ligne de tableau. Ce script
 * rassemble, pour chaque destinataire nommé explicitement, tout ce qui a servi
 * à composer le message et tout ce qui pourrait l'interdire : le score, la
 * provenance de l'adresse, les deux faits sourcés avec leurs URL, l'état du
 * registre, la place d'idempotence, le quota du jour, et le corps intégral
 * exact — celui qui partirait, sans troncature ni reformulation.
 *
 * Il ne compose rien. Le texte est lu en base tel qu'il a été écrit, parce
 * qu'un texte régénéré ici ne serait pas celui qui a été approuvé.
 *
 * Lecture seule et stricte : aucun appel modèle, aucune recherche, aucune
 * écriture, aucun envoi. Les seuls appels réseau sont deux lectures Gmail —
 * les mêmes que la garde 4 du script d'envoi — pour vérifier que l'entreprise
 * n'a pas écrit la première et qu'aucun message ne lui est déjà parti.
 *
 *   npm run sales:presend -- precobox.fr providif.fr groupe-ledoux.com
 */
import { loadConfig, loadAtlasEnv, createLogger } from '../packages/core/src/index.ts';
import { createRepositories, sendKey } from '../packages/data/src/index.ts';
import { GmailInboxProvider } from '../packages/intelligence/src/index.ts';
import {
  classifyContactIntent, outreachSuitability,
  whyNotACompanyName, SALES_TIER_THRESHOLDS,
} from '../packages/departments/src/index.ts';
import { buildApprovals } from '../packages/server/src/http/command-center.ts';

loadAtlasEnv();

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', amber: '\x1b[33m', cyan: '\x1b[36m',
};

const cibles = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (cibles.length === 0) {
  console.error('  nommez au moins un domaine : npm run sales:presend -- precobox.fr');
  process.exit(2);
}

const config = loadConfig(process.cwd());
const logger = createLogger({ level: 'error', pretty: false });
const repos = createRepositories(config.paths.databaseFile, logger);
const inbox = new GmailInboxProvider({ logger });

const today = new Date().toISOString().slice(0, 10);
const envoyesAujourdhui = repos.salesLoop.sentSince(today + 'T00:00:00.000Z');
const restant = Math.max(0, config.sales.maxNewOutreachPerDay - envoyesAujourdhui);
const totalEnvoyes = repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z');

const vue = buildApprovals(repos);

const ligne = (k: string, v: string, ok?: boolean) => {
  const m = ok === undefined ? '   ' : ok ? c.green + ' OK' + c.reset : c.red + ' !!' + c.reset;
  console.log('    ' + m + '  ' + k.padEnd(24) + v);
};

console.log('\n  ' + c.bold + c.cyan + 'DOSSIERS AVANT ENVOI' + c.reset);
console.log('  ' + c.dim + 'lecture seule — aucun appel modèle, aucune recherche, aucun envoi' + c.reset);
console.log('  ' + c.dim + 'MESSAGES SENT : ' + totalEnvoyes + ' · quota du jour : '
  + envoyesAujourdhui + '/' + config.sales.maxNewOutreachPerDay + ' — ' + restant + ' restant(s)' + c.reset + '\n');

const verdicts: Array<{ nom: string; verdict: string; motif: string }> = [];

for (const cible of cibles) {
  const item = vue.pending.find(
    (p) => p.domain === cible
      || p.domain.endsWith('.' + cible)
      || (p.channelTarget ?? '').endsWith('@' + cible)
      || p.company.toLowerCase().includes(cible.toLowerCase()),
  );

  if (!item) {
    console.log('  ' + c.bold + cible + c.reset + '  ' + c.red + "introuvable dans la file d'approbation" + c.reset + '\n');
    verdicts.push({ nom: cible, verdict: 'BLOCK', motif: 'absent de la file' });
    continue;
  }

  const p = item.prospectId ? repos.sales.get(item.prospectId) : null;
  const domain = item.domain;
  const destinataire = item.channelTarget ?? item.recipient ?? '';

  console.log('  ' + '-'.repeat(74));
  console.log('  ' + c.bold + item.company + c.reset + '  ' + c.dim + domain + c.reset + '\n');

  /** Ce qui interdit l'envoi, et ce qui mérite seulement une relecture. */
  const blocs: string[] = [];
  const edits: string[] = [];

  // ── 1. L'entreprise est-elle bien celle qu'on croit ? ───────────────────
  const titre = whyNotACompanyName(item.company);
  ligne('entreprise', item.company, titre === null);
  if (titre) edits.push('nom suspect : ' + titre);

  const conf = p?.identityConfidence ?? null;
  ligne('identity confidence', conf === null ? 'N/A' : conf.toFixed(2), conf !== null && conf >= 0.75);
  ligne('identity sources', (p?.identitySources ?? []).join(', ') || 'aucune');
  if (conf !== null && conf < 0.75) edits.push("confiance d'identité " + conf.toFixed(2) + ' < 0,75');

  // ── 2. Le canal ─────────────────────────────────────────────────────────
  ligne('destinataire', destinataire || 'aucun', item.actionType === 'EMAIL' && destinataire !== '');
  ligne('canal', item.actionType + ' — ' + item.channelReason, item.actionType === 'EMAIL');
  if (item.actionType !== 'EMAIL') blocs.push('canal ' + item.actionType + " : ce n'est pas un envoi email");

  const observe = p?.contactObserved ?? false;
  ligne('contactObserved', observe ? 'YES — relevée sur une page du site' : 'NO — adresse non relevée', observe);
  ligne('contact source', p?.contactSourceUrl ?? 'aucune');
  if (!observe) blocs.push('adresse jamais relevée sur une page : elle serait devinée');

  const intent = classifyContactIntent({
    value: destinataire, kind: 'EMAIL', sourceUrl: p?.contactSourceUrl ?? '',
  });
  const suit = outreachSuitability(intent, Boolean(p?.contactRole));
  ligne('contact suitability', intent + ' / ' + suit, suit !== 'LOW' && intent !== 'PERSONAL');
  if (suit === 'LOW' || intent === 'PERSONAL') blocs.push('canal ' + intent + '/' + suit + ' : aucun démarchage');

  ligne('domain match', item.recipientDomainMatch + ' — ' + item.domainReason,
    item.recipientDomainMatch === 'MATCH');
  if (item.recipientDomainMatch === 'CROSS_DOMAIN') edits.push('adresse hors du domaine du prospect');

  // ── 2 bis. L'objet, sans quoi rien ne part ──────────────────────
  //
  // Les brouillons du lot ne portent que le corps : la ligne d'objet n'a jamais
  // été écrite en base. Un envoi sans objet arrive avec un sujet vide dans la
  // boîte du destinataire — c'est un signal de courrier automatique, et cela
  // suffit à faire ignorer un message par ailleurs bon.
  const objet = (item.subject ?? '').trim();
  ligne('objet', objet || 'AUCUN — le message partirait sans sujet', objet !== '');
  if (objet === '') blocs.push("aucun objet en base : le message partirait sans sujet");

  // ── 2 ter. La devise, telle qu'elle est écrite ────────────────────
  const devise = item.body.includes('49 EUR') ? '49 EUR' : item.body.includes('49 €') || item.body.includes('49 €') ? '49 €' : 'absente';
  ligne('prix écrit', devise, devise === '49 €');
  if (devise === '49 EUR') edits.push("prix écrit « 49 EUR » — la forme retenue est « 49 € »");

  // ── 3. Le score ─────────────────────────────────────────────────────────
  const score = item.score ?? 0;
  ligne('score', score.toFixed(2) + '/100 (seuil PRIORITY ' + SALES_TIER_THRESHOLDS.priority + ')',
    score >= SALES_TIER_THRESHOLDS.priority);
  if (score < SALES_TIER_THRESHOLDS.priority) blocs.push('score ' + score + ' sous le seuil');

  // ── 4. Les faits, avec leurs sources ────────────────────────────────────
  console.log();
  const faits = item.facts;
  ligne('faits commerciaux', faits.length + ' sourcé(s) — 2 exigés', faits.length >= 2);
  faits.forEach((f, i) => {
    console.log('        ' + c.bold + (i + 1) + '.' + c.reset + ' « ' + f.quote + ' »');
    console.log('           ' + c.dim + 'source : ' + f.sourceUrl + c.reset);
  });
  if (faits.length < 2) blocs.push(faits.length + ' fait(s) sourcé(s) — deux au minimum');
  console.log();

  // ── 5. A-t-elle déjà reçu quelque chose ? ───────────────────────────────
  const registre = repos.sales.ledgerFor(domain);
  ligne('registre', registre ? registre.kind + ' — ' + (registre.recordedAt ?? '').slice(0, 10) : 'jamais contactée',
    registre === null);
  if (registre?.kind === 'DO_NOT_CONTACT') blocs.push('registre : DO_NOT_CONTACT');
  if (registre?.kind === 'CONTACTED') blocs.push('déjà contactée le ' + (registre.recordedAt ?? '').slice(0, 10));

  const dernier = repos.salesLoop.lastSentTo(domain);
  ligne('ancien envoi', dernier ? 'YES — ' + dernier.slice(0, 10) : 'NO', dernier === null);
  if (dernier !== null) blocs.push('message déjà envoyé le ' + dernier.slice(0, 10));

  // ── 6. Gmail : a-t-elle écrit ? lui a-t-on écrit ? ──────────────────────
  const hote = destinataire.split('@')[1] ?? domain;
  try {
    const recus = await inbox.list({ rawFilter: 'from:' + hote, max: 10, since: '2026-01-01T00:00:00.000Z' });
    ligne('reçus de ce domaine', recus.length === 0 ? 'aucun' : recus.length + " — à lire avant d'écrire",
      recus.length === 0);
    if (recus.length > 0) blocs.push(recus.length + ' message(s) reçu(s) de ' + hote);
  } catch (err) {
    ligne('reçus de ce domaine', 'illisible : ' + (err instanceof Error ? err.message.slice(0, 40) : String(err)), false);
    blocs.push('boîte illisible');
  }
  try {
    const partis = await inbox.list({
      rawFilter: 'in:sent to:' + destinataire, max: 5,
      includeOwnMessages: true, since: '2026-01-01T00:00:00.000Z',
    });
    ligne('déjà écrit à l’adresse', partis.length === 0 ? 'NO' : 'YES — ' + partis.length, partis.length === 0);
    if (partis.length > 0) blocs.push(partis.length + ' message(s) déjà envoyé(s) à ' + destinataire);
  } catch { ligne('déjà écrit à l’adresse', 'inconnu'); }

  // ── 7. La place d'idempotence ───────────────────────────────────────────
  const cle = sendKey({
    domain, recipient: destinataire, subject: item.subject ?? '',
    body: item.body, purpose: 'FIRST_TOUCH',
  });
  const issue = repos.salesLoop.sendOutcome(cle);
  ligne('anti-doublon', (issue.sent ? 'PLACE PRISE' : 'libre') + ' (' + cle.slice(0, 16) + '…)', !issue.sent);
  if (issue.sent) blocs.push("la place d'idempotence porte déjà un envoi");
  if (issue.exists && issue.ambiguous) blocs.push('issue ambiguë : décision humaine requise');

  ligne('quota', envoyesAujourdhui + '/' + config.sales.maxNewOutreachPerDay + ' — ' + restant + ' restant(s)',
    restant > 0);
  if (restant <= 0) blocs.push('quota du jour atteint');

  // ── 8. Le texte exact, celui qui partirait ──────────────────────────────
  console.log();
  console.log('    ' + c.bold + 'OBJET' + c.reset + '  ' + (objet || c.red + '(aucun)' + c.reset));
  console.log('    ' + c.bold + 'CORPS INTÉGRAL' + c.reset + '  ' + c.dim + item.body.length
    + ' caractères — texte exact en base' + c.reset);
  console.log('    ' + c.dim + '.'.repeat(70) + c.reset);
  for (const l of item.body.split('\n')) console.log('    ' + l);
  console.log('    ' + c.dim + '.'.repeat(70) + c.reset);

  const verdict = blocs.length > 0 ? 'BLOCK' : edits.length > 0 ? 'EDIT' : 'SEND';
  const couleur = verdict === 'SEND' ? c.green : verdict === 'EDIT' ? c.amber : c.red;
  console.log('\n    ' + couleur + c.bold + verdict + c.reset + '  ' + (blocs[0] ?? edits[0] ?? 'toutes les gardes passent'));
  if (blocs.length > 1) console.log('    ' + c.dim + 'aussi : ' + blocs.slice(1).join(' · ') + c.reset);
  if (verdict !== 'BLOCK' && edits.length > 0) console.log('    ' + c.dim + 'réserves : ' + edits.join(' · ') + c.reset);
  console.log();
  verdicts.push({ nom: item.company, verdict, motif: blocs[0] ?? edits[0] ?? 'toutes les gardes passent' });
}

console.log('  ' + '='.repeat(74));
for (const v of verdicts) {
  const couleur = v.verdict === 'SEND' ? c.green : v.verdict === 'EDIT' ? c.amber : c.red;
  console.log('  ' + couleur + v.verdict.padEnd(6) + c.reset + ' ' + v.nom.slice(0, 30).padEnd(32) + c.dim + v.motif + c.reset);
}
console.log('\n  ' + c.dim + 'MESSAGES SENT : ' + repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z')
  + " — inchangé, ce script n'envoie rien" + c.reset + '\n');

repos.close();
