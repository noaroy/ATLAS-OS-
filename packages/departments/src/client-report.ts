import type { Company, Contact, Evidence, Opportunity, ScoringModel } from '@atlas/contracts';
import type { ReportProvenance, ReportEconomics } from './delivery.ts';

/**
 * Le rapport remis au client, en français, lisible sans connaître ATLAS.
 *
 * Le pack précédent était une mise en forme des données ; celui-ci est un
 * document. La différence tient à ce qu'un client fait avec : il le lit sans
 * contexte, le fait circuler, s'en sert pour décider qui appeler lundi. Il ne
 * doit donc jamais avoir à deviner ce qu'est une « opportunité », un
 * « sourceRef » ou une « lignée ».
 *
 * Deux règles gouvernent la traduction :
 *
 *   1. **La présentation est française, les preuves restent dans leur langue.**
 *      Une affirmation relevée sur un site allemand est citée telle quelle, avec
 *      sa traduction à côté. Remplacer l'original par sa traduction ferait
 *      perdre la seule chose que le client peut vérifier lui-même.
 *   2. **Traduire ne reformule pas.** Une nuance perdue change ce qu'on affirme
 *      d'une entreprise, et c'est une entreprise réelle.
 */

export interface ReportProspect {
  rank: number;
  company: string;
  location: string;
  website: string | null;
  sectors: string[];
  score: number;
  confidence: number;
  /** Pourquoi cette entreprise est pertinente, en français. */
  whyRelevant: string;
  /** Ce qui reste incertain — écrit, jamais tu. */
  risks: string[];
  /** Ce que nous recommandons d'en faire. */
  recommendation: string;
  dimensions: ReportDimension[];
  facts: ReportClaim[];
  inferences: ReportClaim[];
  contacts: ReportContact[];
}

export interface ReportDimension {
  key: string;
  label: string;
  value: number;
  weight: number;
  contribution: number;
  rationale: string;
  /** Calculée par la plateforme plutôt qu'affirmée par un analyste. */
  computed: boolean;
  evidenceIds: string[];
}

export interface ReportClaim {
  id: string;
  field: string;
  /** Le libellé français du champ — « secteur » plutôt que « sector ». */
  fieldLabel: string;
  nature: 'observed' | 'reported' | 'inferred';
  natureLabel: string;
  /** Le texte d'origine, tel qu'il a été relevé. */
  original: string;
  /** Sa traduction française, quand l'original n'est pas en français. */
  french: string | null;
  sourceRef: string | null;
  basis: string | null;
  confidence: number;
}

export interface ReportContact {
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  /** Vrai quand une personne est nommée, faux pour un contact de standard. */
  named: boolean;
}

export interface ClientReport {
  /** Ce que le client a demandé, dans ses termes. */
  clientName: string;
  missionTitle: string;
  market: string;
  generatedAt: string;
  analysedCount: number;
  retainedCount: number;
  objective: string;
  summary: ReportSummary;
  prospects: ReportProspect[];
  /** Ce qui n'a pas été trouvé, ou reste à vérifier. */
  limitations: string[];
  sources: string[];
  scoringNarrative: string;
  provenance: ReportProvenance;
  economics: ReportEconomics | null;
}

export interface ReportSummary {
  objective: string;
  result: string;
  /** Les enseignements, distingués des faits qui les portent. */
  findings: string[];
}

// ─── Traduction ─────────────────────────────────────────────────────────────

/**
 * Les libellés de champ, en français.
 *
 * Une table et non une traduction automatique : les clés sont un vocabulaire
 * fermé, connu à l'avance, et les traduire à la volée coûterait un appel au
 * modèle pour un résultat moins stable qu'une constante.
 */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  existence: 'Existence établie',
  sector: 'Secteur d’activité',
  'business model': 'Modèle économique',
  business_model: 'Modèle économique',
  portfolio: 'Gamme de produits',
  capabilities: 'Capacités',
  contact: 'Coordonnées',
  reach: 'Couverture',
  fit: 'Adéquation',
  'company history': 'Historique',
  'Founded year': 'Année de création',
  'Legal name and location': 'Raison sociale et localisation',
  'Product portfolio': 'Gamme de produits',
  'Multi-sector experience': 'Expérience multi-secteurs',
  'Market position': 'Position sur le marché',
};

export const fieldLabel = (field: string): string =>
  FIELD_LABELS[field] ?? FIELD_LABELS[field.toLowerCase()] ?? capitalise(field.replace(/[_-]/g, ' '));

const NATURE_LABELS: Readonly<Record<ReportClaim['nature'], string>> = {
  observed: 'Constaté sur la source',
  reported: 'Rapporté par la source',
  inferred: 'Déduit par ATLAS',
};

const DIMENSION_LABELS: Readonly<Record<string, string>> = {
  'sector-fit': 'Adéquation sectorielle',
  'geographic-fit': 'Couverture géographique',
  'portfolio-fit': 'Complémentarité de gamme',
  'commercial-reach': 'Force commerciale',
  'strategic-relevance': 'Intérêt stratégique',
  'size-fit': 'Taille adaptée',
  'evidence-quality': 'Qualité des preuves',
};

/**
 * Le texte est-il déjà en français ?
 *
 * Heuristique volontairement simple et conservatrice : on cherche des mots
 * outils qui n'existent qu'en français. En cas de doute on considère que le
 * texte est étranger, ce qui déclenche l'affichage côte à côte — au pire le
 * client voit deux fois la même phrase, ce qui ne coûte rien. L'inverse ferait
 * disparaître l'original, ce qui coûte la vérifiabilité.
 */
export function looksFrench(text: string): boolean {
  return /\b(le|la|les|des|une|dans|pour|avec|sur|est|sont|leur|selon|chez)\b/i.test(text);
}

// ─── Assemblage ─────────────────────────────────────────────────────────────

export interface ReportEntry {
  opportunity: Opportunity;
  company: Company;
  evidence: readonly Evidence[];
  contacts: readonly Contact[];
  /** Traductions françaises fournies par l'appelant, par identifiant de preuve. */
  translations?: Record<string, string>;
}

/**
 * Assemble le rapport à partir de ce qui est en base.
 *
 * Aucune donnée n'est complétée. Ce qui manque devient une limite écrite, et
 * une limite écrite vaut mieux qu'un blanc que le client interprétera moins
 * charitablement que la réalité.
 */
export function buildClientReport(input: {
  clientName: string;
  missionTitle: string;
  market: string;
  objective: string;
  generatedAt: string;
  analysedCount: number;
  entries: readonly ReportEntry[];
  scoringModel: ScoringModel;
  provenance: ReportProvenance;
  economics?: ReportEconomics | null;
}): ClientReport {
  const prospects: ReportProspect[] = [];
  const limitations: string[] = [];
  const sources = new Set<string>();

  for (const entry of input.entries) {
    const { opportunity, company, evidence, contacts } = entry;
    const detail = opportunity.scoreDetail;

    const claims = evidence.map((e) => toClaim(e, entry.translations ?? {}));
    for (const claim of claims) if (claim.sourceRef) sources.add(claim.sourceRef);

    const facts = claims.filter((c) => c.nature !== 'inferred' && c.sourceRef);
    const inferences = claims.filter((c) => c.nature === 'inferred');

    const dimensions: ReportDimension[] = (detail?.components ?? []).map((comp) => ({
      key: comp.dimension,
      label: DIMENSION_LABELS[comp.dimension] ?? comp.label,
      value: comp.value,
      weight: comp.weight,
      contribution: comp.contribution,
      rationale: comp.rationale,
      computed: comp.computed,
      evidenceIds: comp.evidenceIds ?? [],
    }));

    // Les risques, déduits de ce qui manque plutôt que rédigés librement.
    const risks: string[] = [];
    const weakest = [...dimensions].filter((d) => !d.computed).sort((a, b) => a.value - b.value)[0];
    if (weakest && weakest.value < 60) {
      risks.push(`${weakest.label} : ${weakest.value}/100 — ${weakest.rationale}`);
    }
    if (facts.length < 3) {
      risks.push(
        `Dossier mince : ${facts.length} affirmation(s) de première main. ` +
          `Un échange direct confirmera plus vite qu'une recherche supplémentaire.`,
      );
    }
    const named = contacts.filter((c) => isNamed(c));
    if (named.length === 0) {
      risks.push(
        'Aucun interlocuteur nommé n’a été trouvé publiquement : le premier contact passera par le standard.',
      );
      limitations.push(`${company.name} — aucun contact nominatif publié.`);
    }
    if (inferences.length > 0) {
      risks.push(
        `${inferences.length} élément(s) du dossier relèvent de la déduction et non du constat ; ` +
          `ils sont signalés comme tels dans la section Preuves.`,
      );
    }

    prospects.push({
      rank: opportunity.rank ?? prospects.length + 1,
      company: company.name,
      location: [company.city, company.region, company.country].filter(Boolean).join(', ') || 'non établie',
      website: company.website ?? (company.domain ? `https://${company.domain}` : null),
      sectors: company.industries,
      score: opportunity.score ?? 0,
      confidence: detail?.confidence ?? 0,
      whyRelevant: opportunity.qualification?.rationale ?? 'La qualification n’a pas été rendue.',
      risks,
      recommendation:
        opportunity.justification ??
        `Position ${opportunity.rank ?? '—'} au classement, score ${opportunity.score ?? '—'}/100.`,
      dimensions,
      facts,
      inferences,
      contacts: contacts.map((c) => ({
        name: c.name,
        role: c.role,
        email: c.email,
        phone: c.phone,
        named: isNamed(c),
      })),
    });
  }

  const best = prospects[0];
  const summary: ReportSummary = {
    objective: input.objective,
    result:
      prospects.length === 0
        ? `Aucune entreprise du périmètre n’a franchi le seuil de sélection sur les ${input.analysedCount} analysées.`
        : `${prospects.length} entreprise(s) retenue(s) sur ${input.analysedCount} analysée(s), ` +
          `notées de ${Math.min(...prospects.map((p) => p.score))} à ${Math.max(...prospects.map((p) => p.score))} sur 100.`,
    findings: buildFindings(prospects, best),
  };

  return {
    clientName: input.clientName,
    missionTitle: input.missionTitle,
    market: input.market,
    generatedAt: input.generatedAt,
    analysedCount: input.analysedCount,
    retainedCount: prospects.length,
    objective: input.objective,
    summary,
    prospects,
    limitations,
    sources: [...sources].sort(),
    scoringNarrative: input.scoringModel.narrative,
    provenance: input.provenance,
    economics: input.economics ?? null,
  };
}

/** Les enseignements, tirés des chiffres et non rédigés librement. */
function buildFindings(prospects: ReportProspect[], best: ReportProspect | undefined): string[] {
  if (!best) {
    return [
      'Le périmètre analysé n’a pas produit de candidat au niveau attendu. Élargir la zone ou assouplir un critère donnerait probablement des résultats — au prix d’une pertinence moindre.',
    ];
  }

  const findings = [
    `${best.company} arrive en tête avec ${best.score}/100. ${firstSentence(best.whyRelevant)}`,
  ];

  // L'axe le plus faible de l'ensemble : c'est là que le marché résiste, et
  // c'est plus utile au client que de répéter ce qui va bien.
  const judged = prospects.flatMap((p) => p.dimensions.filter((d) => !d.computed));
  if (judged.length > 0) {
    const byKey = new Map<string, { label: string; total: number; n: number }>();
    for (const d of judged) {
      const cur = byKey.get(d.key) ?? { label: d.label, total: 0, n: 0 };
      byKey.set(d.key, { label: d.label, total: cur.total + d.value, n: cur.n + 1 });
    }
    const averages = [...byKey.values()].map((v) => ({ label: v.label, avg: v.total / v.n }));
    const weakest = averages.sort((a, b) => a.avg - b.avg)[0]!;
    findings.push(
      `L’axe le plus faible sur l’ensemble est « ${weakest.label} » ` +
        `(${Math.round(weakest.avg)}/100 en moyenne) : c’est le point à traiter en premier lors des échanges.`,
    );
  }

  const withoutNamedContact = prospects.filter((p) => !p.contacts.some((c) => c.named)).length;
  if (withoutNamedContact > 0) {
    findings.push(
      `${withoutNamedContact} entreprise(s) sur ${prospects.length} ne publient aucun interlocuteur nommé. ` +
        `Le premier contact passera par le standard ou par un formulaire.`,
    );
  }

  return findings;
}

function toClaim(evidence: Evidence, translations: Record<string, string>): ReportClaim {
  const original = evidence.claim;
  const supplied = translations[evidence.id];
  return {
    id: evidence.id,
    field: evidence.field,
    fieldLabel: fieldLabel(evidence.field),
    nature: evidence.nature,
    natureLabel: NATURE_LABELS[evidence.nature],
    original,
    // Rien n'est traduit ici : une traduction fabriquée sans le texte source
    // sous les yeux déformerait ce qu'on affirme d'une entreprise réelle. Le
    // champ reste vide tant qu'une traduction n'a pas été fournie.
    french: supplied ?? (looksFrench(original) ? null : null),
    sourceRef: evidence.sourceRef,
    basis: evidence.basis,
    confidence: evidence.confidence,
  };
}

/**
 * Ce contact désigne-t-il une personne ?
 *
 * « Contact général », « Service commercial », « Standard » nomment une porte,
 * pas quelqu'un. La distinction compte pour un client qui prospecte : elle
 * change la première phrase de son message.
 */
export function isNamed(contact: { name: string }): boolean {
  const generic = /^(contact|service|standard|accueil|info|sales|support|vertrieb)\b/i;
  const name = contact.name.trim();
  if (!name || generic.test(name)) return false;
  // Un nom de personne porte au moins deux mots — prénom et nom.
  return name.split(/\s+/).filter((w) => w.length > 1).length >= 2;
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const firstSentence = (text: string): string => {
  const match = text.match(/^[^.!?]+[.!?]/);
  return (match?.[0] ?? text).trim();
};
