# ATLAS — guide de l'opérateur

Une page. Ce qu'il faut savoir pour faire tourner ATLAS 24 h/24 sur un VPS,
lire ce qu'il fait, et décider ce qu'il a le droit de faire.

## Ce qui tourne

Un seul processus : le serveur (`dist/server/atlas.mjs`). Il porte l'API, la
console, le superviseur (cron internes) et le **daemon embarqué** qui exécute
les cycles du moteur commercial. Le moteur de recherche SearXNG tourne à côté
(Docker). Rien d'autre.

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

```bash
npm run atlas:status        # ATLAS ONLINE ? Daemon · Search · LLM · Gmail · Database · Outbound · Dashboard
npm run sales:status        # la page unique, en texte (--range=7d|30d|all)
npm run sales:campaign -- list | create --name=… --countries=FR --keywords="a|b" | approve <id> | pause <id>
npm run sales:campaign -- outcome <domaine> --kind=MEETING_BOOKED|MEETING_DONE|PROPOSAL_SENT|WON|LOST --amount=…
npm run sales:campaign -- suppress <valeur> --kind=EMAIL|DOMAIN|COMPANY
npm run sales:campaign -- decide <recId> test|approve|reject | rollback <versionId>
npm run sales:pause -- --reason="…"   /   npm run sales:resume
npm run client:auto -- --brief=briefs/<client>.json --go   # missions client (V2, inchangé)
npm run atlas:start / atlas:stop     # hors systemd ; sous systemd : systemctl start|stop atlas
npm run backup / restore-check / db:check / db:migrate
```

Le tableau de bord : `https://<domaine>/` (session requise). Sept sections :
cartes (RDV semaine, clients, CA, pipeline), entonnoir, performance (réponses
positives, RDV/contact, client/contact, CAC, CA/100), segments, auto-optimisation
([TESTER] [VALIDER] [REFUSER]), réponses chaudes, système. Une valeur non
mesurée s'affiche `N/A` ou `—`, jamais `0`.

## Déployer (VPS, systemd)

```bash
# première fois, en root, depuis un clone du dépôt
sudo ./deployment/install.sh                       # Node 24, compte atlas, /opt/atlas, unit systemd
sudo install -D -m 0644 deployment/journald-atlas.conf /etc/systemd/journald.conf.d/atlas.conf
docker compose -f deployment/docker-compose.yml up -d searxng   # le moteur de recherche
# puis, à chaque version
sudo bash deployment/release.sh                    # npm ci → typecheck → tests critiques → build → checkpoint → backup → migrate → restart → healthz
sudo bash deployment/release.sh --rollback         # retour au checkpoint précédent
```

`/opt/atlas/.env` reste sur le serveur : jamais copié depuis un poste, jamais
dans git. Y poser au minimum `ATLAS_SESSION_SECRET`, `ATLAS_FOUNDER_EMAIL`,
`ATLAS_FOUNDER_PASSWORD`, `ATLAS_PUBLIC_URL`, `ANTHROPIC_API_KEY`,
`SEARXNG_BASE_URL=http://127.0.0.1:8080`, les quatre `GMAIL_*`, et laisser
`ATLAS_OUTBOUND_ENABLED=false` / `ATLAS_ENGINE_MODE=INTERNAL_TEST` pour la
première mise en ligne.

HTTPS : Caddy (`deployment/Caddyfile`, `ATLAS_DOMAIN`) devant le port 4700 ;
pare-feu : 22, 80, 443 seulement. Le tableau de bord n'est jamais public sans
session.

## Premier lancement sûr (§68)

1. `npm run atlas:status` → ATLAS ONLINE, Outbound PAUSED, mode INTERNAL_TEST.
2. `npm run sales:campaign -- create --name="PME B2B FR" --countries=FR` (non approuvé).
3. Laisser tourner 24 h : découverte + qualification + lecture de la boîte.
4. Lire `npm run sales:status` : entonnoir, frictions, recommandations.
5. Quand tout est lu : `.env` → `ATLAS_ENGINE_MODE=PRODUCTION`,
   `ATLAS_OUTBOUND_ENABLED=true`, approuver la campagne, redémarrer. Les
   brouillons restent soumis à approbation humaine (`ATLAS_SALES_HUMAN_APPROVAL`).

## Sauvegardes et reprise

- Nocturne 02:15 UTC + à chaque arrêt propre → `data/backups/` (rotation
  `ATLAS_BACKUP_RETENTION`). `npm run backup` à la demande.
- `npm run restore-check` ouvre la dernière sauvegarde et vérifie son intégrité.
- Après un reboot, systemd relance ATLAS (`Restart=always`) ; le daemon
  récupère les baux expirés et reprend les cycles de la journée.

## Surveiller

`npm run atlas:status` et la ligne SYSTÈME du tableau de bord : Search ● LLM ●
Gmail ● Workers ● Database ●. Alertes en base (`/api/alerts`) : daemon arrêté,
Gmail illisible, rebonds, budget, base. `journalctl -u atlas -f` pour le détail
— structuré, sans secret, sans corps de message.

## Ce qui reste humain

Approuver un brouillon, approuver une campagne, lever l'interrupteur d'envoi,
répondre à une réponse chaude, consigner un rendez-vous / un client / un CA,
valider ou tester une recommandation, revenir en arrière. ATLAS propose ; il
n'écrit à personne sans qu'une personne l'ait décidé.
