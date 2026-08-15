import { AtlasError, describeError, nowIso, withDeadline } from '@atlas/core';
import type { LlmProvider } from '@atlas/llm';
import { textOf, totalTokens, userText } from '@atlas/llm';
import type {
  Availability,
  DiscoveredCandidate,
  SearchOutcome,
  DiscoveryProvider,
  DiscoveryProviderContext,
  DiscoveryQuery,
  ProviderResult,
} from './types.ts';

/**
 * Découverte par recherche web réelle.
 *
 * S'appuie sur la recherche web exécutée côté fournisseur d'inférence : ATLAS
 * ne scrape rien, ne contourne aucune protection, et ne consulte que ce qu'un
 * moteur de recherche rend publiquement disponible.
 *
 * Le point important est la contrainte imposée au modèle : il ne rend que des
 * organisations effectivement rencontrées dans les résultats de recherche, avec
 * l'URL où il les a vues. Une entreprise « connue de mémoire » est refusée à
 * l'entrée, parce qu'une shortlist commerciale ne peut pas reposer sur des
 * souvenirs de modèle.
 */
export class WebSearchDiscoveryProvider implements DiscoveryProvider {
  readonly key = 'web-search';
  readonly label = 'Recherche web';
  readonly kind = 'web-search' as const;
  readonly synthetic = false;

  constructor(
    private readonly provider: LlmProvider,
    private readonly options: { model: string; maxTokens: number },
  ) {}

  availability(): Availability {
    if (this.provider.kind !== 'anthropic') {
      return {
        available: false,
        reason:
          "La recherche web réelle exige un fournisseur d'inférence en ligne. " +
          'Renseignez ANTHROPIC_API_KEY pour l\'activer.',
      };
    }
    return { available: true, reason: 'Recherche web côté fournisseur, sources citées.' };
  }

  async search(query: DiscoveryQuery, ctx: DiscoveryProviderContext): Promise<ProviderResult> {
    const retrievedAt = nowIso();

    try {
      // Borne dure sur un appel qui sort d'ATLAS. LIVE #002 : cet appel précis
      // est resté en vol 1 284 secondes, sans qu'aucun délai ne le borde, et a
      // figé la mission entière.
      const response = await withDeadline(
        (signal) =>
          this.provider.complete({
            model: this.options.model,
            system: SYSTEM_PROMPT,
            messages: [userText(renderQuery(query))],
            serverTools: ['web_search', 'web_fetch'],
            // L'effort suit l'objectif : chercher largement pour ne rendre que
            // deux candidats se paie sans améliorer les deux retenus.
            serverToolLimits: {
              webSearch: ctx.limits?.maxSearches,
              webFetch: ctx.limits?.maxFetches,
            },
            maxTokens: this.options.maxTokens,
            effort: 'high',
            jsonSchema: RESULT_SCHEMA,
            meta: {
              missionId: ctx.missionId ?? null,
              taskRef: ctx.taskRef ?? null,
              agentKey: ctx.agentKey ?? null,
              purpose: 'discovery-search',
            },
            signal,
          }),
        {
          ms: ctx.timeoutMs ?? 0,
          label: 'recherche web',
          signal: ctx.signal,
          onOrphan: (label) =>
            ctx.logger.error("un appel externe n'a pas honoré son annulation", { label }),
        },
      );

      if (response.refusal) {
        return {
          candidates: [],
          notes: [`Le modèle a décliné la recherche (${response.refusal.category ?? 'non précisé'}).`],
          tokensUsed: totalTokens(response.usage),
          outcome: 'provider-failure',
        };
      }

      const parsed = safeJson<RawResult>(textOf(response.content));
      if (!parsed) {
        return {
          candidates: [],
          notes: ['La réponse de recherche était illisible.'],
          tokensUsed: totalTokens(response.usage),
          outcome: 'provider-failure',
        };
      }

      const requested = new Set(query.targetTypes.map((t) => t.key));
      const candidates: DiscoveredCandidate[] = [];
      let unsourced = 0;

      for (const raw of parsed.companies ?? []) {
        // Sans URL constatée, ce n'est pas une découverte : c'est un souvenir.
        // On préfère une liste courte et vérifiable à une liste longue et fausse.
        if (!raw.sourceUrl?.trim()) {
          unsourced++;
          continue;
        }
        candidates.push({
          name: raw.name.trim(),
          website: raw.website?.trim() || null,
          country: raw.country?.trim() || null,
          region: raw.region?.trim() || null,
          city: raw.city?.trim() || null,
          description: raw.description?.trim() || null,
          industries: raw.industries ?? [],
          relevance: raw.relevance?.trim() || null,
          // Seuls les rôles réellement demandés sont retenus : le modèle ne peut
          // pas inventer un rôle que le département ne traite pas.
          roles: (raw.roles ?? []).filter((role) => requested.has(role)),
          sources: [
            {
              kind: raw.sourceKind === 'company-website' ? 'company-website' : 'directory',
              ref: raw.sourceUrl.trim(),
              title: raw.sourceTitle?.trim() || null,
              retrievedAt,
              provider: this.key,
            },
          ],
          confidence: clamp(raw.confidence ?? 0.5),
        });
      }

      const notes = [...(parsed.notes ?? [])];
      if (unsourced > 0) {
        notes.push(
          `${unsourced} organisation(s) écartée(s) : aucune URL de source n'était citée.`,
        );
      }
      if (candidates.length < query.limit) {
        notes.push(
          `${candidates.length} candidat(s) documenté(s) trouvé(s) pour ${query.limit} demandé(s). ` +
            'La liste n\'a pas été complétée artificiellement.',
        );
      }

      return {
        candidates,
        notes,
        tokensUsed: totalTokens(response.usage),
        // Une recherche qui aboutit sans rien trouver a bien fonctionné : le
        // marché ne contenait rien de documenté, ce n'est pas une panne.
        outcome: candidates.length > 0 ? 'success-with-results' : 'success-empty',
      };
    } catch (err) {
      ctx.logger.warn('la recherche web a échoué', { error: describeError(err) });
      return {
        candidates: [],
        notes: [`La recherche web a échoué : ${describeError(err)}`],
        tokensUsed: 0,
        outcome: classifyFailure(err),
      };
    }
  }
}

/**
 * Traduit une panne en issue de recherche.
 *
 * La distinction porte : un délai dépassé se corrige en desserrant une borne,
 * un refus budgétaire en ajustant un plafond, un rejet du fournisseur en
 * réparant la requête. Les confondre sous « échec » obligerait à relire les
 * journaux à chaque fois — ce qu'il a fallu faire pour LIVE #003.
 */
function classifyFailure(err: unknown): SearchOutcome {
  if (err instanceof AtlasError) {
    if (err.code === 'TIMEOUT') return 'timeout';
    if (err.code === 'BUDGET_EXCEEDED') return 'budget-cancelled';
  }
  return 'provider-failure';
}

const SYSTEM_PROMPT = [
  "Vous êtes le moteur de découverte d'entreprises d'ATLAS. Vous cherchez des organisations réelles.",
  '',
  'Règles absolues :',
  "- N'utilisez que la recherche web. Ne rendez aucune entreprise que vous n'avez pas vue dans un résultat de recherche.",
  "- Chaque entreprise doit être accompagnée de l'URL exacte où vous l'avez rencontrée.",
  "- N'inventez jamais un nom, un site, une ville ou un chiffre. Une case que vous ne pouvez pas remplir reste vide.",
  '- Ne complétez pas la liste pour atteindre le nombre demandé. Sept entreprises documentées valent mieux que vingt dont treize sont inventées.',
  '- Écartez les annuaires, places de marché, comparateurs et agrégateurs : ce sont des sources, pas des candidats.',
  "- Écartez ce qui ne correspond à aucun des rôles demandés, ou au mauvais pays.",
  "- Une organisation peut correspondre à plusieurs rôles à la fois : dites lesquels, sans en inventer.",
  '',
  'Vous rendez un constat de recherche, pas une opinion : la qualification viendra ensuite.',
].join('\n');

/**
 * Le schéma de retour de la recherche.
 *
 * Uniquement des mots-clés structurels : `output_config.format` rejette les
 * contraintes de taille, et un seul `maxItems` a suffi à faire échouer toutes
 * les recherches de LIVE #001 en 400, avant même la moindre inférence. Les
 * bornes qui comptaient sont passées en `description`, où elles guident le
 * modèle au lieu de faire rejeter la requête.
 */
const RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    companies: {
      type: 'array',
      description: 'Au plus 40 organisations, toutes réellement rencontrées en recherche.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "Raison sociale telle qu'affichée" },
          website: { type: 'string', description: 'Site officiel si visible' },
          country: { type: 'string' },
          region: { type: 'string' },
          city: { type: 'string' },
          description: { type: 'string', description: "Ce que fait l'entreprise, en deux phrases" },
          industries: {
            type: 'array',
            items: { type: 'string' },
            description: 'Cinq secteurs au plus',
          },
          relevance: {
            type: 'string',
            description: 'Pourquoi cette organisation correspond au profil recherché',
          },
          roles: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Les rôles recherchés auxquels cette organisation correspond, parmi ceux listés dans la demande. Plusieurs sont possibles pour une même entreprise.",
          },
          sourceUrl: {
            type: 'string',
            description: "URL exacte où vous avez vu cette entreprise. Obligatoire.",
          },
          sourceTitle: { type: 'string' },
          sourceKind: {
            type: 'string',
            enum: ['company-website', 'directory', 'press', 'registry'],
          },
          confidence: { type: 'number', description: 'Entre 0 et 1' },
        },
        required: ['name', 'sourceUrl', 'sourceKind', 'confidence', 'roles'],
        additionalProperties: false,
      },
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
      description:
        "Six notes au plus : couverture obtenue, limites rencontrées, ce que vous n'avez pas pu vérifier",
    },
  },
  required: ['companies', 'notes'],
  additionalProperties: false,
};

function renderQuery(query: DiscoveryQuery): string {
  const lines = [
    `# Recherche`,
    'Rôles recherchés (une même organisation peut correspondre à plusieurs) :',
    ...query.targetTypes.map((t) => `  - ${t.key} (${t.label}) : ${t.description}`),
    `Pays : ${list(query.countries)}`,
    `Secteurs des clients finaux : ${list(query.industries)}`,
  ];
  if (query.keywords.length) lines.push(`Mots-clés : ${list(query.keywords)}`);
  if (query.clientOffering) lines.push(`Ce que vend le client : ${query.clientOffering}`);
  if (query.exclusions.length) lines.push(`Disqualifiant : ${list(query.exclusions)}`);
  lines.push(
    '',
    `Objectif : jusqu'à ${query.limit} organisations réelles et documentées.`,
    'Cherchez, vérifiez, puis rendez le résultat. Chaque entrée porte son URL de source',
    "et la liste des rôles auxquels elle correspond réellement. N'attribuez un rôle que si ce que vous avez lu le montre.",
  );
  return lines.join('\n');
}

interface RawResult {
  companies?: Array<{
    name: string;
    website?: string;
    country?: string;
    region?: string;
    city?: string;
    description?: string;
    industries?: string[];
    relevance?: string;
    roles?: string[];
    sourceUrl?: string;
    sourceTitle?: string;
    sourceKind?: string;
    confidence?: number;
  }>;
  notes?: string[];
}

const list = (values: string[]): string => (values.length ? values.join(', ') : 'non précisé');
const clamp = (n: number): number => Math.max(0, Math.min(1, n));

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}
