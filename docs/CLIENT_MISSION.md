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
