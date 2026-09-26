# Tableau de bord sur Vercel

Vercel sert la console statique (dont l'écran téléphone `/m`). ATLAS reste
sur le VPS, seul détenteur de la base et des identifiants.

```
téléphone ──HTTPS──▶ Vercel (dist/console) ──rewrite HTTPS──▶ Caddy ──▶ ATLAS (VPS)
```

## Ce que Vercel détient

Rien de secret. `vercel.json` relaie `/api/*` et `/healthz` vers l'origine
publique d'ATLAS ; toute autre route renvoie la coquille `index.html`.

Aucune variable d'environnement n'est à déclarer chez Vercel. En particulier,
Vercel ne reçoit **jamais** : clé OpenAI, clé Anthropic, identifiants Gmail,
jeton GitHub, `ATLAS_SESSION_SECRET`, identifiants VPS, ni la base SQLite.
`.vercelignore` empêche qu'un `vercel deploy` lancé depuis le VPS n'envoie
`.env`, `/data/`, une base `*.db`/`*.sqlite` ou un jeton OAuth.

## L'authentification à travers le relais

- Le navigateur n'appelle que son origine Vercel ; aucun CORS n'est ouvert
  côté ATLAS (`ATLAS_CORS_ORIGINS` inchangé).
- ATLAS pose son cookie de session (`HttpOnly; SameSite=Strict; Secure`, sans
  `Domain`) ; relayé, il devient un cookie du domaine Vercel, illisible par le
  JavaScript de la page.
- Toutes les routes `/api` (hors `/api/auth/login`) exigent la session ATLAS.
  Les mutations exigent le rôle `operator` ou `founder`, sauf l'acquittement
  des alertes, ouvert à toute session.
- Les lectures du téléphone (`/api/cc/revenue`, `/api/cc/prospects/:domain`)
  sont en lecture seule, ne sondent aucun service externe et ne renvoient
  aucune valeur ni aucun nom de variable d'identifiant.

## Déployer

```bash
npm i -g vercel          # une fois
vercel login             # action humaine : authentification Vercel
vercel link              # à la racine du dépôt ; Root Directory = racine
vercel deploy --prod
```

Vérifier ensuite depuis le téléphone : `https://<projet>.vercel.app/healthz`
répond `{"ok":true,…}`, puis `/login`, puis `/m`.

## L'écran téléphone

- `/m` : état ATLAS (ONLINE / DEGRADED, DOWN constaté par le navigateur,
  STALE quand les chiffres vieillissent), outbound OFF / INTERNAL_TEST /
  ACTIVE, kill switch, coût IA du jour, dernière action revenue, dernière
  synchronisation Gmail ; KPIs, entonnoir DISCOVERED → WON, prospects
  prioritaires, blocages, brouillons en attente, dernières expansions, coûts,
  santé Search / Gmail / Workers / Inference / DB. Lecture toutes les 10 s,
  suspendue onglet caché.
- `/m/p/:domain` : fiche prospect — identité, score et palier, contact et
  provenance, preuves et URLs, recommandations du mail (celles du graphe
  d'expansion : VERIFIED, OFFICIAL, commerciales, 2 à 3 ou aucune),
  brouillons, historique, blocages du premier contact.

Aucune commande n'est émise depuis ces écrans : les décisions restent sur
`/cc/approvals`, `/cc/sales` et `/cc/outreach`.

## Limites connues

- **Temps réel** : le flux WebSocket `/api/realtime` n'est pas relayé par une
  réécriture Vercel. `/m` lit par intervalle et n'en dépend pas ; l'accueil
  `/` tient compte du flux et affichera « connexion interrompue ».
- **Limitation de débit à la connexion** : vues d'ATLAS, les requêtes
  relayées viennent des adresses de sortie de Vercel ; le limiteur de
  connexion est donc partagé — plus strict, pas plus laxiste.
