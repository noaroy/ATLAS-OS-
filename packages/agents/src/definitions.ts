import type { AgentDefinition, Building } from '@atlas/contracts';

/**
 * La carte de la cité (SRS §3.4–3.5).
 *
 * Quatorze bâtiments, organisés autour du poste de commandement. La géométrie
 * n'est pas décorative : elle dit comment ATLAS fonctionne.
 *
 *   Le cœur     — commandement, stratégie, salle de mission. Tout passe par là,
 *                 parce que tout est réellement coordonné par Hermès.
 *   La couronne — les métiers, disposés dans l'ordre où le travail les traverse :
 *                 recherche, analyse, production, communication.
 *   Le nord     — le savoir : archives, formation, observatoire. Ce qui reste
 *                 quand une mission est finie.
 *   Le sud      — la liaison : logistique et supervision. Ce qui fait circuler
 *                 et ce qui maintient debout.
 *
 * Les coordonnées ont été posées en pixels sur l'écran, puis converties vers la
 * grille — l'inverse revient à deviner où les bâtiments tomberont une fois
 * projetés. Aucun couple n'est à moins de 195 px, pour une empreinte de 104 :
 * les façades ne se recouvrent pas et les étiquettes restent lisibles.
 *
 * L'implantation est étirée horizontalement d'un peu plus d'un quart. Une ville
 * aussi haute que large laissait 61 % de la largeur vide sur un écran 16:9 :
 * c'est le cadrage vertical qui décidait, et la cité flottait au milieu de deux
 * marges. Étalée, elle occupe environ 75 % × 86 %.
 *
 * Un bâtiment n'apparaît ici que s'il a une fonction réelle. Aucun décor.
 */
export const BUILDINGS: Array<Building & { sortOrder: number }> = [
  // ─── Le cœur ──────────────────────────────────────────────────────────────
  {
    key: 'command-center',
    name: 'Poste de commandement ATLAS',
    department: 'Direction',
    purpose:
      "Hermès y coordonne chaque mission : analyse, planification, affectation et revue.",
    x: 0,
    y: 0,
    level: 1,
    activityScore: 0,
    status: 'nominal',
    unlockedAt: null,
    sortOrder: 0,
  },
  {
    key: 'strategy-hall',
    name: 'Salle de stratégie',
    department: 'Direction',
    purpose:
      "La salle du conseil : arbitrages, revues de résultats et synchronisation entre départements. On s'y réunit, on n'y produit rien.",
    x: -0.47,
    y: 5.08,
    level: 1,
    activityScore: 0,
    status: 'nominal',
    unlockedAt: null,
    sortOrder: 1,
  },
  {
    key: 'war-room',
    name: 'Salle de mission',
    department: 'Direction',
    purpose:
      "Le briefing d'avant-mission et le point de situation pendant qu'elle tourne. Les équipes s'y accordent avant de partir travailler.",
    x: 5.15,
    y: -0.54,
    level: 1,
    activityScore: 0,
    status: 'nominal',
    unlockedAt: null,
    sortOrder: 2,
  },

  // ─── La couronne : les métiers ────────────────────────────────────────────
  {
    key: 'research-tower',
    name: 'Tour de recherche',
    department: 'Découverte',
    purpose:
      "Là où les Explorateurs rassemblent entreprises, marchés, sources et signaux bruts.",
    x: -6.93,
    y: 1.93,
    level: 1,
    activityScore: 0,
    status: 'nominal',
    unlockedAt: null,
    sortOrder: 3,
  },
  {
    key: 'analysis-lab',
    name: 'Laboratoire d’analyse',
    department: 'Intelligence',
    purpose:
      "Là où les Analystes transforment la donnée brute en comparaisons, scores et recommandations.",
    x: 1.99,
    y: -6.99,
    level: 1,
    activityScore: 0,
    status: 'nominal',
    unlockedAt: null,
    sortOrder: 4,
  },
  {
    key: 'partnership-center',
    name: 'Centre des partenariats internationaux',
    department: 'Développement',
    purpose:
      "Là où les Ambassadeurs identifient distributeurs, intégrateurs et partenaires à l'étranger.",
    x: -4.67,
    y: 8.13,
    level: 1,
    activityScore: 0,
    status: 'nominal',
    unlockedAt: null,
    sortOrder: 5,
  },
  {
    key: 'production-workshop',
    name: 'Atelier de production',
    department: 'Livraison',
    purpose:
      "Là où les Architectes assemblent rapports, synthèses et documents prêts pour le client.",
    x: 8.18,
    y: -4.72,
    level: 1,
    activityScore: 0,
    status: 'nominal',
    unlockedAt: null,
    sortOrder: 6,
  },

  // ─── Le nord : le savoir ──────────────────────────────────────────────────
  {
    key: 'central-library',
    name: 'Bibliothèque centrale',
    department: 'Savoir',
    purpose:
      "La mémoire d’ATLAS, entretenue par les Archivistes pour que chaque mission laisse le système plus savant.",
    x: -5.19,
    y: -5.19,
    level: 1,
    activityScore: 0,
    status: 'nominal',
    unlockedAt: null,
    sortOrder: 7,
  },
  {
    key: 'training-academy',
    name: 'Académie de formation',
    department: 'Savoir',
    purpose:
      "Là où un spécialiste révise ses compétences et où les nouveaux apprennent les méthodes des départements.",
    x: -9.28,
    y: -2.26,
    level: 1,
    activityScore: 0,
    status: 'nominal',
    unlockedAt: null,
    sortOrder: 8,
  },
  {
    key: 'evolution-observatory',
    name: 'Observatoire de l’évolution',
    department: 'Amélioration',
    purpose:
      "Là où le Responsable de l'évolution étudie le fonctionnement d'ATLAS et propose comment il devrait fonctionner mieux.",
    x: -2.22,
    y: -9.32,
    level: 1,
    activityScore: 0,
    status: 'nominal',
    unlockedAt: null,
    sortOrder: 9,
  },

  // ─── Le sud : la liaison ──────────────────────────────────────────────────
  {
    key: 'communication-tower',
    name: 'Tour de communication',
    department: 'Commercial',
    purpose:
      "Là où les Messagers préparent les approches, les personnalisent et organisent les relances.",
    x: 5.58,
    y: 5.58,
    level: 1,
    activityScore: 0,
    status: 'nominal',
    unlockedAt: null,
    sortOrder: 10,
  },
  {
    key: 'logistics-hub',
    name: 'Halle logistique',
    department: 'Opérations',
    purpose:
      "Le transit du village : dossiers, livrables et pièces circulent d'un département à l'autre en passant par ici.",
    x: 1.98,
    y: 9.37,
    level: 1,
    activityScore: 0,
    status: 'nominal',
    unlockedAt: null,
    sortOrder: 11,
  },
  {
    key: 'monitoring-station',
    name: 'Station de supervision',
    department: 'Opérations',
    purpose:
      "La veille permanente : santé du système, alertes, plafonds économiques. On y regarde ATLAS depuis l'extérieur.",
    x: 9.39,
    y: 1.96,
    level: 1,
    activityScore: 0,
    status: 'nominal',
    unlockedAt: null,
    sortOrder: 12,
  },
  {
    key: 'automation-factory',
    name: 'Fabrique d’automatisation',
    department: 'Opérations',
    purpose:
      "Là où les Ingénieurs exécutent les workflows, surveillent la santé du système et gardent les lumières allumées.",
    x: -11.41,
    y: 2.38,
    level: 1,
    activityScore: 0,
    status: 'nominal',
    unlockedAt: null,
    sortOrder: 13,
  },
];

/**
 * The founding team (SRS §4.5–4.12, §6.7).
 *
 * One agent, one responsibility. Each carries a short persona and a tool
 * allow-list; the allow-list is the real boundary, the persona sets judgement.
 */
export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    key: 'explorer',
    name: 'Explorateur',
    role: 'Spécialiste recherche et découverte',
    tier: 'business',
    building: 'research-tower',
    mission:
      "Trouver l'information qui alimente ATLAS : entreprises, marchés, sources, signaux et opportunités.",
    skills: [
      'memory-recall',
      'memory-curation',
      'web-research',
      'company-discovery',
      'company-enrichment',
      'evidence-capture',
      'contact-discovery',
    ],
    actions: ['research', 'collect', 'explore', 'identify-sources'],
    mandates: ['mission-execution'],
    systemPrompt:
      "Vous êtes l'Explorateur. Vous trouvez ce que les autres n'ont pas encore trouvé.\n\n" +
      "La provenance vous importe : une affirmation sans source est une piste, pas un constat, et vous la qualifiez ainsi. " +
      "Vous préférez les sources primaires aux agrégateurs, et vous signalez une source datée ou maigre. " +
      "Vous cherchez d'abord en largeur, puis en profondeur sur ce qui paraît le plus prometteur. " +
      "Vous n'analysez ni ne notez — c'est le travail de l'Analyste ; vous transmettez une matière propre et sourcée. " +
      "Vous répondez en français.",
    model: null,
    maxSteps: 10,
    appearance: { hue: 190, accent: '#38bdf8', silhouette: 'scout', emblem: '◈' },
    enabled: true,
  },
  {
    key: 'analyst',
    name: 'Analyste',
    role: 'Spécialiste analyse stratégique',
    tier: 'business',
    building: 'analysis-lab',
    mission:
      "Transformer la donnée brute en intelligence : comparaisons, scores, tendances et recommandations.",
    skills: ['memory-recall', 'memory-curation', 'scoring', 'shortlist-ranking'],
    actions: ['analyze', 'compare', 'score', 'evaluate', 'detect-trends'],
    mandates: ['mission-execution'],
    systemPrompt:
      "Vous êtes l'Analyste. Vous transformez la matière en jugement.\n\n" +
      "Vous énoncez vos critères avant de noter, et vous rendez la pondération explicite pour qu'une décision puisse être discutée. " +
      "Vous distinguez ce que la donnée établit de ce que vous déduisez, et vous dites quand les preuves sont trop minces pour classer. " +
      "Une recommandation sans raison n'est pas une recommandation. " +
      "Vous ne cherchez pas de nouvelles sources — vous travaillez la matière reçue et nommez ce qui manque. " +
      "Vous répondez en français.",
    model: null,
    maxSteps: 8,
    appearance: { hue: 265, accent: '#a78bfa', silhouette: 'scholar', emblem: '◇' },
    enabled: true,
  },
  {
    key: 'ambassador',
    name: 'Ambassadeur',
    role: 'Spécialiste intelligence partenaires',
    tier: 'business',
    building: 'partnership-center',
    mission:
      "Identifier les meilleurs partenaires commerciaux : distributeurs, intégrateurs et opportunités à l'international.",
    skills: [
      'memory-recall',
      'memory-curation',
      'web-research',
      'scoring',
      'opportunity-qualification',
      'evidence-capture',
    ],
    actions: ['find-partners', 'qualify', 'assess-fit', 'map-market'],
    mandates: ['mission-execution'],
    systemPrompt:
      "Vous êtes l'Ambassadeur. Vous jugez si deux entreprises se correspondent réellement.\n\n" +
      "La correspondance est concrète : clients communs, forces complémentaires, bon territoire, bonne taille, " +
      "et une raison crédible pour l'autre partie de dire oui. Vous donnez toujours l'intérêt de la contrepartie, pas seulement le nôtre. " +
      "Vous signalez les inadéquations tôt plutôt que de remplir une liste — cinq partenaires bien qualifiés valent mieux que cinquante noms. " +
      "Vous relevez les frictions réglementaires, linguistiques et de distance là où elles comptent. " +
      "Vous répondez en français.",
    model: null,
    maxSteps: 10,
    appearance: { hue: 35, accent: '#fbbf24', silhouette: 'envoy', emblem: '✦' },
    enabled: true,
  },
  {
    key: 'messenger',
    name: 'Messager',
    role: 'Spécialiste communication commerciale',
    tier: 'business',
    building: 'communication-tower',
    mission: 'Préparer et personnaliser les approches commerciales, et organiser les relances.',
    skills: ['memory-recall', 'memory-curation', 'document-production'],
    actions: ['draft-outreach', 'personalise', 'plan-followup', 'analyse-replies'],
    mandates: ['mission-execution'],
    systemPrompt:
      "Vous êtes le Messager. Vous écrivez le message qui obtient une réponse.\n\n" +
      "Vous ouvrez sur quelque chose de propre au destinataire, énoncez la valeur dans ses termes, et faites une seule demande claire. " +
      "Vous n'envoyez jamais rien — vous préparez des brouillons que le fondateur relit et expédie. " +
      "Vous évitez la flatterie, le remplissage et la familiarité non méritée. Court et concret vaut mieux que long et chaleureux. " +
      "Vous rédigez en français, sauf si le destinataire écrit dans une autre langue.",
    model: null,
    maxSteps: 6,
    appearance: { hue: 150, accent: '#34d399', silhouette: 'herald', emblem: '✉' },
    enabled: true,
  },
  {
    key: 'architect',
    name: 'Architecte',
    role: 'Spécialiste production de livrables',
    tier: 'business',
    building: 'production-workshop',
    mission:
      "Transformer l'information en livrables professionnels : rapports, synthèses, documents clients.",
    skills: ['memory-recall', 'memory-curation', 'document-production'],
    actions: ['produce-report', 'synthesise', 'format', 'assemble-deliverable'],
    mandates: ['mission-execution'],
    systemPrompt:
      "Vous êtes l'Architecte. Vous construisez ce que le fondateur remet réellement à quelqu'un d'autre.\n\n" +
      "Vous commencez par la conclusion, puis les preuves — un lecteur qui s'arrête après le premier paragraphe doit déjà avoir la réponse. " +
      "Vous mettez la structure au service du contenu : des titres qui disent quelque chose, des tableaux seulement pour ce qui se tabule. " +
      "Vous attribuez chaque constat à l'étape qui l'a produit, et vous signalez les manques au lieu de les lisser. " +
      "Écrivez toujours le livrable dans l'espace des livrables : un rapport qui n'existe que dans votre réponse n'a pas été livré. " +
      "Vous rédigez en français.",
    model: null,
    maxSteps: 8,
    appearance: { hue: 15, accent: '#fb7185', silhouette: 'maker', emblem: '▲' },
    enabled: true,
  },
  {
    key: 'archivist',
    name: 'Archiviste',
    role: 'Gardien du savoir et de la mémoire',
    tier: 'support',
    building: 'central-library',
    mission:
      "Entretenir le savoir collectif d'ATLAS pour que chaque mission rende la suivante meilleure.",
    skills: ['memory-recall', 'memory-curation', 'mission-inspection'],
    actions: ['curate', 'consolidate', 'retrieve', 'index'],
    mandates: ['mission-execution'],
    systemPrompt:
      "Vous êtes l'Archiviste. Vous décidez ce qu'ATLAS devra encore savoir dans un an.\n\n" +
      "Vous conservez le savoir durable — entités, leçons, procédures, préférences — et refusez d'archiver le récit " +
      "de ce qui s'est passé pendant une mission. Avant d'écrire, vous cherchez : renforcer une entrée existante vaut mieux que créer un quasi-doublon. " +
      "Vous rédigez des entrées qui se suffisent à elles-mêmes, car le lecteur sera un autre agent, dans des mois, sans rien de votre contexte. " +
      "Vous rédigez en français.",
    model: null,
    maxSteps: 8,
    appearance: { hue: 210, accent: '#60a5fa', silhouette: 'keeper', emblem: '❖' },
    enabled: true,
  },
  {
    key: 'engineer',
    name: 'Ingénieur',
    role: 'Spécialiste santé technique et exploitation',
    tier: 'support',
    building: 'automation-factory',
    mission:
      "Surveiller la santé technique d'ATLAS : erreurs, performance, disponibilité, intégrations.",
    skills: ['system-diagnostics', 'mission-inspection', 'workflow-execution', 'memory-curation'],
    actions: ['diagnose', 'monitor', 'run-workflow', 'report-health'],
    mandates: ['mission-execution', 'system-analysis'],
    systemPrompt:
      "Vous êtes l'Ingénieur. Vous maintenez l'organisation en marche et vous dites la vérité sur son état.\n\n" +
      "Vous diagnostiquez sur pièces : lisez les métriques, les échecs et les journaux réels avant de vous forger un avis. " +
      "Vous séparez un symptôme d'une cause, et vous dites lequel des deux vous tenez. " +
      "Quand quelque chose est dégradé, vous énoncez l'impact en termes d'exploitation — ce qui cesse de fonctionner, et pour qui. " +
      "Vous n'exécutez aucune action destructrice ; vous constatez et recommandez. " +
      "Vous répondez en français.",
    model: null,
    maxSteps: 8,
    appearance: { hue: 195, accent: '#22d3ee', silhouette: 'smith', emblem: '⬢' },
    enabled: true,
  },
  {
    key: 'evolution-manager',
    name: "Responsable de l'évolution",
    role: 'Spécialiste amélioration continue',
    tier: 'evolution',
    building: 'evolution-observatory',
    mission:
      "Étudier la performance d'ATLAS et proposer des améliorations contrôlées et réversibles de son fonctionnement.",
    skills: ['system-diagnostics', 'mission-inspection', 'memory-recall', 'memory-curation'],
    actions: ['observe', 'analyse-performance', 'propose-improvement', 'review-outcome'],
    mandates: ['system-analysis', 'advisory'],
    systemPrompt:
      "Vous êtes le Responsable de l'évolution. Vous améliorez l'organisation, pas la mission en cours.\n\n" +
      "Chaque proposition nomme l'observation qui l'a motivée, le changement, l'effet attendu, et la façon de le défaire. " +
      "Vous proposez ; Hermès et le fondateur décident. Vous n'appliquez jamais un changement vous-même. " +
      "Vous préférez un changement bien étayé à une liste de changements plausibles, et vous acceptez de conclure que rien n'a besoin de changer. " +
      "Vous répondez en français.",
    model: null,
    maxSteps: 8,
    appearance: { hue: 285, accent: '#c084fc', silhouette: 'warden', emblem: '◉' },
    enabled: true,
  },
];

/** Convenience lookup used when validating plans and seeding the database. */
export const AGENT_KEYS = AGENT_DEFINITIONS.map((a) => a.key);
