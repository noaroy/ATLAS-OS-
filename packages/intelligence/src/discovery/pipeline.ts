import { describeError, nowIso, withDeadline } from '@atlas/core';
import type { LlmProvider } from '@atlas/llm';
import { textOf, totalTokens, userText } from '@atlas/llm';
import { fetchPages } from '../search/fetcher.ts';
import { filterResults, fetchTargetsFor, type SearchCandidate } from '../search/filter.ts';
import { planQueries } from '../search/planner.ts';
import type { SearchProvider, SearchResult } from '../search/types.ts';
import type {
  Availability,
  DiscoveredCandidate,
  DiscoveryProvider,
  DiscoveryProviderContext,
  DiscoveryQuery,
  ProviderResult,
  SearchOutcome,
} from './types.ts';

/**
 * La découverte comme chaîne, non comme un seul acte de raisonnement.
 *
 * ```
 * brief → requêtes courtes → moteur → filtrage déterministe
 *       → pages ciblées → Claude analyse les survivants
 * ```
 *
 * L'ancienne architecture confiait tout cela à un unique appel LLM : chercher,
 * filtrer, qualifier, structurer. Trois missions consécutives l'ont vu expirer
 * à 120 s, 180 s puis 420 s — le mur reculait à chaque fois qu'on le déplaçait,
 * ce qui signifie que la tâche ne convergeait pas.
 *
 * Ici, chaque maillon fait une chose et la fait vite. Le moteur répond en
 * quelques centaines de millisecondes. Le filtrage est du code. Le modèle
 * n'intervient qu'à la fin, sur quatre à six candidats déjà identifiés, avec
 * une seule question : **lesquels méritent d'entrer dans le pipeline, et
 * qu'est-ce que les sources en disent réellement ?**
 */

export interface PipelineOptions {
  /** Le modèle qui analyse les survivants — jamais celui qui cherche. */
  model: string;
  maxTokens: number;
  /** Requêtes au maximum. Quatre suffisent pour deux candidats. */
  maxQueries: number;
  /** Résultats demandés par requête. */
  resultsPerQuery: number;
  /** Candidats transmis au modèle après filtrage. */
  maxCandidates: number;
  /** Pages récupérées par candidat. */
  maxFetchesPerCandidate: number;
  /** Caractères conservés par page. */
  maxCharsPerPage: number;
  /** Borne d'un appel au moteur. */
  searchTimeoutMs: number;
  /** Borne d'une récupération de page. */
  fetchTimeoutMs: number;
}

export interface PipelineCost {
  /** Ce que le moteur de recherche a facturé. */
  searchApiCostUsd: number;
  queriesRun: number;
  rawResults: number;
  pagesFetched: number;
}

export class PipelineDiscoveryProvider implements DiscoveryProvider {
  readonly key = 'search-pipeline';
  readonly label = 'Recherche web (moteur + analyse)';
  readonly kind = 'web-search' as const;
  readonly synthetic = false;

  /** Le coût moteur de la dernière exécution, lu par le service. */
  lastCost: PipelineCost = {
    searchApiCostUsd: 0,
    queriesRun: 0,
    rawResults: 0,
    pagesFetched: 0,
  };

  constructor(
    /** Le moteur de recherche. Nommé `engine` pour ne pas masquer `search()`. */
    private readonly engine: SearchProvider,
    private readonly llm: LlmProvider,
    private readonly options: PipelineOptions,
  ) {}

  availability(): Availability {
    const engine = this.engine.availability();
    if (!engine.available) return { available: false, reason: engine.reason };
    if (this.llm.kind !== 'anthropic') {
      return {
        available: false,
        reason: "L'analyse des candidats exige un fournisseur d'inférence en ligne.",
      };
    }
    return {
      available: true,
      reason: `${this.engine.label} pour la recherche, analyse des candidats par le modèle.`,
    };
  }

  async search(query: DiscoveryQuery, ctx: DiscoveryProviderContext): Promise<ProviderResult> {
    this.lastCost = { searchApiCostUsd: 0, queriesRun: 0, rawResults: 0, pagesFetched: 0 };
    const notes: string[] = [];

    // ── 1. Planifier ────────────────────────────────────────────────────────
    // Déterministe : le brief contient déjà les rôles, le pays et les secteurs.
    // Les recombiner est un travail de chaînes de caractères, pas un
    // raisonnement — c'est reproductible, gratuit et instantané.
    const planned = planQueries(query, { maxQueries: this.options.maxQueries });
    if (planned.length === 0) {
      return empty('success-empty', ['Aucune requête exploitable ne se déduit du brief.'], 0);
    }
    notes.push(`${planned.length} recherche(s) : ${planned.map((p) => `« ${p.query} »`).join(', ')}`);

    // ── 2. Chercher ─────────────────────────────────────────────────────────
    const raw: SearchResult[] = [];
    let searchFailures = 0;
    for (const plan of planned) {
      const response = await this.engine.search(
        {
          query: plan.query,
          country: plan.country,
          language: plan.language,
          count: this.options.resultsPerQuery,
        },
        { logger: ctx.logger, timeoutMs: this.options.searchTimeoutMs, signal: ctx.signal },
      );

      this.lastCost.queriesRun++;
      this.lastCost.searchApiCostUsd += response.costUsd;

      if (response.outcome === 'ok') {
        raw.push(...response.results);
      } else {
        // `empty` est une recherche qui a *abouti* sans rien trouver : c'est un
        // constat de marché, pas une panne. Les confondre ferait remonter
        // « recherche impossible » là où le moteur a parfaitement fonctionné —
        // exactement la confusion que la taxonomie sert à éviter.
        if (response.outcome !== 'empty') searchFailures++;
        notes.push(`« ${plan.query} » → ${response.outcome} : ${response.detail}`);
      }
    }
    this.lastCost.rawResults = raw.length;

    if (raw.length === 0) {
      // Une panne de moteur et un marché vide ne se corrigent pas pareil.
      // Une panne n'est rapportée que si *aucune* requête n'a pu aboutir.
      const outcome: SearchOutcome = searchFailures > 0 ? 'provider-failure' : 'success-empty';
      notes.push(
        outcome === 'provider-failure'
          ? "Aucune requête n'a abouti : la recherche n'a pas pu avoir lieu."
          : 'Les recherches ont abouti sans rendre de résultat exploitable.',
      );
      return empty(outcome, notes, 0);
    }

    // ── 3. Filtrer ──────────────────────────────────────────────────────────
    // Regrouper par domaine, écarter annuaires et réseaux sociaux, appliquer
    // les exclusions du brief. Entièrement mécanique, donc gratuit.
    const filtered = filterResults(raw, {
      exclusions: query.exclusions,
      maxCandidates: this.options.maxCandidates,
    });
    notes.push(
      `${filtered.seen} résultat(s) bruts → ${filtered.candidates.length} candidat(s) après filtrage ` +
        `(${filtered.grouped} regroupé(s) par domaine, ${filtered.rejected.length} écarté(s)).`,
    );

    if (filtered.candidates.length === 0) {
      return empty('success-empty', notes, this.lastCost.searchApiCostUsd);
    }

    // ── 4. Récupérer, de façon ciblée ───────────────────────────────────────
    const dossiers: CandidateDossier[] = [];
    for (const candidate of filtered.candidates) {
      const targets = fetchTargetsFor(candidate, this.options.maxFetchesPerCandidate);
      const fetched = await fetchPages(targets, {
        logger: ctx.logger,
        timeoutMs: this.options.fetchTimeoutMs,
        maxCharsPerPage: this.options.maxCharsPerPage,
        signal: ctx.signal,
      });
      this.lastCost.pagesFetched += fetched.pages.length;
      dossiers.push({ candidate, pages: fetched.pages });
    }

    // ── 5. Analyser ─────────────────────────────────────────────────────────
    // Un seul appel, sur un contexte borné, avec une question précise.
    try {
      const analysed = await this.#analyse(query, dossiers, ctx);
      notes.push(
        `${analysed.length} candidat(s) retenu(s) par l'analyse sur ${dossiers.length} examiné(s).`,
      );
      return {
        candidates: analysed,
        notes,
        tokensUsed: this.lastAnalysisTokens,
        outcome: analysed.length > 0 ? 'success-with-results' : 'success-empty',
        externalCostUsd: this.lastCost.searchApiCostUsd,
      };
    } catch (err) {
      ctx.logger.warn("l'analyse des candidats a échoué", { error: describeError(err) });
      notes.push(`Analyse impossible : ${describeError(err)}`);
      return {
        candidates: [],
        notes,
        tokensUsed: this.lastAnalysisTokens,
        outcome: 'provider-failure',
        externalCostUsd: this.lastCost.searchApiCostUsd,
      };
    }
  }

  private lastAnalysisTokens = 0;

  /**
   * Le modèle en analyste, non en moteur.
   *
   * Il reçoit le brief et des dossiers déjà constitués — nom probable, URLs,
   * extraits de recherche, contenu des pages — et répond à une seule question.
   * Il ne cherche pas, ne complète pas, ne suppose pas : ce qui n'est pas dans
   * les sources fournies n'existe pas.
   */
  async #analyse(
    query: DiscoveryQuery,
    dossiers: CandidateDossier[],
    ctx: DiscoveryProviderContext,
  ): Promise<DiscoveredCandidate[]> {
    const retrievedAt = nowIso();

    const response = await withDeadline(
      (signal) =>
        this.llm.complete({
          model: this.options.model,
          system: ANALYSIS_PROMPT,
          messages: [userText(renderDossiers(query, dossiers))],
          maxTokens: this.options.maxTokens,
          effort: 'medium',
          jsonSchema: ANALYSIS_SCHEMA,
          // Les blocs stables — consignes, règles de provenance — sont
          // identiques d'un appel à l'autre : le cache les rend presque
          // gratuits dès la deuxième mission.
          cacheSystemPrompt: true,
          meta: {
            missionId: ctx.missionId ?? null,
            taskRef: ctx.taskRef ?? null,
            agentKey: ctx.agentKey ?? null,
            purpose: 'discovery-analysis',
          },
          signal,
        }),
      {
        ms: ctx.timeoutMs ?? 0,
        label: 'analyse des candidats',
        signal: ctx.signal,
      },
    );

    this.lastAnalysisTokens = totalTokens(response.usage);
    if (response.refusal) return [];

    const parsed = safeJson<{ companies?: RawAnalysed[] }>(textOf(response.content));
    if (!parsed) return [];

    const requested = new Set(query.targetTypes.map((t) => t.key));
    const byDomain = new Map(dossiers.map((d) => [d.candidate.domain, d]));
    const out: DiscoveredCandidate[] = [];

    for (const item of parsed.companies ?? []) {
      if (!item.relevant) continue;
      const dossier = byDomain.get((item.domain ?? '').trim().toLowerCase());
      // Le modèle ne peut pas introduire un domaine que la recherche n'a pas
      // rendu : c'est la garantie qu'aucune entreprise n'est inventée.
      if (!dossier) continue;

      out.push({
        name: (item.name ?? dossier.candidate.likelyName).trim(),
        website: dossier.candidate.primaryUrl,
        country: item.country?.trim() || null,
        region: null,
        city: item.city?.trim() || null,
        description: item.description?.trim() || null,
        industries: item.industries ?? [],
        relevance: item.relevance?.trim() || null,
        roles: (item.roles ?? []).filter((role) => requested.has(role)),
        // La provenance vient de la recherche, pas du modèle : chaque source
        // est une URL réellement rendue par le moteur.
        sources: dossier.candidate.results.slice(0, 4).map((r) => ({
          kind: 'directory' as const,
          ref: r.url,
          title: r.title || null,
          retrievedAt: r.retrievedAt || retrievedAt,
          provider: r.provider,
        })),
        confidence: clamp(item.confidence ?? 0.5),
      });
    }
    return out;
  }
}

interface CandidateDossier {
  candidate: SearchCandidate;
  pages: Array<{ url: string; title: string | null; text: string }>;
}

interface RawAnalysed {
  domain?: string;
  name?: string;
  relevant?: boolean;
  country?: string;
  city?: string;
  description?: string;
  industries?: string[];
  relevance?: string;
  roles?: string[];
  confidence?: number;
}

const ANALYSIS_PROMPT = [
  "Vous êtes l'analyste de découverte d'ATLAS. On vous remet des dossiers déjà constitués : une organisation par domaine, avec les extraits de recherche et le contenu des pages effectivement récupérées.",
  '',
  'Votre seule question : cette organisation mérite-t-elle que le pipeline commercial s’en occupe ?',
  '',
  'Règles absolues :',
  "- Ne jugez QUE sur les sources fournies. Ce qui n'y figure pas n'existe pas.",
  "- N'ajoutez aucune organisation : vous ne pouvez retenir que les domaines présents dans les dossiers.",
  "- N'inventez ni ville, ni chiffre, ni activité. Une case que les sources ne remplissent pas reste vide.",
  '- Écartez les annuaires, places de marché et agrégateurs : ce sont des sources, pas des candidats.',
  "- Écartez ce qui ne correspond à aucun rôle demandé, ou au mauvais pays.",
  '- Une organisation peut correspondre à plusieurs rôles : dites lesquels, sans en inventer.',
  '- Mieux vaut retenir deux organisations solides que six douteuses.',
  '',
  "Vous rendez un tri motivé, pas une qualification complète : la qualification, le score et les contacts viendront après, à d'autres étapes.",
].join('\n');

const ANALYSIS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    companies: {
      type: 'array',
      description: 'Un objet par dossier reçu, dans le même ordre.',
      items: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Le domaine du dossier, recopié tel quel' },
          relevant: { type: 'boolean', description: 'Vrai si cette organisation mérite le pipeline' },
          name: { type: 'string', description: 'Raison sociale telle que les sources l’écrivent' },
          country: { type: 'string' },
          city: { type: 'string' },
          description: { type: 'string', description: "Ce que fait l'organisation, d'après les sources" },
          industries: { type: 'array', items: { type: 'string' } },
          relevance: { type: 'string', description: 'Pourquoi elle correspond, ou pourquoi non' },
          roles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Les rôles demandés auxquels elle correspond',
          },
          confidence: { type: 'number', description: 'Entre 0 et 1' },
        },
        required: ['domain', 'relevant'],
        additionalProperties: false,
      },
    },
  },
  required: ['companies'],
  additionalProperties: false,
};

/** Le dossier tel que le modèle le lit. Compact par construction. */
function renderDossiers(query: DiscoveryQuery, dossiers: CandidateDossier[]): string {
  const lines: string[] = [
    '# Ce que nous cherchons',
    `Rôles : ${query.targetTypes.map((t) => `${t.key} (${t.label})`).join(', ')}`,
    `Pays : ${query.countries.join(', ') || 'non précisé'}`,
    query.industries.length ? `Secteurs des clients finaux : ${query.industries.join(', ')}` : '',
    query.clientOffering ? `Ce que vend notre client : ${query.clientOffering}` : '',
    query.exclusions.length ? `Disqualifiant : ${query.exclusions.join(' ; ')}` : '',
    '',
    `# Dossiers (${dossiers.length})`,
  ].filter(Boolean);

  for (const { candidate, pages } of dossiers) {
    lines.push(
      '',
      `## ${candidate.domain}`,
      `Nom probable : ${candidate.likelyName}`,
      `URL principale : ${candidate.primaryUrl}`,
      `Trouvé par ${candidate.queryHits} recherche(s), meilleur rang ${candidate.bestRank}.`,
      '',
      'Extraits de recherche :',
      ...candidate.results.slice(0, 3).map((r) => `- ${r.title} — ${r.snippet.slice(0, 240)}`),
    );

    if (pages.length === 0) {
      lines.push('', 'Aucune page n’a pu être récupérée pour ce domaine.');
      continue;
    }
    for (const page of pages) {
      lines.push('', `Page ${page.url}${page.title ? ` — ${page.title}` : ''} :`, page.text);
    }
  }

  lines.push('', 'Rendez votre tri maintenant, un objet par dossier.');
  return lines.join('\n');
}

const empty = (outcome: SearchOutcome, notes: string[], costUsd: number): ProviderResult => ({
  candidates: [],
  notes,
  tokensUsed: 0,
  outcome,
  externalCostUsd: costUsd,
});

const clamp = (n: number): number => Math.max(0, Math.min(1, n));

function safeJson<T>(text: string): T | null {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
