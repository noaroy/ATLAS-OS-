import type { AgentDefinition, MissionArtifact, MissionTask, Mission } from '@atlas/contracts';
import type { AtlasConfig, EventBus, Logger } from '@atlas/core';
import { AtlasError, withDeadline, describeError } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import type { MemoryService } from '@atlas/memory';
import type { LlmMessage, LlmProvider, LlmContent, LlmServerTool } from '@atlas/llm';
import { textOf, toolCallsOf, totalTokens } from '@atlas/llm';
import type { DiscoveryService, OpportunityService } from '@atlas/intelligence';
import type { AutomationGateway, ToolContext } from './tool-types.ts';
import type { ToolRegistry } from './tools.ts';

/**
 * What the agent is doing right now.
 *
 * The runtime is the only place that knows this, so it reports it rather than
 * letting the orchestrator guess — which is what keeps the village's agent
 * states honest instead of decorative.
 */
export type AgentPhase = 'working' | 'analyzing';

export interface AgentRunInput {
  agent: AgentDefinition;
  mission: Mission;
  task: MissionTask;
  /** Outputs of the steps this task depends on, keyed by step ref. */
  upstream: Record<string, unknown>;
  /** Upstream steps that produced nothing — never to be redone by this agent. */
  upstreamFailures?: Array<{ ref: string; title: string; status: string; error: string | null }>;
  signal?: AbortSignal;
  /** Called whenever the agent moves between working and reasoning. */
  onPhase?: (phase: AgentPhase) => void;
}

export interface AgentRunResult {
  summary: string;
  output: Record<string, unknown>;
  artifacts: MissionArtifact[];
  tokensUsed: number;
  toolCalls: number;
  /**
   * Combien de ces appels ont échoué.
   *
   * Un agent conclut toujours par du texte, y compris quand tous ses outils
   * l'ont refusé — et ce texte dit volontiers que l'étape s'est bien passée.
   * Compter les échecs est le seul moyen de distinguer « j'ai cherché et le
   * marché est vide » de « je n'ai rien pu chercher », sans avoir à interpréter
   * une prose écrite par la partie qui a échoué.
   */
  toolFailures: number;
  durationMs: number;
}

export interface AgentRuntimeDeps {
  provider: LlmProvider;
  registry: ToolRegistry;
  repos: Repositories;
  memory: MemoryService;
  events: EventBus;
  config: AtlasConfig;
  logger: Logger;
  automation: AutomationGateway | null;
  intelligence: OpportunityService | null;
  discovery: DiscoveryService | null;
  /** Resolves the effective model + effort at call time (settings are mutable). */
  resolveModel: () => { agentModel: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
}

/** Skill categories whose work genuinely needs the open web. */
const WEB_RESEARCH_CATEGORIES = new Set(['research']);

/**
 * Combien de fois un agent peut rejouer exactement le même appel d'outil.
 *
 * Trois, parce qu'un deuxième essai est légitime — un service momentanément
 * indisponible répond souvent au coup suivant — mais qu'au troisième échec
 * identique on ne mesure plus qu'un entêtement, facturé au prix du contexte
 * complet à chaque tour.
 */
const MAX_IDENTICAL_TOOL_CALLS = 3;

/** Échecs d'outil consécutifs après lesquels la boucle est close. */
const MAX_CONSECUTIVE_TOOL_FAILURES = 5;

/** Sérialise un objet indépendamment de l'ordre de ses clés. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * Executes one assigned step, as one agent, with that agent's tools.
 *
 * The loop is written explicitly rather than delegated to an SDK helper
 * because every turn must be observable: each tool call becomes an event, a
 * village journey, and a line in the mission audit trail.
 */
export class AgentRuntime {
  #log: Logger;

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.#log = deps.logger.child({ scope: 'agent-runtime' });
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const started = Date.now();
    const { agent, mission, task } = input;
    const { agentModel, effort } = this.deps.resolveModel();

    const toolCtx: ToolContext = {
      missionId: mission.id,
      taskId: task.id,
      // La ref de l'étape voyage avec le contexte : c'est elle qui permet
      // d'imputer chaque coût à une étape lisible, plutôt que « hors étape ».
      taskRef: task.ref,
      departmentKey: mission.departmentKey,
      agentKey: agent.key,
      config: this.deps.config,
      repos: this.deps.repos,
      memory: this.deps.memory,
      events: this.deps.events,
      logger: this.#log.child({ agent: agent.key, task: task.ref }),
      automation: this.deps.automation,
      intelligence: this.deps.intelligence,
      discovery: this.deps.discovery,
      signal: input.signal,
    };

    // The allow-list is derived from the skills the agent declares, so a
    // granted tool always has a declared skill behind it (Article VII).
    const allowedTools = this.deps.repos.agents.toolsFor(agent.key);
    const tools = this.deps.registry.forAgent(allowedTools);
    const serverTools = this.#serverToolsFor(tools);

    const messages: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', text: this.#buildBriefing(input) }] },
    ];

    const artifacts: MissionArtifact[] = [];
    const structured: Record<string, unknown> = {};
    let tokensUsed = 0;
    let toolCalls = 0;
    let toolFailures = 0;
    let summary = '';

    /**
     * Combien de fois chaque appel d'outil identique a été tenté.
     *
     * `maxSteps` borne les tours de boucle, pas l'acharnement : un agent peut
     * relancer le même outil avec les mêmes arguments à chaque tour et payer
     * le contexte entier à chaque fois. LIVE #001 en a donné la version
     * extrême — cinq `http_fetch` tous en échec, et l'agent qui continue.
     */
    const attemptsBySignature = new Map<string, number>();
    let consecutiveToolFailures = 0;
    let stoppedEarly: string | null = null;

    for (let step = 1; step <= agent.maxSteps; step++) {
      if (input.signal?.aborted) throw new AtlasError('TIMEOUT', 'Task cancelled');

      // The first turn is fresh work; every later turn is the agent reasoning
      // over tool results it just received.
      input.onPhase?.(toolCalls === 0 ? 'working' : 'analyzing');

      // `withDeadline` plutôt que `withTimeout` : l'inférence reçoit le signal
      // et s'arrête réellement. La course abandonnait une requête qui
      // continuait de consommer socket, contexte et budget.
      const response = await withDeadline(
        (signal) =>
          this.deps.provider.complete({
            model: agent.model ?? agentModel,
            system: this.#buildSystemPrompt(agent, mission),
            messages,
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
            serverTools,
            serverToolLimits: this.#serverToolLimits(),
            maxTokens: this.deps.config.llm.maxTokens,
            effort,
            simulationHints: this.#simulationHints(mission, task, tools),
            meta: {
              missionId: mission.id,
              taskRef: task.ref,
              agentKey: agent.key,
              purpose: 'agent-step',
            },
            signal,
          }),
        {
          ms: this.deps.config.orchestration.providerTimeoutMs,
          label: `inférence de ${agent.key}`,
          signal: input.signal,
          onOrphan: (label) => this.#log.error("un appel n'a pas honoré son annulation", { label }),
        },
      );

      tokensUsed += totalTokens(response.usage);

      if (response.refusal) {
        throw new AtlasError(
          'PROVIDER_ERROR',
          `Le modèle a décliné cette étape (${response.refusal.category ?? 'motif non précisé'}). ` +
            `Reformulez l'objectif ou réaffectez l'étape.`,
          { retryable: false },
        );
      }

      const text = textOf(response.content);
      if (text) summary = text;

      // A provider-side tool loop paused; resend the turn to let it continue.
      if (response.stopReason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }

      const calls = toolCallsOf(response.content);
      if (calls.length === 0) break;

      messages.push({ role: 'assistant', content: response.content });

      // All results for one assistant turn must go back in a single user
      // message, or the model learns to stop making parallel calls.
      const results: LlmContent[] = [];
      for (const call of calls) {
        toolCalls++;

        // Le même outil, avec exactement les mêmes arguments, au-delà de la
        // limite : le refus est rendu à l'agent comme un résultat d'outil, et
        // non levé en exception. Il garde ainsi la main pour conclure avec ce
        // qu'il a — ce qui est le comportement souhaité — sans pouvoir relancer
        // indéfiniment un appel dont on sait déjà qu'il ne changera rien.
        const signature = `${call.name}:${stableJson(call.input)}`;
        const attempts = (attemptsBySignature.get(signature) ?? 0) + 1;
        attemptsBySignature.set(signature, attempts);
        if (attempts > MAX_IDENTICAL_TOOL_CALLS) {
          results.push({
            type: 'tool_result',
            toolUseId: call.id,
            content:
              `Appel refusé : « ${call.name} » a déjà été invoqué ${MAX_IDENTICAL_TOOL_CALLS} fois ` +
              'avec exactement les mêmes arguments. Le résultat ne changera pas. ' +
              'Concluez avec ce que vous avez, ou changez de méthode.',
            isError: true,
          });
          stoppedEarly = `outil « ${call.name} » répété à l'identique`;
          continue;
        }

        const { result, category } = await this.deps.registry.invoke(
          call.name,
          call.input,
          allowedTools,
          toolCtx,
        );

        this.deps.events.publish({
          type: 'agent.tool',
          severity: result.isError ? 'warning' : 'debug',
          source: agent.key,
          missionId: mission.id,
          agentKey: agent.key,
          message: `${agent.name} used ${call.name}${result.isError ? ' (failed)' : ''}`,
          payload: { tool: call.name, category, taskRef: task.ref, ok: !result.isError },
        });

        if (result.data?.artifact) {
          artifacts.push(result.data.artifact as MissionArtifact);
        }
        if (result.data && !result.isError) {
          structured[`${call.name}#${toolCalls}`] = result.data;
        }

        if (result.isError) toolFailures++;
        consecutiveToolFailures = result.isError ? consecutiveToolFailures + 1 : 0;

        results.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: result.content.slice(0, 24_000),
          isError: result.isError,
        });
      }

      messages.push({ role: 'user', content: results });

      // ── Contexte borné ──────────────────────────────────────────────────
      // Chaque tour rejoue tout ce qui précède. LIVE #005 a produit un appel à
      // 154 000 jetons d'entrée — 0,49 $, 57 % de la mission — parce que trois
      // échecs de recherche et une page récupérée s'étaient accumulés dans
      // l'historique. Le modèle n'a pas besoin des transcriptions : il a besoin
      // de ce qui a été essayé et de ce qui en est ressorti.
      this.#compactIfNeeded(messages, agent);

      // Une panne d'outillage qui se répète ne s'améliore pas en insistant, et
      // chaque tour supplémentaire repaye tout le contexte accumulé. On demande
      // une conclusion plutôt que de laisser la boucle aller à son terme.
      if (consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
        stoppedEarly = `${consecutiveToolFailures} appels d'outil consécutifs en échec`;
      }

      if (stoppedEarly) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `ATLAS interrompt la boucle d'outils (${stoppedEarly}). ` +
                "Donnez votre résultat final maintenant, à partir de ce que vous avez déjà obtenu. " +
                "N'appelez plus aucun outil, et dites explicitement ce que vous n'avez pas pu vérifier.",
            },
          ],
        });
        const closing = await this.deps.provider.complete({
          model: agent.model ?? agentModel,
          system: this.#buildSystemPrompt(agent, mission),
          messages,
          maxTokens: this.deps.config.llm.maxTokens,
          effort,
          meta: {
            missionId: mission.id,
            taskRef: task.ref,
            agentKey: agent.key,
            purpose: 'agent-conclusion',
          },
          signal: input.signal,
        });
        tokensUsed += totalTokens(closing.usage);
        const closingText = textOf(closing.content);
        if (closingText) summary = closingText;
        break;
      }

      if (step === agent.maxSteps) {
        // Out of steps: ask for a conclusion rather than returning a dangling
        // tool call as the result.
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: "Vous avez atteint votre limite d'étapes. Donnez votre résultat final maintenant, à partir de ce que vous avez déjà. N'appelez plus aucun outil.",
            },
          ],
        });
        const final = await this.deps.provider.complete({
          model: agent.model ?? agentModel,
          system: this.#buildSystemPrompt(agent, mission),
          messages,
          maxTokens: this.deps.config.llm.maxTokens,
          effort,
          meta: {
            missionId: mission.id,
            taskRef: task.ref,
            agentKey: agent.key,
            purpose: 'agent-conclusion',
          },
          signal: input.signal,
        });
        tokensUsed += totalTokens(final.usage);
        const finalText = textOf(final.content);
        if (finalText) summary = finalText;
      }
    }

    if (!summary.trim()) {
      throw new AtlasError('PROVIDER_ERROR', `${agent.name} n'a produit aucun résultat pour l'étape ${task.ref}`, {
        retryable: true,
      });
    }

    return {
      summary: summary.trim(),
      output: { summary: summary.trim(), ...structured },
      artifacts,
      tokensUsed,
      toolCalls,
      toolFailures,
      durationMs: Date.now() - started,
    };
  }

  /**
   * Real values a simulated provider can use, so a demonstration exercises the
   * actual pipeline rather than failing on invented identifiers.
   *
   * Built only in simulation, and only from what already exists in the
   * database. In live mode this is empty and the provider ignores it — nothing
   * here can influence what a real model is asked or allowed to do.
   */
  #simulationHints(
    mission: Mission,
    task: MissionTask,
    tools: Array<{ name: string }>,
  ): Record<string, unknown[]> | undefined {
    if (this.deps.provider.kind !== 'simulation' || !mission.departmentKey) return undefined;

    const department = this.deps.repos.departments.get(mission.departmentKey);
    if (!department) return undefined;

    const opportunities = this.deps.repos.opportunities.forMission(mission.id);
    const brief = (
      mission.context as {
        brief?: {
          targetType?: string;
          targetTypes?: string[];
          desiredCount?: number;
          markets?: { countries?: string[]; industries?: string[]; regions?: string[] };
        };
      }
    ).brief;

    const declaredRoles = department.targetTypes.map((t) => t.key);
    // Only roles this department actually handles: `discover_companies` rejects
    // any other, and a rejected call is a step that finds nothing.
    const briefedRoles = (brief?.targetTypes ?? []).filter((key) => declaredRoles.includes(key));

    const hints: Record<string, unknown[]> = {
      // The tools this step's own instruction names. Passed explicitly rather
      // than letting the provider scan the briefing, because the briefing also
      // carries upstream results — and a tool named in a previous step's output
      // is not an instruction to run that step again.
      toolsInInstruction: tools
        .map((tool) => tool.name)
        .filter((name) => task.instruction.includes(name)),
      // Agents may only score the dimensions the department declares, and may
      // not assert the ones ATLAS computes for itself.
      dimension: department.scoringModel.dimensions.filter((d) => !d.computed).map((d) => d.key),
      // Singular and plural both, because tools name the field either way and a
      // hint that misses by one letter silently falls back to invented prose.
      // That is precisely what happened: `discover_companies` takes
      // `targetTypes`, only `targetType` was hinted, and the simulated agent
      // called it with "[simulated] TargetTypes for …" — a role no department
      // declares. The tool refused it, the step found nothing, and the five
      // stages behind it were skipped for want of input.
      targetType: [brief?.targetType ?? briefedRoles[0] ?? declaredRoles[0]].filter(Boolean),
      targetTypes: briefedRoles.length > 0 ? briefedRoles : declaredRoles.slice(0, 3),
    };

    // Geography likewise: `countries` never matched the generator's singular
    // rule, so a market became a sentence restating the objective.
    const countries = brief?.markets?.countries?.filter(Boolean) ?? [];
    if (countries.length > 0) {
      hints.country = countries;
      hints.countries = countries;
    }
    const industries = brief?.markets?.industries?.filter(Boolean) ?? [];
    if (industries.length > 0) {
      hints.industry = industries;
      hints.industries = industries;
    }

    // Combien chercher. Sans cela le plafond est tiré au hasard dans la plage du
    // schéma — une démonstration annonçait « shortlist de 9 » après en avoir
    // découvert 35, ce qui donne d'un entonnoir soigneusement calibré l'image
    // d'une collecte au hasard. Un agent réel lit ce nombre dans son brief ;
    // l'agent simulé doit le lire au même endroit.
    const desired = brief?.desiredCount;
    if (typeof desired === 'number' && desired > 0) {
      hints.limit = [desired];
      hints.desiredCount = [desired];
    }

    // Only candidates a stage can still act on. A rejected one is refused by the
    // tools by design, so offering it to a simulated agent would spend the whole
    // step budget on refusals and prove nothing about the pipeline.
    const eligible = opportunities.filter((o) => o.stage !== 'rejected');
    if (eligible.length > 0) {
      hints.opportunityId = eligible.map((o) => o.id);
    }
    return hints;
  }

  /**
   * Ce que les outils côté fournisseur ont le droit de consommer.
   *
   * Chaque recherche et chaque page rapportée entre dans le contexte, et y
   * reste pour tous les tours suivants : la dépense n'est pas celle de la
   * requête, c'est celle du contexte qu'elle laisse derrière elle. Borner
   * l'exploration est donc le levier le plus direct sur le coût d'une étape.
   */
  #serverToolLimits(): { webSearch: number; webFetch: number } {
    const { web } = this.deps.config;
    return {
      webSearch: web.maxSearchesPerDiscovery,
      webFetch: web.maxFetchesPerCandidate,
    };
  }

  /** Grants provider-side web research only to agents that hold research tools. */
  #serverToolsFor(tools: Array<{ category: string }>): LlmServerTool[] {
    if (this.deps.provider.kind !== 'anthropic') return [];
    const research = tools.some((t) => WEB_RESEARCH_CATEGORIES.has(t.category));
    return research ? ['web_search', 'web_fetch'] : [];
  }

  /**
   * The agent's persona and standing rules.
   *
   * Deliberately short and non-prescriptive: current models follow a system
   * prompt closely, so listing procedures here would fight the specialist
   * judgement each agent is supposed to bring.
   */
  #buildSystemPrompt(agent: AgentDefinition, mission: Mission): string {
    return [
      agent.systemPrompt.trim(),
      '',
      "## Votre place dans ATLAS",
      `Vous êtes ${agent.name}, ${agent.role}, au sein du bâtiment « ${agent.building} » d'ATLAS — une organisation numérique autonome. Hermès, le directeur des opérations, vous a confié une étape d'une mission plus large.`,
      `Votre spécialité : ${agent.mission}`,
      '',
      '## Comment travailler',
      "- Réalisez l'étape qui vous est confiée. Ne prenez pas la place des étapes voisines : d'autres spécialistes les tiennent.",
      '- Cherchez en mémoire avant de rechercher ; consignez le savoir durable que vous trouvez, pas le récit de votre démarche.',
      "- Rapportez fidèlement. Si les preuves sont minces ou l'étape bloquée, dites-le clairement plutôt que de combler le vide.",
      "- Terminez par un résultat autonome, exploitable par l'agent suivant sans relire votre brouillon.",
      this.deps.provider.kind === 'simulation'
        ? "- ATLAS tourne en mode simulation : vous n'avez aucune donnée externe réelle. Produisez un travail correctement structuré et signalez que les constats sont simulés."
        : '',
      '',
      `Mission en cours : ${mission.code} — ${mission.title}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Ramène l'historique sous son plafond, sans perdre ce qui compte.
   *
   * Le briefing initial est conservé intact — il porte l'objectif, sans lui
   * l'agent ne sait plus ce qu'il fait. Les deux derniers échanges le sont
   * aussi : c'est là que se joue le tour en cours. Entre les deux, les
   * résultats d'outils sont remplacés par un relevé compact de ce qui a été
   * tenté et de ce que cela a donné.
   *
   * Un agent n'a pas besoin de relire trois pages web pour se souvenir qu'il
   * les a lues. Il a besoin de savoir qu'il les a lues, et ce qu'il en a tiré.
   */
  #compactIfNeeded(messages: LlmMessage[], agent: AgentDefinition): void {
    const ceiling = this.deps.config.search.discoveryMaxContextTokens;
    if (ceiling <= 0 || messages.length <= 3) return;

    const size = (): number =>
      Math.ceil(
        messages.reduce(
          (chars, m) =>
            chars +
            m.content.reduce((c, block) => {
              if (block.type === 'text') return c + block.text.length;
              if (block.type === 'tool_result') return c + block.content.length;
              return c + JSON.stringify(block.input ?? {}).length;
            }, 0),
          0,
        ) / 4,
      );

    if (size() <= ceiling) return;

    const summarised: string[] = [];
    // On garde le briefing (0) et les deux derniers messages intacts.
    for (let i = 1; i < messages.length - 2; i++) {
      const message = messages[i]!;
      for (const block of message.content) {
        if (block.type === 'tool_use') {
          summarised.push(`- ${block.name} ${compactArgs(block.input)}`);
        } else if (block.type === 'tool_result') {
          const head = block.content.slice(0, 200).replace(/\s+/g, ' ');
          summarised.push(`  → ${block.isError ? 'ÉCHEC' : 'ok'} : ${head}`);
        }
      }
    }

    if (summarised.length === 0) return;

    const compacted: LlmMessage[] = [
      messages[0]!,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              '# Ce que vous avez déjà fait',
              'Les détails complets ont été retirés pour tenir dans votre contexte. Voici le relevé :',
              '',
              ...summarised.slice(-40),
              '',
              "Ne refaites pas ces appels. Poursuivez à partir de là, ou concluez.",
            ].join('\n'),
          },
        ],
      },
      ...messages.slice(-2),
    ];

    this.#log.info('context compacted', {
      agent: agent.key,
      before: messages.length,
      after: compacted.length,
    });
    messages.length = 0;
    messages.push(...compacted);
  }

  /**
   * Ce qu'ATLAS sait déjà — y compris quand il ne sait rien.
   *
   * Le silence n'est pas une réponse. LIVE #003 a lancé quatre `memory_search`
   * successifs sur un registre vide : l'agent, ne recevant aucune connaissance
   * préalable, a supposé qu'il n'avait pas cherché au bon endroit. Quatre
   * appels, 0,17 $, 45 % du coût de la mission — pour redécouvrir un vide
   * qu'ATLAS connaissait avant même de démarrer.
   *
   * L'instruction reste de chercher en mémoire avant de rechercher sur le web.
   * On ne la retire pas : on lui donne la réponse quand elle est déjà connue.
   * Dès qu'une mémoire existe, le briefing normal reprend et cette section
   * disparaît.
   */
  #emptyKnowledge(mission: Mission): string | null {
    const { repos } = this.deps;

    // Deux réserves distinctes, et c'est tout l'objet de la correction.
    //
    // La mémoire générale accumule des traces de fonctionnement — bilans de
    // l'Evolution Manager, résumés de missions passées, incidents. Le registre
    // métier, lui, contient la matière réutilisable : des organisations déjà
    // étudiées. LIVE #004 avait deux éléments en mémoire générale et zéro
    // entreprise : le garde-fou, qui exigeait le vide absolu, ne s'est pas
    // déclenché — et l'Explorateur a passé sept `memory_search` pour redécouvrir
    // un registre vide, soit 46 % du coût de la mission.
    const generalEmpty = repos.memory.total() === 0;
    // Générique par domaine : une mission de département cherche de la matière
    // métier ; une mission générique n'a que la mémoire.
    const businessEmpty = mission.departmentKey ? repos.companies.count() === 0 : generalEmpty;

    if (!generalEmpty && !businessEmpty) return null;

    const lines = ['# État des connaissances ATLAS', ''];

    if (mission.departmentKey && businessEmpty) {
      lines.push(
        `Le registre métier est **vide** : aucune organisation n'a encore été étudiée pour « ${mission.departmentKey} », donc **aucun candidat antérieur n'est réutilisable**.`,
        generalEmpty
          ? "La mémoire générale d'ATLAS est vide elle aussi."
          : "La mémoire générale contient des traces de fonctionnement (bilans, incidents, missions passées) — rien qui puisse servir de candidat.",
        '',
        "Ce n'est pas une panne : ce domaine est neuf. **N'interrogez pas la mémoire pour y chercher des candidats** — la réponse est ici, et chaque interrogation coûte sans rien pouvoir apprendre. Passez directement à la recherche.",
      );
    } else {
      lines.push(
        "La mémoire d'ATLAS est **vide** : aucune mission antérieure n'a rien consigné.",
        '',
        "**N'interrogez pas la mémoire** — la réponse est ici. Travaillez à partir de vos propres outils.",
      );
    }
    return lines.join('\n');
  }

  /** The assignment itself: instruction, inputs, upstream results, prior knowledge. */
  #buildBriefing(input: AgentRunInput): string {
    const { mission, task, upstream } = input;
    const sections: string[] = [
      `# Objectif de la mission\n${mission.objective}`,
      `# Votre étape (${task.ref})\n${task.title}\n\n${task.instruction}`,
    ];

    if (Object.keys(mission.context).length > 0) {
      sections.push(`# Contexte métier\n${JSON.stringify(mission.context, null, 2).slice(0, 3000)}`);
    }
    if (Object.keys(task.input).length > 0) {
      sections.push(`# Entrées de l'étape\n${JSON.stringify(task.input, null, 2).slice(0, 3000)}`);
    }

    const upstreamEntries = Object.entries(upstream);
    if (upstreamEntries.length > 0) {
      const rendered = upstreamEntries
        .map(([ref, value]) => `## Résultat de ${ref}\n${summarise(value, 2500)}`)
        .join('\n\n');
      sections.push(`# Résultats dont vous dépendez\n${rendered}`);
    }

    // Un agent consciencieux comble un vide. C'est précisément ce qu'il ne
    // faut pas ici : privé de sa liste de candidats, l'Explorateur de
    // LIVE #001 en a reconstitué une à la main, hors pipeline, pour 8,24 $.
    // Le vide laissé par une étape amont ne le regarde pas — c'est à
    // l'orchestrateur d'en décider.
    const failures = input.upstreamFailures ?? [];
    if (failures.length > 0) {
      const rendered = failures
        .map((f) => `- ${f.ref} « ${f.title} » : ${f.status}${f.error ? ` — ${f.error}` : ''}`)
        .join('\n');
      sections.push(
        [
          '# Étapes amont sans résultat',
          rendered,
          '',
          "**Ne refaites pas leur travail.** Vous n'avez pas été mandaté pour cela, et le produire ici le laisserait hors du pipeline : il ne serait ni vérifié, ni tracé, ni exploitable par la suite.",
          "Faites ce que votre étape permet avec ce que vous avez réellement reçu, puis dites clairement ce qui manquait. Un constat d'absence est un résultat valable.",
        ].join('\n'),
      );
    }

    const briefing = this.deps.memory.briefing(`${mission.title} ${task.title}`, {
      missionId: mission.id,
    });
    if (briefing) sections.push(`# ${briefing}`);

    // Ajouté *en plus* du briefing, jamais à sa place. Une mémoire générale
    // fournie ne dit rien du registre métier : LIVE #004 avait deux souvenirs
    // système et zéro entreprise, et c'est le second chiffre qui comptait.
    const empty = this.#emptyKnowledge(mission);
    if (empty) sections.push(empty);

    return sections.join('\n\n');
  }
}

/** Les arguments d'un appel d'outil, réduits à ce qui l'identifie. */
function compactArgs(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input ?? {})) {
    const text = Array.isArray(value) ? value.slice(0, 3).join(',') : String(value ?? '');
    if (text) parts.push(`${key}=${text.slice(0, 60)}`);
    if (parts.length >= 3) break;
  }
  return parts.join(' ');
}

/** Renders an upstream result for the next agent without flooding its context. */
function summarise(value: unknown, max: number): string {
  if (typeof value === 'string') return value.slice(0, max);
  if (value && typeof value === 'object' && 'summary' in value) {
    const summary = String((value as { summary: unknown }).summary);
    return summary.slice(0, max);
  }
  try {
    return JSON.stringify(value, null, 2).slice(0, max);
  } catch {
    return String(value).slice(0, max);
  }
}

export { describeError };
