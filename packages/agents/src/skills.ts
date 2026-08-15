import type { Skill, SkillKey } from '@atlas/contracts';

/**
 * The platform's skill catalogue (Article VII).
 *
 * A skill is a reusable technical know-how that belongs to ATLAS, not to any
 * one department. Adding a skill makes it available to every department at
 * once — which is the mechanism the Constitution asks for when it says ATLAS
 * builds skills rather than features.
 *
 * Each skill names the tools that provide it. An agent declares the skills it
 * holds; its tool allow-list follows from that, so a declared skill and a
 * granted tool can never disagree.
 */
export const SKILL_CATALOGUE: Skill[] = [
  {
    key: 'memory-recall',
    name: 'Memory recall',
    description:
      'Search everything ATLAS has learned before, so prior work is reused rather than repeated.',
    category: 'knowledge',
    tools: ['memory_search'],
    enabled: true,
  },
  {
    key: 'memory-curation',
    name: 'Memory curation',
    description: 'Record durable knowledge — entities, lessons, procedures — into the organisation’s memory.',
    category: 'knowledge',
    tools: ['memory_remember'],
    enabled: true,
  },
  {
    key: 'web-research',
    name: 'Web research',
    description:
      'Gather information from public sources on the open web, with provenance. Private and internal addresses are refused.',
    category: 'research',
    tools: ['http_fetch'],
    enabled: true,
  },
  {
    key: 'scoring',
    name: 'Weighted scoring',
    description:
      'Rank candidates against explicit, weighted criteria so a comparison is reproducible and arguable.',
    category: 'analysis',
    tools: ['score_candidates', 'score_opportunity'],
    enabled: true,
  },
  {
    key: 'document-production',
    name: 'Document production',
    description: 'Write reports, syntheses and datasets into the mission artifact store.',
    category: 'production',
    tools: ['create_document'],
    enabled: true,
  },
  {
    key: 'workflow-execution',
    name: 'Workflow execution',
    description: 'Run a registered automation workflow and wait for its result.',
    category: 'automation',
    tools: ['trigger_workflow'],
    enabled: true,
  },
  {
    key: 'system-diagnostics',
    name: 'System diagnostics',
    description: 'Read live technical health: resources, throughput, failures and open alerts.',
    category: 'observation',
    tools: ['system_status'],
    enabled: true,
  },
  {
    key: 'company-discovery',
    name: 'Company discovery',
    description:
      'Identify candidate organisations and register them against the shared company registry, deduplicated.',
    category: 'research',
    tools: ['discover_companies'],
    enabled: true,
  },
  {
    key: 'company-enrichment',
    name: 'Company enrichment',
    description:
      'Deepen what is known about an organisation — territory, portfolio, size, reach — with a source per claim.',
    category: 'research',
    tools: ['enrich_company'],
    enabled: true,
  },
  {
    key: 'evidence-capture',
    name: 'Evidence capture',
    description:
      'Record sourced claims, keeping what was observed distinct from what was inferred.',
    category: 'research',
    tools: ['record_evidence'],
    enabled: true,
  },
  {
    key: 'contact-discovery',
    name: 'Recherche de contacts',
    description:
      "Relever les coordonnées professionnelles publiées par une organisation, avec l'URL où elles figurent. Aucune adresse n'est déduite.",
    category: 'research',
    tools: ['find_contacts'],
    enabled: true,
  },
  {
    key: 'opportunity-qualification',
    name: 'Opportunity qualification',
    description:
      'Judge whether a candidate genuinely fits a brief, criterion by criterion, against the evidence held.',
    category: 'analysis',
    tools: ['qualify_opportunity'],
    enabled: true,
  },
  {
    key: 'shortlist-ranking',
    name: 'Shortlist ranking',
    description:
      'Turn scored candidates into an ordered shortlist, each position justified from its score components.',
    category: 'analysis',
    tools: ['rank_shortlist'],
    enabled: true,
  },
  {
    key: 'mission-inspection',
    name: 'Mission inspection',
    description: 'Read the full record of a mission: its plan, steps, agents and outputs.',
    category: 'observation',
    tools: ['inspect_mission'],
    enabled: true,
  },
];

export const SKILL_KEYS: SkillKey[] = SKILL_CATALOGUE.map((s) => s.key);

/**
 * Resolves an agent's declared skills into the tools it may call.
 *
 * Unknown or disabled skills contribute nothing rather than throwing: an agent
 * whose skill was withdrawn keeps working with what remains, which is the
 * behaviour the Constitution's stability requirement asks for (Article XV).
 */
export function toolsForSkills(skills: readonly SkillKey[], catalogue: readonly Skill[]): string[] {
  const byKey = new Map(catalogue.filter((s) => s.enabled).map((s) => [s.key, s]));
  const tools = new Set<string>();

  for (const key of skills) {
    for (const tool of byKey.get(key)?.tools ?? []) tools.add(tool);
  }
  return [...tools].sort();
}

/** Skills that reference a tool the registry does not provide. */
export function danglingSkills(catalogue: readonly Skill[], knownTools: readonly string[]): string[] {
  const known = new Set(knownTools);
  return catalogue
    .filter((skill) => skill.tools.some((tool) => !known.has(tool)))
    .map((skill) => skill.key);
}
