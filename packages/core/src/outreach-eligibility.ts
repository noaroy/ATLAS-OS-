/**
 * Ce qu'un prospect a été, et ce qu'on peut en faire aujourd'hui.
 *
 * Le lot 002 a produit deux PRIORITY qui n'auraient jamais dû l'être. La
 * tentation était de réécrire leur état : elle a été écartée, parce qu'un
 * historique corrigé n'apprend plus rien, et parce qu'un lot qu'on retouche
 * cesse d'être une preuve de ce qui s'est passé.
 *
 * D'où deux notions au lieu d'une. `state` reste ce que le lot a décidé au
 * moment où il l'a décidé. `effectiveOutreachEligibility` est calculée à la
 * lecture, avec les gardes d'aujourd'hui — et c'est elle, jamais le tier
 * historique, qui autorise un message à partir.
 *
 * La conséquence pratique : corriger une garde suffit à neutraliser tous les
 * prospects qu'elle aurait dû arrêter, y compris ceux déjà en base, sans
 * qu'aucune ligne bouge.
 */

/**
 * La version des gardes sous lesquelles un prospect a été résolu.
 *
 * À incrémenter quand une garde change au point que ses décisions passées
 * deviennent suspectes. Un prospect résolu sous une version antérieure n'est
 * pas déclaré faux — il est déclaré *non vérifié*, ce qui n'est pas la même
 * chose et se corrige par un ré-audit.
 */
export const GUARD_VERSION = 'v2-entity-resolution';

export type OutreachEligibility =
  /** Les gardes actuelles le confirment : un humain peut décider. */
  | 'ELIGIBLE'
  /**
   * On a déjà écrit à cette entreprise, dans un autre lot ou à la main. Ce
   * n'est pas un défaut du prospect : c'est que la question ne se pose plus.
   */
  | 'ALREADY_CONTACTED'
  /** Écartée volontairement. Aucune découverte ultérieure ne la rouvre. */
  | 'DO_NOT_CONTACT'
  /** Une garde actuelle le refuse. Aucun message, quel que soit l'historique. */
  | 'BLOCKED'
  /** Antérieur aux gardes actuelles, jamais revérifié : on ne sait pas. */
  | 'PENDING_RESOLUTION';

/**
 * Ce que le registre d'entreprise dit du domaine.
 *
 * Tenu par domaine canonique et non par prospect : les lots sont des passes
 * de prospection, l'entreprise n'existe qu'une fois. Deux lignes dans deux
 * lots ne font pas deux destinataires.
 */
export interface LedgerVerdict {
  kind: 'CONTACTED' | 'DO_NOT_CONTACT';
  recordedAt: string;
  recordedBy: string;
  note: string | null;
}

/** Un domaine comparable : minuscules, sans `www.`, sans espace. */
export function canonicalDomainOf(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] ?? '';
}

export interface EligibilityVerdict {
  eligibility: OutreachEligibility;
  /** Ce que le lot avait décidé — conservé, jamais réécrit. */
  historicalState: string;
  historicalTier: string | null;
  /** Toutes les raisons, pas la première : un refus partiel se répare mal. */
  blockers: string[];
  reason: string;
}

export interface EligibilityInput {
  historicalState: string;
  historicalTier: string | null;
  /** La version de gardes sous laquelle la ligne a été écrite, si connue. */
  guardVersion: string | null;
  /** Le type de page tel que le résolveur l'a classé, en clair. */
  pageType: string | null;
  identityConfidence: number | null;
  domain: string | null;
  /** MATCH · OUT_OF_ICP · UNKNOWN, tel que le résolveur l'a rendu. */
  icp: string | null;
  observedSourcedFacts: number;
  score: number | null;
  scoreThreshold: number;
  hasSourcedPersonalization: boolean;
  /**
   * Un canal public relevé sur une page officielle — adresse, formulaire ou
   * téléphone. Sans lui, un prospect « prêt » ne l'est pas : il n'y a personne
   * à qui écrire, et le seul moyen d'en trouver un serait d'en inventer un.
   */
  hasObservedContact: boolean;
  /**
   * Un ré-audit qui a explicitement condamné cette ligne. Prime sur tout le
   * reste : c'est un jugement porté, pas une absence de preuve.
   */
  invalidation: { reason: string } | null;
  /**
   * L'entrée la plus forte du registre pour ce domaine, s'il y en a une.
   * Consultée avant tout le reste : la question « peut-on écrire ? » se
   * tranche au niveau de l'entreprise, pas à celui d'une ligne de lot.
   */
  ledger?: LedgerVerdict | null;
}

/** Les seuils de confiance d'identité en deçà desquels rien ne part. */
export const MIN_IDENTITY_CONFIDENCE = 0.5;
export const MIN_OBSERVED_FACTS = 2;

export function effectiveOutreachEligibility(input: EligibilityInput): EligibilityVerdict {
  const historical = {
    historicalState: input.historicalState,
    historicalTier: input.historicalTier,
  };

  // Le registre d'abord. Un refus volontaire ne se rediscute pas parce qu'une
  // nouvelle passe a retrouvé l'entreprise, et un envoi déjà parti ne se
  // reprend pas parce que le score a monté.
  if (input.ledger?.kind === 'DO_NOT_CONTACT') {
    return {
      ...historical,
      eligibility: 'DO_NOT_CONTACT',
      blockers: ['écartée volontairement du démarchage'],
      reason:
        `Écartée volontairement le ${input.ledger.recordedAt.slice(0, 10)} par ${input.ledger.recordedBy}` +
        `${input.ledger.note ? ` : ${input.ledger.note}` : '.'}`,
    };
  }
  if (input.ledger?.kind === 'CONTACTED') {
    return {
      ...historical,
      eligibility: 'ALREADY_CONTACTED',
      blockers: ['entreprise déjà contactée'],
      reason:
        `Déjà contactée le ${input.ledger.recordedAt.slice(0, 10)} par ${input.ledger.recordedBy}` +
        `${input.ledger.note ? ` : ${input.ledger.note}` : '.'} Un second message n'est pas une relance décidée.`,
    };
  }

  if (input.invalidation) {
    return {
      ...historical,
      eligibility: 'BLOCKED',
      blockers: [`invalidé par ré-audit : ${input.invalidation.reason}`],
      reason: `Ligne invalidée par un ré-audit. ${input.invalidation.reason}`,
    };
  }

  if (input.historicalState === 'REJECTED') {
    return {
      ...historical,
      eligibility: 'BLOCKED',
      blockers: ['prospect rejeté'],
      reason: 'Le lot l’a rejeté ; rien ne le rouvre automatiquement.',
    };
  }

  // Une ligne écrite avant les gardes actuelles n'est pas fausse : elle est
  // non vérifiée. La distinction compte, parce qu'un ré-audit peut la rouvrir.
  if (input.guardVersion !== GUARD_VERSION) {
    return {
      ...historical,
      eligibility: 'PENDING_RESOLUTION',
      blockers: [
        `résolu sous « ${input.guardVersion ?? 'aucune garde enregistrée'} », ` +
          `les gardes actuelles sont « ${GUARD_VERSION} »`,
      ],
      reason:
        'Ce prospect est antérieur aux gardes de résolution d’identité. Il n’a pas été ' +
        'déclaré faux — il n’a pas été vérifié. Un ré-audit peut le rouvrir.',
    };
  }

  const blockers: string[] = [];
  if (input.pageType !== 'OFFICIAL_COMPANY_SITE') {
    blockers.push(`page de type ${input.pageType ?? 'inconnu'} : le propriétaire n’est pas le candidat`);
  }
  if (!input.domain) blockers.push('aucun domaine officiel');
  if (input.identityConfidence == null) {
    blockers.push('identité jamais résolue');
  } else if (input.identityConfidence < MIN_IDENTITY_CONFIDENCE) {
    blockers.push(
      `confiance d’identité ${input.identityConfidence.toFixed(2)} sous ${MIN_IDENTITY_CONFIDENCE}`,
    );
  }
  if (input.icp !== 'MATCH') blockers.push(`profil ${input.icp ?? 'non évalué'}`);
  if (input.observedSourcedFacts < MIN_OBSERVED_FACTS) {
    blockers.push(`${input.observedSourcedFacts} fait(s) observé(s) sourcé(s) — ${MIN_OBSERVED_FACTS} au minimum`);
  }
  if ((input.score ?? 0) < input.scoreThreshold) {
    blockers.push(`score ${input.score ?? 0} sous le seuil ${input.scoreThreshold}`);
  }
  if (!input.hasSourcedPersonalization) blockers.push('aucune personnalisation appuyée sur une source');
  if (!input.hasObservedContact) blockers.push('aucun canal de contact public observé');

  if (blockers.length > 0) {
    return {
      ...historical,
      eligibility: 'BLOCKED',
      blockers,
      reason: blockers.join(' · '),
    };
  }

  return {
    ...historical,
    eligibility: 'ELIGIBLE',
    blockers: [],
    reason: 'Identité, domaine, profil, preuves et personnalisation vérifiés sous les gardes actuelles.',
  };
}

/**
 * Les états qui font effectivement partir un message.
 *
 * Isolé ici pour qu'aucun appelant n'ait à s'en souvenir : c'est la liste que
 * le dépôt consulte avant d'autoriser une transition.
 */
export const OUTREACH_STATES: readonly string[] = ['APPROVED_TO_CONTACT', 'CONTACTED', 'SENT'];

export function isOutreachState(state: string): boolean {
  return OUTREACH_STATES.includes(state);
}
