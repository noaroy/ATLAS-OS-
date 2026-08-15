import type { DepartmentDefinition } from '@atlas/contracts';

/**
 * Business Expansion Intelligence — ATLAS's first department.
 *
 * It answers one commercial question: *who abroad should we be talking to, and
 * why them?* Everything that makes it different from the departments that will
 * follow is data in this file — its targets, its brief, its method, its scoring
 * weights, its teams. The platform underneath knows none of it.
 */

/**
 * The kinds of counterparty this department knows how to look for.
 *
 * Adding a seventh is an entry in this list plus, if it deserves one, a line in
 * the qualification guidance — no schema change and no new code path.
 */
const TARGET_TYPES = [
  {
    key: 'distributor',
    label: 'Distributeur',
    description:
      "Achète pour revendre sur un territoire, tient du stock, détient la relation client et attend souvent l'exclusivité.",
  },
  {
    key: 'supplier',
    label: 'Fournisseur',
    description: 'Fournit des composants, matières ou sous-ensembles entrant dans notre production.',
  },
  {
    key: 'integrator',
    label: 'Intégrateur',
    description:
      "Conçoit et installe des systèmes complets dont notre produit est un composant ; vend de l'ingénierie, pas du catalogue.",
  },
  {
    key: 'oem',
    label: 'Partenaire OEM',
    description: 'Intègre notre produit dans ses propres équipements sous sa marque, généralement en volume.',
  },
  {
    key: 'reseller',
    label: 'Revendeur',
    description: "Revend sans tenir de stock ni détenir la relation d'après-vente.",
  },
  {
    key: 'commercial-partner',
    label: 'Partenaire commercial',
    description:
      'Co-vend ou apporte des affaires sans relation de revente : agents, cabinets, éditeurs complémentaires.',
  },
];

/**
 * What Hermes must understand before any work starts.
 *
 * The founder writes a sentence; this schema is what that sentence has to
 * become before it can drive a pipeline.
 */
const BRIEF_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    clientProfile: {
      type: 'object',
      description: 'The business ATLAS is working on behalf of.',
      properties: {
        name: { type: 'string', description: 'Company name, or "the client" if unstated' },
        country: { type: 'string' },
        industry: { type: 'string' },
        offering: {
          type: 'string',
          description: 'What they make or sell, in concrete terms',
        },
        differentiators: {
          type: 'array',
          items: { type: 'string' },
          description: 'Why a partner would choose them over an incumbent. Five at most.',
        },
      },
      required: ['name', 'country', 'industry', 'offering'],
      additionalProperties: false,
    },
    targetTypes: {
      type: 'array',
      items: { type: 'string', enum: TARGET_TYPES.map((t) => t.key) },
      description:
        "Les rôles recherchés, un au minimum. Plusieurs sont possibles : une mission peut viser des distributeurs *et* des intégrateurs, et une même organisation peut correspondre aux deux.",
    },
    markets: {
      type: 'object',
      properties: {
        countries: { type: 'array', items: { type: 'string' } },
        industries: { type: 'array', items: { type: 'string' } },
        regions: { type: 'array', items: { type: 'string' } },
      },
      required: ['countries', 'industries', 'regions'],
      additionalProperties: false,
    },
    desiredCount: {
      type: 'integer',
      description: 'How many candidates the founder asked for. Between 1 and 100.',
    },
    mustHave: {
      type: 'array',
      items: { type: 'string' },
      description: 'Non-negotiable criteria a candidate must meet. Six at most.',
    },
    niceToHave: {
      type: 'array',
      items: { type: 'string' },
      description: 'Desirable but not disqualifying. Six at most.',
    },
    exclusions: {
      type: 'array',
      items: { type: 'string' },
      description: 'What disqualifies a candidate outright. Six at most.',
    },
  },
  required: ['clientProfile', 'targetTypes', 'markets', 'desiredCount', 'mustHave', 'niceToHave', 'exclusions'],
  additionalProperties: false,
};

/**
 * The scoring model.
 *
 * Weights are data so they can be re-tuned from evidence about which
 * shortlisted partners actually converted, without touching code — and a
 * re-weighting is visibly a new model version on every score it produces.
 */
const SCORING_MODEL = {
  dimensions: [
    {
      key: 'sector-fit',
      label: 'Adéquation sectorielle',
      description: 'Vendent-ils déjà aux secteurs où sont nos clients ?',
      weight: 20,
    },
    {
      key: 'geographic-fit',
      label: 'Couverture géographique',
      description:
        'Couvrent-ils le territoire visé, avec une présence réelle et non une adresse postale ?',
      weight: 18,
    },
    {
      key: 'portfolio-fit',
      label: 'Complémentarité de gamme',
      description:
        "Notre produit complète-t-il ce qu'ils portent — ni redondant, ni sans rapport ?",
      weight: 16,
    },
    {
      key: 'commercial-reach',
      label: 'Force commerciale',
      description: 'Équipe de vente, capacité de service, parc installé, salons, références.',
      weight: 14,
    },
    {
      key: 'strategic-relevance',
      label: 'Intérêt stratégique',
      description: 'Existe-t-il une raison crédible pour *eux* de dire oui, cette année ?',
      weight: 12,
    },
    {
      key: 'size-fit',
      label: 'Taille adaptée',
      description: 'Assez grands pour compter, assez petits pour que nous comptions pour eux.',
      weight: 10,
    },
    {
      key: 'evidence-quality',
      label: 'Qualité des preuves',
      description:
        "À quel point l'évaluation est sourcée. Calculée par la plateforme depuis le registre de preuves ; un agent ne peut pas l'affirmer.",
      weight: 10,
      computed: true,
    },
  ],
  shortlistThreshold: 45,
  narrative:
    "Un candidat marque des points lorsqu'il touche déjà nos clients sur le territoire visé, " +
    "porte une gamme complémentaire plutôt que concurrente, dispose de la capacité commerciale pour " +
    "vendre et soutenir le produit, et a un intérêt propre à prendre la ligne. La qualité des preuves " +
    "fait partie du score : une supposition bien argumentée passe derrière un fait modestement établi.",
};

const TEAMS = [
  {
    key: 'research',
    name: 'Équipe Recherche',
    purpose:
      'Trouver les candidats et rassembler ce qui est publiquement connu, avec la source de chaque affirmation.',
    stages: ['discovered', 'enriched'] as const,
    agentKeys: ['explorer'],
  },
  {
    key: 'qualification',
    name: 'Équipe Qualification',
    purpose:
      "Décider qui correspond réellement, et refuser de qualifier de vérifié ce qui ne repose que sur une déduction.",
    stages: ['qualified'] as const,
    agentKeys: ['ambassador'],
  },
  {
    key: 'intelligence',
    name: 'Équipe Intelligence',
    purpose: 'Noter les candidats qualifiés selon le modèle du département et ordonner la shortlist.',
    stages: ['scored', 'shortlisted'] as const,
    agentKeys: ['analyst'],
  },
  {
    key: 'reporting',
    name: 'Équipe Livraison',
    purpose: "Transformer la shortlist en un document exploitable et transmissible.",
    stages: [] as const,
    agentKeys: ['architect'],
  },
];

/**
 * The method.
 *
 * Six stages, each owned by a team, each producing an output the next depends
 * on. The pipeline is linear because each stage genuinely needs the previous
 * one's result; nothing is sequenced for the sake of appearances.
 */
/**
 * La méthode.
 *
 * Six étapes, chacune portée par une équipe, chacune produisant un résultat
 * vérifiable dont dépend la suivante. Le pipeline est linéaire parce que chaque
 * étape a réellement besoin du résultat de la précédente ; rien n'est séquencé
 * pour la forme.
 */
const PLAYBOOK = [
  {
    ref: "discovery",
    title: "Trouver des {{targetTypes}}s en {{markets.countries}}",
    agentKey: "explorer",
    teamKey: "research",
    action: "research",
    requiredSkills: ["company-discovery", "web-research", "memory-recall"],
    instruction: [
      "Trouvez des organisations réelles pouvant agir comme {{targetTypes}} pour {{clientProfile.name}}.",
      "",
      "Client : {{clientProfile.name}} ({{clientProfile.country}}) — {{clientProfile.offering}}",
      "Territoire : {{markets.countries}}. Régions visées : {{markets.regions}}.",
      "Leurs clients sont dans : {{markets.industries}}.",
      "Indispensable : {{mustHave}}. Disqualifiant : {{exclusions}}.",
      "",
      "Appelez discover_companies UNE fois en décrivant ce que vous cherchez. ATLAS interroge ses sources,",
      "déduplique et conserve la provenance de chaque résultat. Vous ne fournissez pas la liste des entreprises :",
      "vous décrivez le profil, ATLAS le cherche.",
      "",
      "Ajoutez des mots-clés métier dans la langue du marché : c'est ce qui sépare une recherche générique",
      "d'une recherche qui trouve les bons acteurs.",
      "",
      "Si ATLAS ne trouve pas assez de candidats, rapportez-le tel quel. Ne complétez jamais la liste de mémoire :",
      "une entreprise sans source ne peut pas entrer dans le pipeline.",
    ].join('\n'),
    expectedOutput: "Les candidats enregistrés par discover_companies, avec une note sur la couverture obtenue et ce qui manque.",
    dependsOn: [],
    advancesTo: "discovered" as const,
  },
  {
    ref: "enrichment",
    title: "Documenter chaque candidat",
    agentKey: "explorer",
    teamKey: "research",
    action: "collect",
    requiredSkills: ["company-enrichment", "evidence-capture", "contact-discovery", "web-research"],
    instruction: [
      "Pour chaque candidat enregistré à l'étape précédente, rassemblez ce qui est publiquement vérifiable.",
      "",
      "En priorité : territoire couvert, secteurs servis, gamme distribuée, taille et effectif,",
      "capacité commerciale et service, marques déjà représentées.",
      "",
      "Utilisez enrich_company une fois par candidat. Chaque affirmation entre comme preuve, avec l'URL de sa source.",
      "Marquez « constaté » seulement si vous l'avez lu à la source citée ; « rapporté » si un tiers l'affirme ;",
      "« déduit » si vous l'avez conclu — et dites alors à partir de quoi.",
      "Ne présentez jamais une déduction comme un fait.",
      "",
      "Puis appelez find_contacts sur chaque candidat : ATLAS relève les coordonnées réellement publiées sur son site.",
      "N'inventez aucune adresse — une adresse fabriquée est plausible et fausse.",
      "",
      "Un candidat sur lequel vous ne trouvez rien est un résultat : consignez-le au lieu de le remplir.",
    ].join('\n'),
    expectedOutput: "Chaque candidat documenté, preuves sourcées, coordonnées publiques relevées lorsque disponibles.",
    dependsOn: ["discovery"],
    // Sans candidat, il n'y a rien à documenter. LIVE #001 a lancé cette
    // étape sur une liste vide : faute d'entrée, l'agent a reconstitué des
    // pistes à la main, hors pipeline, pour 8,24 $.
    preconditions: [
      {
        kind: "pipeline-count" as const,
        minCount: 1,
        because: "Aucun candidat n'a été découvert : il n'y a rien à documenter",
      },
    ],
    advancesTo: "enriched" as const,
  },
  {
    ref: "qualification",
    title: "Qualifier les candidats au regard du brief",
    agentKey: "ambassador",
    teamKey: "qualification",
    action: "qualify",
    requiredSkills: ["opportunity-qualification", "memory-recall"],
    instruction: [
      "Décidez, candidat par candidat, s'il s'agit réellement d'un {{targetTypes}} à poursuivre pour",
      "{{clientProfile.name}} sur {{markets.countries}}.",
      "",
      "Indispensable : {{mustHave}}. Souhaitable : {{niceToHave}}. Disqualifiant : {{exclusions}}.",
      "",
      "Appelez qualify_opportunity une fois par candidat, avec une vérification explicite par critère et la preuve",
      "qui la tranche. Donnez l'intérêt de la contrepartie, pas seulement le nôtre.",
      "Rejetez clairement ce qui ne correspond pas : une liste courte et honnête vaut mieux qu'une liste remplie.",
      "",
      "ATLAS rétrograde tout verdict « qualifié » dont les faits clés ne reposent que sur une déduction :",
      "vérifiez le registre de preuves avant de conclure.",
    ].join('\n'),
    expectedOutput: "Un verdict par candidat, avec vérification par critère et preuves citées.",
    dependsOn: ["enrichment"],
    preconditions: [
      {
        kind: "pipeline-count" as const,
        minCount: 1,
        because: "Aucun candidat à qualifier",
      },
    ],
    advancesTo: "qualified" as const,
  },
  {
    ref: "scoring",
    title: "Noter les candidats qualifiés",
    agentKey: "analyst",
    teamKey: "intelligence",
    action: "score",
    requiredSkills: ["scoring", "memory-recall"],
    instruction: [
      "Notez chaque candidat non rejeté, avec score_opportunity, une fois par candidat.",
      "",
      "Évaluez chaque dimension déclarée par le département, de 0 à 100, en donnant la raison du chiffre.",
      "Citez les identifiants de preuves sur lesquels votre évaluation repose. Une dimension que vous ne pouvez pas",
      "étayer se note bas avec une confiance basse — pas haut par défaut.",
      "La qualité des preuves est calculée par ATLAS : ne l'évaluez pas vous-même.",
      "",
      "Offre du client, pour juger la complémentarité : {{clientProfile.offering}}",
      "Différenciateurs : {{clientProfile.differentiators}}",
    ].join('\n'),
    expectedOutput: "Chaque candidat qualifié noté, chaque dimension motivée et rattachée à ses preuves.",
    dependsOn: ["qualification"],
    preconditions: [
      {
        kind: "pipeline-count" as const,
        minCount: 1,
        because: "Aucun candidat à noter",
      },
    ],
    advancesTo: "scored" as const,
  },
  {
    ref: "ranking",
    title: "Produire la shortlist de {{desiredCount}}",
    agentKey: "analyst",
    teamKey: "intelligence",
    action: "evaluate",
    requiredSkills: ["shortlist-ranking"],
    instruction: [
      "Produisez la shortlist finale avec rank_shortlist, limitée à {{desiredCount}}.",
      "",
      "Le classement et les justifications sont générés à partir des scores : votre rôle est de contrôler le résultat.",
      "Si l'ordre vous paraît faux, dites quel candidat est mal placé et pourquoi, plutôt que de le corriger en silence.",
      "",
      "Puis résumez la shortlist : qui est en tête, ce qui sépare les premiers, et sur quoi le fondateur",
      "devrait rester sceptique.",
    ].join('\n'),
    expectedOutput: "Une shortlist classée, justifiée position par position, et votre lecture critique.",
    dependsOn: ["scoring"],
    preconditions: [
      {
        kind: "pipeline-count" as const,
        minCount: 1,
        because: "Aucun candidat à classer",
      },
    ],
    advancesTo: "shortlisted" as const,
  },
  {
    ref: "report",
    title: "Rédiger le rapport de shortlist",
    agentKey: "architect",
    teamKey: "reporting",
    action: "produce",
    requiredSkills: ["document-production"],
    instruction: [
      "Rédigez en français le livrable que reçoit {{clientProfile.name}}, avec create_document.",
      "",
      "Structure : la réponse d'abord (qui approcher, dans quel ordre), puis une section par candidat retenu —",
      "ce qu'il fait, pourquoi il correspond, quelles preuves l'établissent, ce qui reste incertain, et la première",
      "approche suggérée. Terminez par les candidats écartés et la raison, pour que le fondateur puisse être",
      "en désaccord.",
      "",
      "Attribuez chaque affirmation factuelle. Là où c'est une déduction, dites-le dans la phrase, pas en note.",
      "Ce document sera lu par quelqu'un qui n'était pas dans la pièce : il doit se suffire à lui-même.",
    ].join('\n'),
    expectedOutput: "Un rapport de shortlist complet et autonome, déposé dans l'espace des livrables.",
    dependsOn: ["ranking"],
    advancesTo: null,
  },
];

export const BUSINESS_EXPANSION: DepartmentDefinition = {
  key: 'business-expansion',
  name: 'Business Expansion Intelligence',
  tagline: "Trouver les bons partenaires à l'étranger, et savoir pourquoi ce sont les bons.",
  mission:
    "Identifier, qualifier et classer des contreparties commerciales sur un marché cible pour le compte " +
    "d'une entreprise cliente — distributeurs, fournisseurs, intégrateurs, partenaires OEM, revendeurs ou " +
    "partenaires commerciaux — et livrer une shortlist dont le classement se défend affirmation par affirmation.",
  building: 'partnership-center',
  targetTypes: TARGET_TYPES,
  briefSchema: BRIEF_SCHEMA,
  playbook: PLAYBOOK.map((stage) => ({
    ...stage,
    stages: undefined,
    dependsOn: [...stage.dependsOn],
  })) as DepartmentDefinition['playbook'],
  scoringModel: SCORING_MODEL as DepartmentDefinition['scoringModel'],
  teams: TEAMS.map((team) => ({ ...team, stages: [...team.stages] })) as DepartmentDefinition['teams'],
  kpis: [
    {
      key: 'opportunities-shortlisted',
      label: 'Partenaires retenus',
      unit: 'count',
      description: 'Candidats ayant passé la qualification, le score et le seuil de shortlist.',
    },
    {
      key: 'qualification-rate',
      label: 'Taux de qualification',
      unit: 'percent',
      description: 'Part des candidats découverts qui passent la qualification — la précision de la découverte.',
    },
    {
      key: 'cost-per-qualified-opportunity',
      label: 'Coût par opportunité qualifiée',
      unit: 'currency',
      description: "Dépense d'inférence estimée divisée par les candidats qualifiés. L'économie unitaire.",
    },
    {
      key: 'knowledge-reuse',
      label: 'Réutilisation du savoir',
      unit: 'count',
      description: 'Candidats repris du registre au lieu d\'être recherchés à nouveau.',
    },
  ],
  triggers: [
    'distributor',
    'distributeur',
    'reseller',
    'revendeur',
    'partner',
    'partenaire',
    'integrator',
    'intégrateur',
    'supplier',
    'fournisseur',
    'oem',
    'expansion',
    'export',
    'new market',
    'nouveau marché',
    'go to market',
    'importer',
    'importateur',
  ],
  enabled: true,
};
