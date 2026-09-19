# ATLAS — guide de l'opérateur

Une page. Ce qu'il faut savoir pour faire tourner ATLAS 24 h/24 sur un VPS,
lire ce qu'il fait, et décider ce qu'il a le droit de faire.

## Ce qui tourne

Un seul processus : le serveur (`dist/server/atlas.mjs`). Il porte l'API, la
console, le superviseur (cron internes) et le **daemon embarqué** qui exécute
les cycles du moteur commercial. Sur le VPS, il tourne dans un conteneur
(`atlas`) à côté du moteur de recherche SearXNG (`searxng`), les deux portés
par Docker Compose. La base SQLite vit dans le volume `atlas-data` (`/data`).
Rien d'autre.

| Cycle | Cadence | Ce qu'il fait | Ce qu'il ne fait jamais |
|---|---|---|---|
| Lecture de la boîte | 15 min | importe les réponses Gmail (lecture seule), classe l'intention, annule les relances, supprime les opt-out | répondre |
| Envoi | 10 min | envoie les brouillons **approuvés** si la politique l'autorise | envoyer sans approbation, hors fenêtre, en pause, en INTERNAL_TEST |
| Relances | 06:00 UTC | marque les relances dues (J+3 ouvrés, une seule) | envoyer une relance sans approbation |
| Découverte | 05:00 UTC | lance `sales-batch` (recherche → ICP → qualification → contacts → brouillons) sur le segment du jour | dépasser le budget IA du jour |
| Mesures | 1 h | rebonds → pause automatique ; frictions → insights | — |
| Recommandations | 07:00 UTC | propose SCALE / REDUCE / PROMOTE… avec seuils d'échantillon | appliquer seul |

Chaque cycle est une tâche à clé de période : un redémarrage ne rejoue rien,
un plantage laisse un bail qui expire et la tâche est reprise — sans doublon
d'envoi (place exactement-une-fois `outbound_sends`).

## Les interrupteurs, du plus fort au plus fin

1. `ATLAS_OUTBOUND_ENABLED=false` (défaut) — aucun message réel, quoi qu'il arrive.
2. `ATLAS_ENGINE_MODE=INTERNAL_TEST` (défaut) — aucun vrai prospect contacté.
3. **PAUSE ATLAS** — `npm run sales:pause -- --reason="…"` ou le bouton du
   tableau de bord. Levée par `npm run sales:resume` / RESUME. Posée toute
   seule quand le taux de rebonds dépasse `ATLAS_SALES_BOUNCE_PAUSE_RATE`.
4. Chaque campagne (segment) exige `APPROVED_FOR_SEND` :
   `npm run sales:campaign -- approve <segmentId>`.
5. La liste de suppression (opt-out, rebond, manuel, légal) survit à tout.
6. Fenêtre `ATLAS_SALES_SEND_WINDOW`, plafonds jour/heure, délai minimal,
   week-end : `.env.example` les documente.

Ouvrir l'envoi réel = poser **les deux** premières valeurs dans `.env`, avoir
un segment approuvé, la portée Gmail d'envoi accordée, et redémarrer.

## Commandes

> **En production (VPS), toute commande passe par `bash deployment/atlas-cli.sh …`.**
> `npm run client:mission …`, `npm run atlas:status`, `npm run backup` lancés
> depuis l'hôte du dépôt déployé sont **refusés** (garde de base canonique) :
> ils ouvriraient une seconde base hors du volume Docker. Les commandes
> `npm run …` ci-dessous valent pour un poste de développement ; sur le VPS,
> remplacer `npm run <x:y> --` par `bash deployment/atlas-cli.sh <x-y>`.

```bash
npm run atlas:status        # ATLAS ONLINE ? Daemon · Search · LLM · Gmail · Database · Outbound · Dashboard
npm run sales:status        # la page unique, en texte (--range=7d|30d|all)
npm run sales:campaign -- list | create --name=… --countries=FR --keywords="a|b" | approve <id> | pause <id>
npm run sales:campaign -- outcome <domaine> --kind=MEETING_BOOKED|MEETING_DONE|PROPOSAL_SENT|WON|LOST --amount=…
npm run sales:campaign -- suppress <valeur> --kind=EMAIL|DOMAIN|COMPANY
npm run sales:campaign -- decide <recId> test|approve|reject | rollback <versionId>
npm run sales:pause -- --reason="…"   /   npm run sales:resume
npm run client:auto -- --brief=briefs/<client>.json --go   # missions client (V2, inchangé)
npm run atlas:start / atlas:stop     # sur un poste ; sur le VPS : docker compose … start|stop atlas
npm run backup / restore-check / db:check / db:migrate
npm run atlas:production-check       # les gardes, avant chaque bascule : SOFTWARE_READINESS · DEPLOYMENT_READINESS · REAL_WORLD_EVIDENCE ·
                                     # LIVE_DEPLOYMENT_STATUS (observé seulement depuis atlas-cli) · EXTERNAL_INTEGRATIONS
npm run atlas:vps-check              # sur le VPS, lecture seule : système, .env (sans valeurs), conteneurs, réseau, base
```

Les scripts `sales:*`, `client:*`, `backup`, `restore-check` s'exécutent depuis
un **dépôt complet** (`tsx` + `scripts/`). L'image serveur ne contient que
`dist/` : dans le conteneur `atlas`, seuls le serveur et son daemon tournent.
La découverte planifiée, qui lance `scripts/sales-batch.ts`, signale donc
`DISCOVERY_UNAVAILABLE` tant qu'ATLAS tourne en image dist-only — c'est une
friction visible, pas une panne silencieuse.

### Sur le VPS : `atlas-cli`, la seule façon de lancer les outils

**Une seule base en production : `/data/atlas.db` dans le volume Docker
`atlas-os_atlas-data`.** C'est elle que le serveur, le daemon et le tableau de
bord écrivent. Un script lancé depuis l'hôte (`npm run client:mission …` dans
`/opt/atlas`) ouvrirait — ou créerait — `/opt/atlas/data/atlas.db` : une
**seconde base**, silencieuse, sans daemon ni tableau de bord. C'est arrivé ;
la base hôte des benchmarks INTERNAL_TEST est archivée et ne sert plus.

Les outils tournent donc dans un conteneur jetable qui partage le volume, le
réseau, le `.env` et l'utilisateur du serveur :

```bash
bash deployment/atlas-cli.sh --build                 # une fois par version : l'image outils (étape `cli` du Dockerfile)
bash deployment/atlas-cli.sh client-mission start --brief=briefs/internal-test-sweden.json
bash deployment/atlas-cli.sh client-mission batch --run=msn_xxx --size=20 --queries=8 --budget=0.30 --batch-budget=0.30 --concurrency=4 --go
bash deployment/atlas-cli.sh client-mission status --run=msn_xxx
bash deployment/atlas-cli.sh client-review --run=msn_xxx
bash deployment/atlas-cli.sh client-preflight --brief=briefs/internal-test-sweden.json
bash deployment/atlas-cli.sh client-report --run=msn_xxx --partial      # rapport HTML/CSV → out/ sur l'hôte
bash deployment/atlas-cli.sh backup | restore-check | daemon-check | atlas-status | production-check
                                                     # restore-check et daemon-check travaillent sur un instantané : la base canonique ne bouge pas
bash deployment/atlas-cli.sh --print client-mission status --run=msn_xxx   # la commande Docker, sans l'exécuter
```

Dans le conteneur outils, `atlas-status` joint le serveur à `http://atlas:4700`
(le service Compose ; 127.0.0.1 y désignerait le conteneur outils lui-même) :
c'est `ATLAS_INTERNAL_URL`, déduite du contexte, et posable explicitement. La
ligne « Database » doit montrer `/data/atlas.db` — la base canonique.

(`chmod +x deployment/atlas-cli.sh` une fois, et `./deployment/atlas-cli.sh …`
marche aussi.) Ce que le wrapper fait : résout la commande Compose du
déploiement (`--env-file /opt/atlas/.env`, base + override + private s'ils
existent), vérifie que Docker répond, que le volume `atlas-os_atlas-data`
existe — sinon Compose en créerait un vide, avec une base neuve : il refuse —
puis lance `docker compose … run --rm atlas-cli npm run <script> -- <args>`.
Rien n'est publié, rien ne redémarre, le conteneur disparaît avec la commande.
Les briefs se lisent dans `briefs/` (monté en lecture seule), les rapports
s'écrivent dans `out/` sur l'hôte (monté ; l'utilisateur `node`, uid 1000, doit
pouvoir y écrire : `chown 1000 out` ou `chmod 777 out` une fois).

Et si quelqu'un lance quand même un script depuis l'hôte ? Sur le dépôt déployé
— reconnu à `deployment/docker-compose.private.yml` —, `loadConfig` **refuse
d'ouvrir `./data/atlas.db`** et affiche la commande `atlas-cli` à utiliser.
Rien n'est créé. Pour lire volontairement l'archive de l'hôte :
`ATLAS_DB_PATH=/opt/atlas/data/atlas.db npm run atlas:status` (un fichier
choisi), ou `ATLAS_ALLOW_HOST_DB=1`. `npm run atlas:vps-check` signale la
base hôte en WARN si elle existe encore.

Le tableau de bord (session requise) : aujourd'hui `http://127.0.0.1:4700/`
sur le VPS, atteint depuis le poste par un tunnel SSH
(`ssh -L 4700:127.0.0.1:4700 <user>@<vps>` puis `http://127.0.0.1:4700/`) ;
demain derrière Caddy en HTTPS. Une seule page, lisible en cinq secondes :
ATLAS · ● En ligne · 7 jours / 30 jours / Tout ; BUSINESS (RDV, clients, CA
signé, pipeline actif) ; PROSPECTION (entonnoir) ; SEGMENTS ; À FAIRE ; HOT
LEADS ([Ouvrir]) ; AMÉLIORATION ATLAS — une recommandation à la fois, [Oui,
tester] / [Pas maintenant] ; la ligne SYSTÈME. Elle se rafraîchit toute seule
(toutes les 10 s), ne lit que la base réelle, exclut les entrées INTERNAL_TEST
du chiffre, et garde les dernières valeurs affichées quand le serveur ne répond
plus (indicateur « il y a … »). Une valeur non mesurée s'affiche `N/A` ou `—`,
jamais `0`.

## Déployer (VPS Debian 12, Docker Compose)

Le chemin réel, celui qui a mis la v2 en ligne :

```
PC Windows (dépôt Git) → bundle / release → VPS Debian 12 (/opt/atlas)
  → Docker Compose (docker-compose.yml + docker-compose.private.yml, --env-file /opt/atlas/.env)
  → conteneurs atlas + searxng → base persistante (volume atlas-data, /data)
  → tableau de bord sur 127.0.0.1:4700 → tunnel SSH → (plus tard) Caddy HTTPS
```

```bash
# sur le VPS, depuis /opt/atlas (le dépôt à la version voulue)
sudo bash deployment/vps-deploy.sh                 # idempotent : Docker si absent, .env vérifié (sans l'afficher),
                                                   # build de l'image, up -d, healthchecks, UNE recherche SearXNG
# à la main, si l'on préfère voir chaque geste
# les fichiers Compose du VPS : la base du dépôt + l'override privé (liaisons
# 127.0.0.1, hors dépôt). Même liste pour build, up, ps, logs.
COMPOSE="docker compose --env-file /opt/atlas/.env -f deployment/docker-compose.yml -f deployment/docker-compose.private.yml"
$COMPOSE build atlas
$COMPOSE up -d atlas searxng
$COMPOSE ps
$COMPOSE logs -f atlas
bash deployment/vps-check.sh                       # lecture seule : VPS_OK / VPS_OK_WITH_WARNINGS / VPS_ISSUES
                                                   # (charge base + override + private s'ils existent, et le --env-file ;
                                                   #  ATLAS_COMPOSE_FILES=a:b pour imposer la liste ; --compose-command l'affiche)
```

Mettre à jour = amener le dépôt à la nouvelle version (`git fetch` depuis un
bundle ou un dépôt distant, `git checkout <tag>`), puis `build atlas` et
`up -d atlas` : le volume `atlas-data` n'est jamais touché, les migrations
s'appliquent au démarrage. Revenir en arrière = `git checkout <tag précédent>`
et les deux mêmes commandes ; la base, elle, ne redescend pas — restaurer une
sauvegarde si une migration l'exige.

`/opt/atlas/.env` reste sur le serveur : jamais copié depuis un poste, jamais
dans git, droits `0600`. Y poser au minimum `ATLAS_SESSION_SECRET`,
`ATLAS_FOUNDER_EMAIL`, `ATLAS_FOUNDER_PASSWORD`, `ATLAS_PUBLIC_URL`,
`ANTHROPIC_API_KEY`, `SEARXNG_SECRET`, les quatre `GMAIL_*`, et laisser
`ATLAS_OUTBOUND_ENABLED=false` / `ATLAS_ENGINE_MODE=INTERNAL_TEST` /
`ATLAS_SEARCH_FALLBACK_ENABLED=false` tant que l'envoi réel n'est pas décidé.
Dans Compose, `SEARXNG_BASE_URL` vaut `http://searxng:8080` (réseau interne) ;
SearXNG ne publie aucun port. Le port 4700 d'ATLAS n'est publié, s'il l'est,
que sur `127.0.0.1` du VPS — jamais sur `0.0.0.0` (`atlas:vps-check` le
vérifie).

Caddy (`deployment/Caddyfile`, `ATLAS_DOMAIN`, ports 80/443) est l'entrée
publique prévue ; tant qu'il n'est pas activé, le tableau de bord n'est joignable
que par le tunnel SSH. Pare-feu : 22 seulement aujourd'hui, 80/443 le jour de
Caddy. Le tableau de bord n'est jamais public sans session.

**Proxy de confiance.** `ATLAS_TRUST_PROXY=false` (défaut) : ATLAS ne croit
aucun en-tête `X-Forwarded-*` — l'adresse du client est celle de la connexion,
et personne ne contourne le limiteur de connexion en écrivant `X-Forwarded-For`.
Le jour de Caddy, sur le réseau Compose : `ATLAS_TRUST_PROXY=uniquelocal`
(les adresses privées, dont celle du conteneur Caddy), ou le CIDR exact du
réseau `atlas` (`docker network inspect atlas-os_atlas`) — et retirer alors la
publication `127.0.0.1:4700` du fichier privé, sinon le tunnel SSH partage
cette confiance. Jamais `true` sur un port qu'autre chose que le proxy peut
joindre ; jamais un nombre de sauts (refusé au démarrage).

`deployment/install.sh`, `atlas.service` et `release.sh` décrivent l'autre
voie — systemd sans Docker — utilisable sur un poste ou un serveur nu ; ce n'est
pas celle du VPS actuel.

## Gmail, en lecture seule d'abord

ATLAS lit la boîte pour rattacher les réponses ; il n'y écrit rien. L'envoi est
une phase à part, décidée plus tard (`--with-send`, `ATLAS_OUTBOUND_ENABLED`).

**Architecture.** OAuth 2.0 « application de bureau », flux *loopback* avec
PKCE : le consentement se donne dans le navigateur, sur les pages de Google ;
le code revient sur `http://127.0.0.1:<port aléatoire>/callback`, ATLAS
l'échange contre un jeton de rafraîchissement avec le secret client, qui ne
quitte jamais la machine. Aucun serveur tiers, aucun mot de passe vu par
ATLAS. Le jeton est écrit dans `.env.local` (ignoré par Git), jamais affiché.
Les portées acceptées sont fermées : `gmail.readonly` seule en phase 1 ;
`gmail.send` seulement sur `--with-send` ; jamais `gmail.modify` ni
`mail.google.com` — un jeton plus large est **refusé**, même s'il vient d'un
consentement antérieur.

**1. Google Cloud, une fois.** Un projet → *APIs & Services › Library* →
activer **Gmail API** → *OAuth consent screen* : type *External*, votre
adresse en **Test user**, portée `…/auth/gmail.readonly` seulement →
*Credentials › Create credentials › OAuth client ID* → type **Desktop app**
(pas « Web application » : le loopback n'a pas d'URI de redirection fixe).
Notez le *client ID* et le *client secret*.

**2. Sur le poste Windows** (il faut un navigateur ; le VPS n'en a pas) :
```bash
# dans .env.local (ignoré par Git), à la main :
#   GMAIL_CLIENT_ID=…apps.googleusercontent.com
#   GMAIL_CLIENT_SECRET=…
npm run gmail:authorize               # lecture seule : ouvre Google, écoute 127.0.0.1, écrit GMAIL_REFRESH_TOKEN + GMAIL_USER dans .env.local
npm run gmail:check                   # jeton échangé, portées accordées, boîte identifiée — rien d'écrit
npm run gmail:read-check              # les 5 derniers en-têtes entrants, lecture seule
```
Si Google refuse l'échange (HTTP 400/401) : le jeton a été révoqué ou le
client n'est pas de type *Desktop app*. Si `gmail:authorize` annonce une
portée en trop : révoquer sur https://myaccount.google.com/permissions et
recommencer en ne cochant que la lecture.

**3. Sur le VPS**, sans rien commiter : recopier à la main
`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_USER`
dans `/opt/atlas/.env` (`chmod 600`), puis
`$COMPOSE up -d atlas` (Compose recrée le conteneur avec le nouvel
environnement ; `ATLAS_OUTBOUND_ENABLED=false` et `ATLAS_ENGINE_MODE=INTERNAL_TEST`
restent tels quels). Ensuite, tout en lecture seule :
```bash
bash deployment/atlas-cli.sh gmail-check        # jeton + portées + boîte
bash deployment/atlas-cli.sh gmail-read-check   # en-têtes des derniers messages (--max=20, --thread=<id>, --since=AAAA-MM-JJ)
bash deployment/atlas-cli.sh inbox-initial-sync # premier import : une conversation par entreprise contactée (registre), puis lecture de la boîte
bash deployment/atlas-cli.sh inbox-sync         # ensuite : la lecture seule, rejouable (curseur, 6 h de chevauchement, dédup) ; n'écrit que dans la base ATLAS
bash deployment/atlas-cli.sh sales-inbox        # la boîte commerciale : ce qui est revenu, ce qu'il reste à faire
bash deployment/atlas-cli.sh production-check   # GMAIL AUTH : ce que le jeton porte · GMAIL SEND READINESS : autorisation d'un côté, verrous (PAUSED) de l'autre
```
La synchronisation est « sans trou » par construction : curseur
`lastReceivedAt` par boîte, relu avec **6 h de chevauchement**, déduplication
par identifiant de message (`alreadyImported`), curseur avancé seulement
quand toute la page a été traitée ; le daemon la rejoue toutes les 15 min.
Rattachement par fil (`threadId`, `In-Reply-To`/`References`) puis par
domaine ; classification déterministe (REPLIED / BOUNCED / AUTO_REPLY /
NEEDS_REVIEW) ; une réponse non rattachée n'est attribuée à personne.

**Ce que dit la ligne `Gmail` d'`atlas-status`.** C'est la *dernière*
tentative de lecture qui parle — celle du daemon (toutes les 15 min) ou
d'`inbox-sync` — par ce qu'elle a constaté, jamais l'absence de travail :

| Code | Sens | Quoi faire |
|---|---|---|
| `READY` | la dernière lecture a parcouru la boîte et s'est bien terminée | rien |
| `READY_IDLE` | identifiants présents, **aucune conversation ouverte : rien à synchroniser** — la boîte n'est pas en panne, elle n'a pas de travail | rien ; `gmail-check` éprouve le jeton si besoin |
| `DOWN` | la dernière tentative a réellement échoué (jeton refusé, API, réseau), motif affiché — ou *le daemon ne voit pas les identifiants* alors que la commande les voit : le conteneur `atlas` tourne avec un environnement antérieur au `.env` | lire le motif ; `$COMPOSE up -d atlas` recrée le conteneur avec le `.env` courant |
| `STALE` | aucune lecture depuis plus de 90 min : la preuve est trop vieille pour conclure | `daemon-check` — le daemon tourne-t-il ? |
| `UNKNOWN` | aucune tentative jamais consignée | attendre un cycle, ou `inbox-sync` |
| `OFF` | Gmail non configuré ici | — |

**Ce que dit `production-check` de l'envoi.** Trois faits qui ne se parlent
pas : ce que le jeton porte (OAuth), l'autorisation d'envoi qui en découle, et
les verrous d'exploitation. Une porte fermée n'est pas une portée manquante.

| Ligne | Sens |
|---|---|
| `GMAIL AUTH / GMAIL_AUTH_READ`, `GMAIL_AUTH_SEND` | identifiants présents, jeton échangé (oauth2 seulement, aucun appel Gmail), `gmail.readonly` / `gmail.send` **constatées sur le jeton**. MANUEL seulement si la portée manque, si Google refuse le jeton, ou sans identifiants |
| `GMAIL SEND READINESS / GMAIL_SEND_SCOPE`, `AUTH_READY` | l'autorisation d'envoi est complète — **quel que soit l'interrupteur** |
| `OUTBOUND_SWITCH` | `PAUSED` tant que `ATLAS_OUTBOUND_ENABLED=false` ; `ARMED` sinon. Un verrou d'exploitation : compté sous OPERATIONAL LOCKS, jamais sous EXTERNAL_INTEGRATIONS |
| `ENGINE_MODE` | `PAUSED` en `INTERNAL_TEST` (la politique d'envoi refuse tout envoi réel, le daemon n'a qu'un expéditeur à blanc) ; `PASS` en `PRODUCTION` |
| `MESSAGES_SENT` | les messages réellement partis d'après le registre — les accusés `dry-run-N` de l'expéditeur à blanc sont comptés à part |

La ligne de synthèse `GMAIL_SEND = AUTH_READY · OUTBOUND PAUSED · ENGINE PAUSED ·
MESSAGES SENT 0` est l'état attendu avant le premier envoi réel : tout est
autorisé, rien n'est ouvert. Le contrôle ne passe jamais par le transport pour
le savoir — `sendEmail()` se heurterait à la porte avant de voir le jeton.

**Aucun envoi possible.** `GmailOutboundProvider` refuse (`OUTBOUND_DISABLED`)
dans le transport lui-même tant que `ATLAS_OUTBOUND_ENABLED` n'est pas vrai,
avant toute politique et quel que soit le jeton — un jeton portant
`gmail.send` par accident n'y change rien ; la politique d'envoi bloque encore
en `INTERNAL_TEST_MODE`, et le daemon n'a qu'un fournisseur à blanc hors
PRODUCTION.

## Premier envoi réel : le self-test, vers sa propre boîte

Tant que `ATLAS_ENGINE_MODE=INTERNAL_TEST`, le chemin manuel
`sales:send-approved --send` **ne peut écrire qu'à `GMAIL_USER`** : un lot
qui contient une seule autre adresse est refusé en entier
(`INTERNAL_TEST_RECIPIENT_BLOCKED`), avant toute lecture de boîte,
réservation ou écriture. Pas de liste d'exceptions, pas de variable de
contournement : PRODUCTION est le seul mode qui écrit à quelqu'un d'autre.
La porte (`ATLAS_OUTBOUND_ENABLED`) reste prioritaire. Le daemon, lui, ne
change pas : hors PRODUCTION il n'a qu'un expéditeur à blanc.

Ordre des gardes, dans `runManualSendLot` (packages/runtime/src/manual-send.ts),
éprouvé avec le vrai transport dont seul `fetch` est intercepté :
garde de lot (porte, puis destinataires) → échange de jeton → **confirmation
au clavier** (destination, nombre, mode) → par message : transport autorisé,
registre, déjà parti ?, réponse reçue ?, clé d'idempotence → brouillon →
approbation → réservation → envoi → registre.

```bash
# 1. Le lot : un seul message, vers GMAIL_USER (le domaine sert de clé de registre ; choisir un nom qui ne ressemble à aucun prospect)
cat > out/self-test.json <<'EOF'
[{ "domain": "selftest.atlas.invalid", "companyName": "ATLAS self-test", "recipient": "<GMAIL_USER>",
   "subject": "ATLAS — self-test", "bodyText": "Premier envoi réel, vers moi-même.", "purpose": "FIRST_TOUCH" }]
EOF

# 2. Simulation : la garde, le registre, la clé — rien n'est écrit ; une NOTE dit ce que --send refuserait
bash deployment/atlas-cli.sh send-approved --file=out/self-test.json

# 3. Ouvrir la porte, pour ce seul envoi : ATLAS_OUTBOUND_ENABLED=true dans /opt/atlas/.env
#    (le conteneur outils lit .env à chaque commande ; le daemon, non recréé, garde false)

# 4. L'envoi, confirmé au clavier : destination / nombre / mode INTERNAL_TEST SELF-TEST, puis [o/N]
bash deployment/atlas-cli.sh send-approved --file=out/self-test.json --send

# 5. Refermer la porte : ATLAS_OUTBOUND_ENABLED=false dans /opt/atlas/.env

# 6. Vérifier : registre (MESSAGES SENT 1), réception (le message dans la boîte), anti-doublon (rejouer refuse)
bash deployment/atlas-cli.sh production-check | grep -E 'MESSAGES_SENT|GMAIL_SEND '
bash deployment/atlas-cli.sh gmail-read-check --max=5
bash deployment/atlas-cli.sh send-approved --file=out/self-test.json --send   # → BLOCKED : deja contactee / déjà envoyé
```
Sans terminal (cron, script), `--yes` tient lieu de confirmation — tapé par
une personne ; il ne touche pas à la garde de lot.

## Premier lancement sûr (§68)

1. `npm run atlas:status` (ou, sur le VPS, `bash deployment/vps-check.sh`) →
   ATLAS ONLINE, Outbound fermé, mode INTERNAL_TEST.
2. `npm run sales:campaign -- create --name="PME B2B FR" --countries=FR` (non approuvé).
3. Laisser tourner 24 h : découverte + qualification + lecture de la boîte.
4. Lire `npm run sales:status` : entonnoir, frictions, recommandations.
5. Quand tout est lu : `.env` → `ATLAS_ENGINE_MODE=PRODUCTION`,
   `ATLAS_OUTBOUND_ENABLED=true`, approuver la campagne, redémarrer. Les
   brouillons restent soumis à approbation humaine (`ATLAS_SALES_HUMAN_APPROVAL`).

## Sauvegardes et reprise

- Nocturne 02:15 UTC + à chaque arrêt propre → `data/backups/` (sur le VPS :
  `/data/backups` dans le volume `atlas-data`), rotation
  `ATLAS_BACKUP_RETENTION`. `npm run backup` à la demande. Chaque sauvegarde
  est écrite par `VACUUM INTO` dans un fichier temporaire, vérifiée
  (`integrity_check`, taille non nulle) puis renommée : jamais de fichier vide
  ou à moitié écrit sous le nom final.
- `npm run restore-check` restaure la dernière sauvegarde **dans un fichier
  temporaire**, vérifie taille, intégrité et contenu, et prouve que la base
  principale n'a pas bougé. Il ne remplace jamais la base en place.
- Sortir une sauvegarde du VPS : `docker cp` depuis le conteneur
  (`/data/backups/…`) ou `docker run --rm -v atlas-os_atlas-data:/data …`,
  puis `rsync`/`scp` vers un stockage distinct.
- Après un reboot, Docker relance les conteneurs (`restart: unless-stopped`) ;
  le daemon récupère les baux expirés et reprend les cycles de la journée.

## Surveiller

`npm run atlas:status` (dépôt complet) ou `bash deployment/vps-check.sh`
(VPS) et la ligne SYSTÈME du tableau de bord : Search ● LLM ● Gmail ● Workers ●
Database ●. Alertes en base (`/api/alerts`) : daemon arrêté, Gmail illisible,
rebonds, budget, base. `$COMPOSE logs -f atlas` (la même commande Compose
que ci-dessus) pour le détail — structuré, sans secret, sans corps de message. Trois alertes suffisent : conteneur arrêté,
sauvegarde de plus de 48 h, disque au-delà de 80 %.

## Ce qui reste humain

Approuver un brouillon, approuver une campagne, lever l'interrupteur d'envoi,
répondre à une réponse chaude, consigner un rendez-vous / un client / un CA,
valider ou tester une recommandation, revenir en arrière. ATLAS propose ; il
n'écrit à personne sans qu'une personne l'ait décidé.
