# Le Search Fabric

ATLAS doit tourner 24 h/24. « Attendre que DuckDuckGo relâche son bridage » ne
peut donc pas être une stratégie — et c'en était une pendant deux jours.

Le Search Fabric remplace le moteur unique par un parc. Un moteur qui bride
passe en refroidissement, un autre prend la file, et la mission continue. Une
mission n'est bloquée que lorsque **tous** les moteurs adaptés et autorisés sont
indisponibles.

---

## Le contrat

Le Fabric implémente `SearchProvider` — la même interface qu'un moteur.

C'est le choix qui porte toute la valeur du module. Le pipeline de découverte,
le cockpit, le contrôle avant décollage et les scripts continuent de parler à
« un moteur » ; ce moteur est devenu un parc, sans qu'une ligne en aval ait à le
savoir. C'est aussi ce qui rend le futur runtime 24/7 possible sans refonte : il
branchera un Fabric là où il branchait un moteur.

```
mission → pipeline → SearchProvider ─┬─ SearXNG
                                     ├─ DuckDuckGo
                                     ├─ Brave
                                     └─ Marginalia
```

---

## Le routage

Entièrement déterministe. **Aucun modèle n'intervient dans ce choix.**

Ce n'est pas une économie : demander à un modèle quel moteur employer, c'est
payer un appel pour obtenir une réponse qu'un tri rend exactement, plus
lentement, et sans garantie qu'elle soit la même deux fois. Un routage qui varie
d'une exécution à l'autre rend tout incident irreproductible.

L'ordre des critères n'est pas négociable :

| # | Critère | Pourquoi à cette place |
|---|---|---|
| 1 | **Adéquation** | Un moteur inadapté n'est jamais choisi, quel que soit le reste. |
| 2 | **Santé** | Sain > inconnu > en panne. Mais jamais devant l'adéquation. |
| 3 | **Coût** | À qualité égale, le gratuit d'abord. |
| 4 | **Latence** | Mesurée, jamais supposée. |
| 5 | **Historique** | Mesuré, jamais supposé. |
| 6 | **Priorité** | Le dernier mot de la configuration. |

**On ne choisit jamais un moteur au seul motif qu'il répond.** Marginalia
répondait en 300 ms et ne savait rien du marché allemand ; il était le plus sain
et le plus rapide du parc, et c'est exactement pourquoi il a été choisi, et
pourquoi la mission a conclu qu'il n'existait aucun distributeur en Allemagne.

---

## La bascule

Elle se déclenche sur : `429`, `403` temporaire, captcha, anti-bot, délai
dépassé, `5xx`, erreur de connexion.

Elle **ne se déclenche pas** sur un résultat vide. Un moteur qui répond « rien »
a répondu ; interroger le suivant reviendrait à chercher jusqu'à ce qu'un index
quelconque rende quelque chose, c'est-à-dire à transformer une absence honnête
en découverte fabriquée.

Chaque bascule est écrite dans le détail du résultat. Un résultat obtenu au
troisième moteur n'a pas la même valeur qu'un résultat obtenu au premier, et le
rapport final doit pouvoir le dire.

---

## Les disjoncteurs

Un moteur qui bride une adresse bride plus longtemps si on insiste. C'est la
propriété qui rend le réessai naïf plus nuisible que l'attente : chaque requête
envoyée pendant le bridage repousse la fin du bridage, si bien qu'un système qui
« réessaie jusqu'à ce que ça marche » ne se rétablit jamais.

```
CLOSED ──── 2 échecs (ou 1 bridage) ────► OPEN
  ▲                                        │
  │                                   refroidissement
  │                                        │
  └──── sonde réussie ──── HALF_OPEN ◄──────┘
                              │
                        sonde échouée
                              │
                              ▼
                            OPEN (plus longtemps)
```

Un `429` ouvre **immédiatement**, sans attendre le seuil : le moteur a dit
d'arrêter, et attendre un second `429` pour le croire, c'est envoyer la requête
qui aggrave le bridage.

En `HALF_OPEN`, **une seule** sonde passe. C'est ce qui distingue un disjoncteur
d'une boucle de test : sans cela, dix requêtes en attente partiraient toutes à
la seconde où le refroidissement expire — précisément la rafale qui a causé le
bridage.

Le refroidissement double à chaque échec consécutif : 2 min, 4, 8, 16… jusqu'à
une heure. Un moteur qui échoue cinq fois de suite dit quelque chose de plus
durable qu'un hoquet, et le sonder toutes les minutes revient à le marteler
poliment.

L'état se déduit de l'horloge, jamais d'un minuteur : ATLAS doit se réveiller
cohérent après une pause, un arrêt ou un redéploiement.

---

## La cadence

Le bridage n'est pas venu d'un volume : **quatre recherches en 1,3 seconde** ont
suffi. Un moteur public lit une rafale comme un robot — et il avait raison.

Deux niveaux :

- **Par moteur** — protège le moteur de nous. Chacun a sa tolérance : SearXNG
  auto-hébergé 200 ms, DuckDuckGo 1 100 ms, Marginalia 1 500 ms par courtoisie.
- **Global** — nous protège de nous-mêmes. Sans lui, trois missions simultanées
  respecteraient chacune leur cadence tout en produisant, ensemble, la rafale
  qu'on voulait éviter.

La gigue n'est pas une décoration : des requêtes espacées de 1 100 ms exactement
sont plus reconnaissables comme automatiques que des requêtes espacées de 1 000 à
1 400 ms. Une régularité parfaite est une signature.

---

## Le score opérationnel

`successRate`, `errorRate`, `rateLimitFrequency`, `averageLatencyMs`,
`coverage`, et leur synthèse `composite`.

**Un moteur jamais appelé n'a pas de score.** Ni zéro, ni parfait, ni « neutre » :
`null`. Lui en inventer un le classerait par rapport à des moteurs dont on sait
des choses, sur la foi de rien.

`coverage` est délibérément grossier — le nombre moyen de résultats par appel
réussi. Il mesure le volume, pas la pertinence, et il est nommé en conséquence :
un score « pertinence » qui mesure en fait le volume est pire qu'un score absent.

---

## Les moteurs

| Moteur | Coût | Découverte commerciale | Couverture | Note |
|---|---|---|---|---|
| **SearXNG** | auto-hébergé | oui | universelle | Premier choix : pas de quota, pas de bridage, pas de tiers. |
| **DuckDuckGo** | gratuit | oui | universelle | Bride une adresse insistante. |
| **Brave** | facturé | oui | universelle | Requiert une clé. |
| **Marginalia** | gratuit | **non** | `en`, monde anglophone | Index documentaire. Écarté d'office ailleurs. |

Aucun moteur ajouté ne contourne de protection anti-bot, et aucun captcha n'est
résolu. Un moteur qui bride est un moteur qui dit non : on l'entend, on note, et
on va voir ailleurs.

### SearXNG en production

```bash
ATLAS_SEARCH_PROVIDER=auto
SEARXNG_BASE_URL=http://searxng:8080     # ou une instance privée distante
SEARXNG_ENGINES=duckduckgo,brave,startpage,mojeek
```

L'instance peut être locale ou distante privée. **Ne dépendez d'aucune instance
publique** en production : elles rendent du HTML au lieu du JSON sans prévenir,
appliquent leurs propres quotas, et disparaissent.

L'architecture est prête ; brancher une instance persistante ne demande aucune
modification de code.

---

## Le contrôle avant décollage

La question a changé.

**Avant** — « DuckDuckGo répond-il ? » Une question à laquelle un seul moteur
pouvait répondre non, bloquant tout.

**Maintenant** — « Existe-t-il au moins un moteur sain **et** adapté ? »

- Oui → LIVE autorisé.
- Non → `BLOCKED-BY-SEARCH-FABRIC`, avec la cause distinguée : moteur en
  refroidissement (attendre), moteur non configuré (une variable), ou parc
  inadapté au marché (changer de marché ou de parc). Trois gestes différents que
  « aucun moteur disponible » confondait.

Un parc réduit à un seul moteur passe, mais est signalé : c'est une
configuration légitime, et c'est un point de défaillance unique. Le taire
laisserait croire que la bascule protège quand elle n'a nulle part où basculer.

Le contrôle **n'appelle aucun moteur** pour rendre son verdict. Sonder à chaque
contrôle enverrait exactement le trafic qui a causé le bridage.

---

## Les deux niveaux de disponibilité

Le Search Fabric est compatible avec les deux, sans refonte.

### ATLAS LOCAL

Fonctionne tant que la machine est allumée. Les disjoncteurs, les métriques et
les cadences vivent en mémoire : un redémarrage les remet à zéro, ce qui est
sans conséquence — l'état se reconstruit au premier appel, et un moteur bridé
qu'on redécouvre coûte une requête refusée.

C'est le mode actuel. Il suffit pour valider, pour piloter, et pour toute
mission lancée sous supervision.

### ATLAS 24/7

Nécessite un runtime toujours disponible. Ce que cela change pour le Fabric :

- **L'état des disjoncteurs devrait survivre au redémarrage.** Le `CircuitBreaker`
  expose déjà `snapshot()` et déduit son état de l'horloge plutôt que d'un
  minuteur — le persister est une addition, pas une refonte.
- **Le limiteur global devient inter-processus** si plusieurs instances tournent.
  Aujourd'hui il protège un processus ; à plusieurs, chacun respecterait sa
  cadence tout en produisant ensemble une rafale.
- **SearXNG devient nécessaire, pas optionnel.** Un runtime permanent interroge
  davantage, et une instance auto-hébergée est le seul moteur qui ne bride pas.

Aucune de ces trois évolutions ne touche au routage, à la bascule ni au contrat
`SearchProvider`. C'est la propriété qui comptait.

**Rien de payant n'est déployé sans autorisation explicite.**

---

## Ce qui n'arrivera plus

> « Attendez quelques heures que DuckDuckGo revienne. »

À la place :

> « DuckDuckGo indisponible → bascule vers SearXNG. »

Et uniquement si tout le parc est à terre :

> `BLOCKED-BY-SEARCH-FABRIC` — 2 moteurs en refroidissement (duckduckgo,
> brave) — le premier redevient interrogeable dans 4 min · 1 moteur sain mais
> inadapté à cette mission (marginalia).
