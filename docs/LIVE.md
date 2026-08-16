# Sortir de la simulation

ATLAS sait tourner sans rien dépenser. Ce document décrit le passage à l'autre
mode — celui où les appels sont facturés, où les résultats portent sur des
entreprises réelles, et où une erreur coûte de l'argent.

Le mode réel n'est pas une option de confort. Il change ce qu'une conclusion
vaut : en simulation, « aucun distributeur trouvé » ne dit rien du marché ; en
réel, la même phrase est un renseignement — à condition que la chaîne qui l'a
produite soit vérifiable de bout en bout.

Tout ce qui suit vient de missions réelles qui ont échoué. Voir
[ECONOMIE.md](ECONOMIE.md) pour le détail des incidents.

---

## Ce que « réel » veut dire ici

| | Simulation | Réel |
|---|---|---|
| Appels au modèle | fabriqués localement | facturés par Anthropic |
| Recherche web | inventée | interrogée réellement |
| Coût | 0,00 $, toujours | plafonné, jamais nul |
| Conclusion | sans valeur informative | opposable, si sourcée |
| Reprise après arrêt | sans conséquence | jamais automatique |

Les deux modes traversent exactement le même code. Rien n'est court-circuité en
simulation : c'est le fournisseur qui change, pas la chaîne. Une mission qui
passe en simulation et échoue en réel a rencontré le monde, pas un chemin de
code différent.

---

## Déclarer le mode

```bash
ATLAS_EXECUTION_MODE=live
```

Trois valeurs : `auto`, `simulation`, `live`.

`auto` déduit le mode de la présence d'une clé API. C'est pratique et c'est
exactement ce qu'il ne faut pas en production : une clé posée pour un essai fait
basculer tout le déploiement en mode facturé sans que personne ne l'ait décidé.
Le contrôle avant décollage signale ce cas.

**Une déclaration explicite l'emporte toujours sur la déduction.**
`ATLAS_EXECUTION_MODE=simulation` avec une clé valide reste en simulation — le
sens inverse serait un piège, puisqu'il ferait dépenser une configuration qui
demandait à ne pas dépenser.

---

## Le verrou de modèle

```bash
ATLAS_FORBIDDEN_MODELS=claude-opus     # jamais appelé, quoi qu'il arrive
ATLAS_ALLOWED_MODELS=claude-haiku      # si renseigné, seuls ceux-là passent
```

Un plafond de dépense ne sert à rien si un modèle dix-huit fois plus cher peut
être choisi trois lignes plus loin. Trois chemins menaient au modèle le plus
coûteux pour un travail d'extraction : un réglage de console, une variable
d'environnement, et le `model` propre à un agent.

Le refus est appliqué **sous** les appels, dans le décorateur que tout le monde
traverse — pas dans une vérification que chaque appelant devrait penser à faire.
Il n'y a donc plus d'oubli possible, seulement une fraude délibérée.

Deux règles, et l'interdiction l'emporte :

- `ATLAS_FORBIDDEN_MODELS` — refusé quelle que soit la configuration par ailleurs.
- `ATLAS_ALLOWED_MODELS` — vide signifie « tout sauf les interdits ». Renseigné,
  il devient exclusif : un modèle absent de la liste est refusé même si rien ne
  l'interdit nommément. Pas d'escalade implicite.

Un modèle simulé passe toujours : il ne coûte rien et ne quitte pas la machine.

---

## Le moteur de recherche

```bash
ATLAS_SEARCH_PROVIDER=duckduckgo        # duckduckgo | marginalia | searxng | brave | anthropic | none
```

**Santé et adéquation sont deux verdicts différents.** La confusion entre les
deux a coûté deux missions.

- *Santé* — le moteur répond-il ? Mesurée en l'appelant réellement.
- *Adéquation* — peut-il répondre à **cette** mission ? Déduite de ses capacités
  déclarées, sans appel.

Marginalia répond parfaitement et ne couvre ni l'allemand ni la découverte
commerciale. Il est donc `healthy` et `unsuitable`. Sans cette distinction, la
mission dépensait pour le découvrir, et rendait « aucun distributeur en
Allemagne » là où il fallait lire « ce moteur ne contient pas la réponse ».

Un moteur `unsuitable` bloque le décollage. C'est voulu : mieux vaut ne pas
partir que rapporter une absence qui n'existe que dans l'index consulté.

---

## Le contrôle avant décollage

```bash
npm run live:retry
```

Sans argument : contrôle seul, aucune dépense. Huit vérifications, chacune
disant quoi faire quand elle échoue.

| Contrôle | Ce qu'il empêche |
|---|---|
| mode | partir en facturé sans l'avoir décidé |
| inférence | demander le mode réel sans clé |
| modèles | appeler le plus cher pour de l'extraction |
| budget | partir sans plafond |
| délais | un outil qui borne plus court que le fournisseur qu'il enveloppe |
| recherche (santé) | un moteur « configuré » et injoignable |
| recherche (adéquation) | un moteur sain qui ignore le marché visé |
| santé générale | partir sur un système déjà en alerte |

Une remarque bloque, un avertissement prévient. Rien ne part tant qu'une
remarque subsiste.

```bash
npm run live:retry -- --go
```

Contrôle **puis** exécution, et seulement si tout est vert. Une seule tentative,
aucune boucle : un moteur qui bride une adresse bride plus longtemps si on
insiste, et une tentative répétée en arrière-plan est une dépense que personne ne
surveille.

---

## La séquence de validation

Cinq missions, dans cet ordre. Chacune valide une propriété et une seule —
une mission qui vérifie tout à la fois ne dit rien quand elle échoue.

| Rang | Preset | Ce qu'il met à l'épreuve | Plafond |
|---|---|---|---|
| 1 | `VAL-001-PIPELINE` | la chaîne tourne de bout en bout | 0,00 $ |
| 2 | `VAL-002-FRUGAL` | un budget atteint s'arrête proprement | 0,05 $ |
| 3 | `VAL-003-HONNETETE` | un marché sans réponse rend « rien trouvé » | 0,10 $ |
| 4 | `VAL-004-SOURCES` | chaque candidat porte une source consultable | 0,20 $ |
| 5 | `VAL-005-PILOTE` | la mission réelle, sur un marché réel | 0,40 $ |

Le coût croît avec le rang, et un échec au rang *n* rend inutile de payer le
rang *n+1*. Les critères PASS / PARTIAL / FAIL de chaque preset sont écrits
avant l'exécution — c'est la seule protection contre la tentation de relire un
résultat médiocre comme un succès partiel.

Ils vivent dans `packages/departments/src/validation-presets.ts`.

---

## Lire un rapport de mission

Une règle gouverne le rapport : **rien n'est calculé à partir de rien.** Un
champ sans mesure vaut « inconnu », jamais zéro.

La distinction n'est pas cosmétique. « Zéro candidat trouvé » et « la recherche
n'a jamais tourné » mènent à des décisions opposées, et les cinq missions
échouées rapportaient les deux de la même façon : on lisait `0 candidat` et on
cherchait pourquoi le marché était vide, alors que le moteur n'avait pas répondu
une seule fois.

Les réserves s'affichent **avant** les chiffres. Un rapport dont on lit les
totaux avant d'apprendre qu'aucun appel n'a eu lieu trompe son lecteur, même
quand chaque chiffre est exact.

Trois lignes valent une lecture attentive :

- **sans source** — candidats ne portant aucune preuve. Doit valoir `0`.
- **décisions sans preuve** — conclusions rendues sans rien à l'appui. Doit valoir `0`.
- **part consommée** — au-delà de 90 %, la mission a probablement été coupée
  plutôt que terminée. Vérifier ce qu'elle a conservé.

Aucun de ces chiffres n'est demandé au modèle. Ils sont lus dans les tables que
les appels ont écrites en passant : un rapport qu'on interroge un modèle pour
produire est un rapport qui peut être flatté.

---

## Après un arrêt brutal

Un processus tué en pleine mission laisse la base dans un état qui ment : la
mission est `running`, ses étapes sont `running`, et plus rien ne les fera
avancer. Une mission bloquée depuis trois jours et une mission lancée il y a dix
secondes se lisent exactement pareil.

Au démarrage suivant, ces missions repassent **en pause** :

- pas en échec — elles n'ont pas échoué, elles ont été interrompues, et les
  compter ensemble fausserait le taux de réussite dont l'évolution se sert ;
- pas en reprise — **rien ne repart tout seul.** Le scénario qui déclenche cette
  logique est celui où personne n'était devant l'écran ; une mission réelle qui
  reprend d'elle-même dépense de l'argent que personne ne surveille.

Reprendre est une décision humaine, prise depuis le cockpit, en connaissant le
budget déjà consommé. Il s'affiche au démarrage.

---

## Ce qui n'est jamais fait

- **Aucun contournement anti-bot.** Un moteur qui bride est un moteur qui dit
  non ; ATLAS attend, il ne déguise pas ses requêtes.
- **Aucune donnée métier inventée.** Une organisation sans source consultable
  n'est pas un candidat. Un contact sans page qui le porte n'est pas un contact.
- **Aucune reprise automatique après incident.**
- **Aucune compensation d'un manque de résultats par plus d'appels.** Une
  recherche qui ne trouve rien conclut qu'elle n'a rien trouvé.
- **Aucun secret dans le dépôt.** Les clés vivent dans `.env`, exclu de Git et
  du déploiement. Elles n'apparaissent jamais entières dans un journal.

---

## Variables d'environnement

Toutes optionnelles ; les valeurs indiquées sont les défauts.

```bash
ATLAS_EXECUTION_MODE=auto              # auto | simulation | live
ATLAS_FORBIDDEN_MODELS=claude-opus     # séparés par des virgules
ATLAS_ALLOWED_MODELS=                  # vide = tout sauf les interdits
ATLAS_SEARCH_PROVIDER=duckduckgo
ATLAS_MAX_MISSION_COST_USD=            # le plafond, en dollars
ANTHROPIC_API_KEY=                     # jamais dans Git, jamais dans un journal
```

Une mission peut resserrer le plafond du déploiement via `context.budgetUsd`,
jamais l'élargir : c'est un `min`, pas une substitution.
