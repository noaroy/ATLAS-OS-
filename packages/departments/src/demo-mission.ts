/**
 * La mission de démonstration locale.
 *
 * Une seule, nommée, reproductible. Elle existe pour prouver l'orchestration —
 * qu'Hermès reçoit un objectif, construit un plan, assigne des étapes, fait
 * évoluer l'état des agents, récolte les résultats et conclut — et pour rien
 * d'autre. Elle ne prouve rien d'un marché : ses candidats sont fabriqués et
 * portent la marque `[SIMULÉ]` jusque dans leur nom.
 *
 * Deux garanties tiennent, et elles sont structurelles.
 *
 * La première : elle est refusée en mode réel. Une démonstration qui pourrait
 * partir sur de l'inférence facturée n'est plus une démonstration, c'est une
 * dépense déclenchée par un bouton. Le refus vit dans la route, pas dans une
 * consigne d'interface.
 *
 * La seconde : tout ce qu'elle produit est étiqueté. Le titre, les marqueurs,
 * le contexte — de sorte qu'aucune ligne issue de cette mission ne puisse être
 * confondue plus tard avec un résultat de terrain.
 */

export const DEMO_MISSION_TAG = 'demo';

export interface DemoMissionSpec {
  title: string;
  objective: string;
  context: Record<string, unknown>;
  priority: 'low' | 'normal' | 'high' | 'critical';
  tags: string[];
  departmentKey: string;
  autoStart: boolean;
}

export const DEMO_MISSION: DemoMissionSpec = {
  title: 'DEMO — Business Expansion',
  objective:
    "DÉMONSTRATION LOCALE. Identifier et qualifier des partenaires de distribution en Allemagne " +
    "pour un fabricant français de machines d'emballage industriel, puis produire une shortlist " +
    'argumentée. Cette mission sert à démontrer le fonctionnement de la chaîne ATLAS : les ' +
    'organisations qu’elle rapporte sont fabriquées et ne doivent jamais être présentées à un tiers.',
  context: {
    // Lu par les outils : le brief s'appuie dessus pour cadrer la recherche.
    sector: "machines d'emballage industriel",
    origin: 'France',
    targetMarket: 'Allemagne',
    companySize: '80 personnes, 14 M€ de chiffre d’affaires',
    // Lu par un humain, et par l'interface qui l'affiche en bandeau.
    demonstration: true,
    dataNature: 'SIMULATION — aucune recherche réelle, aucune organisation réelle',
  },
  priority: 'normal',
  tags: [DEMO_MISSION_TAG, 'simulation', 'business-expansion'],
  departmentKey: 'business-expansion',
  autoStart: true,
};
