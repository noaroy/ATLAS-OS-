# Déclarer le tarif d'un modèle

ATLAS refuse de dépenser sur un modèle dont il ne connaît pas le tarif. Ce n'est
pas une lacune à contourner : un plafond vérifié contre un montant inconnu ne
protège rien. Tant que le tarif manque, toute chaîne s'arrête sur
`COST_UNKNOWN_BLOCKED`.

Le débloquer ne demande aucune modification de code.

## 1. Écrire le fichier

Créez un fichier — par exemple `data/model-pricing.json` — hors du dépôt suivi :

```json
{
  "models": [
    {
      "provider": "OPENAI",
      "model": "gpt-5",
      "input_per_million": 0,
      "output_per_million": 0,
      "cached_input_per_million": 0,
      "effective_from": "2026-01-01",
      "source": "https://openai.com/api/pricing/ — relevé le 2026-08-25"
    }
  ]
}
```

**Les zéros ci-dessus sont des emplacements, pas des tarifs.** Remplacez-les par
les chiffres officiels relevés sur votre page de facturation. ATLAS ne devinera
jamais un prix : c'est précisément ce que cette mécanique existe pour éviter.

`model` doit correspondre à ce que la configuration utilise réellement — vérifiez
avec `npm run atlas:production-check`, ligne « tarif des modeles configures ».

## 2. Le désigner

```bash
ATLAS_MODEL_PRICING_CONFIG=data/model-pricing.json
```

Dans `.env`, comme les autres variables.

## 3. Vérifier

```bash
npm run atlas:production-check
```

Sous `COST SAFETY`, deux lignes doivent passer au vert :

| Ligne | Attendu |
|---|---|
| `tarif des modeles configures` | PASS — plus aucun modèle INCONNU |
| `fichier de tarifs declares` | PASS — le nombre de tarifs lus |

## Ce que le fichier refuse

Chaque règle répare une façon précise de se mentir sur la dépense.

| Refus | Pourquoi |
|---|---|
| Un champ manquant | Un champ absent qui vaudrait zéro transforme « je ne sais pas » en « c'est gratuit » |
| `source` vide | Un tarif sans provenance est un tarif inventé — et un tarif inventé est pire qu'un tarif absent : l'absence bloque, la fiction laisse dépenser |
| Un nombre négatif | — |
| `effective_from` dans le futur | Facturer aujourd'hui au prix de demain |
| JSON illisible | Le découvrir au moment de la dépense serait trop tard |

Une entrée refusée est **rejetée entière**, jamais complétée. Le contrôle de
production nomme chaque refus et sa raison.

## Les tarifs de cache non déclarés

`cached_input_per_million` et `cache_write_per_million` sont facultatifs. Absents,
les jetons de cache sont facturés **au tarif de sortie** — le poste le plus cher.

C'est volontairement pessimiste. Surestimer arrête une chaîne trop tôt, ce qui se
voit et se corrige ; sous-estimer la laisse filer au-delà du plafond, ce qui ne se
voit qu'à la facture.

## Plusieurs dates pour un même modèle

Le fichier accepte plusieurs entrées pour un même modèle avec des
`effective_from` différents. ATLAS retient la plus récente **déjà en vigueur**, et
rejette celles qui ne le sont pas encore, en le disant.
