import type { ReportState } from './delivery.ts';

/**
 * La boucle commerciale, et les deux portes qui la ferment.
 *
 * Le moteur sait produire un rapport ; la production V1 sait le mettre en
 * forme et le tracer. Il reste deux moments où quelque chose peut mal tourner
 * d'une manière qui ne se rattrape pas :
 *
 *   avant la production   dépenser pour un client qui ne paiera pas
 *   avant la livraison    envoyer un document que personne n'a relu
 *
 * Les deux portes sont ici, en fonctions pures, pour qu'elles puissent être
 * éprouvées sans monter de mission ni engager un centime. Une garde qui a
 * besoin d'une dépense pour être testée n'est jamais testée.
 */

export type PaymentStatus =
  /** Rien n'a été demandé — le prospect a reçu l'extrait, c'est tout. */
  | 'NONE'
  /** La commande est passée, le règlement attendu. */
  | 'PENDING'
  /** Le règlement a été constaté, à la main. */
  | 'CONFIRMED'
  | 'REFUNDED'
  | 'CANCELLED';

export type OrderStatus =
  | 'TEASER_SENT'
  | 'ORDERED'
  | 'IN_PRODUCTION'
  | 'DELIVERED'
  | 'CANCELLED';

export type DeliveryStatus = 'NOT_READY' | 'READY_TO_DELIVER' | 'DELIVERED';

/** Une commande, telle qu'elle est suivie. */
export interface CustomerOrder {
  id: string;
  customer: string;
  email: string | null;
  company: string | null;
  missionId: string | null;
  /** En centimes : un montant en flottant finit par valoir 48,999999. */
  sellingPriceCents: number | null;
  currency: string;
  orderStatus: OrderStatus;
  paymentStatus: PaymentStatus;
  /** La référence du règlement, telle que constatée — virement, lien, espèces. */
  paymentReference: string | null;
  paidAt: string | null;
  deliveryStatus: DeliveryStatus;
}

// ─── Garde de production ────────────────────────────────────────────────────

export type ProductionRefusal = 'BLOCKED_BY_PAYMENT' | 'BLOCKED_BY_STATUS' | 'BLOCKED_BY_PRICE';

export interface ProductionDecision {
  allowed: boolean;
  refusal: ProductionRefusal | null;
  reason: string;
}

/**
 * Cette commande autorise-t-elle une dépense ?
 *
 * Appelée **avant** que le premier appel au modèle ne parte, jamais après. Une
 * mission commerciale lancée sur une commande non réglée transforme un prospect
 * qui hésite en coût certain, et rien dans le pipeline ne rattrape cela — le
 * budget est consommé au moment où il est consommé.
 *
 * `CONFIRMED` et rien d'autre. `PENDING` signifie qu'on attend le règlement,
 * pas qu'on peut commencer en attendant : c'est exactement la nuance qui coûte
 * de l'argent quand on la laisse au jugement.
 */
export function canStartProduction(order: CustomerOrder): ProductionDecision {
  if (order.orderStatus === 'CANCELLED') {
    return {
      allowed: false,
      refusal: 'BLOCKED_BY_STATUS',
      reason: 'La commande est annulée : rien ne doit être produit pour elle.',
    };
  }
  if (order.paymentStatus !== 'CONFIRMED') {
    return {
      allowed: false,
      refusal: 'BLOCKED_BY_PAYMENT',
      reason:
        `Règlement « ${order.paymentStatus} », attendu « CONFIRMED ». ` +
        `Aucune dépense n'est engagée avant constatation du paiement.`,
    };
  }
  if (order.sellingPriceCents === null || order.sellingPriceCents <= 0) {
    return {
      allowed: false,
      refusal: 'BLOCKED_BY_PRICE',
      reason:
        'Aucun prix convenu sur cette commande. Produire sans prix rend la marge ' +
        'incalculable et la livraison indéfendable.',
    };
  }
  return { allowed: true, refusal: null, reason: 'Règlement constaté — la production est autorisée.' };
}

// ─── Garde de livraison ─────────────────────────────────────────────────────

/** Ce qu'on sait du rapport au moment de décider s'il peut partir. */
export interface DeliveryFacts {
  paymentStatus: PaymentStatus;
  reviewStatus: ReportState;
  /** Le nombre de preuves de lignée simulée dans le rapport. */
  simulatedEvidence: number;
  /**
   * Les affirmations de fait sans source.
   *
   * Comptées et non estimées : c'est la promesse centrale du produit, et une
   * seule suffit à la rompre.
   */
  unsupportedClaims: number;
}

export interface DeliveryDecision {
  allowed: boolean;
  /** Ce qui bloque, énuméré : un client qui attend mérite une réponse précise. */
  blockers: string[];
  reason: string;
}

/**
 * Ce rapport peut-il partir ?
 *
 * Quatre conditions, toutes nécessaires, aucune suffisante. Elles sont
 * énumérées plutôt que court-circuitées : quand une livraison est bloquée, on
 * veut savoir *tout* ce qui manque, pas seulement le premier obstacle. Corriger
 * un point pour découvrir le suivant fait perdre un aller-retour à chaque fois.
 */
export function canDeliver(facts: DeliveryFacts): DeliveryDecision {
  const blockers: string[] = [];

  if (facts.paymentStatus !== 'CONFIRMED') {
    blockers.push(`règlement « ${facts.paymentStatus} » au lieu de « CONFIRMED »`);
  }
  if (facts.reviewStatus !== 'APPROVED_FOR_DELIVERY') {
    blockers.push(
      `revue « ${facts.reviewStatus} » au lieu de « APPROVED_FOR_DELIVERY » — ` +
        `aucun rapport ne part sans qu'un humain ait engagé sa parole dessus`,
    );
  }
  if (facts.simulatedEvidence > 0) {
    blockers.push(
      `${facts.simulatedEvidence} preuve(s) de lignée simulée — une fiche de démonstration ` +
        `livrée comme réelle décrédibilise aussi ce qui était vrai`,
    );
  }
  if (facts.unsupportedClaims > 0) {
    blockers.push(
      `${facts.unsupportedClaims} affirmation(s) de fait sans source — c'est la promesse ` +
        `centrale du produit, et une seule suffit à la rompre`,
    );
  }

  return {
    allowed: blockers.length === 0,
    blockers,
    reason:
      blockers.length === 0
        ? 'Les quatre conditions sont réunies : le rapport peut être livré.'
        : `Livraison refusée : ${blockers.join(' · ')}.`,
  };
}

// ─── Économie ───────────────────────────────────────────────────────────────

export interface OrderEconomics {
  sellingPriceEur: number;
  productionCostUsd: number;
  productionCostEur: number;
  grossMarginEur: number;
  /** En pourcentage, à deux décimales — jamais arrondi à 100 quand le coût existe. */
  grossMarginPercent: number;
}

/** Le taux employé pour comparer un coût en dollars à un prix en euros. */
export const USD_PER_EUR = 1.08;

/**
 * La marge d'une commande, calculée sur le coût réellement mesuré.
 *
 * Le pourcentage est arrondi à deux décimales et **plafonné en dessous de
 * 100 tant que le coût n'est pas nul**. Un arrondi à 100 % sur une production
 * qui a coûté quelque chose est faux, et c'est le genre de faux qui rassure :
 * il fait disparaître le coût au lieu de le montrer petit.
 */
export function orderEconomics(input: {
  sellingPriceEur: number;
  productionCostUsd: number;
}): OrderEconomics {
  const productionCostEur = input.productionCostUsd / USD_PER_EUR;
  const grossMarginEur = input.sellingPriceEur - productionCostEur;

  let grossMarginPercent =
    input.sellingPriceEur === 0
      ? 0
      : Math.round((grossMarginEur / input.sellingPriceEur) * 10_000) / 100;

  // 49 € pour 0,0244 $ de coût donne 99,954 %, que deux décimales arrondissent
  // à 99,95 — mais un coût plus faible franchirait la barre. Un coût non nul ne
  // peut pas produire une marge de 100 %.
  if (input.productionCostUsd > 0 && grossMarginPercent >= 100) grossMarginPercent = 99.99;

  return {
    sellingPriceEur: input.sellingPriceEur,
    productionCostUsd: round4(input.productionCostUsd),
    productionCostEur: round4(productionCostEur),
    grossMarginEur: round4(grossMarginEur),
    grossMarginPercent,
  };
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
