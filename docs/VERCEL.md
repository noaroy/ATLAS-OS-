# Tableau de bord sur Vercel

Le tableau de bord (la console, dont l'écran téléphone `/m`) peut être servi
par Vercel. ATLAS reste sur le VPS ; Vercel ne sert que des fichiers statiques
et un relais.

```
téléphone ──HTTPS──▶ Vercel (statique + api/atlas-proxy.ts) ──HTTPS──▶ Caddy ──▶ ATLAS (VPS)
```

## Ce que Vercel détient

| Variable | Où | Secret ? | Valeur attendue |
|---|---|---|---|
| `ATLAS_API_ORIGIN` | Vercel → Project → Settings → Environment Variables (Production) | **Non** | L'origine HTTPS publique d'ATLAS, sans chemin ni barre finale, p. ex. `https://atlas.<votre-domaine>` — la même que `ATLAS_PUBLIC_URL` côté VPS |

C'est tout. **Aucune** clé Gmail, OpenAI, Anthropic, GitHub, ni base SQLite,
ni identifiant VPS n'est à configurer chez Vercel, et le relais n'en lit
aucune.

## Comment l'authentification traverse le relais

- Le navigateur n'appelle que son origine Vercel (`/api/*`, `/healthz`).
- `vercel.json` réécrit ces appels vers `api/atlas-proxy.ts`, qui les relaie
  vers `ATLAS_API_ORIGIN`.
- ATLAS pose son cookie de session (`HttpOnly; SameSite=Strict; Secure`, sans
  `Domain`) ; le relais le transmet tel quel, il devient donc un cookie du
  domaine Vercel. Aucun CORS n'est à ouvrir côté ATLAS
  (`ATLAS_CORS_ORIGINS` reste inchangé).
- Toutes les routes `/api` (hors `/api/auth/login`) restent protégées par la
  session ATLAS. Les mutations exigent le rôle `operator` ou `founder` côté
  ATLAS, à l'exception de l'acquittement des alertes, ouvert à toute session.

Le relais ne transmet que `accept`, `accept-language`, `content-type`,
`cookie`, `user-agent` vers ATLAS, et que `content-type`, `retry-after`,
`content-disposition`, `set-cookie` vers le navigateur. Délai 15 s, corps
1 Mo, redirections refusées, réponses `no-store`.

## Déployer

Prérequis : ATLAS joignable en HTTPS à `ATLAS_API_ORIGIN` (Caddy, déjà en
place sur le VPS).

```bash
npm i -g vercel          # une fois
vercel login             # action humaine : authentification Vercel
vercel link              # à la racine du dépôt ; Root Directory = racine
vercel env add ATLAS_API_ORIGIN production
vercel deploy --prod
```

`vercel.json` fixe le reste : `npm ci --ignore-scripts` (aucun module natif
n'est compilé chez Vercel), `npm run build:console`, sortie `dist/console`.

Vérifier ensuite, depuis le téléphone : `https://<projet>.vercel.app/healthz`
répond `{"ok":true,…}`, puis `/login`, puis `/m`.

## Limites connues

- **Temps réel** : le relais ne tient pas de WebSocket (`/api/realtime` rend
  501). L'écran `/m` lit par intervalle (10 s) et n'en dépend pas. La page
  d'accueil `/` affichera « connexion interrompue » car elle tient compte du
  flux d'événements ; utiliser `/m` depuis Vercel.
- **Limitation de débit à la connexion** : vue d'ATLAS, toutes les requêtes
  relayées viennent des adresses de sortie de Vercel. Le limiteur de
  connexion est donc partagé entre tous les utilisateurs du relais — plus
  strict, pas plus laxiste.
