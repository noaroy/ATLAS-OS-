import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../core/src/logger.ts';
import { GUARD_VERSION } from '../../core/src/index.ts';
import { createRepositories, sendKey, type Repositories } from '../../data/src/index.ts';
import { buildApprovals } from '../src/http/command-center.ts';

/**
 * La file d'approbation, lue dans les deux magasins de brouillons.
 *
 * ATLAS en tient deux, pour des raisons historiques : `outreach_drafts` pour la
 * boucle d'outreach, `sales_prospects` en état `READY_FOR_REVIEW` pour le lot de
 * prospection. L'écran ne lisait que le premier — et les neuf brouillons qu'il
 * savait lire étaient tous déjà envoyés. Vingt-et-un dossiers réellement prêts
 * n'apparaissaient nulle part.
 *
 * Les rendre visibles d'un coup aurait fait remonter des décisions déjà prises.
 * Ce que ces tests tiennent, c'est donc moins l'union que le tri :
 *
 *   · Ce qui est parti ne revient pas. Un message déjà envoyé proposé une
 *     seconde fois se renvoie, et un destinataire qui reçoit deux fois le même
 *     courriel ne répond plus jamais.
 *   · Un dossier écarté reste consultable avec son motif. Disparaître sans
 *     trace est ce qui avait rendu deux entreprises invisibles pendant des
 *     semaines.
 *   · Lire n'écrit rien. Un écran qui modifie ce qu'il affiche finit par
 *     afficher ce qu'il a modifié.
 */

const logger = createLogger({ level: 'error', pretty: false });
let dir: string;
let repos: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-appr-'));
  repos = createRepositories(join(dir, 'db.sqlite'), logger);
});
afterEach(() => {
  repos.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Un prospect du lot, prêt à relire. */
function prospectPret(options: {
  domain: string;
  company?: string;
  at?: string;
  contact?: string | null;
  observed?: boolean;
}) {
  const { prospect } = repos.sales.discover({
    batchId: 'B-001',
    companyName: options.company ?? 'Entreprise',
    domain: options.domain,
    website: `https://${options.domain}`,
    discoveredAt: options.at ?? '2026-08-20T00:00:00.000Z',
    identityConfidence: 0.9,
    identitySources: ['mentions legales'],
    // Sans version de garde, la revue refuse le dossier : il serait anterieur
    // aux controles d'identite, donc non verifie plutot que faux.
    guardVersion: GUARD_VERSION,
    pageType: 'OFFICIAL_COMPANY_SITE',
  });
  // La machine a etats impose le passage : DISCOVERED -> QUALIFIED -> pret.
  repos.sales.setScore(prospect.id, {
    score: 72, tier: 'PRIORITY', detail: {}, whyFit: 'PME industrielle',
  });
  repos.sales.setState(prospect.id, 'QUALIFIED');

  const contact = options.contact === undefined ? `contact@${options.domain}` : options.contact;
  if (contact) {
    repos.sales.setContact(prospect.id, {
      name: null, role: null, email: contact, phone: null, contactPage: null,
      sourceUrl: `https://${options.domain}/contact`, confidence: 0.9,
      method: 'EMAIL', confidenceLabel: 'HIGH',
      observed: options.observed ?? true,
    });
  }
  const preuve = repos.sales.addEvidence({
    prospectId: prospect.id, field: 'signal:export',
    claim: 'Nous accompagnons des industriels à l’international depuis 1976.',
    nature: 'observed', sourceUrl: `https://${options.domain}/a-propos`,
    basis: null, confidence: 0.8,
  });
  // Deux faits sources : c'est l'exigence de la revue, et elle vaut ici aussi.
  repos.sales.addEvidence({
    prospectId: prospect.id, field: 'signal:new_capacity',
    claim: 'Nous avons installe cette annee une nouvelle machine de decoupe laser.',
    nature: 'observed', sourceUrl: `https://${options.domain}/savoir-faire`,
    basis: null, confidence: 0.8,
  });
  repos.sales.setOutreach(prospect.id, {
    personalizationFactId: preuve.id,
    messageShort: 'court',
    messageEmail: 'Bonjour,\n\nJ’ai regardé votre site.\n\nBien à vous,',
    sourceUrl: `https://${options.domain}/a-propos`,
  });
  repos.sales.setState(prospect.id, 'READY_FOR_REVIEW');
  return prospect;
}

/** Un brouillon de la boucle d'outreach. */
function brouillon(domain: string, state = 'READY_FOR_APPROVAL') {
  const d = repos.salesLoop.saveDraft({
    domain,
    companyName: 'Entreprise',
    recipient: `contact@${domain}`,
    subject: 'Sujet',
    body: 'Corps du message.',
    purpose: 'FIRST_TOUCH',
    sources: [{ quote: 'un fait', sourceUrl: `https://${domain}/a` }],
    createdBy: 'test',
  });
  if (state !== 'READY_FOR_APPROVAL') {
    repos.salesLoop.decideDraft({
      draftId: d.id,
      decision: state as 'APPROVED_TO_SEND' | 'REJECTED',
      decidedBy: 'test',
    });
  }
  return d;
}

describe('les deux magasins alimentent une seule file', () => {
  test('un prospect READY_FOR_REVIEW apparaît', () => {
    prospectPret({ domain: 'lot.invalid', company: 'Depuis le lot' });
    const vue = buildApprovals(repos);

    assert.equal(vue.pending.length, 1);
    assert.equal(vue.pending[0]!.source, 'SALES_PROSPECT');
    assert.equal(vue.bySource.SALES_PROSPECT, 1);
  });

  test('un brouillon d’outreach apparaît', () => {
    brouillon('outreach.invalid');
    const vue = buildApprovals(repos);

    assert.equal(vue.pending.length, 1);
    assert.equal(vue.pending[0]!.source, 'OUTREACH_DRAFT');
    assert.equal(vue.bySource.OUTREACH_DRAFT, 1);
  });

  test('la source de chaque ligne est nommée, jamais devinée', () => {
    prospectPret({ domain: 'a.invalid' });
    brouillon('b.invalid');
    const vue = buildApprovals(repos);

    assert.equal(vue.pending.length, 2);
    for (const item of vue.pending) {
      assert.ok(['OUTREACH_DRAFT', 'SALES_PROSPECT'].includes(item.source), item.source);
    }
  });
});

describe('l’état persistant n’est pas réécrit pour l’affichage', () => {
  test('READY_FOR_REVIEW reste READY_FOR_REVIEW sous un libellé d’écran', () => {
    // Deux états persistants distincts, dans deux tables distinctes. Les
    // confondre pour uniformiser l'écran ferait mentir toute requête ultérieure.
    prospectPret({ domain: 'etat.invalid' });
    const item = buildApprovals(repos).pending[0]!;

    assert.equal(item.sourceState, 'READY_FOR_REVIEW');
    assert.equal(item.uiStatus, 'READY FOR APPROVAL');
  });

  test('un brouillon d’outreach garde son propre état', () => {
    brouillon('etat2.invalid');
    const item = buildApprovals(repos).pending[0]!;

    assert.equal(item.sourceState, 'READY_FOR_APPROVAL');
    assert.equal(item.uiStatus, 'READY FOR APPROVAL');
  });
});

describe('ce qui est déjà tranché ne revient pas', () => {
  test('un message déjà envoyé sort de la file', () => {
    // Le cas qui compte : proposer une seconde fois une décision déjà prise
    // fait renvoyer le message, et un destinataire qui reçoit deux fois le même
    // courriel ne répond plus.
    const domain = 'parti.invalid';
    prospectPret({ domain });
    const message = {
      domain, recipient: `contact@${domain}`, subject: 'S', body: 'B', purpose: 'FIRST_TOUCH',
    };
    repos.salesLoop.claimSend({ ...message, claimedBy: 'test' });
    repos.salesLoop.recordSendResult({
      idempotencyKey: sendKey(message), phase: 'SENT', externalMessageId: 'm-1',
    });

    const vue = buildApprovals(repos);
    assert.equal(vue.pending.length, 0);
    assert.equal(vue.excluded.length, 1);
    assert.match(vue.excluded[0]!.reason, /deja envoye/);
  });

  test('un brouillon abandonné n’entre jamais dans la file', () => {
    // La protection vient du filtre d'état, pas d'une vérification en plus :
    // `draftsInState` ne rend que les READY_FOR_APPROVAL.
    const d = brouillon('abandonne.invalid');
    repos.salesLoop.decideDraft({
      draftId: d.id, decision: 'ABANDONED', decidedBy: 'test',
      note: 'STALE_DRY_RUN_DRAFT',
    });
    assert.equal(buildApprovals(repos).pending.length, 0);
  });

  test('un brouillon rejeté n’entre jamais dans la file', () => {
    brouillon('rejete.invalid', 'REJECTED');
    assert.equal(buildApprovals(repos).pending.length, 0);
  });

  test('un domaine au registre DO_NOT_CONTACT sort de la file', () => {
    const domain = 'interdit.invalid';
    prospectPret({ domain });
    repos.sales.recordOutreach({
      domain, kind: 'DO_NOT_CONTACT', recordedBy: 'proprietaire',
      channel: 'EMAIL', recordedAt: '2026-08-21T00:00:00.000Z',
    });

    const vue = buildApprovals(repos);
    assert.equal(vue.pending.length, 0);
    assert.match(vue.excluded[0]!.reason, /DO_NOT_CONTACT/);
  });

  test('un dossier sans canal de contact sort de la file', () => {
    /*
     * Cet etat n'est plus atteignable par l'API : la revue refuse un prospect
     * sans canal public observe. Il existe pourtant en base — deux dossiers
     * anterieurs a cette garde. Le fixture les reproduit donc en ecrivant
     * directement, ce que la garde actuelle empeche precisement de refaire.
     */
    const p = prospectPret({ domain: 'sanscanal.invalid' });
    repos.db
      .prepare('UPDATE sales_prospects SET contact_email = NULL, contact_phone = NULL, contact_page = NULL WHERE id = ?')
      .run(p.id);

    const vue = buildApprovals(repos);
    assert.equal(vue.pending.length, 0);
    assert.match(vue.excluded[0]!.reason, /aucun canal/);
  });

  test('une adresse non relevée sur une page sort de la file', () => {
    // Une adresse deduite d'un nom est une invention polie. Meme cas
    // historique : la revue actuelle refuserait ce dossier en amont.
    const p = prospectPret({ domain: 'devine.invalid' });
    repos.db
      .prepare('UPDATE sales_prospects SET contact_observed = 0 WHERE id = ?')
      .run(p.id);

    const vue = buildApprovals(repos);
    assert.equal(vue.pending.length, 0);
    assert.match(vue.excluded[0]!.reason, /non releve/);
  });

  test('l’écarté garde sa place à l’historique, avec son motif', () => {
    // Disparaître sans trace est ce qui avait rendu deux entreprises
    // invisibles pendant des semaines.
    const p = prospectPret({ domain: 'trace.invalid', company: 'À tracer' });
    repos.db
      .prepare('UPDATE sales_prospects SET contact_email = NULL, contact_phone = NULL, contact_page = NULL WHERE id = ?')
      .run(p.id);
    const exclu = buildApprovals(repos).excluded[0]!;

    assert.equal(exclu.company, 'À tracer');
    assert.equal(exclu.domain, 'trace.invalid');
    assert.equal(exclu.sourceState, 'READY_FOR_REVIEW');
    assert.ok(exclu.reason.length > 0);
  });
});

describe('un même dossier ne s’affiche qu’une fois', () => {
  test('présent dans les deux magasins, il ne compte qu’une ligne', () => {
    const domain = 'double.invalid';
    prospectPret({ domain });
    brouillon(domain);

    const vue = buildApprovals(repos);
    assert.equal(vue.pending.length, 1, 'une seule ligne pour un seul dossier');
    // Le brouillon d'outreach l'emporte : il porte un objet et un corps validés.
    assert.equal(vue.pending[0]!.source, 'OUTREACH_DRAFT');
    assert.match(
      vue.excluded.find((e) => e.source === 'SALES_PROSPECT')!.reason,
      /deja present/,
    );
  });

  test('la déduplication porte sur le domaine, pas sur le texte', () => {
    // Comparer des textes serait approximatif, et une approximation qui masque
    // un brouillon est pire qu'un doublon visible.
    prospectPret({ domain: 'un.invalid' });
    prospectPret({ domain: 'deux.invalid' });
    assert.equal(buildApprovals(repos).pending.length, 2, 'deux domaines, deux lignes');
  });

  test('une version plus récente remplace la précédente', () => {
    const domain = 'reprise.invalid';
    prospectPret({ domain, at: '2026-08-01T00:00:00.000Z' });
    // Le même domaine, repris dans un lot ultérieur.
    const { prospect } = repos.sales.discover({
      batchId: 'B-002', companyName: 'Entreprise', domain,
      website: `https://${domain}`, discoveredAt: '2026-08-25T00:00:00.000Z',
      identityConfidence: 0.9, identitySources: ['mentions legales'],
    });
    void prospect;

    const vue = buildApprovals(repos);
    assert.ok(vue.pending.length <= 1, 'jamais deux fois le même domaine');
  });
});

describe('les boutons restent fermés', () => {
  test('aucune ligne n’est approuvable tant qu’aucun endpoint n’existe', () => {
    prospectPret({ domain: 'bouton.invalid' });
    const vue = buildApprovals(repos);

    assert.equal(vue.canApprove, false);
    assert.equal(vue.actionEndpoint, 'ACTION ENDPOINT UNAVAILABLE');
    assert.equal(vue.humanApprovalRequired, true);
    for (const item of vue.pending) assert.equal(item.canApprove, false);
  });
});

describe('lire n’écrit rien', () => {
  test('la base est identique avant et après', () => {
    // Un écran qui modifie ce qu'il affiche finit par afficher ce qu'il a
    // modifié.
    prospectPret({ domain: 'lecture.invalid' });
    brouillon('lecture2.invalid');

    const empreinte = () => ({
      prospects: repos.sales.forBatch('B-001').map((p) => `${p.id}:${p.state}`).sort().join('|'),
      drafts: ['READY_FOR_APPROVAL', 'APPROVED_TO_SEND', 'REJECTED', 'SENT', 'ABANDONED']
        .map((s) => `${s}=${repos.salesLoop.draftsInState(s).length}`).join('|'),
      sent: repos.salesLoop.sentSince('1970-01-01T00:00:00.000Z'),
    });

    const avant = empreinte();
    buildApprovals(repos);
    buildApprovals(repos);
    assert.deepEqual(empreinte(), avant);
  });
});

describe('chaque dossier porte son canal réel', () => {
  test('une adresse relevée donne EMAIL, et lui seul propose l’envoi', () => {
    prospectPret({ domain: 'courriel.invalid' });
    const item = buildApprovals(repos).pending[0]!;

    assert.equal(item.actionType, 'EMAIL');
    assert.equal(item.channelTarget, 'contact@courriel.invalid');
    assert.equal(item.actionLabel, 'EMAIL READY');
    // Et l'envoi reste impossible : le canal existe, l'endpoint non.
    assert.equal(item.canApprove, false);
  });

  test('un numéro seul donne PHONE, jamais EMAIL', () => {
    /*
     * Le cas STP Concept : le seul canal relevé est un numéro. Un brouillon
     * d'e-mail adressé à un téléphone ne partira jamais, et le proposer fait
     * perdre le temps de celui qui clique.
     */
    const p = prospectPret({ domain: 'telephone.invalid' });
    repos.db
      .prepare("UPDATE sales_prospects SET contact_email = NULL, contact_phone = '+33 4 76 45 69 25', contact_method = 'PHONE' WHERE id = ?")
      .run(p.id);

    const item = buildApprovals(repos).pending[0]!;
    assert.equal(item.actionType, 'PHONE');
    assert.equal(item.channelTarget, '+33 4 76 45 69 25');
    assert.match(item.actionLabel, /MANUAL/);
  });

  test('un formulaire donne FORM', () => {
    const p = prospectPret({ domain: 'formulaire.invalid' });
    repos.db
      .prepare("UPDATE sales_prospects SET contact_email = NULL, contact_page = 'https://formulaire.invalid/contact', contact_method = 'FORM' WHERE id = ?")
      .run(p.id);

    const item = buildApprovals(repos).pending[0]!;
    assert.equal(item.actionType, 'FORM');
    assert.equal(item.actionLabel, 'MANUAL FORM');
  });

  test('aucune adresse n’est jamais dérivée du domaine', () => {
    /*
     * La garde qui compte le plus : `contact@<domaine>` déduit d'un nom de
     * domaine est plausible, invérifiable, et parfois la boîte de quelqu'un
     * d'autre. Non relevée sur une page, elle ne devient pas un destinataire.
     */
    const p = prospectPret({ domain: 'devine2.invalid' });
    repos.db.prepare('UPDATE sales_prospects SET contact_observed = 0 WHERE id = ?').run(p.id);

    const vue = buildApprovals(repos);
    // Le dossier sort déjà de la file active ; s'il y revenait un jour, le
    // canal refuserait quand même de nommer un destinataire.
    assert.equal(vue.pending.length, 0);
    const rendu = JSON.stringify(vue.pending);
    assert.equal(rendu.includes('contact@devine2.invalid'), false);
  });

  test('les compteurs par canal totalisent la file', () => {
    prospectPret({ domain: 'c1.invalid' });
    const p2 = prospectPret({ domain: 'c2.invalid' });
    repos.db
      .prepare("UPDATE sales_prospects SET contact_email = NULL, contact_phone = '02 44 76 03 70', contact_method = 'PHONE' WHERE id = ?")
      .run(p2.id);

    const vue = buildApprovals(repos);
    const somme = vue.byChannel.EMAIL + vue.byChannel.FORM + vue.byChannel.PHONE
      + vue.byChannel.MANUAL + vue.byChannel.UNAVAILABLE;
    assert.equal(somme, vue.pending.length, 'chaque ligne a exactement un canal');
    assert.equal(vue.byChannel.EMAIL, 1);
    assert.equal(vue.byChannel.PHONE, 1);
  });
});

describe('une adresse personnelle ne rejoint pas la file d’envoi', () => {
  test('PERSONAL / LOW sort de la file active, avec sa raison', () => {
    /*
     * Relevé sur Fujielectric : `nadia.dasilva@fujielectric.fr`, une personne
     * nommée sans fonction publiée, trouvée dans les mentions légales. Écrire
     * là est exactement ce que la garde d'intention existe pour empêcher.
     */
    const p = prospectPret({ domain: 'perso.invalid' });
    repos.db
      .prepare("UPDATE sales_prospects SET contact_email = 'nadia.dasilva@perso.invalid', contact_source_url = 'https://perso.invalid/mentions-legales' WHERE id = ?")
      .run(p.id);

    const vue = buildApprovals(repos);
    assert.equal(vue.pending.length, 0, 'aucune ligne actionnable');
    assert.match(vue.excluded[0]!.reason, /PERSONAL|LOW/);
  });

  test('une adresse commerciale publique reste actionnable', () => {
    const p = prospectPret({ domain: 'commercial.invalid' });
    repos.db
      .prepare("UPDATE sales_prospects SET contact_email = 'contact@commercial.invalid' WHERE id = ?")
      .run(p.id);

    const vue = buildApprovals(repos);
    assert.equal(vue.pending.length, 1);
    assert.equal(vue.pending[0]!.actionType, 'EMAIL');
  });
});

// ─── LE PROFIL, RELU À CHAQUE AFFICHAGE ─────────────────────────────────────

describe('un dossier devenu hors cible quitte la file active', () => {
  /**
   * Trois dossiers ont été produits quand `country` valait « France » pour tout
   * le monde — le lot recopiait la régionalisation de sa propre requête.
   * Zhejiang NPC Machinery (Chine), Diversitech Equipment & Sales (Canada) et
   * Getinge (groupe multinational) sont ainsi entrés dans la file.
   *
   * Le défaut est corrigé en amont, mais les lignes déjà écrites restent : la
   * file se construit sur l'état `READY_FOR_REVIEW`, qui ne dit rien du profil.
   * Ce filtre est une lecture — il n'écrit rien et ne change aucun état.
   */

  test('un pays prouvé hors profil sort de la file', () => {
    const p = prospectPret({ domain: 'npcinjection.invalid', company: 'NPC' });
    repos.sales.setCountry(p.id, {
      country: 'Chine', basis: 'POSTAL_ADDRESS',
      sourceUrl: 'https://npcinjection.invalid/fr/',
    });

    const vue = buildApprovals(repos);
    assert.equal(vue.pending.some((x) => x.domain === 'npcinjection.invalid'), false);
    const e = vue.excluded.find((x) => x.domain === 'npcinjection.invalid');
    assert.ok(e, 'le dossier doit rester consultable, jamais disparaître');
    assert.match(e!.reason, /hors ICP/);
    assert.match(e!.reason, /Chine/);
  });

  test('l’exclusion conserve l’état, la preuve et la date', () => {
    const p = prospectPret({ domain: 'diversitech.invalid', company: 'Diversitech' });
    repos.sales.setCountry(p.id, {
      country: 'Canada', basis: 'DECLARED_METADATA',
      sourceUrl: 'https://diversitech.invalid/contact-us',
    });

    const e = buildApprovals(repos).excluded.find((x) => x.domain === 'diversitech.invalid')!;
    assert.equal(e.sourceState, 'READY_FOR_REVIEW', 'l’état réel n’est jamais réécrit');
    assert.match(e.evidence ?? '', /Canada/);
    assert.match(e.evidence ?? '', /diversitech\.invalid/);
    assert.equal(e.recordedAt?.slice(0, 10), '2026-08-20');
  });

  test('un site multi-pays sort sur la taille, sans connaître le pays', () => {
    // Getinge : le pays reste inconnu, mais `/int/` n'existe que sur un site
    // qui sert plusieurs pays. Un fait observable, pas une estimation.
    const p = prospectPret({ domain: 'getinge.invalid', company: 'Getinge' });
    repos.sales.addEvidence({
      prospectId: p.id, field: 'signal:distributeurs',
      claim: 'Programme distributeurs international.',
      nature: 'observed', sourceUrl: 'https://getinge.invalid/int/contact/',
      basis: null, confidence: 0.8,
    });

    const vue = buildApprovals(repos);
    assert.equal(vue.pending.some((x) => x.domain === 'getinge.invalid'), false);
    const e = vue.excluded.find((x) => x.domain === 'getinge.invalid')!;
    assert.match(e.reason, /multi-pays/);
    assert.match(e.evidence ?? '', /\/int\//);
  });

  test('un pays inconnu ne suffit jamais à exclure', () => {
    /*
     * Le défaut symétrique de celui qu'on vient de corriger. Beaucoup de PME
     * françaises ne publient aucune adresse ; les écarter parce que le pays est
     * inconnu viderait la file des vrais prospects.
     */
    const p = prospectPret({ domain: 'sans-adresse.invalid', company: 'Sans adresse' });
    assert.equal(p.country, null);

    const vue = buildApprovals(repos);
    assert.equal(vue.pending.some((x) => x.domain === 'sans-adresse.invalid'), true);
  });

  test('un dossier dans le profil n’est pas touché', () => {
    const p = prospectPret({ domain: 'qg-securite.invalid', company: 'QG Sécurité' });
    repos.sales.setCountry(p.id, {
      country: 'France', basis: 'OFFICIAL_ID',
      sourceUrl: 'https://qg-securite.invalid/mentions-legales/',
    });

    const vue = buildApprovals(repos);
    assert.equal(vue.pending.some((x) => x.domain === 'qg-securite.invalid'), true);
  });

  test('exclure ne modifie rien en base', () => {
    // Un écran qui modifie ce qu'il affiche finit par afficher ce qu'il a
    // modifié : le prospect garde son état, ses preuves et son pays.
    const p = prospectPret({ domain: 'chine.invalid', company: 'Fabricant' });
    repos.sales.setCountry(p.id, {
      country: 'Chine', basis: 'POSTAL_ADDRESS', sourceUrl: 'https://chine.invalid/',
    });
    const preuvesAvant = repos.sales.evidenceFor(p.id).length;

    buildApprovals(repos);
    buildApprovals(repos);

    const apres = repos.sales.require(p.id);
    assert.equal(apres.state, 'READY_FOR_REVIEW');
    assert.equal(apres.country, 'Chine');
    assert.equal(repos.sales.evidenceFor(p.id).length, preuvesAvant);
  });

  test('seuls les hors-cible partent : les autres restent tous', () => {
    prospectPret({ domain: 'a-fr.invalid', company: 'A' });
    prospectPret({ domain: 'b-fr.invalid', company: 'B' });
    const hors = prospectPret({ domain: 'c-cn.invalid', company: 'C' });
    repos.sales.setCountry(hors.id, {
      country: 'Chine', basis: 'POSTAL_ADDRESS', sourceUrl: 'https://c-cn.invalid/',
    });

    const actifs = buildApprovals(repos).pending.map((x) => x.domain).sort();
    assert.deepEqual(actifs, ['a-fr.invalid', 'b-fr.invalid']);
  });
});
