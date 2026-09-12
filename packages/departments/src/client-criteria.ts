import type { ClientBrief, ClientCriterion } from './client-brief.ts';
import { allCriteria } from './client-brief.ts';
import type { BlockCatalogue } from './verbatim-selection.ts';
import { resolveSelections } from './verbatim-selection.ts';
import type { SourcedEvidence } from './evidence-blocks.ts';

/**
 * La qualification d'un candidat, critère par critère, sur ses propres pages.
 *
 * Le modèle lit des passages numérotés et, pour chaque critère du brief, rend
 * un verdict et les numéros des passages qui le fondent. Il n'écrit jamais
 * une citation : le texte est relu au numéro rendu, et un verdict ÉTABLI sans
 * passage relu redescend en À CONFIRMER. La source décide, le modèle propose.
 *
 * Quatre verdicts, et leur sens exact :
 *
 *   ESTABLISHED      les pages le montrent, et la citation est relue
 *   NOT_ESTABLISHED  les pages montrent le contraire — pas « rien trouvé »
 *   TO_CONFIRM       les pages n'en parlent pas, ou pas assez
 *   EXCLUDED         un critère d'exclusion est établi, preuve à l'appui
 *
 * « Rien trouvé » n'est jamais une conclusion. C'est la règle qui empêche
 * d'écarter une bonne société pour un site trop court, et d'en retenir une
 * mauvaise pour une phrase bien tournée.
 */
export type CriterionVerdict = 'ESTABLISHED' | 'NOT_ESTABLISHED' | 'TO_CONFIRM' | 'EXCLUDED';

export interface CriterionResult {
  key: string;
  label: string;
  kind: 'required' | 'preferred' | 'exclusion';
  weight: number;
  verdict: CriterionVerdict;
  /** Ce que le modèle a compris — usage interne et lecture humaine, jamais une affirmation client. */
  note: string;
  /** Les citations relues qui fondent le verdict. Vide pour TO_CONFIRM et NOT_ESTABLISHED. */
  evidence: SourcedEvidence[];
  /** Pourquoi un verdict a été rétrogradé, quand il l'a été. */
  downgraded: string | null;
}

export type SpecialisationVerdict = 'SPECIALIST' | 'GENERALIST' | 'TO_CONFIRM';

export interface SpecialisationResult {
  verdict: SpecialisationVerdict;
  note: string;
  evidence: SourcedEvidence[];
}

export type ExclusionCategory =
  | 'TOO_GENERAL' | 'WRONG_COUNTRY' | 'COMPETITOR' | 'LOW_RELEVANCE' | 'DIRECTORY'
  | 'DUPLICATE' | 'INSUFFICIENT_EVIDENCE' | 'EXCLUSION_CRITERION' | 'CLIENT_EXCLUDED';

export interface CompetitorHit {
  competitor: string;
  quote: string;
  sourceUrl: string;
}

/** Ce que le modèle doit rendre. Des numéros, jamais des phrases de la page. */
export function criteriaSchema(brief: ClientBrief): Record<string, unknown> {
  const keys = allCriteria(brief).map((c) => c.key);
  return {
    type: 'object',
    properties: {
      activity: { type: 'string', maxLength: 140, description: 'Ce que fait la société, en une phrase neutre, en français.' },
      sectors: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 30 } },
      criteria: {
        type: 'array', minItems: keys.length, maxItems: keys.length,
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', enum: keys },
            verdict: { type: 'string', enum: ['ESTABLISHED', 'NOT_ESTABLISHED', 'TO_CONFIRM'] },
            evidenceBlockIds: { type: 'array', maxItems: 3, items: { type: 'integer' } },
            note: { type: 'string', maxLength: 110 },
          },
          required: ['key', 'verdict', 'evidenceBlockIds', 'note'],
          additionalProperties: false,
        },
      },
      specialisation: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['SPECIALIST', 'GENERALIST', 'AMBIGUOUS'] },
          evidenceBlockIds: { type: 'array', maxItems: 3, items: { type: 'integer' } },
          note: { type: 'string', maxLength: 110 },
        },
        required: ['verdict', 'evidenceBlockIds', 'note'],
        additionalProperties: false,
      },
    },
    required: ['activity', 'sectors', 'criteria', 'specialisation'],
    additionalProperties: false,
  };
}

export const CRITERIA_SYSTEM =
  'Vous qualifiez une société candidate pour une mission commerciale, critère par critère, '
  + 'à partir de passages NUMÉROTÉS extraits de son site. Pour chaque critère, rendez un verdict '
  + 'et les NUMÉROS des passages qui le fondent. Ne recopiez jamais un passage. '
  + 'ESTABLISHED seulement si un passage le montre. NOT_ESTABLISHED seulement si un passage montre '
  + 'le contraire. TO_CONFIRM quand les passages n’en parlent pas — c’est la réponse normale, pas un échec. '
  + 'Pour la spécialisation : GENERALIST si le site présente un catalogue large et hétérogène sans '
  + 'positionnement sur le domaine visé ; SPECIALIST si le domaine visé est son cœur d’activité ; '
  + 'AMBIGUOUS sinon. Les faits déjà relevés (identifiant, adresse, coordonnées) sont acquis : ne les '
  + 'rejugez pas. Notes en français, courtes, factuelles, sans reformuler les passages. '
  + 'Répondez en JSON strict, sans texte autour.';

/** Ce qui est donné au modèle en tête : les faits relevés sans lui. */
export interface PromptFacts {
  country: string | null;
  countryBasis: string | null;
  orgNr: string | null;
  vat: string | null;
  postalAddress: string | null;
  emails: readonly string[];
  briefTermsSeen: readonly string[];
}

export function criteriaPrompt(
  brief: ClientBrief,
  company: { name: string; url: string },
  catalogue: Pick<BlockCatalogue, 'text'>,
  facts?: PromptFacts,
): string {
  const lignes = allCriteria(brief).map((c) =>
    `- [${c.key}] (${c.kind}) ${c.label}${c.hint ? ` — indice : ${c.hint}` : ''}`);
  const faits = facts ? [
    ``,
    `# Faits déjà relevés (acquis)`,
    `Pays : ${facts.country ? `${facts.country} (${facts.countryBasis ?? 'prouvé'})` : 'non prouvé — ne pas conclure'}`,
    ...(facts.orgNr ? [`Organisationsnummer : ${facts.orgNr}`] : []),
    ...(facts.vat ? [`TVA : ${facts.vat}`] : []),
    ...(facts.postalAddress ? [`Adresse : ${facts.postalAddress}`] : []),
    ...(facts.emails.length ? [`Courriels publiés : ${facts.emails.join(', ')}`] : []),
    ...(facts.briefTermsSeen.length ? [`Termes du brief vus sur les pages : ${facts.briefTermsSeen.join(', ')}`] : []),
  ] : [];
  return [
    `# Mission`,
    `Client : ${brief.client.name} — ${brief.client.offering}`,
    `Marché : ${brief.market.countryLabel}. Rôles cherchés : ${brief.targetRoles.join(', ')}.`,
    `Domaine visé : ${brief.productKeywords.join(', ')}${brief.industries.length ? ` · secteurs : ${brief.industries.join(', ')}` : ''}.`,
    ``,
    `# Critères`,
    ...lignes,
    ``,
    `# Société candidate`,
    `${company.name} — ${company.url}`,
    ...faits,
    ``,
    `# Passages${catalogue.text}`,
  ].join('\n');
}

interface RawCriterion { key?: unknown; verdict?: unknown; evidenceBlockIds?: unknown; note?: unknown }
interface RawOutput {
  activity?: unknown; sectors?: unknown; criteria?: unknown;
  specialisation?: { verdict?: unknown; evidenceBlockIds?: unknown; note?: unknown };
}

const asInts = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : [];
const asText = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Au plus trois passages par verdict : svk.se en a rendu quatre-vingts, tous relus, tous écrits. */
const MAX_PASSAGES_PAR_VERDICT = 3;

function relire(ids: number[], note: string, catalogue: BlockCatalogue): SourcedEvidence[] {
  const { evidence } = resolveSelections(
    ids.slice(0, MAX_PASSAGES_PAR_VERDICT).map((evidenceBlockId) => ({ evidenceBlockId, normalizedClaim: note || 'passage cité', evidenceType: 'COMMERCIAL_FACT' as const })),
    catalogue,
  );
  return evidence;
}

export interface ResolvedQualification {
  activity: string;
  sectors: string[];
  criteria: CriterionResult[];
  specialisation: SpecialisationResult;
}

/**
 * La sortie du modèle, relue contre les pages.
 *
 * Chaque verdict positif doit pointer un passage qui existe et se relit ; à
 * défaut il redescend, et la rétrogradation est écrite. Un critère que le
 * modèle a oublié est À CONFIRMER — l'oubli n'est pas une absence.
 */
export function resolveQualification(
  raw: unknown,
  brief: ClientBrief,
  catalogue: BlockCatalogue,
): ResolvedQualification {
  const sortie = (raw ?? {}) as RawOutput;
  const rendus = new Map<string, RawCriterion>();
  if (Array.isArray(sortie.criteria)) {
    for (const c of sortie.criteria as RawCriterion[]) if (typeof c?.key === 'string') rendus.set(c.key, c);
  }

  const criteria: CriterionResult[] = allCriteria(brief).map((critere) => {
    const r = rendus.get(critere.key);
    const base = { key: critere.key, label: critere.label, kind: critere.kind, weight: critere.weight };
    if (!r) {
      return { ...base, verdict: 'TO_CONFIRM', note: 'critère non traité par le modèle', evidence: [], downgraded: null };
    }
    const note = asText(r.note, 160);
    const verdict = r.verdict;
    if (verdict === 'ESTABLISHED') {
      const evidence = relire(asInts(r.evidenceBlockIds), note, catalogue);
      if (evidence.length === 0) {
        return { ...base, verdict: 'TO_CONFIRM', note, evidence: [], downgraded: 'établi sans passage relu : rétrogradé' };
      }
      return {
        ...base,
        verdict: critere.kind === 'exclusion' ? 'EXCLUDED' : 'ESTABLISHED',
        note, evidence, downgraded: null,
      };
    }
    if (verdict === 'NOT_ESTABLISHED') {
      // Le contraire peut avoir sa preuve ; sinon la note reste une lecture.
      const evidence = relire(asInts(r.evidenceBlockIds), note, catalogue);
      return { ...base, verdict: 'NOT_ESTABLISHED', note, evidence, downgraded: null };
    }
    return { ...base, verdict: 'TO_CONFIRM', note, evidence: [], downgraded: null };
  });

  const spec = sortie.specialisation ?? {};
  const specNote = asText(spec.note, 160);
  let specialisation: SpecialisationResult;
  if (spec.verdict === 'GENERALIST' || spec.verdict === 'SPECIALIST') {
    const evidence = relire(asInts(spec.evidenceBlockIds), specNote, catalogue);
    specialisation = evidence.length > 0
      ? { verdict: spec.verdict, note: specNote, evidence }
      : { verdict: 'TO_CONFIRM', note: `${specNote} (sans passage relu)`.trim(), evidence: [] };
  } else {
    specialisation = { verdict: 'TO_CONFIRM', note: specNote, evidence: [] };
  }

  return {
    activity: asText(sortie.activity, 160),
    sectors: Array.isArray(sortie.sectors) ? (sortie.sectors as unknown[]).map((s) => asText(s, 40)).filter(Boolean).slice(0, 6) : [],
    criteria,
    specialisation,
  };
}

/**
 * Les marques concurrentes, cherchées mot entier dans les passages.
 *
 * Déterministe : une marque du brief citée sur une page est une citation,
 * pas une opinion. Le nom doit faire au moins trois caractères et se lire
 * comme un mot entier — « Ishida » ne se cache pas dans un autre mot.
 */
export function scanCompetitors(catalogue: BlockCatalogue, competitors: readonly string[]): CompetitorHit[] {
  const hits: CompetitorHit[] = [];
  const vus = new Set<string>();
  for (const brut of competitors) {
    const nom = brut.trim();
    if (nom.length < 3) continue;
    const motif = new RegExp(`(?:^|[^\\p{L}\\p{N}])${nom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');
    for (const [url, blocs] of catalogue.blocksByUrl) {
      for (const b of blocs) {
        if (!motif.test(b.text)) continue;
        const cle = `${nom.toLowerCase()}|${url}`;
        if (vus.has(cle)) continue;
        vus.add(cle);
        hits.push({ competitor: nom, quote: b.text.slice(0, 240), sourceUrl: url });
        break;
      }
    }
  }
  return hits;
}

export interface CandidateDecision {
  outcome: 'RETAINED' | 'REVIEW_REQUIRED' | 'EXCLUDED';
  category: ExclusionCategory | null;
  reason: string;
  /** Les critères qui restent à confirmer par un humain ou le client. */
  toConfirm: string[];
}

/**
 * Ce qu'on fait du candidat, à partir des verdicts et de rien d'autre.
 *
 * L'ordre importe : une marque concurrente écarte avant tout ; un critère
 * d'exclusion établi ensuite ; un critère requis contredit par les pages
 * écarte ; un généraliste établi est mis en revue si le client préfère un
 * spécialiste. Puis : rien d'établi n'est pas un dossier, c'est une revue.
 * Et ce qui reste est retenu — avec ses points à confirmer nommés, jamais
 * effacés.
 *
 * Le contredit passe avant le généraliste depuis le premier lot réel : sept
 * sociétés y sont sorties « généraliste à revoir » alors que chacun de leurs
 * critères requis était contredit, citation à l'appui — un bureau d'études,
 * une autorité publique, un grossiste agricole. La revue relisait ce que la
 * page avait tranché.
 */
export function decideCandidate(input: {
  criteria: readonly CriterionResult[];
  specialisation: SpecialisationResult;
  competitors: readonly CompetitorHit[];
  preferSpecialist: boolean;
  countryStatus: 'IN_SCOPE' | 'OUT_OF_SCOPE' | 'NEEDS_VERIFICATION';
}): CandidateDecision {
  const toConfirm = input.criteria.filter((c) => c.verdict === 'TO_CONFIRM').map((c) => c.key);
  if (input.specialisation.verdict === 'TO_CONFIRM') toConfirm.push('specialisation');
  if (input.countryStatus === 'NEEDS_VERIFICATION') toConfirm.push('pays');

  if (input.countryStatus === 'OUT_OF_SCOPE') {
    return { outcome: 'EXCLUDED', category: 'WRONG_COUNTRY', reason: 'pays prouvé hors du marché visé', toConfirm };
  }
  if (input.competitors.length > 0) {
    const noms = [...new Set(input.competitors.map((h) => h.competitor))].join(', ');
    return { outcome: 'EXCLUDED', category: 'COMPETITOR', reason: `cite une marque concurrente : ${noms}`, toConfirm };
  }
  const exclu = input.criteria.find((c) => c.verdict === 'EXCLUDED');
  if (exclu) {
    return { outcome: 'EXCLUDED', category: 'EXCLUSION_CRITERION', reason: `${exclu.label} — ${exclu.note}`, toConfirm };
  }
  /*
   * Un généraliste établi est signalé, pas écarté d'office. Sur solserv.se le
   * modèle a lu SPECIALIST un jour et GENERALIST le lendemain, sur des pages
   * différentes : une lecture qui varie ne peut pas exclure seule. La société
   * reste visible, marquée TOO_GENERAL avec sa citation, et l'humain tranche —
   * un mot d'ajustement l'écarte s'il le faut.
   */
  const contredit = input.criteria.find((c) => c.kind === 'required' && c.verdict === 'NOT_ESTABLISHED');
  if (contredit) {
    return { outcome: 'EXCLUDED', category: 'LOW_RELEVANCE', reason: `${contredit.label} — ${contredit.note}`, toConfirm };
  }
  if (input.preferSpecialist && input.specialisation.verdict === 'GENERALIST') {
    return { outcome: 'REVIEW_REQUIRED', category: 'TOO_GENERAL', reason: input.specialisation.note || 'catalogue généraliste', toConfirm: [...toConfirm, 'spécialisation (généraliste selon les pages lues)'] };
  }
  const requisEtablis = input.criteria.filter((c) => c.kind === 'required' && c.verdict === 'ESTABLISHED').length;
  if (requisEtablis === 0) {
    return {
      outcome: 'REVIEW_REQUIRED', category: 'INSUFFICIENT_EVIDENCE',
      reason: 'aucun critère requis établi sur les pages lues', toConfirm,
    };
  }
  const requisAConfirmer = input.criteria.some((c) => c.kind === 'required' && c.verdict === 'TO_CONFIRM');
  if (requisAConfirmer || input.countryStatus === 'NEEDS_VERIFICATION') {
    return { outcome: 'REVIEW_REQUIRED', category: null, reason: `à confirmer : ${toConfirm.join(', ')}`, toConfirm };
  }
  return { outcome: 'RETAINED', category: null, reason: `${requisEtablis} critère(s) requis établi(s)`, toConfirm };
}

export interface CriteriaScore {
  total: number;
  confidence: number;
  components: Array<{
    dimension: string; label: string; value: number; weight: number; contribution: number;
    rationale: string; confidence: number; evidenceQuotes: string[];
  }>;
}

/**
 * Une note déterministe, lisible, sans modèle.
 *
 * 70 points pour les critères requis, 30 pour les préférés, au prorata des
 * poids établis. Un critère à confirmer vaut zéro — pas la moitié : une note
 * qui compterait ce qu'on ne sait pas serait une note inventée. La confiance
 * dit, séparément, quelle part des critères a pu être tranchée.
 */
export function scoreCriteria(criteria: readonly CriterionResult[]): CriteriaScore {
  const part = (kind: 'required' | 'preferred'): number => {
    const liste = criteria.filter((c) => c.kind === kind);
    const total = liste.reduce((s, c) => s + c.weight, 0);
    if (total === 0) return kind === 'required' ? 0 : 1;
    const etabli = liste.filter((c) => c.verdict === 'ESTABLISHED').reduce((s, c) => s + c.weight, 0);
    return etabli / total;
  };
  const requis = part('required');
  const preferes = part('preferred');
  const aPreferes = criteria.some((c) => c.kind === 'preferred');
  const total = Math.round(aPreferes ? requis * 70 + preferes * 30 : requis * 100);
  const tranches = criteria.filter((c) => c.verdict !== 'TO_CONFIRM').length;
  const confidence = criteria.length === 0 ? 0 : Math.round((tranches / criteria.length) * 100) / 100;

  const components = criteria.filter((c) => c.kind !== 'exclusion').map((c) => {
    const value = c.verdict === 'ESTABLISHED' ? 100 : 0;
    return {
      dimension: c.key, label: c.label, value, weight: c.weight,
      contribution: Math.round(value * c.weight) / 100,
      rationale: c.verdict === 'TO_CONFIRM' ? `À confirmer — ${c.note || 'les pages n’en parlent pas'}` : c.note,
      confidence: c.verdict === 'TO_CONFIRM' ? 0 : 1,
      evidenceQuotes: c.evidence.map((e) => e.evidenceQuote),
    };
  });
  return { total, confidence, components };
}

export type { ClientCriterion };
