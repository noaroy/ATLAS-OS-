import { sendKey, type Repositories } from '@atlas/data';
import type { MailInboxProvider, MailOutboundProvider } from '@atlas/intelligence';
import { replyHistory, canTransitionLoop, evaluateManualSendLot, type ManualSendLotVerdict } from '@atlas/departments';

/**
 * Le chemin manuel d'envoi, tel que `scripts/sales-send-approved.ts` le joue.
 *
 * Déplacé ici, à l'identique, pour une seule raison : être éprouvé avec un
 * transport factice avant que le vrai ne serve. Le script garde l'impression,
 * la lecture du fichier et la confirmation humaine ; l'ordre des gardes est
 * ici, et il est la seule chose que ce fichier impose.
 *
 * Chaque vérification a lieu AVANT l'appel réseau. Un refus après l'envoi ne
 * refuse rien ; un message parti ne se rappelle pas. La réservation de la clé
 * d'idempotence précède l'envoi pour la même raison : si le processus meurt
 * entre l'envoi et sa consignation, la place est déjà prise et une reprise ne
 * réexpédiera pas.
 *
 * Et avant tout cela, la garde de lot : en INTERNAL_TEST, un envoi réel ne va
 * qu'à GMAIL_USER, et un lot qui contient une seule autre adresse est refusé
 * en entier — avant la première lecture de boîte, la première réservation, la
 * première écriture.
 */

export interface ManualSendItem {
  domain: string;
  companyName: string;
  recipient: string;
  subject: string;
  bodyText: string;
  /**
   * Ce que ce message est : une relance, ou un premier contact.
   *
   * La distinction commande les gardes, et elle les inverse. Une relance exige
   * que l'entreprise figure au registre — sans quoi on relancerait quelqu'un
   * qu'on n'a jamais contacte. Un premier contact exige l'inverse : elle ne
   * doit PAS y figurer comme deja contactee.
   *
   * `FOLLOW_UP` par defaut : c'est ce que ce script faisait avant d'accepter
   * les premiers contacts, et un fichier ecrit pour l'ancienne forme doit
   * continuer a se comporter comme avant.
   */
  purpose?: 'FIRST_TOUCH' | 'FOLLOW_UP';
}

export interface ManualSendResult {
  nom: string;
  verdict: 'BLOCKED' | 'PRÊT' | 'SENT';
  motif: string;
  /** Le code du refus quand il vient de la garde de lot. */
  code?: string;
}

export interface ManualSendOptions {
  repos: Repositories;
  lot: readonly ManualSendItem[];
  /** `--send` : envoi réel. Sinon, simulation — rien n'est écrit. */
  send: boolean;
  engineMode: 'INTERNAL_TEST' | 'PRODUCTION';
  /** L'interrupteur, tel que le transport le lit (`authorization().outboundEnabled`). */
  outboundEnabled: boolean;
  /** GMAIL_USER : la boîte dont le jeton porte les droits. */
  mailbox: string;
  inbox: MailInboxProvider;
  outbound: MailOutboundProvider;
  /** Chaque issue, au moment où elle tombe — pour l'écran. */
  onResult?: (result: ManualSendResult) => void;
}

export interface ManualSendReport {
  guard: ManualSendLotVerdict;
  /** Le lot a été refusé en entier par la garde : rien n'a été lu, réservé ni écrit. */
  refused: boolean;
  results: ManualSendResult[];
}

export async function runManualSendLot(options: ManualSendOptions): Promise<ManualSendReport> {
  const { repos, lot, send, inbox, outbound } = options;
  const boite = options.mailbox;
  const results: ManualSendResult[] = [];
  const emit = (result: ManualSendResult) => {
    results.push(result);
    options.onResult?.(result);
  };
  const bloquer = (nom: string, motif: string, code?: string) => emit({ nom, verdict: 'BLOCKED', motif, ...(code ? { code } : {}) });

  // ── 0. La garde de lot, avant toute lecture, réservation ou écriture ────
  //
  // Tout le lot ou rien : une adresse étrangère refuse aussi les autres, pour
  // qu'aucun message ne parte « avant » qu'on remarque la mauvaise ligne.
  const guard = evaluateManualSendLot({
    send, engineMode: options.engineMode, outboundEnabled: options.outboundEnabled,
    gmailUser: boite, recipients: lot.map((r) => r.recipient),
  });
  if (!guard.allowed) {
    for (const relance of lot) {
      const block = guard.blocks.find((b) => b.recipients.includes(relance.recipient)) ?? guard.blocks[0]!;
      bloquer(relance.companyName, `${block.code} — ${block.message}`, block.code);
    }
    return { guard, refused: true, results };
  }

  for (const relance of lot) {
    const nom = relance.companyName;
    // ── 1. Le transport est-il autorisé ? ──────────────────────────────────
    const transport = outbound.status();
    if (!transport.configured) {
      bloquer(nom, `envoi non autorisé : ${transport.code}`);
      continue;
    }
    // ── 2. L'entreprise est-elle joignable ? ───────────────────────────────
    const intention = relance.purpose ?? 'FOLLOW_UP';
    const inscrit = repos.sales.ledgerFor(relance.domain);
    // Un refus explicite ferme la porte quelle que soit l'intention.
    if (inscrit?.kind === 'DO_NOT_CONTACT') {
      bloquer(nom, 'registre : DO_NOT_CONTACT');
      continue;
    }
    if (intention === 'FOLLOW_UP') {
      // Relancer quelqu'un qu'on n'a jamais contacte n'a pas de sens : le
      // message ferait reference a un premier envoi qui n'existe pas.
      if (!inscrit) {
        bloquer(nom, `absente du registre : ${relance.domain}`);
        continue;
      }
    } else if (inscrit?.kind === 'CONTACTED') {
      // Et l'inverse : un premier contact vers une entreprise deja contactee
      // serait un doublon, vu de sa boite de reception.
      bloquer(nom, `deja contactee le ${inscrit.recordedAt?.slice(0, 10)} — ce n'est plus un premier contact`);
      continue;
    }

    // ── 3. Un message est-il déjà parti ? ──────────────────────────────────
    if (intention === 'FOLLOW_UP') {
      const dejaRelance = repos.salesLoop.followUpsFor(relance.domain);
      if (dejaRelance > 0) {
        bloquer(nom, `${dejaRelance} relance(s) déjà partie(s)`);
        continue;
      }
    } else {
      const dejaParti = repos.salesLoop.lastSentTo(relance.domain);
      if (dejaParti !== null) {
        bloquer(nom, `message déjà envoyé le ${dejaParti.slice(0, 10)}`);
        continue;
      }
    }

    // ── 4. Une personne a-t-elle répondu depuis ? ──────────────────────────
    //
    // Lu dans Gmail sur le domaine réel du destinataire, pas sur celui du
    // registre : les deux diffèrent pour trois de ces entreprises, et chercher
    // au mauvais endroit ferait conclure au silence quelqu'un qui a écrit.
    const domaineReel = relance.recipient.split('@')[1] ?? relance.domain;
    let recus: Awaited<ReturnType<typeof inbox.list>> = [];
    try {
      recus = await inbox.list({
        rawFilter: `from:${domaineReel}`, max: 20, since: '2026-01-01T00:00:00.000Z',
      });
    } catch (err) {
      bloquer(nom, `boîte illisible : ${err instanceof Error ? err.message.slice(0, 60) : err}`);
      continue;
    }
    if (recus.length > 0) {
      bloquer(nom, `${recus.length} message(s) reçu(s) de ${domaineReel} — à lire avant de relancer`);
      continue;
    }

    const conversation = repos.conversations.byDomain(relance.domain);
    const histoire = conversation
      ? replyHistory(repos.conversations.eventsFor(conversation.id), boite)
      : null;
    if (histoire?.everHumanReplied) {
      bloquer(nom, `réponse humaine le ${histoire.lastHumanReplyAt?.slice(0, 10)}`);
      continue;
    }

    // ── 5. Le fil d'origine, pour rester dans la conversation ──────────────
    let threadId: string | null = null;
    let inReplyTo: string | null = null;
    try {
      const envoyes = await inbox.list({
        rawFilter: `in:sent to:${relance.recipient}`, max: 10,
        includeOwnMessages: true, since: '2026-01-01T00:00:00.000Z',
      });
      const origine = envoyes.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))[0];
      if (origine) {
        threadId = origine.threadId;
        inReplyTo = origine.headers['message-id'] ?? null;
      }
    } catch { /* sans fil, le message part seul : ce n'est pas bloquant */ }

    /**
     * La clé, calculée sans rien réserver.
     *
     * C'est ici que la version précédente s'est piégée : elle réservait la place
     * avant de vérifier qu'elle était une simulation. Quatre relances approuvées
     * sont devenues impossibles à envoyer, sans qu'aucun message ne parte. Une
     * simulation qui laisse une trace n'est pas une simulation.
     */
    const cle = sendKey({
      domain: relance.domain,
      recipient: relance.recipient,
      subject: relance.subject,
      body: relance.bodyText,
      purpose: intention,
    });
    const issue = repos.salesLoop.sendOutcome(cle);
    if (issue.sent) {
      bloquer(nom, `déjà envoyé : la place porte un envoi consigné (${cle.slice(0, 16)}…)`);
      continue;
    }
    if (issue.exists && issue.ambiguous) {
      bloquer(nom, `issue ambiguë sur ${cle.slice(0, 16)}… : décision humaine requise`);
      continue;
    }

    // ── 6. La sortie de simulation, AVANT toute écriture ───────────────────
    //
    // Ni brouillon, ni approbation, ni réservation, ni appel réseau. Ce qui suit
    // écrit en base ; une simulation s'arrête donc exactement ici.
    if (!send) {
      emit({ nom, verdict: 'PRÊT', motif: `vers ${relance.recipient}${threadId ? `, fil ${threadId}` : ', sans fil'}` });
      continue;
    }

    // ── 7. Le brouillon, puis l'approbation ────────────────────────────────
    //
    // L'approbation n'est pas décorative : la transition READY_FOR_APPROVAL →
    // APPROVED_TO_SEND est la seule porte, et elle est franchie explicitement au
    // nom du propriétaire qui a fourni ce texte.
    const brouillon = repos.salesLoop.saveDraft({
      domain: relance.domain,
      companyName: nom,
      recipient: relance.recipient,
      subject: relance.subject,
      body: relance.bodyText,
      purpose: intention,
      sources: [],
      createdBy: 'proprietaire',
    });

    const decision = repos.salesLoop.decideDraft({
      draftId: brouillon.id,
      decision: 'APPROVED_TO_SEND',
      decidedBy: 'proprietaire',
      note: 'texte fourni et approuvé explicitement par le propriétaire',
    });
    if (!decision.applied) {
      bloquer(nom, `approbation refusée : ${decision.reason}`);
      continue;
    }
    if (!canTransitionLoop('READY_FOR_APPROVAL', 'APPROVED_TO_SEND').allowed) {
      bloquer(nom, 'la transition d’approbation n’existe pas');
      continue;
    }

    // ── 8. La réservation, juste avant le réseau ───────────────────────────
    const place = repos.salesLoop.claimSend({
      domain: relance.domain,
      conversationId: conversation?.id ?? null,
      recipient: relance.recipient,
      subject: relance.subject,
      body: relance.bodyText,
      purpose: intention,
      claimedBy: 'sales-send-approved',
    });
    if (!place.claimed) {
      bloquer(nom, `place non disponible : ${place.reason}`);
      continue;
    }

    // ── 9. L'envoi ─────────────────────────────────────────────────────────
    try {
      const recu = await outbound.sendEmail({
        to: relance.recipient,
        subject: relance.subject,
        bodyText: relance.bodyText,
        threadId,
        inReplyTo,
      });
      repos.salesLoop.recordSendResult({
        idempotencyKey: place.idempotencyKey,
        phase: 'SENT',
        externalMessageId: recu.externalMessageId,
        externalThreadId: recu.externalThreadId,
      });
      // Le brouillon suit le message : laisse en APPROVED_TO_SEND, il resterait
      // « pret a partir » alors qu'il est parti, et compterait indefiniment dans
      // la file des envois en attente.
      repos.salesLoop.markDraftSent(brouillon.id);

      /*
       * Le registre global, tenu a jour au moment ou le message part.
       *
       * Ce script a ete ecrit pour des relances : la cible y figurait toujours,
       * donc il n'a jamais eu a l'inscrire. Un premier contact, si — et sans
       * cette ligne l'entreprise reste invisible au War Room, dont l'entonnoir
       * compte le registre. Deux dossiers ont deja disparu ainsi pendant des
       * semaines : jamais relances, jamais comptes, signales nulle part.
       *
       * Inscrit apres l'envoi, jamais avant : le registre dit ce qui est parti,
       * pas ce qu'on avait l'intention d'envoyer.
       */
      if (repos.sales.ledgerFor(relance.domain) === null) {
        repos.sales.recordOutreach({
          domain: relance.domain,
          kind: 'CONTACTED',
          recordedBy: 'sales-send-approved',
          channel: 'EMAIL',
          recordedAt: new Date().toISOString(),
        });
      }
      emit({ nom, verdict: 'SENT', motif: `${relance.recipient} · ${recu.externalMessageId}` });
    } catch (err) {
      const motif = err instanceof Error ? err.message.slice(0, 100) : String(err);
      repos.salesLoop.recordSendResult({
        idempotencyKey: place.idempotencyKey, phase: 'FAILED', error: motif,
      });
      repos.salesLoop.decideDraft({
        draftId: brouillon.id, decision: 'ABANDONED', decidedBy: 'sales-send-approved',
        note: `envoi refusé : ${motif}`,
      });
      bloquer(nom, `envoi refusé : ${motif}`);
    }
  }

  return { guard, refused: false, results };
}
