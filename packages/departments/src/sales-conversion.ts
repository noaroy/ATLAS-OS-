/**
 * Qui a des chances d'acheter, ce qui n'est pas la même question que qui
 * correspond au profil.
 *
 * Le score de qualification répond à « cette entreprise ressemble-t-elle à
 * notre client type ? ». Il a bien travaillé : les lots récents rendent des
 * fabricants français, réels, correctement identifiés. Mais il ne dit rien de
 * la probabilité qu'un message aboutisse — un équipementier parfait dans un
 * marché saturé, sans canal de contact propre et dont on ne saurait pas
 * démontrer trois prospects pertinents, est un mauvais premier client même
 * avec 74 sur 100.
 *
 * Ce second score porte donc sur l'achat, pas sur l'adéquation. Il pèse ce qui
 * fait qu'une offre à 49 € trouve preneur en soixante-douze heures : un besoin
 * commercial visible, un marché qu'on sait aller chercher, une taille qui
 * permet de décider seul, et quelqu'un à qui écrire.
 *
 * Une règle domine toutes les autres : **aucun besoin n'est supposé**. Chaque
 * point vient d'un fait observé sur le site de l'entreprise, avec sa source.
 * Un score élevé sans faits est le symptôme qu'on a noté son propre espoir —
 * c'est exactement ce que le lot 002 avait fait, à l'échelle de l'identité.
 */

import type { SalesTier } from './sales-score.ts';

export type ConversionDimensionKey =
  /** Cherche-t-elle visiblement de nouveaux clients ? */
  | 'growthSignal'
  /** Export, distributeurs, partenaires : un besoin de couverture. */
  | 'expansionReach'
  /** Son marché est-il identifiable, donc démontrable ? */
  | 'marketLegibility'
  /** Une offre spécialisée se prospecte ; une offre généraliste se noie. */
  | 'offerSpecificity'
  /** Assez petite pour que la personne qui lit décide. */
  | 'decisionSpeed'
  /** Un canal commercial propre, pas un service après-vente. */
  | 'contactQuality'
  /** Saurait-on lui montrer trois prospects pertinents dès demain ? */
  | 'demonstrability';

export interface ConversionDimension {
  key: ConversionDimensionKey;
  label: string;
  weight: number;
  /** Ce qui doit être constaté pour marquer des points. */
  evidence: string;
}

/**
 * Sept dimensions, cent points.
 *
 * `growthSignal` et `demonstrability` pèsent le plus parce qu'elles décident
 * de la conversation : sans besoin visible il n'y a rien à vendre, et sans
 * capacité à montrer trois prospects il n'y a rien à prouver.
 */
export const CONVERSION_MODEL: readonly ConversionDimension[] = [
  {
    key: 'growthSignal',
    label: 'Besoin de nouveaux clients, visible',
    weight: 22,
    evidence: 'recrutement commercial, page « devenir distributeur », nouveaux marchés annoncés',
  },
  {
    key: 'demonstrability',
    label: 'Trois prospects démontrables dès demain',
    weight: 20,
    evidence: 'clientèle cible nommée et cherchable — un secteur, un métier, une application',
  },
  {
    key: 'expansionReach',
    label: 'Export, distribution, partenariats',
    weight: 14,
    evidence: 'mention d’export, de réseau de distributeurs ou de partenaires',
  },
  {
    key: 'marketLegibility',
    label: 'Marché B2B lisible',
    weight: 14,
    evidence: 'les clients sont des entreprises, et on sait lesquelles',
  },
  {
    key: 'offerSpecificity',
    label: 'Offre spécialisée',
    weight: 12,
    evidence: 'un métier précis, pas un catalogue généraliste',
  },
  {
    key: 'decisionSpeed',
    label: 'Taille qui permet de décider vite',
    weight: 10,
    evidence: 'PME : le lecteur du message peut engager 49 € sans comité',
  },
  {
    key: 'contactQuality',
    label: 'Canal commercial propre',
    weight: 8,
    evidence: 'adresse commerciale ou générale, jamais support ni juridique',
  },
];

export interface ObservedFact {
  claim: string;
  sourceUrl: string | null;
  nature: 'observed' | 'reported' | 'inferred';
}

export interface ConversionInput {
  companyName: string;
  facts: readonly ObservedFact[];
  /** Ce que le résolveur de contacts a retenu. */
  contactIntent: string | null;
  contactSuitability: string | null;
  /** Le score de qualification, pour situer — jamais pour remplacer. */
  qualificationScore: number | null;
  qualificationTier: SalesTier | string | null;
  /** Le résumé que la qualification a produit, s'il existe. */
  whyFit?: string | null;
}

export interface ConversionComponent {
  key: ConversionDimensionKey;
  label: string;
  weight: number;
  /** 0..1 — la part de la dimension acquise. */
  ratio: number;
  points: number;
  /** Le fait qui a valu ces points. Vide quand rien n'a été constaté. */
  basis: string | null;
  sourceUrl: string | null;
}

export interface ConversionScore {
  total: number;
  components: ConversionComponent[];
  /** Combien de dimensions reposent sur un fait réellement observé. */
  groundedDimensions: number;
  /** La phrase de personnalisation, tirée du meilleur fait constaté. */
  personalization: { line: string; sourceUrl: string | null } | null;
  /** Ce qui manque pour aller plus haut, dit plutôt que masqué. */
  gaps: string[];
}

const norm = (text: string): string =>
  text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Les mots qui trahissent chaque dimension, sur un fait constaté. */
const MARKERS: Record<ConversionDimensionKey, string[]> = {
  growthSignal: [
    'distributeur', 'revendeur', 'partenaire commercial', 'nouveaux marches',
    'nouveaux clients', 'developpement commercial', 'recrute', 'recrutement',
    'commercial itinerant', 'attache commercial', 'reseau de vente', 'croissance',
    'nous recherchons', 'devenir partenaire', 'rejoindre notre reseau',
  ],
  expansionReach: [
    'export', 'international', 'a l etranger', 'europe', 'monde entier',
    'distributeur', 'filiale', 'implantation', 'pays',
  ],
  marketLegibility: [
    'b2b', 'industriel', 'industrie', 'professionnel', 'entreprises',
    'agroalimentaire', 'automobile', 'aeronautique', 'pharmaceutique',
    'cosmetique', 'ferroviaire', 'nucleaire', 'medical', 'logistique',
    'emballage', 'chimie', 'energie', 'defense', 'naval',
  ],
  offerSpecificity: [
    'sur mesure', 'sur-mesure', 'machine speciale', 'machines speciales',
    'usinage', 'soudure', 'assemblage', 'automatisation', 'robotique',
    'cobotique', 'mecanique de precision', 'sous-ensemble', 'sous-traitance',
    'prototype', 'bureau d etudes', 'conception',
  ],
  decisionSpeed: [
    'pme', 'familiale', 'entreprise familiale', 'salaries', 'effectif',
    'artisanale', 'a taille humaine', 'independante',
  ],
  contactQuality: [],
  demonstrability: [
    'nos clients', 'secteurs', 'applications', 'domaines d intervention',
    'references', 'nous travaillons pour', 'destines aux', 'a destination des',
  ],
};

/** Un fait vaut plein tarif s'il a été constaté ; moitié s'il est rapporté. */
function factWeight(fact: ObservedFact): number {
  if (fact.nature === 'observed' && fact.sourceUrl) return 1;
  if (fact.nature === 'observed') return 0.7;
  if (fact.nature === 'reported') return 0.5;
  // Une déduction ne finance aucun point : c'est déjà une supposition.
  return 0;
}

export function scoreConversion(input: ConversionInput): ConversionScore {
  const components: ConversionComponent[] = [];
  const gaps: string[] = [];
  let grounded = 0;

  for (const dimension of CONVERSION_MODEL) {
    // Le canal se lit sur ce que le résolveur a retenu, pas sur les faits.
    if (dimension.key === 'contactQuality') {
      const intent = input.contactIntent ?? '';
      const suitability = input.contactSuitability ?? '';
      const ratio =
        suitability === 'BLOCKED' || !intent ? 0
        : intent === 'SALES' || intent === 'EXPORT' ? 1
        : intent === 'GENERAL' ? 0.7
        : 0.3;
      if (ratio === 0) gaps.push('aucun canal commercial utilisable');
      components.push({
        key: dimension.key,
        label: dimension.label,
        weight: dimension.weight,
        ratio,
        points: Math.round(dimension.weight * ratio * 100) / 100,
        basis: intent ? `canal ${intent} (${suitability})` : null,
        sourceUrl: null,
      });
      continue;
    }

    // Le meilleur fait qui touche la dimension. Un seul suffit : compter les
    // répétitions récompenserait un site bavard.
    let best: { fact: ObservedFact; marker: string; weight: number } | null = null;
    for (const fact of input.facts) {
      const weight = factWeight(fact);
      if (weight === 0) continue;
      const haystack = norm(fact.claim);
      const marker = MARKERS[dimension.key].find((m) => haystack.includes(m));
      if (!marker) continue;
      if (!best || weight > best.weight) best = { fact, marker, weight };
    }

    if (!best) {
      gaps.push(`${dimension.label.toLowerCase()} : rien de constaté`);
      components.push({
        key: dimension.key, label: dimension.label, weight: dimension.weight,
        ratio: 0, points: 0, basis: null, sourceUrl: null,
      });
      continue;
    }

    if (best.fact.nature === 'observed' && best.fact.sourceUrl) grounded += 1;
    components.push({
      key: dimension.key,
      label: dimension.label,
      weight: dimension.weight,
      ratio: best.weight,
      points: Math.round(dimension.weight * best.weight * 100) / 100,
      basis: `« ${best.marker} » — ${best.fact.claim.slice(0, 110)}`,
      sourceUrl: best.fact.sourceUrl,
    });
  }

  const total = Math.round(components.reduce((sum, c) => sum + c.points, 0) * 100) / 100;

  // La personnalisation vient du fait le plus spécifique réellement constaté.
  // Sans fait sourcé, il n'y en a pas : un « j'ai vu que… » inventé se repère
  // en dix secondes et disqualifie tout le message.
  const sourced = input.facts.filter((f) => f.nature === 'observed' && f.sourceUrl);
  const chosen = sourced.sort((a, b) => b.claim.length - a.claim.length)[0] ?? null;

  return {
    total,
    components,
    groundedDimensions: grounded,
    personalization: chosen ? { line: chosen.claim, sourceUrl: chosen.sourceUrl } : null,
    gaps,
  };
}

/**
 * Un score de conversion ne suffit pas à démarcher.
 *
 * Deux conditions s'y ajoutent, et elles portent sur la matière plutôt que sur
 * le chiffre : au moins trois dimensions financées par un fait constaté, et une
 * personnalisation sourcée. Un total élevé obtenu sur des déductions décrit
 * notre optimisme, pas l'entreprise.
 */
/**
 * Les extensions qui désignent une entreprise hors de France.
 *
 * La campagne vise des PME françaises : `diversitech.ca` et `humanafterall.ca`
 * sont sorties « prêtes », l'une canadienne, l'autre une agence de Montréal.
 * Le `.com` reste neutre — beaucoup de PME françaises l'utilisent — mais une
 * extension nationale étrangère tranche seule.
 */
const FOREIGN_TLDS = [
  '.ca', '.us', '.co.uk', '.uk', '.de', '.es', '.it', '.nl', '.pl',
  '.cn', '.in', '.br', '.au', '.jp', '.ru', '.tr',
];

export function isForeignDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const host = domain.toLowerCase().replace(/^www\./, '');
  return FOREIGN_TLDS.some((tld) => host.endsWith(tld));
}

export const CONVERSION_READY_THRESHOLD = 55;
export const MIN_GROUNDED_DIMENSIONS = 3;

export function isConversionReady(
  score: ConversionScore,
  context: { domain?: string | null; contactValue?: string | null } = {},
): { ready: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (isForeignDomain(context.domain) || isForeignDomain((context.contactValue ?? '').split('@')[1] ?? '')) {
    blockers.push('domaine hors de France : le profil de cette campagne vise des PME françaises');
  }
  if (score.total < CONVERSION_READY_THRESHOLD) {
    blockers.push(`score ${score.total} sous ${CONVERSION_READY_THRESHOLD}`);
  }
  if (score.groundedDimensions < MIN_GROUNDED_DIMENSIONS) {
    blockers.push(
      `${score.groundedDimensions} dimension(s) appuyée(s) sur un fait constaté — ${MIN_GROUNDED_DIMENSIONS} au minimum`,
    );
  }
  if (!score.personalization) blockers.push('aucune personnalisation sourcée');
  // Un canal utilisable, sans quoi « prêt à démarcher » ne veut rien dire :
  // deux dossiers sont sortis prêts sans adresse ni formulaire ni téléphone.
  const channel = score.components.find((c) => c.key === 'contactQuality');
  if (!channel || channel.points === 0) blockers.push('aucun canal de contact utilisable');
  return { ready: blockers.length === 0, blockers };
}
