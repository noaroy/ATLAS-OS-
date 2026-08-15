import { createHash } from 'node:crypto';
import type { Logger } from '@atlas/core';
import type { LlmContent, LlmProvider, LlmRequest, LlmResponse } from './types.ts';
import { textOf } from './types.ts';

/**
 * Deterministic offline provider.
 *
 * This is not a stub — it is a supported operating mode. Without an API key
 * ATLAS still plans, dispatches, executes, records, remembers and evolves, so
 * the whole organisation can be demonstrated, tested and developed offline.
 *
 * Two rules keep it honest:
 *  • Output is derived from the actual request (schema, tools, objective), so
 *    the shape of what flows through the system is real.
 *  • Everything it produces is labelled `[simulated]`, so simulated findings
 *    can never be mistaken for researched fact.
 */
export class SimulationProvider implements LlmProvider {
  readonly kind = 'simulation' as const;
  #log: Logger;

  constructor(logger: Logger) {
    this.#log = logger.child({ scope: 'llm:simulation' });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const seed = hashOf(request.system + JSON.stringify(request.messages).slice(0, 4000));
    const rng = mulberry32(seed);

    // Simulated latency keeps the village animation realistic and surfaces
    // genuine concurrency behaviour during development.
    await new Promise((r) => setTimeout(r, 120 + Math.floor(rng() * 380)));

    const content = request.jsonSchema
      ? this.#structured(request, rng)
      : this.#conversational(request, rng);

    const promptChars = request.system.length + JSON.stringify(request.messages).length;
    const outputChars = JSON.stringify(content).length;

    return {
      content,
      stopReason: content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn',
      // ~4 characters per token is close enough for cost dashboards in dev.
      usage: {
        inputTokens: Math.ceil(promptChars / 4),
        outputTokens: Math.ceil(outputChars / 4),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      model: `${request.model} (simulation)`,
      refusal: null,
    };
  }

  /** Generates a value conforming to the requested JSON schema. */
  #structured(request: LlmRequest, rng: () => number): LlmContent[] {
    const objective = extractObjective(request);
    const value = generateFromSchema(request.jsonSchema!, {
      objective,
      rng,
      depth: 0,
      key: 'root',
      hints: request.simulationHints ?? {},
      ordinal: 0,
    });
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  }

  /**
   * Simulates an agent turn. Exercises the tool loop for the first couple of
   * turns — so tool permissions, journeys, and result handling are all really
   * tested — then delivers a written conclusion.
   */
  #conversational(request: LlmRequest, rng: () => number): LlmContent[] {
    const objective = extractObjective(request);
    const hints = request.simulationHints ?? {};
    const made = toolCallCounts(request);

    // A real model does what its instruction tells it to. Picking a tool at
    // random exercises the loop but never exercises a *pipeline*, so a
    // simulated agent follows the tools its briefing actually names, and falls
    // back to a random one only when the briefing names none.
    // The caller may state which tools the instruction actually names; that is
    // more reliable than reading the transcript, which also holds upstream work.
    const instructed = hints.toolsInInstruction as string[] | undefined;
    const named = (request.tools ?? []).filter((tool) =>
      instructed ? instructed.includes(tool.name) : mentions(request, tool.name),
    );
    const pool = named.length > 0 ? named : (request.tools ?? []);

    for (const tool of named) {
      const budget = callBudget(tool.inputSchema, hints);
      const done = made.get(tool.name) ?? 0;
      if (done >= budget) continue;

      return [
        { type: 'text', text: `Using ${tool.name} to make progress on: ${objective}.` },
        {
          type: 'tool_use',
          id: `sim_${hashOf(tool.name + done + objective).toString(16)}`,
          name: tool.name,
          input: sampleToolInput(tool.inputSchema, objective, hints, done),
        },
      ];
    }

    // Nothing named: still exercise the loop once, so tool permissions and
    // result handling stay covered for steps that name no tool.
    if (named.length === 0 && pool.length > 0 && made.size < 2) {
      const tool = pool[Math.floor(rng() * pool.length)]!;
      return [
        { type: 'text', text: `Consulting ${tool.name} to make progress on: ${objective}.` },
        {
          type: 'tool_use',
          id: `sim_${hashOf(tool.name + made.size + objective).toString(16)}`,
          name: tool.name,
          input: sampleToolInput(tool.inputSchema, objective, hints, made.size),
        },
      ];
    }

    const toolFindings = request.messages
      .flatMap((m) => m.content)
      .filter((c): c is Extract<LlmContent, { type: 'tool_result' }> => c.type === 'tool_result')
      .map((c) => c.content.slice(0, 220));

    const findings = toolFindings.length
      ? toolFindings.map((f, i) => `${i + 1}. ${f.replace(/\s+/g, ' ')}`).join('\n')
      : '1. No external tool data was required for this step.';

    this.#log.debug('simulated agent turn', { objective: objective.slice(0, 60) });

    return [
      {
        type: 'text',
        text: [
          `[simulated] Completed the assigned step for: ${objective}`,
          '',
          'What was gathered:',
          findings,
          '',
          'Conclusion: the step produced a usable result and the mission can proceed.',
          'Note: ATLAS is running in simulation mode — no external research was performed,',
          'so these findings are structural placeholders rather than verified facts.',
        ].join('\n'),
      },
    ];
  }
}

// ─── Schema-driven generation ───────────────────────────────────────────────

interface GenContext {
  objective: string;
  rng: () => number;
  depth: number;
  key: string;
  /** Domain values by field name, supplied by the caller. */
  hints: Record<string, unknown[]>;
  /**
   * Which hint to take. At the root it is the call index, so successive calls
   * address successive records; inside an array it is the item index, so one
   * call covers each hinted value exactly once.
   */
  ordinal: number;
}

type Schema = Record<string, unknown>;

/**
 * Walks a JSON Schema and produces a conforming value.
 *
 * `enum` is honoured exactly, which is what lets the planner's schema — where
 * `agentKey` enumerates the real registered agents — yield plans that address
 * agents that actually exist.
 */
function generateFromSchema(schema: Schema, ctx: GenContext): unknown {
  const declaredType = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  // A hinted field takes a real value, so the tool it reaches accepts it —
  // but it must still respect the declared type. Returning the hint blindly
  // handed `"integrator"` to a field declared `array`, and the tool's own
  // validator answered "Expected array, received string". The step then made
  // four refused calls, found nothing, and the five stages behind it were
  // skipped for want of input. A hint is a source of values, never a licence
  // to ignore the shape.
  const hinted = ctx.hints[baseKey(ctx.key)];
  if (hinted?.length) {
    if (declaredType !== 'array') return hinted[ctx.ordinal % hinted.length];

    const max = (schema.maxItems as number | undefined) ?? hinted.length;
    const min = (schema.minItems as number | undefined) ?? 1;
    const count = Math.max(min, Math.min(hinted.length, max));
    return hinted.slice(0, count);
  }

  const enumValues = schema.enum as unknown[] | undefined;
  if (enumValues?.length) {
    return enumValues[Math.floor(ctx.rng() * enumValues.length)];
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined && ctx.rng() < 0.3) return schema.default;

  const type = declaredType;

  switch (type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      const required = (schema.required as string[] | undefined) ?? Object.keys(properties);
      const out: Record<string, unknown> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        // A hinted field is never dropped: it is the one the tool needs.
        const isHinted = Boolean(ctx.hints[key]?.length);
        if (!required.includes(key) && !isHinted && ctx.rng() < 0.15) continue;
        out[key] = generateFromSchema(propSchema, { ...ctx, depth: ctx.depth + 1, key });
      }
      return out;
    }

    case 'array': {
      const items = (schema.items ?? { type: 'string' }) as Schema;
      const min = (schema.minItems as number | undefined) ?? 2;
      const max = Math.min((schema.maxItems as number | undefined) ?? min + 2, min + 3);

      // When the items carry a hinted field, produce one item per hinted value
      // — an assessment per scoring dimension rather than an arbitrary two.
      const hintedCount = hintedItemCount(items, ctx.hints);
      const requested = hintedCount ?? min + Math.floor(ctx.rng() * Math.max(1, max - min + 1));
      const count = Math.min(requested, (schema.maxItems as number | undefined) ?? requested);

      // A list drawn from an enum must not repeat itself. Picking independently
      // per slot gave briefs asking for "commercial-partner, commercial-partner,
      // supplier" — a duplicate that reads as sloppiness in the plan and, worse,
      // narrows the search to fewer roles than the count suggests.
      const itemEnum = items.enum as unknown[] | undefined;
      if (itemEnum?.length && !hintedCount) {
        return shuffled(itemEnum, ctx.rng).slice(0, Math.min(count, itemEnum.length));
      }

      const generated = Array.from({ length: count }, (_, index) =>
        generateFromSchema(items, {
          ...ctx,
          depth: ctx.depth + 1,
          key: `${ctx.key}[${index}]`,
          // Inside an array the position selects the hint, so items differ.
          ordinal: index,
        }),
      );

      // A list of criteria that says the same thing twice reads as carelessness
      // and, in a brief, quietly narrows the search. Objects are left alone:
      // two similar records are not a duplicate.
      if (generated.every((v) => typeof v === 'string')) {
        const unique = [...new Set(generated as string[])];
        if (unique.length >= min) return unique;
      }
      return generated;
    }

    case 'integer':
    case 'number': {
      const min = (schema.minimum as number | undefined) ?? 1;
      const max = (schema.maximum as number | undefined) ?? min + 9;

      // Drawn from a triangular distribution rather than uniformly: a real
      // assessment clusters, and a simulated agent that rates everything at
      // random produces funnels whose shape says nothing about the pipeline.
      const spread = (ctx.rng() + ctx.rng()) / 2;
      const value = min + (0.2 + 0.8 * spread) * (max - min);
      return type === 'integer' ? Math.round(value) : Math.round(value * 100) / 100;
    }

    case 'boolean':
      return ctx.rng() > 0.4;

    case 'null':
      return null;

    case 'string':
    default:
      return generateString(schema, ctx);
  }
}

function generateString(schema: Schema, ctx: GenContext): string {
  // Honour the schema's own length bound, otherwise generated values can
  // violate the validator the tool actually enforces and produce tool
  // failures that tell the developer nothing about their system.
  const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : 400;
  return clamp(generateStringBody(schema, ctx), maxLength);
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max).trimEnd();
}

function generateStringBody(schema: Schema, ctx: GenContext): string {
  const description = typeof schema.description === 'string' ? schema.description : '';
  const key = ctx.key.replace(/\[\d+\]$/, '');
  const objective = ctx.objective;

  // Tag-like fields must stay short and slug-shaped.
  if (/^tags?$/i.test(key)) return ['simulated', 'atlas', 'draft', 'review'][Math.floor(ctx.rng() * 4)]!;

  // Field names carry more intent than descriptions, so match on them first.
  if (/^ref$/i.test(key)) return `step-${Math.floor(ctx.rng() * 900 + 100)}`;

  // An organisation's name is an identity, not a restatement of the objective:
  // echoing the brief back produces records that are unreadable and, worse,
  // deduplicate against each other for the wrong reason.
  if (/^(legal_?name|company|organisation|organization)$/i.test(key) || key === 'name') {
    return simulatedCompanyName(ctx.rng);
  }
  // Short factual fields need short factual values. The generic fallback below
  // restates the objective, which is fine for prose and nonsense for a city.
  //
  // Plurals count as much as singulars. A brief holds `markets.countries`, not
  // `country`, and matching only the singular sent the objective itself into
  // the field: a 96-character sentence where `discover_companies` accepts 60,
  // rejected by the tool's own validator. The whole pipeline stalled on a
  // missing letter, and the failure surfaced four stages downstream as
  // "aucun candidat découvert" — a market that looked empty when in truth
  // nothing had been asked of it.
  if (/^countr(y|ies)$/i.test(key)) return pick(ctx.rng, ['Germany', 'Austria', 'Switzerland']);
  if (/^(cit(y|ies)|regions?)$/i.test(key)) {
    return pick(ctx.rng, ['Hamburg', 'München', 'Köln', 'Stuttgart', 'Leipzig', 'Frankfurt']);
  }
  if (/^(websites?|urls?|source_?refs?)$/i.test(key)) {
    return `https://sim-${Math.floor(ctx.rng() * 9000 + 1000)}.example/${slugFor(ctx.rng)}`;
  }
  if (/^(industry|industries|sectors?)$/i.test(key)) {
    return pick(ctx.rng, ['Industrial equipment', 'Automation', 'Machine tools', 'Logistics']);
  }
  // Criteria lists: short, checkable clauses rather than a restated brief.
  if (/^(mustHave|niceToHave|exclusions?|keywords?|criteria)$/i.test(key)) {
    return pick(ctx.rng, [
      '[sim] présence commerciale établie sur le marché visé',
      '[sim] équipe technique capable d’installer et de maintenir',
      '[sim] pas de concurrent direct déjà distribué',
      '[sim] chiffre d’affaires supérieur à 2 M€',
      '[sim] références vérifiables dans le secteur',
    ]);
  }
  // An evidence field names an attribute, so it must stay a short token.
  if (/^field$/i.test(key)) {
    return pick(ctx.rng, ['territory', 'portfolio', 'size', 'reach', 'certifications']);
  }

  if (/title|summary/i.test(key)) return `${capitalize(verbFor(ctx.rng))} ${shorten(objective, 60)}`;
  if (/rationale|reason|why/i.test(key)) {
    return `[simulated] This decomposition isolates independent work so specialists can run in parallel while dependent analysis waits for its inputs.`;
  }
  if (/strategy|approach/i.test(key)) {
    return `[simulated] Gather source material first, analyse and score it, then produce a consolidated deliverable.`;
  }
  if (/instruction|prompt|detail/i.test(key)) {
    return `[simulated] Work the assigned step for "${shorten(objective, 80)}". Use your tools where they add evidence, record what you learn, and return a structured result.`;
  }
  if (/expected|output/i.test(key)) return `A structured result covering the assigned step.`;
  if (/action/i.test(key)) return 'execute';

  const hint = description || key;
  return `[simulated] ${capitalize(hint)} for ${shorten(objective, 60)}`;
}

/**
 * A plausible, obviously-invented organisation name.
 *
 * Distinct names matter beyond readability: identical ones would collapse under
 * deduplication and make a simulated run look like it found one company.
 */
function simulatedCompanyName(rng: () => number): string {
  const roots = ['Nord', 'Sud', 'Rhein', 'Alpen', 'Hansa', 'Vector', 'Meridian', 'Kestrel', 'Baltic', 'Terra'];
  const trades = ['Antriebe', 'Industrietechnik', 'Systemtechnik', 'Maschinenhandel', 'Automation', 'Werkzeuge'];
  const forms = ['GmbH', 'AG', 'GmbH & Co. KG', 'Group'];

  return `[sim] ${pick(rng, roots)}${pick(rng, trades)} ${pick(rng, forms)}`;
}

const pick = <T>(rng: () => number, list: T[]): T => list[Math.floor(rng() * list.length)]!;

/** Fisher–Yates on a copy, so drawing without replacement stays deterministic. */
function shuffled<T>(list: readonly T[], rng: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const slugFor = (rng: () => number): string =>
  pick(rng, ['about', 'standorte', 'produkte', 'unternehmen', 'kontakt']);

/** Builds a minimal valid input for a tool from its schema. */
function sampleToolInput(
  schema: Record<string, unknown>,
  objective: string,
  hints: Record<string, unknown[]>,
  callIndex: number,
): Record<string, unknown> {
  const rng = mulberry32(hashOf(objective + callIndex));
  const value = generateFromSchema(schema, {
    objective,
    rng,
    depth: 0,
    key: 'input',
    hints,
    ordinal: callIndex,
  });
  return (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
}

/** Strips the path so `assessments[2].dimension` resolves the hint `dimension`. */
const baseKey = (key: string): string => key.replace(/.*[.[]/, '').replace(/\]$/, '');

/**
 * How many times a tool should be called to cover every hinted record.
 *
 * Only a top-level identifier drives repetition: an array of hinted values is
 * covered inside one call, not by calling the tool again.
 */
function callBudget(schema: Record<string, unknown>, hints: Record<string, unknown[]>): number {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  let budget = 1;
  for (const key of Object.keys(properties)) {
    const hinted = hints[key];
    if (hinted?.length) budget = Math.max(budget, Math.min(hinted.length, 12));
  }
  return budget;
}

/** One array item per hinted value, when the item schema has a hinted field. */
function hintedItemCount(items: Schema, hints: Record<string, unknown[]>): number | null {
  const properties = (items.properties ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(properties)) {
    if (hints[key]?.length) return hints[key]!.length;
  }
  return null;
}

/**
 * Whether the *briefing* names this tool.
 *
 * Only the first message counts. A tool name that merely appears in a previous
 * step's result is not an instruction, and treating it as one makes a simulated
 * agent re-run an earlier stage's work — which is not what a real one does with
 * the instruction it was given.
 */
function mentions(request: LlmRequest, toolName: string): boolean {
  const briefing = request.messages[0];
  if (!briefing) return false;
  return briefing.content.some(
    (content) => content.type === 'text' && content.text.includes(toolName),
  );
}

/** How many times each tool has already been called in this conversation. */
function toolCallCounts(request: LlmRequest): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of request.messages) {
    for (const content of message.content) {
      if (content.type !== 'tool_use') continue;
      counts.set(content.name, (counts.get(content.name) ?? 0) + 1);
    }
  }
  return counts;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Pulls the working objective out of the conversation for grounding.
 *
 * Markdown scaffolding is stripped first: the briefing an agent receives is a
 * structured document, and quoting its headings back as a step title makes
 * simulated output far harder to read than it needs to be.
 */
function extractObjective(request: LlmRequest): string {
  for (const message of request.messages) {
    if (message.role !== 'user') continue;
    const text = textOf(message.content);
    if (!text) continue;

    const body = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (body) return shorten(body, 200);
  }
  return shorten(request.system.replace(/\s+/g, ' '), 120) || 'the current objective';
}

const hashOf = (input: string): number =>
  createHash('sha256').update(input).digest().readUInt32BE(0);

/** Small deterministic PRNG — same request always yields the same output. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERBS = ['research', 'analyse', 'qualify', 'compile', 'evaluate', 'synthesise'];
const verbFor = (rng: () => number): string => VERBS[Math.floor(rng() * VERBS.length)]!;

const capitalize = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

const shorten = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
