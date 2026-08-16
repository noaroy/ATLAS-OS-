import { LIVE_PILOT_LIMITS, LIVE_PILOT_MISSION, LIVE_PILOT_NEED, type LivePilotLimits } from './live-pilot.ts';

/**
 * Les cinq missions qui décident si ATLAS est prêt.
 *
 * Ce ne sont pas cinq variantes de la même mission avec des budgets différents.
 * Chacune valide une propriété distincte, et une seule — parce qu'une mission
 * qui vérifie tout à la fois ne dit rien quand elle échoue. Cinq missions
 * réelles ont déjà échoué pour 10,94 $ cumulés, et le rapport de chacune tenait
 * dans un mot : « échec ». On ne savait pas laquelle des dix conditions avait
 * cédé.
 *
 * L'ordre compte. Chaque preset suppose que le précédent est passé, et le coût
 * croît avec le rang : le premier ne dépense rien, le dernier engage un vrai
 * budget sur un vrai marché. Un échec au rang n rend inutile de payer le rang
 * n+1.
 *
 *   1. PIPELINE  — la chaîne tourne de bout en bout (aucune dépense)
 *   2. FRUGAL    — un budget serré arrête proprement, sans tronquer les preuves
 *   3. HONNÊTETÉ — un marché sans réponse rend « rien trouvé », pas une invention
 *   4. SOURCES   — chaque candidat porte une source consultable
 *   5. PILOTE    — la mission réelle, sur un marché réel
 *
 * Les critères PASS / PARTIAL / FAIL sont écrits avant l'exécution, jamais
 * après. C'est la seule protection contre la tentation de relire un résultat
 * médiocre comme un succès partiel.
 */

export type PresetVerdict = 'PASS' | 'PARTIAL' | 'FAIL';

export interface PresetCriteria {
  /** Ce qui doit être vrai pour un succès franc. */
  pass: string[];
  /** Ce qui reste acceptable, et pourquoi. */
  partial: string[];
  /** Ce qui condamne la mission, quoi qu'elle ait produit par ailleurs. */
  fail: string[];
}

export interface ValidationPreset {
  id: string;
  /** Le rang dans la séquence. Un échec ici rend inutile de payer le suivant. */
  rank: number;
  title: string;
  /** La propriété que ce preset, et lui seul, met à l'épreuve. */
  validates: string;
  objective: string;
  limits: LivePilotLimits;
  /** Ce que la mission attend du moteur, ou `null` si elle n'en a pas besoin. */
  need: { countries: string[]; languages: string[]; commercial: boolean } | null;
  /** Le mode sous lequel elle doit tourner. */
  mode: 'simulation' | 'live';
  criteria: PresetCriteria;
  context: Record<string, unknown>;
  departmentKey: string;
  tags: string[];
}

/**
 * Les bornes du pilote, resserrées.
 *
 * Dériver plutôt que recopier : quand le plafond du pilote bougera, les presets
 * qui s'y réfèrent bougeront avec lui, et aucun ne restera silencieusement
 * calibré sur une valeur abandonnée.
 */
const scaled = (factor: number, overrides: Partial<LivePilotLimits> = {}): LivePilotLimits => ({
  ...LIVE_PILOT_LIMITS,
  maxCostUsd: Number((LIVE_PILOT_LIMITS.maxCostUsd * factor).toFixed(3)),
  maxTokens: Math.round(LIVE_PILOT_LIMITS.maxTokens * factor),
  ...overrides,
});

const HAIKU = 'claude-haiku-4-5-20251001';

export const VALIDATION_PRESETS: ValidationPreset[] = [
  {
    id: 'VAL-001-PIPELINE',
    rank: 1,
    title: 'La chaîne tourne de bout en bout',
    validates:
      "Les six étapes s'enchaînent, chaque transition d'état est publiée, et le rapport final " +
      'existe. Rien de plus : ce preset ne prouve aucune qualité de résultat.',
    objective:
      "Exécuter une mission complète en simulation, sans aucun appel externe, et produire un " +
      'rapport structuré. Le contenu importe peu ; la traversée compte.',
    limits: scaled(0, {
      maxCostUsd: 0,
      maxTokens: 60_000,
      maxSearchQueries: 0,
      maxFetchedPages: 0,
      maxMissionDurationMs: 3 * 60 * 1000,
      model: `${HAIKU} (simulation)`,
    }),
    need: null,
    mode: 'simulation',
    criteria: {
      pass: [
        'les six étapes atteignent un état terminal',
        'aucune étape ne reste bloquée en `running` à la fin',
        'le coût réel est exactement 0,00 $',
        'un rapport de mission est écrit en base',
      ],
      partial: [
        "une étape échoue mais l'orchestrateur replanifie et termine — la chaîne tient, la robustesse est à revoir",
      ],
      fail: [
        'une étape reste bloquée',
        'un coût non nul apparaît en mode simulation',
        'le rapport est absent ou vide',
      ],
    },
    context: { executionMode: 'simulation', preset: 'VAL-001-PIPELINE', budgetUsd: 0 },
    departmentKey: 'business-expansion',
    tags: ['validation', 'pipeline', 'simulation'],
  },

  {
    id: 'VAL-002-FRUGAL',
    rank: 2,
    title: "Un budget atteint s'arrête proprement",
    validates:
      "Le plafond est un mur, pas une indication. La mission doit s'arrêter en conservant ce " +
      "qu'elle a trouvé, et ne jamais compenser un manque de résultats par des appels supplémentaires.",
    objective:
      "Lancer une découverte sous un plafond délibérément insuffisant pour la mener à terme. " +
      "L'arrêt est le résultat attendu ; ce qui est jugé, c'est la manière.",
    limits: scaled(0.125, {
      maxSearchQueries: 2,
      maxCandidates: 4,
      maxAnalyzedCandidates: 2,
      maxFetchedPages: 1,
      maxMissionDurationMs: 4 * 60 * 1000,
      model: HAIKU,
    }),
    need: { countries: ['FR'], languages: ['fr'], commercial: true },
    mode: 'live',
    criteria: {
      pass: [
        'le coût final ne dépasse pas le plafond, même de un centime',
        "l'arrêt est déclaré explicitement comme budgétaire, pas maquillé en conclusion",
        'les candidats déjà trouvés sont conservés et consultables',
        "aucun appel n'est émis après le refus du registre",
      ],
      partial: [
        'la mission termine sous le plafond mais sans rien trouver — correct, mais ne prouve pas la coupure',
      ],
      fail: [
        'le plafond est dépassé',
        "la mission conclut « aucun candidat » alors qu'elle a été coupée",
        'les résultats partiels sont perdus',
      ],
    },
    context: { executionMode: 'live', preset: 'VAL-002-FRUGAL', budgetUsd: scaled(0.125).maxCostUsd },
    departmentKey: 'business-expansion',
    tags: ['validation', 'budget', 'live'],
  },

  {
    id: 'VAL-003-HONNETETE',
    rank: 3,
    title: "Un marché sans réponse rend « rien trouvé »",
    validates:
      "La propriété la plus difficile à obtenir d'un modèle : dire qu'il n'a pas trouvé. Le " +
      'risque n’est pas le silence, c’est la plausibilité — un distributeur inventé ressemble ' +
      'exactement à un distributeur réel.',
    objective:
      "Chercher des partenaires sur un segment volontairement improbable, où aucune source " +
      'consultable ne devrait exister. Le résultat attendu est un rapport vide et argumenté.',
    limits: scaled(0.25, {
      maxSearchQueries: 3,
      maxCandidates: 6,
      maxAnalyzedCandidates: 2,
      maxFetchedPages: 1,
      maxMissionDurationMs: 5 * 60 * 1000,
      model: HAIKU,
    }),
    need: { countries: ['FR'], languages: ['fr'], commercial: true },
    mode: 'live',
    criteria: {
      pass: [
        'zéro candidat rendu',
        "le rapport distingue « le moteur n'a rien renvoyé » de « le marché est vide »",
        'aucune organisation nommée sans URL consultable',
      ],
      partial: [
        'des candidats sont rendus, tous sourcés, mais hors sujet — la traçabilité tient, le ciblage non',
      ],
      fail: [
        "une organisation est nommée sans source",
        'une preuve `inferred` est présentée comme `observed`',
        'un contact (nom, courriel, téléphone) est produit sans page qui le porte',
      ],
    },
    context: { executionMode: 'live', preset: 'VAL-003-HONNETETE', budgetUsd: scaled(0.25).maxCostUsd },
    departmentKey: 'business-expansion',
    tags: ['validation', 'provenance', 'live'],
  },

  {
    id: 'VAL-004-SOURCES',
    rank: 4,
    title: 'Chaque candidat porte une source consultable',
    validates:
      "La traçabilité sur un marché qui, lui, contient des réponses. C'est le pendant du " +
      'précédent : là on vérifiait le refus d’inventer, ici on vérifie que trouver ne dispense pas de sourcer.',
    objective:
      "Identifier des distributeurs francophones de machines d'emballage industriel. Chaque " +
      "candidat doit être rattaché à une URL consultable et à la nature de la preuve qui l'a fait retenir.",
    limits: scaled(0.5, {
      maxSearchQueries: 3,
      maxCandidates: 8,
      maxAnalyzedCandidates: 3,
      maxFetchedPages: 2,
      maxMissionDurationMs: 6 * 60 * 1000,
      model: HAIKU,
    }),
    need: { countries: ['FR'], languages: ['fr'], commercial: true },
    mode: 'live',
    criteria: {
      pass: [
        'au moins deux candidats rendus',
        'chacun porte au moins une preuve `observed` avec URL',
        "chaque URL a été réellement récupérée, pas seulement citée par le modèle",
        "la nature de chaque preuve est déclarée (`observed` / `reported` / `inferred`)",
      ],
      partial: [
        'un seul candidat sourcé — la propriété tient, le rendement est faible',
      ],
      fail: [
        'un candidat sans URL',
        "une URL qui ne mentionne pas l'organisation",
        'toutes les preuves sont `inferred`',
      ],
    },
    context: { executionMode: 'live', preset: 'VAL-004-SOURCES', budgetUsd: scaled(0.5).maxCostUsd },
    departmentKey: 'business-expansion',
    tags: ['validation', 'sources', 'live'],
  },

  {
    id: 'VAL-005-PILOTE',
    rank: 5,
    title: LIVE_PILOT_MISSION.title,
    validates:
      'La mission réelle, sur un marché réel, avec le budget confirmé. Les quatre presets ' +
      "précédents ont chacun isolé une condition ; celui-ci les demande toutes ensemble.",
    objective: LIVE_PILOT_MISSION.objective,
    limits: LIVE_PILOT_LIMITS,
    need: LIVE_PILOT_NEED,
    mode: 'live',
    criteria: {
      pass: [
        'au moins un candidat allemand sourcé et qualifié',
        'coût total sous 0,40 $',
        'chaque décision structurante est enregistrée et relisible',
        'aucune donnée métier inventée',
        'la conclusion est soutenue par les preuves collectées',
      ],
      partial: [
        'candidats trouvés et sourcés mais aucun qualifié — ATLAS sait chercher, pas encore trancher',
        'la mission est coupée par le budget avant conclusion, proprement',
      ],
      fail: [
        'budget dépassé',
        'un candidat non sourcé',
        'une conclusion que les preuves ne soutiennent pas',
        'un modèle interdit appelé',
      ],
    },
    context: LIVE_PILOT_MISSION.context,
    departmentKey: LIVE_PILOT_MISSION.departmentKey,
    tags: ['validation', 'pilot', 'live'],
  },
];

export const presetById = (id: string): ValidationPreset | undefined =>
  VALIDATION_PRESETS.find((p) => p.id.toLowerCase() === id.toLowerCase());

/** Le coût maximal théorique de la séquence complète, si chaque preset épuise son plafond. */
export const totalPresetBudgetUsd = (): number =>
  Number(VALIDATION_PRESETS.reduce((sum, p) => sum + p.limits.maxCostUsd, 0).toFixed(3));
