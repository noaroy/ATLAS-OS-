# Mission client — exécution (ACRN, Suède)

Le chemin déterministe, par lots, reprenable. Rien n'est envoyé ni soumis par
ces commandes : elles produisent des fiches et des rapports. La livraison au
client reste un geste humain.

## 0. Ce que la mission exige

- un moteur de recherche réel qui rend des résultats (le preflight le vérifie ;
  sans lui, il refuse de partir — aucun modèle ne remplace une recherche) ;
- `ATLAS_SEARCH_FALLBACK_ENABLED=false` (le preflight le vérifie aussi) ;
- `ANTHROPIC_API_KEY`, mode `live` ;
- un plafond quotidien : `ATLAS_AI_DAILY_BUDGET_USD=2.00` en développement.

## 1. Preflight

```bash
npm run client:preflight -- --brief=briefs/acrn-sweden.json
```

Verdict `GO` / `NO-GO`. La ligne `recherche` dit `SEARCH_READY` (deux moteurs
rendent des résultats), `SEARCH_DEGRADED` (un seul, sans relève) ou
`SEARCH_BLOCKED` (aucun — la mission ne part pas). Ajouter `--probe-llm` pour
un appel modèle réel (≈ 0,001 $).

La ligne `budget` affiche les plafonds que `batch` appliquera — mission
(`--budget`, défaut 1,00 $), lot (`--batch-budget`, défaut 0,40 $), jour
(`ATLAS_AI_DAILY_BUDGET_USD`). Passer au preflight les mêmes `--budget` et
`--batch-budget` qu'au lot pour voir leurs valeurs. `ATLAS_MAX_MISSION_COST_USD`
ne s'applique pas à ce pipeline.

## 2. Créer et valider le brief

Le brief est `briefs/acrn-sweden.json`. Il est validé à chaque commande. Avant
de lancer ACRN, remplir `competitorExclusions` avec les marques qu'ACRN
confirme comme concurrentes — la liste est volontairement vide dans le brief
actuel.

```bash
npm run client:mission -- start --brief=briefs/acrn-sweden.json
```

Rend l'identifiant de mission `msn_…` — le `<run>` des commandes suivantes.

## 3. Premier lot

```bash
npm run client:mission -- batch --run=<run> --size=20 --budget=1.00 --batch-budget=0.40 --go
```

Sans `--go` : contrôle seul, estimation, aucune dépense. Chaque candidat est
écrit dès qu'il est traité. Coût mesuré : 0,003 à 0,012 $ par candidat lu.

Un lot lit quatre candidats de front (`--concurrency=4`, `1` pour du strict
séquentiel), jamais plus de deux pages à la fois sur un même site. Chaque
site est lu par ses propres liens — accueil, puis contact, produits, marques,
service — deux à quatre pages, jamais un chemin deviné tant que le site en
publie un. Un site qui ne répond pas en dix secondes passe en échec reprenable
sans bloquer les autres ; il a droit à vingt secondes à la reprise.

Ce qui a déjà été lu ou jugé est en mémoire (`page_cache`, quatorze jours ;
`qualification_cache`, trente jours, par société, brief et passages) : une
reprise ou une seconde mission sur les mêmes sites ne relit ni ne repaie ce
qui est su. `--no-cache` contourne les deux. Mesuré sur vingt sociétés
suédoises réelles : 388 s → 54 s, 265 → 83 requêtes, 0,090 → 0,061 $.

À la fin du lot, chaque candidat porte un tri :

- `AUTO_APPROVED` → `RETAINED` : pays prouvé, critères requis établis et
  relus, aucune contradiction, aucun concurrent, note ≥ 70, un canal de
  contact publié — tout, sans exception ;
- `AUTO_EXCLUDED` → `EXCLUDED` : pays prouvé ailleurs, marque concurrente
  citée, annuaire, hors sujet (aucun terme du brief), ou un critère requis
  contredit par un passage relu — la citation est dans la feuille des écartées ;
- `HUMAN_REVIEW` → `REVIEW_REQUIRED` : tout le reste, classé P1 (probablement
  à retenir : il ne manque qu'un pays ou un canal), P2 (ambigu), P3
  (probablement à écarter).

## 4. Progression, revue, mesures

```bash
npm run client:mission -- status --run=<run>
```

```bash
npm run client:mission -- review --run=<run>
```

La file de revue, P1 d'abord : pour chaque société, la raison exacte, deux à
cinq passages relus, le canal, la recommandation, et les deux commandes qui
tranchent (`adjust --keep=…` / `adjust --exclude=…`). Le rapport (§6) écrit
la même file en HTML et CSV (`revue-v<n>-….html`, interne, jamais livrée).

```bash
npm run client:mission -- metrics --run=<run>
```

Les mesures de chaque lot — recherche, filtre, traitement, qualité,
performance — pour comparer un lot à un autre.

## 5. Reprendre après interruption

```bash
npm run client:mission -- batch --run=<run> --resume --go
```

Ne redécouvre rien ; retraite seulement ce qui est en attente ou en échec
reprenable (trois tentatives, puis définitif). Rien n'est repayé.

## 6. Rapport intermédiaire

```bash
npm run client:report -- --run=<run> --partial
```

Écrit `out/client/<run>/rapport-PARTIAL-v1-….html`, `.csv`, `-ecartees.csv`.
La mission reste ouverte.

## 7. Modifier les critères après le retour client

```bash
npm run client:mission -- propose --run=<run> --feedback="trop généralistes ; nous préférons ceux qui assurent le service ; pas la marque X"
```

Traduit le retour du client en proposition de brief v2 — `preferSpecialist`,
concurrents, poids de critères, mots-clés — écrite dans
`out/client/<run>/brief-v<n+1>-proposition.json` avec la commande `adjust`
équivalente. Rien n'est appliqué sans relecture : c'est la commande suivante
qui applique.

```bash
npm run client:mission -- adjust --run=<run> --keep=a.se,b.se --exclude=c.se --competitors="Marque A,Marque B" --keywords=etikettering --notes="trop généralistes"
```

Crée le brief v2. Le travail de la v1 reste en base ; les domaines exclus
sont marqués « écartée à votre demande ».

## 8. Lancer la v2

```bash
npm run client:mission -- batch --run=<run> --size=20 --budget=2.00 --go
```

Même mission, brief v2 : les nouveaux résultats rejoignent les anciens.

## 9. Rapport final, revue, approbation

```bash
npm run client:report -- --run=<run> --final --submit
npm run client:report -- --run=<run> --approve --check=sources-live --check=evidence-coherent --check=translation-faithful --check=opportunities-relevant
```

Les quatre contrôles humains se déclarent à la main après lecture. Rien ne
devient `APPROVED_FOR_DELIVERY` autrement.

## 10. Coût total

```bash
npm run client:mission -- cost --run=<run>
```

## Mode automatique — `client:auto`

Le pilote enchaîne tout ce qui est certain et s'arrête exactement là où le
jugement humain devient utile. Il n'invente rien du pipeline : il appelle le
preflight, la création, les lots, le tri, les rapports — les mêmes briques,
dans le même ordre. Rien n'est envoyé, soumis, contacté ni livré.

```bash
npm run client:auto -- --brief=briefs/<client>.json
```

Sans `--go` : le plan et l'estimation (candidats max, lots, minutes machine,
minutes de revue, coût attendu, plafonds), aucune recherche, aucun appel,
aucune mission créée. Même en automatique, le premier lancement exige `--go`.

```bash
npm run client:auto -- --brief=briefs/<client>.json --go --budget=3.00
```

Preflight (un NO-GO n'est jamais contourné) → mission → lots enchaînés, de
taille adaptative (10–50, montée quand la qualité est bonne, descente au
moindre signe) → reprise automatique des échecs reprenables avec attente →
qualité de lot (GOOD / WARNING / BAD) → rendement de recherche → arrêt propre.
Le pilote s'arrête, et le dit, quand :

| État | Ce qui s'est passé | Votre commande |
|---|---|---|
| `HUMAN_REVIEW_REQUIRED` | plus de 40 % du lot à revoir, 10 dossiers en attente, ou qualité BAD | `npm run client:review -- --run=<run> --interactive` |
| `WAITING_CLIENT_FEEDBACK` | un rapport PARTIAL est écrit (à partir de `--partial-at=10` retenues) | `npm run client:auto -- --run=<run> --feedback="…"` |
| `BRIEF_UPDATE_REQUIRED` | une proposition de brief v(n+1) attend votre relecture | `npm run client:auto -- --run=<run> --approve-brief --go` |
| `FINAL_REVIEW_REQUIRED` | objectif atteint, marché saturé (3 lots sans rien de neuf), ou plafond de lots | `npm run client:auto -- --run=<run> --final` |
| `FINAL_READY` | le rapport FINAL est écrit — pas envoyé | `client:report --approve …` puis `client:auto -- --run=<run> --complete` |
| `PAUSED_BUDGET` | le plafond a arrêté un lot ; rien de perdu | `--budget=<nouveau> --raise-budget --go` |
| `PAUSED_INFRA` | aucun moteur ne répond | réparer, puis `--go` |

Niveaux : `--level=0` MANUAL (recommande, ne lance rien) · `1` ASSISTED (nomme
la prochaine action) · `2` SEMI_AUTO (défaut : lots, reprises, mesures ; pause
pour revue et retour client) · `3` AUTO_MISSION (ne s'arrête que pour une
revue critique, le client, le budget, l'infra).

Ce qui reste toujours humain : la revue, le retour client, l'approbation d'un
brief, un plafond relevé, le rapport final, la clôture, et tout geste
commercial externe.

Suivi, arrêt, reprise :

```bash
npm run client:status -- --run=<run>
```

```bash
npm run client:pause -- --run=<run>
```

Le candidat en cours se termine, l'état est écrit ; `client:auto -- --run=<run>
--go` reprend exactement là. Ctrl+C fait la même chose. Deux exécutants sur
la même mission sont refusés (verrou `out/client/<run>/runner.lock`).

Chaque transition est journalisée dans les événements de la mission ; chaque
lot, revue, brief, PARTIAL et FINAL écrit un instantané dans
`out/client/<run>/snapshots/` et régénère `decisions.jsonl` — une ligne par
société : décision, raison, preuve, règle, version du brief. Bornes : 6 lots
par lancement, 12 par mission, 45 minutes par lancement, 3 tentatives par
candidat, l'objectif `maxCandidates` du brief.

L'objectif du brief (`objective.targetRetained`, `targetRetainedMin`,
`maxCandidates`) est une cible, pas une promesse : si le marché ne porte que
douze bonnes sociétés, la mission s'arrête à douze.

## Dry-run gratuit

```bash
npm run client:dryrun
```

Fixtures, aucun réseau, aucun modèle : écrit `out/client-dryrun/` avec un
PARTIAL, un FINAL et les écartées — les documents mêmes, à ouvrir.

## Ce que le pipeline garantit

- Ce que le client lit sur une société vient de ses pages : citation relue au
  numéro de passage, jamais une phrase du modèle.
- Un critère sans passage relu est « à confirmer », jamais « établi ».
- Le pays est prouvé (org.nr, TVA, adresse) ou « à vérifier » ; jamais déduit
  de l'extension ni de la langue.
- Une marque concurrente citée écarte la société — avec la phrase et la page.
- Les contacts sont ceux publiés ; une personne n'apparaît que si elle est
  nommée sur le site.
- Un candidat terminé n'est jamais retraité ; un lot interrompu reprend.
- Une société n'est approuvée seule que si un humain n'aurait rien à
  vérifier ; une exclusion automatique se relit toujours à sa citation.
- Le modèle interprète, il ne cherche pas : il reçoit les faits relevés
  (identifiant, adresse, courriels) et au plus soixante passages choisis,
  numérotés comme le catalogue entier — une relecture au numéro trouve le
  même texte.
