# Installer et authentifier Claude Code

Quatre commandes, aucune dépense, aucune modification de code. À la fin, ATLAS
détecte le worker tout seul.

## Ce que ça débloque

Claude Code est le worker qui **modifie réellement le dépôt** : il travaille dans
un worktree git isolé, produit un diff, et rend la main. Tant qu'il manque,
toute tâche d'ingénierie s'arrête en attente et l'écran de gestion l'annonce.

C'est une capacité distincte du worker Anthropic d'API, qui lit et analyse sans
jamais écrire. Les deux coexistent et ne se remplacent pas.

## 1. Installer

```bash
npm i -g @anthropic-ai/claude-code
```

## 2. Authentifier

```bash
claude
```

Au premier lancement, l'outil ouvre une connexion dans le navigateur. **Si votre
abonnement Claude couvre déjà Claude Code, c'est ce mode qu'il faut choisir** —
il n'entraîne aucune facturation à l'appel. Fermez ensuite la session ; ATLAS ne
s'en sert pas de façon interactive.

### La clé d'API n'est pas utilisée par défaut

`ANTHROPIC_API_KEY` est présente dans votre `.env`, et ATLAS charge `.env` dans
son environnement. Le binaire Claude Code, lui, préfère cette clé quand il la
trouve — et facture alors **chaque appel** sur le compte d'API au lieu de
consommer l'abonnement.

ATLAS retire donc la clé de l'environnement transmis au binaire. L'abonnement
est le mode par défaut, et il ne coûte rien de plus.

Pour facturer à l'appel délibérément :

```bash
ATLAS_CLAUDE_CODE_USE_API_KEY=true npm run claude-code:smoke
```

Un mode qui facture se choisit, il ne s'hérite pas. ATLAS ne lit jamais la
valeur de la clé, dans un cas comme dans l'autre.

## 3. Vérifier la détection

```bash
npm run atlas:production-check
```

Trois lignes doivent apparaître sous `CLAUDE CODE REAL BINARY` :

| Ligne | Attendu |
|---|---|
| `binaire reel` | PASS, avec le numéro de version détecté |
| `authentification` | PASS |
| `mission reelle eprouvee` | encore MANUEL — c'est l'étape 4 |

Aucun fichier n'est à modifier entre l'installation et la détection : ATLAS
interroge le binaire par `--version` à chaque contrôle, plutôt que de retenir un
état dans sa configuration.

## 4. Éprouver par une vraie mission

```bash
npm run claude-code:smoke
```

Une mission minuscule et sans intérêt métier — faire refuser `NaN` à une
fonction d'addition — parcourt la chaîne complète : file → daemon → registre →
worker → binaire réel → édition → résultat structuré.

Elle travaille dans un dépôt jetable créé pour l'occasion. **Votre dépôt n'est
jamais touché**, et rien n'est appliqué : le diff reste en attente
d'approbation, comme pour toute mission ordinaire.

Sept mesures sont rapportées : durée, état final, tentatives, fichiers
modifiés, état du workspace, présence d'un résultat structuré, intégrité du
dépôt de départ.

## Si le binaire n'est pas trouvé

ATLAS cherche `claude` dans le `PATH`. Pour désigner un autre emplacement,
renseignez le chemin dans la configuration d'ingénierie plutôt que de renommer
le binaire.

Un chemin contenant un caractère de shell — `&`, `|`, `;`, `` ` ``, `$`, `<`,
`>`, une apostrophe ou un guillemet — est refusé et rapporté. Sous Windows le
lancement passe par le shell pour atteindre le shim `.cmd` que npm installe, et
le shell y interpréterait ces caractères comme des commandes.

## Ce qui reste hors de portée de Claude Code

Le worker ne peut pas lire `.env`, les clés d'API, les jetons OAuth, les
identifiants ni les clés SSH privées : la liste noire est appliquée **après**
résolution des liens, de sorte qu'un détour par un répertoire lié n'y donne pas
accès non plus.

Les outils autorisés ne comprennent ni accès réseau ni installation de paquet.
Aucun patch ne s'applique au dépôt sans passer par `APPROVED_TO_APPLY`.
