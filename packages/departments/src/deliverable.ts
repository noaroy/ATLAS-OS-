import type { Company, Contact, Evidence, Opportunity } from '@atlas/contracts';

/**
 * Le pack remis au client.
 *
 * Ce fichier ne met pas en forme des résultats : il décide de ce qui peut être
 * affirmé. Un client qui paie 49 € pour cinq prospects achète surtout le droit
 * de faire confiance à ce qu'il lit — et il ne peut faire confiance que s'il
 * voit, ligne par ligne, d'où vient chaque phrase.
 *
 * D'où la seule structure de ce document :
 *
 *   FAIT            quelqu'un l'a lu quelque part, et le lien est donné
 *   DÉDUCTION       ATLAS l'a inféré, et dit à partir de quoi
 *   RECOMMANDATION  ATLAS le conseille, et c'est un avis, pas un constat
 *
 * La séparation n'est pas typographique. Un fait sans source ne peut pas être
 * rendu — il n'a pas de place dans la première catégorie, et le déplacer dans
 * la deuxième serait mentir sur sa nature. Les trois catégories viennent
 * directement de `EvidenceNature`, posée à l'écriture de chaque preuve : elles
 * ne sont pas recalculées ici, où la tentation d'arrondir serait maximale.
 *
 * Rien n'est inventé pour combler un trou. Un contact introuvable reste
 * introuvable, et c'est écrit ; le remplacer par « contact@domaine.de » serait
 * une adresse plausible, invérifiable, et fausse une fois sur deux.
 */

/** Une affirmation, avec ce qui l'autorise. */
export interface PackClaim {
  field: string;
  text: string;
  /** L'adresse où c'est lisible. Toujours présente pour un fait. */
  sourceRef: string | null;
  sourceTitle: string | null;
  /** Ce sur quoi la déduction s'appuie. Toujours présente pour une déduction. */
  basis: string | null;
  confidence: number;
  collectedAt: string;
}

/** Un conseil d'ATLAS — jamais présenté comme un constat. */
export interface PackAdvice {
  /** Ce qui est conseillé. */
  text: string;
  /** Sur quoi ce conseil repose, en clair. */
  because: string;
}

export interface PackProspect {
  rank: number | null;
  company: string;
  website: string | null;
  sector: string[];
  location: string;
  /** Les rôles retenus après qualification — distributeur, intégrateur… */
  roles: string[];
  /** Pourquoi ce prospect correspond à la cible, en une phrase. */
  whyItMatches: string;

  /** Ce qui a été lu quelque part, avec le lien. */
  facts: PackClaim[];
  /** Ce qu'ATLAS a déduit, avec la base de la déduction. */
  inferences: PackClaim[];
  /** Ce qu'ATLAS conseille. */
  recommendations: PackAdvice[];

  /** Les signaux commerciaux détectés, tirés des faits. */
  signals: string[];
  /** Un contact, seulement s'il a réellement été trouvé. */
  contact: PackContact | null;
  score: number | null;
  /** 0..1 — ce que vaut le score, vu les preuves qui le portent. */
  confidence: number | null;
  /** L'angle d'approche suggéré. Une recommandation, jamais un fait. */
  approachAngle: string;
}

export interface PackContact {
  name: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  /** La page où le contact est joignable, quand aucune personne n'est nommée. */
  contactPage: string | null;
}

export interface Pack {
  title: string;
  /** Ce que le client a demandé, repris tel quel. */
  brief: string;
  generatedAt: string;
  prospects: PackProspect[];
  /** Ce qui a été cherché et n'a pas été trouvé. Le silence serait trompeur. */
  limitations: string[];
}

/** Une affirmation de première main : lue quelque part, pas déduite. */
const isFirsthand = (e: Evidence): boolean => e.nature !== 'inferred';

const toClaim = (e: Evidence): PackClaim => ({
  field: e.field,
  text: e.claim,
  sourceRef: e.sourceRef,
  sourceTitle: e.sourceTitle,
  basis: e.basis,
  confidence: e.confidence,
  collectedAt: e.collectedAt,
});

/**
 * Les signaux commerciaux lisibles dans les faits.
 *
 * Déterministe et volontairement pauvre : ce sont des mots-clés cherchés dans
 * des affirmations sourcées, pas une lecture du marché. Un signal détecté ainsi
 * renvoie toujours au fait qui l'a déclenché, donc le client peut vérifier ;
 * un signal produit par le modèle serait plus riche et invérifiable.
 */
const SIGNAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Recrutement en cours', pattern: /\b(recrut|stellenangebot|karriere|hiring|jobs?)\b/i },
  { label: 'Expansion internationale', pattern: /\b(export|international|expansion|filiale|niederlassung)\b/i },
  { label: 'Investissement ou nouvelle capacité', pattern: /\b(investi|invest|neue anlage|erweiterung|nouvelle usine)\b/i },
  { label: 'Salon ou événement professionnel', pattern: /\b(messe|salon|trade fair|fachmesse)\b/i },
  { label: 'Certification ou norme', pattern: /\b(iso\s?\d{4}|certifi|zertifi)\b/i },
  { label: 'Distribution ou partenariat déclaré', pattern: /\b(distribut|händler|vertrieb|partner)\b/i },
];

export function detectSignals(facts: readonly PackClaim[]): string[] {
  const found = new Set<string>();
  for (const fact of facts) {
    for (const { label, pattern } of SIGNAL_PATTERNS) {
      if (pattern.test(fact.text)) found.add(label);
    }
  }
  return [...found];
}

/**
 * L'angle d'approche conseillé.
 *
 * Construit à partir des rôles retenus et des signaux détectés, jamais d'une
 * génération libre : un angle inventé serait la partie la plus convaincante du
 * document et la seule sans support.
 *
 * Rendu comme une recommandation explicite. Le client doit pouvoir le rejeter
 * sans que cela remette en cause les faits qui précèdent.
 */
export function approachAngleFor(roles: readonly string[], signals: readonly string[]): string {
  const parts: string[] = [];

  if (roles.includes('distributor')) {
    parts.push('Aborder sous l’angle de la distribution : proposer une zone ou une gamme définie plutôt qu’un partenariat général.');
  }
  if (roles.includes('integrator')) {
    parts.push('Aborder sous l’angle de l’intégration : partir d’un cas d’installation concret côté client final.');
  }
  if (roles.includes('manufacturer')) {
    parts.push('Aborder sous l’angle de la complémentarité produit, pas de la revente.');
  }
  if (parts.length === 0) {
    parts.push('Aucun rôle n’a été retenu avec certitude : ouvrir par une question sur leur activité réelle plutôt que par une proposition.');
  }

  if (signals.includes('Recrutement en cours')) {
    parts.push('Le recrutement en cours suggère une croissance : mentionner la capacité à absorber un volume supplémentaire.');
  }
  if (signals.includes('Expansion internationale')) {
    parts.push('L’expansion déclarée est un point d’entrée naturel : rattacher l’offre à leur marché cible.');
  }
  if (signals.includes('Salon ou événement professionnel')) {
    parts.push('Une présence en salon offre un prétexte de contact daté et vérifiable.');
  }

  return parts.join(' ');
}

/**
 * Assemble le pack à partir de ce qui est réellement en base.
 *
 * Aucune donnée n'est complétée, devinée ni arrondie. Ce qui manque est
 * signalé, parce qu'un livrable qui tait ses trous se fait juger sur eux.
 */
export function buildPack(input: {
  title: string;
  brief: string;
  generatedAt: string;
  entries: Array<{
    opportunity: Opportunity;
    company: Company;
    evidence: readonly Evidence[];
    contacts: readonly Contact[];
  }>;
}): Pack {
  const prospects: PackProspect[] = [];
  const limitations: string[] = [];

  for (const { opportunity, company, evidence, contacts } of input.entries) {
    const facts = evidence.filter(isFirsthand).map(toClaim);
    const inferences = evidence.filter((e) => !isFirsthand(e)).map(toClaim);
    const signals = detectSignals(facts);
    const roles = opportunity.targetTypes;

    const contact = pickContact(contacts, company);
    // Une page de contact n'est pas un contact : elle dit où écrire, pas à qui.
    // La distinction compte pour le client, qui prospecte des personnes.
    if (!contact?.name) {
      limitations.push(
        `${company.name} — aucun contact nominatif n’a été trouvé dans les sources consultées` +
          `${contact?.contactPage ? ' ; seule la page de contact du site est connue.' : '.'}`,
      );
    }
    if (facts.length < 2) {
      limitations.push(
        `${company.name} — ${facts.length} affirmation(s) de première main seulement ; ` +
          `le reste du dossier repose sur des déductions.`,
      );
    }

    const recommendations: PackAdvice[] = [];
    if (opportunity.justification) {
      recommendations.push({
        text: opportunity.justification,
        because: `Position ${opportunity.rank ?? '—'} au classement, score ${opportunity.score ?? 'non mesuré'}/100.`,
      });
    }
    recommendations.push({
      text: approachAngleFor(roles, signals),
      because:
        `Rôles retenus : ${roles.length > 0 ? roles.join(', ') : 'aucun établi'}. ` +
        `Signaux détectés : ${signals.length > 0 ? signals.join(', ') : 'aucun'}.`,
    });

    prospects.push({
      rank: opportunity.rank,
      company: company.name,
      website: company.website ?? (company.domain ? `https://${company.domain}` : null),
      sector: company.industries,
      location: [company.city, company.region, company.country].filter(Boolean).join(', ') || 'non établi',
      roles,
      whyItMatches: opportunity.qualification?.rationale ?? 'La qualification n’a pas été rendue.',
      facts,
      inferences,
      recommendations,
      signals,
      contact,
      score: opportunity.score,
      confidence: opportunity.scoreDetail?.confidence ?? null,
      approachAngle: approachAngleFor(roles, signals),
    });
  }

  return {
    title: input.title,
    brief: input.brief,
    generatedAt: input.generatedAt,
    prospects,
    limitations,
  };
}

/**
 * Le contact, seulement s'il existe vraiment.
 *
 * Une personne nommée d'abord ; à défaut, la page de contact du site, qui est
 * une information utile et vérifiable. Jamais une adresse reconstruite depuis
 * le domaine : `kontakt@…` est plausible, invérifiable, et fausse assez souvent
 * pour ruiner la crédibilité du reste du document.
 */
function pickContact(contacts: readonly Contact[], company: Company): PackContact | null {
  const named = contacts.find((c) => c.name.trim().length > 0 && (c.email ?? c.phone ?? c.linkedin));
  if (named) {
    return {
      name: named.name,
      role: named.role,
      email: named.email,
      phone: named.phone,
      contactPage: null,
    };
  }
  const site = company.website ?? (company.domain ? `https://${company.domain}` : null);
  if (site) {
    return { name: null, role: null, email: null, phone: null, contactPage: `${site}/kontakt` };
  }
  return null;
}
