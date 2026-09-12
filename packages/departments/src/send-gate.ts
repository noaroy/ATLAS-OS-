/**
 * Le dernier controle avant qu'un message parte.
 *
 * Les gardes existent deja, chacune de son cote : resolution d'identite, ICP,
 * registre global, intention du contact. Le defaut recurrent n'a jamais ete
 * leur qualite — il a ete leur cablage. Une garde correcte, branchee a cote du
 * chemin qu'elle protege, ne protege rien : `findGrowthSignals` n'appelait pas
 * `readsAsSentence`, et une page de menu est passee pour un signal commercial.
 *
 * Ce module existe pour qu'il n'y ait qu'un seul endroit ou l'on demande
 * « peut-on ecrire a cette entreprise ». Toutes les conditions y sont
 * evaluees, aucune n'est optionnelle, et chacune rend un motif nomme : un
 * refus muet ne s'instruit pas.
 */
import type { OutreachEligibility } from '@atlas/core';
import type { ContactIntent, OutreachSuitability } from './contact-intent.ts';

/** Chaque motif de refus porte un nom stable, testable et affichable. */
export type BlockReason =
  | 'IDENTITY_UNRESOLVED'
  | 'NO_OFFICIAL_DOMAIN'
  | 'OUT_OF_ICP'
  | 'NO_COMMERCIAL_SIGNAL'
  | 'NOT_ENOUGH_OBSERVED_FACTS'
  | 'NO_WRITTEN_CHANNEL'
  | 'GUESSED_ADDRESS'
  | 'UNSUITABLE_CONTACT_INTENT'
  | 'PERSONAL_NON_COMMERCIAL'
  | 'ALREADY_CONTACTED'
  | 'DO_NOT_CONTACT'
  | 'PENDING_RESOLUTION'
  | 'BELOW_CONVERSION_SCORE'
  | 'DAILY_QUOTA_REACHED';

export interface SendCandidate {
  domain: string;
  /** Nom resolu par Entity Resolution V2, ou `null` s'il ne l'a pas ete. */
  companyName: string | null;
  officialDomain: string | null;
  icpStatus: 'IN_ICP' | 'OUT_OF_ICP' | 'UNKNOWN';
  conversionScore: number;
  /** Faits releves mot pour mot sur le site, avec leur URL. */
  observedFacts: ReadonlyArray<{ quote: string; sourceUrl: string }>;
  /** Signaux commerciaux reels : croissance, recrutement, export, salon. */
  commercialSignals: readonly string[];
  contact: {
    value: string;
    type: 'EMAIL' | 'FORM';
    intent: ContactIntent;
    suitability: OutreachSuitability;
    /** Relevee sur une page, ou reconstruite a partir d'un nom. */
    observed: boolean;
    sourceUrl: string | null;
  } | null;
  /** Ce que le registre global dit du domaine, aujourd'hui. */
  ledger: OutreachEligibility;
}

export interface SendGateLimits {
  minConversionScore: number;
  /** Ce qu'il reste d'envois neufs autorises aujourd'hui. */
  remainingToday: number;
  /**
   * Les intentions qu'un humain a explicitement autorisees pour ce prospect.
   * Vide par defaut : le support et le juridique ne sont jamais un canal
   * commercial par accident.
   */
  allowedIntents?: readonly ContactIntent[];
}

export interface SendGateVerdict {
  allowed: boolean;
  blocks: readonly { reason: BlockReason; detail: string }[];
  /** Ce qui a ete verifie et tenu, pour que l'approbation soit instruite. */
  passed: readonly string[];
}

/** Les intentions qui ne servent jamais de porte d'entree commerciale. */
const NEVER_AUTO_SELECTED: readonly ContactIntent[] = [
  'TECHNICAL_SUPPORT', 'LEGAL', 'PRIVACY', 'WEBMASTER', 'HR', 'BILLING',
];

export function evaluateSendGate(
  candidate: SendCandidate,
  limits: SendGateLimits,
): SendGateVerdict {
  const blocks: { reason: BlockReason; detail: string }[] = [];
  const passed: string[] = [];
  const block = (reason: BlockReason, detail: string) => blocks.push({ reason, detail });
  const allowedIntents = limits.allowedIntents ?? [];

  // 1 — l'entreprise doit etre nommable. « Devenez distributeur » n'est pas
  // une raison sociale, et un lot en a deja qualifie deux.
  if (!candidate.companyName || candidate.companyName.trim().length < 2) {
    block('IDENTITY_UNRESOLVED', 'aucune raison sociale resolue');
  } else passed.push(`identite resolue : ${candidate.companyName}`);

  // 2 — un domaine officiel, pas une fiche d'annuaire.
  if (!candidate.officialDomain) {
    block('NO_OFFICIAL_DOMAIN', 'aucun domaine officiel resolu');
  } else passed.push(`domaine officiel : ${candidate.officialDomain}`);

  // 3 — l'ICP tranche avant la qualification, jamais apres.
  if (candidate.icpStatus !== 'IN_ICP') {
    block('OUT_OF_ICP', `statut ICP : ${candidate.icpStatus}`);
  } else passed.push('dans la cible');

  // 4 — un signal commercial reel, pas une page « qui sommes-nous ».
  if (candidate.commercialSignals.length === 0) {
    block('NO_COMMERCIAL_SIGNAL', 'aucun signal commercial releve');
  } else passed.push(`${candidate.commercialSignals.length} signal(aux) commercial(aux)`);

  // 5 — deux faits sources. Un seul se conteste ; deux montrent qu'on a lu.
  const sourced = candidate.observedFacts.filter((f) => f.quote.trim() && f.sourceUrl.trim());
  if (sourced.length < 2) {
    block('NOT_ENOUGH_OBSERVED_FACTS', `${sourced.length} fait(s) source(s) sur 2 exiges`);
  } else passed.push(`${sourced.length} faits observes, chacun avec sa source`);

  // 6 a 9 — le canal.
  if (!candidate.contact) {
    block('NO_WRITTEN_CHANNEL', 'aucun canal ecrit releve');
  } else {
    const { intent, suitability, observed, value } = candidate.contact;
    if (!observed) {
      // Une adresse deduite d'un nom est une invention polie.
      block('GUESSED_ADDRESS', `${value} n'a ete relevee sur aucune page`);
    } else passed.push(`canal releve sur ${candidate.contact.sourceUrl ?? 'une page du site'}`);

    if (suitability === 'BLOCKED') {
      block('UNSUITABLE_CONTACT_INTENT', `canal marque BLOCKED (${intent})`);
    } else if (NEVER_AUTO_SELECTED.includes(intent) && !allowedIntents.includes(intent)) {
      block(
        'UNSUITABLE_CONTACT_INTENT',
        `${intent} n'est pas un canal commercial ; une autorisation explicite est exigee`,
      );
    } else if (intent === 'PERSONAL' && !allowedIntents.includes('PERSONAL')) {
      block('PERSONAL_NON_COMMERCIAL', `${value} est une adresse personnelle non commerciale`);
    } else passed.push(`intention du canal : ${intent} (${suitability})`);
  }

  // 10 — le registre global, qui prime sur tout historique de lot.
  switch (candidate.ledger) {
    case 'ALREADY_CONTACTED':
      block('ALREADY_CONTACTED', 'cette entreprise a deja recu un message');
      break;
    case 'DO_NOT_CONTACT':
      block('DO_NOT_CONTACT', 'entreprise ecartee volontairement');
      break;
    case 'PENDING_RESOLUTION':
      block('PENDING_RESOLUTION', 'resolue sous des gardes anterieures, jamais reverifiee');
      break;
    case 'BLOCKED':
      block('DO_NOT_CONTACT', 'une garde courante refuse ce prospect');
      break;
    default:
      passed.push('registre global : jamais contactee');
  }

  // 11 — le score, puis le quota du jour.
  if (candidate.conversionScore < limits.minConversionScore) {
    block(
      'BELOW_CONVERSION_SCORE',
      `${candidate.conversionScore} < ${limits.minConversionScore}`,
    );
  } else passed.push(`score de conversion ${candidate.conversionScore}`);

  if (limits.remainingToday <= 0) {
    block('DAILY_QUOTA_REACHED', 'plafond d envois neufs atteint pour aujourd hui');
  }

  return { allowed: blocks.length === 0, blocks, passed };
}
