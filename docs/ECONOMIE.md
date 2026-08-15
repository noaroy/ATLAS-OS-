# Sûreté économique

ATLAS dépense de l'argent réel à chaque appel au modèle. Ce document décrit ce
qui empêche une panne de coûter cher, et ce qui permet de savoir où l'argent est
parti.

Tout ce qui suit vient d'un incident daté.

---

## L'incident fondateur — LIVE #001

Le 8 août 2026, la mission `M-0EF6B` a cherché des distributeurs et intégrateurs
allemands pour un fabricant français de lignes d'emballage.

| | |
|---|---|
| Coût | **9,15 $** |
| Jetons | **1 524 676** pour un budget de 400 000 (**+281 %**) |
| Durée | 18 min 10 |
| Candidats trouvés | **0** |
| Statut technique | `completed` |

La chaîne causale :

1. Le schéma de découverte contenait `maxItems`. L'API de sortie structurée
   d'Anthropic ne l'accepte pas et **rejetait la requête entière en 400**, avant
   toute inférence. Quatorze rejets au journal.
2. Faute de résultats, l'étape de découverte s'est terminée **avec succès** en
   rapportant honnêtement qu'elle n'avait rien trouvé. Aucune entreprise
   inventée — le garde-fou anti-fabrication a tenu.
3. L'enrichissement dépendait de la découverte. Celle-ci ayant *réussi*,
   l'enrichissement a été lancé — sur une liste vide.
4. Privé d'entrée, l'agent a improvisé : recherche manuelle, lecture de sites,
   rédaction de fiches en prose. **715 secondes, 1 372 673 jetons — 343 % du
   budget de la mission entière, dans une seule étape**, pour un travail qui
   n'est jamais entré dans le pipeline.

Le plafond de 400 000 jetons existait. Il n'a rien empêché : il n'était consulté
**qu'entre les étapes**. Une étape déjà lancée allait jusqu'au bout.

> Un plafond qu'on ne vérifie qu'après coup n'est pas un plafond, c'est un
> constat.

---

## Les quatre niveaux de protection

```
MISSION    jetons et dollars, tout compris
   ↓
ÉTAPE      jetons et nombre d'appels
   ↓
APPEL      plafond de sortie, refusé s'il ne tient pas dans le reste
   ↓
BOUCLE     coupe-circuit sur répétition anormale
```

### Où le contrôle vit

Sous les appels, pas au-dessus. `BudgetedProvider` décore le fournisseur
d'inférence : le runtime des agents, le planificateur, l'extraction de brief et
la recherche web appellent tous `complete()`, donc tous sont plafonnés — **y
compris ceux qui n'existent pas encore**.

C'est le déplacement qui compte. Un contrôle placé dans l'orchestrateur exige
que chaque appelant pense à le consulter ; un contrôle placé sous les appels ne
laisse plus d'oubli possible, seulement une fraude délibérée.

### L'autorisation raisonne sur le pire cas

Entrée estimée plus sortie pleine. Un plafond calculé sur une consommation
moyenne serait dépassé une fois sur deux — ce n'est pas un plafond non plus.

Le refus lève `BUDGET_EXCEEDED`, **non réessayable** : réessayer coûterait
exactement ce que le refus vient d'éviter. L'orchestrateur traite ce refus comme
un arrêt net — étape `cancelled`, pas `failed`, aucun retry, mission close
proprement.

### Les réglages

| Variable | Défaut | Ce qu'elle empêche |
|---|---|---|
| `ATLAS_MISSION_TOKEN_BUDGET` | 400 000 | Une mission sans fin |
| `ATLAS_MAX_MISSION_COST_USD` | 5 | Le seul plafond qui parle la langue de la facture |
| `ATLAS_MAX_STEP_TOKENS` | 120 000 | Qu'une étape absorbe la mission |
| `ATLAS_MAX_LLM_CALLS_PER_STEP` | 12 | Un agent qui boucle |
| `ATLAS_MAX_OUTPUT_TOKENS_PER_CALL` | 16 000 | Une réponse qu'on ne peut plus interrompre |
| `ATLAS_CIRCUIT_BREAKER_FAILURES` | 3 | Une panne répétée à vos frais |

Le plafond d'étape effectif est le plus petit entre `ATLAS_MAX_STEP_TOKENS` et
**le tiers du budget de la mission** : c'est ce rapport qui manquait.

Dans le runtime des agents, deux bornes supplémentaires : un même appel d'outil
rejoué trois fois à l'identique est refusé, et cinq échecs d'outil consécutifs
closent la boucle. Dans les deux cas l'agent est invité à conclure avec ce qu'il
a, plutôt que d'être interrompu brutalement.

---

## Préconditions : ne pas lancer une étape sans matière

`dependsOn` répond à « l'étape amont s'est-elle terminée ? ». C'est une question
de séquence, et LIVE #001 a montré qu'elle ne suffit pas.

Une **précondition** répond à l'autre question : « la matière est-elle là ? »

```ts
preconditions: [
  { kind: 'pipeline-count', minCount: 1, because: "Aucun candidat n'a été découvert" },
]
```

Non satisfaite, l'étape passe en `skipped` avec `SKIPPED_NO_INPUT`, **sans
qu'aucun appel au modèle ne soit émis**. C'est un concept de plateforme : tout
workflow ATLAS peut en déclarer, pas seulement les départements.

Deux formes :

| `kind` | Vérifie |
|---|---|
| `upstream-output` | Les étapes citées ont produit un résultat exploitable |
| `pipeline-count` | Le pipeline contient assez d'éléments actionnables |

Seule la **première** étape privée de matière porte `SKIPPED_NO_INPUT` ; les
suivantes tombent par cascade de dépendance. Les marquer toutes « sans entrée »
masquerait laquelle a réellement manqué de quelque chose.

### Le second garde-fou

Une étape qui *démarre* malgré une amont en échec reçoit dans son briefing la
liste de ce qui manque, et l'interdiction explicite d'en refaire le travail :

> **Ne refaites pas leur travail.** [...] Un constat d'absence est un résultat
> valable.

Un agent consciencieux comble un vide. C'est à l'orchestrateur de lui dire que
ce vide ne le regarde pas.

---

## Issue de mission

Le statut dit où en est une mission ; il ne dit pas si elle a servi à quelque
chose. LIVE #001 est resté `completed`.

| Issue | Sens |
|---|---|
| `success` | Toutes les étapes ont abouti |
| `partial` | Des étapes ont échoué ou été sautées, mais il reste du résultat |
| `no-result` | Le pipeline s'est arrêté honnêtement, sans rien trouver |
| `failed` | La mission n'a pas pu produire de résultat |
| `cancelled-budget` | Un plafond économique a arrêté la mission |

`no-result` est délibérément distinct de `failed` : **une recherche honnête qui
ne trouve aucun candidat suffisamment documenté a bien fonctionné**. Les
confondre pousserait exactement au comportement qu'ATLAS refuse — remplir la
liste pour avoir l'air d'avoir réussi.

---

## Télémétrie

### Par appel — table `llm_calls`

Fournisseur, modèle, agent, mission, étape, intention, jetons d'entrée, de
sortie, de lecture et d'écriture de cache, coût, durée, succès ou échec, nombre
d'outils utilisés.

**La table décrit ce qu'un appel a coûté, jamais ce qu'il contenait** : ni
requête, ni réponse, ni en-tête, ni clé. Un test le vérifie.

### Par appel d'outil — table `tool_calls`

`agent.tool` est publié en sévérité `debug`, que le journal d'événements écarte
pour rester lisible. Un outil qui *réussissait* ne laissait donc aucune trace, et
`externalCalls` ne comptait que les échecs — LIVE #001 rapportait « 5 appels
externes » précisément parce que les cinq avaient échoué.

Une table dédiée plutôt qu'une promotion du niveau de log : on mesure sans noyer
le journal. Nom, mission, étape, agent, durée, issue. Jamais les arguments.

### Par étape et par modèle

`repos.llmCalls.byStep()` et `byModel()` — l'étape la plus chère en tête. C'est
la ventilation qui manquait : sans elle, impossible de dire si router vers un
modèle moins cher change quoi que ce soit.

### Par mission

`missionEconomics()` porte un champ `measured` avec la décomposition complète,
plus les coûts unitaires par candidat découvert, qualifié et retenu.

`measured` vaut `null` pour les missions antérieures à la télémétrie. **LIVE
#001 garde ainsi le chiffre sous lequel il a été constaté** plutôt qu'un coût
recalculé après coup avec une répartition entrée/sortie qu'on n'a jamais
mesurée.

### Tarification

`packages/llm/src/pricing.ts` porte les tarifs entrée / sortie / cache par
modèle. Un modèle sans tarif connu rend `null` plutôt qu'une estimation
inventée — et reste plafonné en jetons, sans quoi il contournerait toute la
protection.

Les jetons lus en cache sont comptés à leur propre tarif et retirés de l'entrée
facturable : les compter deux fois gonflerait le coût des missions qui
bénéficient le mieux du cache.

---

## Schémas de sortie structurée

L'API de sortie structurée n'accepte qu'un sous-ensemble de JSON Schema et
**rejette la requête entière** dès qu'un mot-clé n'est pas supporté.

`packages/llm/src/json-schema.ts` applique une **liste blanche** de mots-clés
structurels. Nous n'avons observé qu'un seul refus réel (`maxItems`) ; deviner
la liste noire complète reviendrait à réintroduire le même risque au prochain
mot-clé.

Deux pièces complémentaires :

- `validateStructuredSchema` — utilisée par les tests. Un schéma incompatible
  casse la CI, pas une mission facturée.
- `sanitiseStructuredSchema` — appliquée par le fournisseur juste avant l'envoi.
  Un mot-clé passé au travers des tests coûte une validation en moins, jamais
  une mission entière.

Les contraintes de taille qui portaient une consigne utile ont été déplacées
dans `description`, où elles guident le modèle au lieu de faire rejeter la
requête.

**Ne concerne que `output_config.format`.** Les schémas d'entrée d'outils
passent par `tools[].input_schema`, qui accepte le JSON Schema ordinaire — ils
fonctionnaient pendant LIVE #001.

---

## Délais de garde — l'incident LIVE #002

Le 9 août 2026, `M-5R4VB` s'est figée. L'appel de recherche web est resté en vol
**1 284 secondes** sous un délai d'étape de 300, et la mission n'a jamais rendu
la main : il a fallu l'annuler à la main.

La cause n'était pas un délai mal réglé. `withTimeout` place une course entre la
promesse et une minuterie — le perdant est **ignoré, jamais interrompu**. L'appel
continuait donc à consommer socket, contexte et budget, et la mission restait
suspendue à son résultat. Et ce délai n'enveloppait que l'inférence propre de
l'agent, jamais l'exécution de ses outils.

> La course *abandonne* une promesse qui continue. L'annulation *arrête* le
> travail.

`withDeadline` transmet un `AbortSignal` au travail et le déclenche. Quatre
niveaux emboîtés, chacun annulant réellement :

| Niveau | Variable | Couvre |
|---|---|---|
| Outil | `ATLAS_TOOL_TIMEOUT_MS` | Une exécution d'outil, réseau compris |
| Fournisseur | `ATLAS_PROVIDER_TIMEOUT_MS` | Un appel d'inférence ou de découverte |
| Étape | `ATLAS_TASK_TIMEOUT_MS` | Une étape complète |
| Mission | `ATLAS_MISSION_TIMEOUT_MS` | L'enlisement — des appels légitimes qui n'aboutissent jamais |

Le signal transmis combine la borne locale et celle de l'appelant : une
annulation de mission descend jusqu'au fournisseur sans que chaque niveau ait à
la relayer. Un appelé qui ignorerait son signal ne peut pas figer la mission
pour autant — passé un délai de grâce, la main est rendue et le manquement
journalisé.

---

## Budget adaptatif

LIVE #002 a montré l'absurdité d'un plafond purement validant. Sous 1,00 $, un
appel `opus-5` demandant 16 000 jetons de sortie coûtait au pire 1,22 $ et était
refusé — **non pas une fois, mais toujours**, quel que soit le solde. Hermès
était devenu structurellement muet.

La bonne réponse n'est pas de relever le plafond, c'est de demander une réponse
plus courte. Avant chaque appel, ATLAS calcule ce que le budget restant permet
réellement de produire :

```
budget restant − coût de l'entrée
─────────────────────────────────  =  jetons de sortie finançables
        tarif de sortie
```

Le plafond appliqué est le plus petit de trois nombres : ce que l'appelant
demande, le plafond global, et ce qui est finançable. En dessous de
`ATLAS_MIN_VIABLE_OUTPUT_TOKENS`, l'appel est refusé plutôt que rétréci — payer
une réponse coupée en deux est un gaspillage complet.

Le seuil ne s'applique **que si c'est le budget qui a rétréci la sortie**. Un
appelant qui demande délibérément un verdict d'un mot a le droit de l'obtenir.

---

## Niveaux de raisonnement d'Hermès

Hermès tournait sur le modèle premium pour tout — lire un formulaire déjà rempli
comme arbitrer une replanification.

| Niveau | Décisions | Modèle |
|---|---|---|
| `routine` | Structurer un objectif en brief | Modèle rapide |
| `complex` | Décomposer, rendre compte | Modèle rapide, **effort supérieur** |
| `strategic` | Reconsidérer un plan après échec | Modèle premium |

`complex` monte l'effort plutôt que le modèle : sur les modèles actuels, la
profondeur de réflexion rattrape l'essentiel de l'écart à une fraction du prix.
Le premier réflexe n'est plus le plus cher, mais l'escalade reste disponible.

**Et surtout : un brief entièrement déclaré ne coûte rien.** Quand le formulaire
couvre déjà tout ce que le département exige, aucun modèle n'est appelé — il
reformulerait des informations que le fondateur vient de fournir, et le résultat
serait de toute façon écrasé par les champs déclarés, qui l'emportent toujours.

Un tableau vide compte comme rempli : « aucun critère disqualifiant » est une
réponse délibérée, pas une case oubliée.

---

## Bornes de recherche

Chaque recherche et chaque page rapportée entre dans le contexte et y reste pour
tous les tours suivants. La dépense n'est pas celle de la requête, c'est celle du
contexte qu'elle laisse derrière elle.

| Variable | Défaut |
|---|---|
| `ATLAS_MAX_WEB_SEARCHES_PER_DISCOVERY` | 6 |
| `ATLAS_MAX_PAGE_FETCHES_PER_CANDIDATE` | 2 |
| `ATLAS_MAX_TOTAL_PAGE_FETCHES_PER_MISSION` | 20 |

Le nombre effectif de recherches suit l'objectif — une par candidat visé plus
deux de marge, borné par la configuration. Viser deux candidats en déclenche
quatre, pas six. Le plafond de pages est compté **sur la mission**, non sur
l'étape : un plafond par étape se contournerait en répartissant les
récupérations.

---

## Ce qui reste à mesurer

La baseline de LIVE #001 est inexploitable pour arbitrer une optimisation : elle
n'a qu'un total de jetons. La télémétrie décrite ici est le préalable à toute
comparaison — Ollama, modèles moins chers, routage, cache de prompt.

**Aucune de ces optimisations n'a été faite.** L'architecture est d'abord
économiquement sûre ; la comparaison viendra ensuite, sur des chiffres
décomposables.
