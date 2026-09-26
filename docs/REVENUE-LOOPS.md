# Les deux boucles revenue

```
BOUCLE A — fabrique de revenu (REVENUE_FACTORY, toutes les 30 min, déterministe, 0 $)
  découverte (lot, expansion) → contact lu sur le site officiel → 2 faits sourcés
  → recommandations du graphe du prospect (2 à 3 ou aucune) → dédoublonnage
  → score → HOT · WARM · NEEDS_ENRICHMENT · DROP · DUPLICATE · BLOCKED  (+ send_eligible)

BOUCLE B — envoi contrôlé (SALES_SEND, toutes les 10 min)
  SEND_ELIGIBLE → mail personnalisé → porte qualité → approbation → politique d'envoi
  → réservation exactement-une-fois → transport → réponses (SALES_REPLY_CHECK)
  → état commercial : READY · QUEUED · PAUSED · SENT · DELIVERED · FAILED · BOUNCED
    · REPLIED · POSITIVE_REPLY · NEGATIVE_REPLY · MEETING · PROPOSAL · WON · LOST · SUPPRESSED
```

## Boucle A

- **Code** : `packages/runtime/src/revenue-factory.ts`, tâche `REVENUE_FACTORY`
  servie par le worker déterministe du serveur (aucun script, aucun modèle).
- **Persistance** : migration 40 — `revenue_factory_verdicts` (un verdict par
  domaine canonique), `revenue_factory_events` (audit, jamais réécrit),
  `revenue_factory_runs` (chaque tour). `initial_score`, `first_classification`
  et `first_processed_at` ne sont écrits qu'une fois : c'est la base de la
  boucle de retour (score prédit vs issue réelle, par domaine).
- **Règles** :
  - contact : uniquement lu sur une page du domaine officiel ; jamais une
    adresse déduite d'une convention ; webmail et boîtes RGPD/support exclus ;
  - faits : arrêt dès deux faits distincts ; un fait n'est rangé `verbatim:`
    (donc citable au destinataire) que s'il se relit mot pour mot dans la page ;
  - recommandations : `registryRecommendationsFor` — relations VERIFIED, source
    OFFICIAL, commerciales, jamais le prospect ni ses sous-domaines, jamais
    COMPETITOR/SIMILAR_COMPANY ; moins de deux → NEEDS_ENRICHMENT et une
    expansion ciblée sur le prospect (une par prospect et par 3 jours) ;
  - score : la qualification existante n'est jamais réécrite ; sinon un score
    déterministe sur les seuls signaux observés (aucune dimension n'est
    affirmée sans signal) ;
  - campagne : héritée du segment de la graine qui a fait découvrir
    l'entreprise ; sinon rien n'est deviné et la politique d'envoi bloque ;
  - capacité inoccupée : file presque vide → une expansion générale, au plus
    une par 6 h (si `ATLAS_SALES_DISCOVERY_ENABLED`).
- **Débit** : 12 entreprises par tour × 48 tours/jour = 576/jour de capacité.
  Le volume réel est borné par ce que la découverte verse.

## Boucle B

- `materializeFirstTouchDrafts` ne rédige plus que les domaines que la
  fabrique a déclarés `send_eligible` (motif `FACTORY_NOT_ELIGIBLE` sinon).
- **Porte qualité** (`validateOutreachDraft`) avant la file et au moment de
  partir : destinataire lu sur le site, ≥ 2 recommandations citées et
  sourcées, provenance complète, personnalisation réelle, aucune intention
  d'achat affirmée hors citation, pas de gabarit, longueur. Un refus renvoie
  le dossier en NEEDS_ENRICHMENT avec le motif ; à l'envoi il ferme le
  brouillon.
- Une réponse rapprochée « à relire » (NEEDS_REVIEW) arrête désormais aussi
  premiers contacts et relances.
- **État commercial** : `commercialStateOf` le dérive de ce qui est consigné,
  sans nouvel état stocké. DELIVERED est une inférence (envoi sans rebond
  depuis 24 h) — Gmail ne confirme pas la remise.

## Variables

| Variable | Rôle | Valeur actuelle attendue |
|---|---|---|
| `ATLAS_OUTBOUND_ENABLED` | interrupteur général de l'envoi | `false` |
| `ATLAS_ENGINE_MODE` | `INTERNAL_TEST` ne contacte jamais un vrai prospect | `INTERNAL_TEST` |
| `ATLAS_SALES_ENGINE_ENABLED` | planificateur des deux boucles | `true` |
| `ATLAS_SALES_DISCOVERY_ENABLED` | autorise les expansions posées par la fabrique | `true` |
| `ATLAS_SALES_HUMAN_APPROVAL` | `true` : chaque premier contact attend une personne | `true` |
| `SEARXNG_BASE_URL` / `ATLAS_SEARCH_PROVIDER` | recherche des expansions | configurées |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_USER` | lecture des réponses, puis envoi | présentes |

Aucune nouvelle variable n'est requise par ces boucles.

## Mettre en service (après validation)

```bash
git fetch origin && git checkout <commit>
bash deployment/atlas-cli.sh npm run backup          # sauvegarde de la base canonique
docker compose -f deployment/docker-compose.yml up -d --build atlas
curl -fsS https://<atlas>/healthz                     # la migration 40 s'applique au démarrage
```

## Retour arrière

```bash
git checkout <commit précédent> && docker compose -f deployment/docker-compose.yml up -d --build atlas
# Optionnel — retirer les tables (aucune autre n'en dépend) :
sqlite3 /data/atlas.db "DROP TABLE revenue_factory_events; DROP TABLE revenue_factory_runs;
  DROP TABLE revenue_factory_verdicts; DELETE FROM schema_migrations WHERE version = 40;"
```

Après retour arrière, les tâches `REVENUE_FACTORY` encore en file échouent en
`NO_HANDLER` (échec permanent, sans réessai ni effet sur les autres tâches) ;
la nouvelle migration reste inerte tant que les tables ne sont pas retirées.

## La dernière porte humaine

Envoyer réellement exige, dans cet ordre :

1. approuver pour l'envoi le segment de campagne (`/cc/sales`, founder) ;
2. relire quelques brouillons `READY_FOR_APPROVAL` produits par la boucle B ;
3. `ATLAS_ENGINE_MODE=PRODUCTION` et `ATLAS_OUTBOUND_ENABLED=true`, puis
   redémarrer `atlas` ;
4. garder `ATLAS_SALES_HUMAN_APPROVAL=true` tant que les premiers envois ne
   sont pas relus un par un.
