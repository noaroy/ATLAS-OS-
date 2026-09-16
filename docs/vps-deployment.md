# ATLAS — plan de déploiement VPS (variante systemd)

> **État réel.** Le VPS existe : Debian 12, Docker Compose, conteneurs `atlas`
> et `searxng` sains, `ATLAS_OUTBOUND_ENABLED=false`,
> `ATLAS_ENGINE_MODE=INTERNAL_TEST`, tableau de bord sur `127.0.0.1:4700` par
> tunnel SSH. Le chemin en vigueur est décrit dans `docs/OPERATOR.md`
> (« Déployer »). Ce document garde la variante **systemd sans Docker**
> (`deployment/install.sh`, `atlas.service`, `release.sh`) : valable pour un
> serveur nu, pas celle du VPS actuel. Les principes — secrets hors dépôt,
> sauvegarde par `VACUUM INTO`, restauration éprouvée, ordre de bascule —
> restent vrais dans les deux cas.

Ce document décrit comment ATLAS tournerait sur un serveur sans Docker. Il
existe pour que le passage en production soit une exécution plutôt qu'une
improvisation, et pour que le contrôle de mise en production ait quelque chose
à vérifier.

---

## 1. Ce qui tourne réellement

Un seul processus long : le serveur (`dist/server/atlas.mjs`, `npm start`),
qui embarque le daemon. Il dort quand la file est vide — un `setTimeout`, pas
une boucle — et se réveille à l'échéance connue. Les autres commandes (`atlas`,
`atlas:status`, `atlas:apply`, `sales:*`) sont ponctuelles et lancées à la main.

Conséquence de dimensionnement : ATLAS n'a pas besoin d'un serveur puissant. Il
a besoin d'un disque fiable et d'un processus qui redémarre.

## 2. Machine cible

| | |
|---|---|
| OS | Debian 12 ou Ubuntu 22.04 LTS |
| CPU / RAM | 1 vCPU, 1 Go suffisent — 2 Go si SearXNG tourne sur la même machine |
| Disque | 20 Go. La base fait 6 Mo ; les sauvegardes et les worktrees dominent |
| Node | 24.x, la version utilisée en développement |

**Un point à vérifier avant de basculer :** `SIGTERM` n'est pas supporté sous
Windows, où ATLAS a été développé. L'arrêt propre — libération des baux,
fermeture de la base — n'a donc jamais été éprouvé sur la plateforme cible. Le
premier geste sur le serveur est un `systemctl stop` suivi d'une lecture des
journaux pour confirmer que la ligne « daemon arrêté » apparaît.

## 3. Service systemd

```ini
[Unit]
Description=ATLAS daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=atlas
WorkingDirectory=/opt/atlas
EnvironmentFile=/etc/atlas/atlas.env
ExecStart=/usr/bin/npm run atlas:daemon
Restart=always
RestartSec=10
# Le temps de finir la tâche en cours et de rendre les baux proprement.
TimeoutStopSec=90
KillSignal=SIGTERM

# Le daemon n'a besoin d'écrire que dans son répertoire de travail.
ProtectSystem=strict
ReadWritePaths=/opt/atlas/data /opt/atlas/tmp
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`Restart=always` couvre le plantage. Il ne couvre pas la boucle de plantage : si
le daemon meurt en dix secondes, systemd le relance indéfiniment. `RestartSec=10`
laisse le temps de le voir dans les journaux avant qu'il ne consomme la machine.

## 4. Secrets

Dans `/etc/atlas/atlas.env`, propriété de `root`, mode `0600`, lu par systemd.
**Jamais dans le dépôt, jamais dans une variable de `WorkingDirectory`.**

```
ANTHROPIC_API_KEY=…
ATLAS_OPENAI_API_KEY=…
GMAIL_CLIENT_ID=…
GMAIL_CLIENT_SECRET=…
GMAIL_REFRESH_TOKEN=…
GMAIL_USER=…
ATLAS_SESSION_SECRET=…
```

Les réglages qui engagent de l'argent ou des envois restent explicites :

```
ATLAS_AI_LIVE=false                 # à ne lever qu'après un premier essai borné
ATLAS_SALES_HUMAN_APPROVAL=true     # ne pas modifier
ATLAS_AI_DAILY_BUDGET_USD=2
ATLAS_MAX_CHAIN_COST_USD=1
ATLAS_UNKNOWN_COST_POLICY=BLOCK
```

## 5. Sauvegarde

`npm run backup` produit une copie cohérente par `VACUUM INTO` — copier le
fichier d'une base en WAL donnerait une copie muette et fausse. Rotation à 7
copies par défaut.

```ini
# /etc/systemd/system/atlas-backup.timer
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
```

`Persistent=true` rattrape la sauvegarde manquée si la machine était éteinte.

**Une sauvegarde jamais restaurée n'est pas une sauvegarde.** La restauration se
teste en copiant une sauvegarde vers un fichier temporaire et en lançant
`ATLAS_DB_PATH=/tmp/essai.db npm run atlas:status` : si le tableau s'affiche, la
copie est lisible. À faire une fois avant la bascule, puis une fois par mois.

Les sauvegardes doivent quitter la machine. Un `rsync` vers un stockage distinct
suffit ; une sauvegarde sur le disque qu'elle protège ne protège que d'une
erreur logicielle, pas d'une panne matérielle.

## 6. SearXNG

Sur la même machine, en conteneur, écoutant sur `127.0.0.1:8080` uniquement.
Aucun port exposé : ATLAS est le seul client.

```
ATLAS_SEARCH_PROVIDER=searxng
SEARXNG_BASE_URL=http://127.0.0.1:8080
```

Le préflight refuse déjà avec zéro dépense quand le moteur est absent. C'est le
comportement voulu, mais il fait qu'une découverte échoue silencieusement du
point de vue commercial : la surveillance doit inclure `/healthz`.

## 7. Surveillance

Le minimum qui rende une panne visible :

- `systemctl is-active atlas` — le daemon tourne
- `npm run atlas:status` — file, quotas, fournisseurs
- `npm run atlas:production-check` — les gardes, une fois par semaine
- taille de `data/atlas.db` et de `data/backups`
- date de la sauvegarde la plus récente

Une alerte utile est rare. Trois suffisent : le service est mort, la sauvegarde
a plus de 48 h, le disque dépasse 80 %.

## 8. Ce qui reste manuel, et le restera

L'approbation d'un envoi commercial, l'application d'un patch au dépôt, un
paiement. Ces trois-là sont irréversibles pour quelqu'un d'autre que nous — un
destinataire, un dépôt de travail, un compte — et aucun niveau d'autonomie ne
les retire de la file humaine.

Le déploiement ne les change pas. Un serveur rend ATLAS disponible ; il ne le
rend pas autorisé.

## 9. Ordre de bascule

1. Provisionner, installer Node 24, créer l'utilisateur `atlas`.
2. Déployer le dépôt dans `/opt/atlas`, `npm ci`, `npm run build`.
3. Écrire `/etc/atlas/atlas.env` avec `ATLAS_AI_LIVE=false`.
4. Restaurer la dernière sauvegarde, vérifier avec `atlas:status`.
5. Installer le service et le timer, **sans les démarrer**.
6. Lancer `npm run atlas:production-check` sur la machine cible.
7. Démarrer le service. Vérifier l'arrêt propre par un `systemctl stop` et la
   ligne « daemon arrêté » dans `journalctl`.
8. Redémarrer. Observer 24 h en autonomie, `ATLAS_AI_LIVE` toujours à `false`.
9. Lever `ATLAS_AI_LIVE` seulement après un premier essai borné et chiffré.

L'étape 7 est celle qui vaut le détour : c'est la seule qui vérifie ce que
Windows n'a jamais permis de vérifier.
