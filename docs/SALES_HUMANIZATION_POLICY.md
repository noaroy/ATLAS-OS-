# ATLAS SALES HUMANIZATION POLICY

**Source de vérité unique** pour le ton et la forme de tout message commercial
sortant. Premier contact, relance, réponse, suivi, proposition — et tout canal
texte à venir.

Le code référence ce document ; il ne le recopie pas. Une règle écrite à dix
endroits diverge à dix endroits.

- Règles applicables : `packages/departments/src/humanization.ts`
- Rédaction du premier contact : `packages/departments/src/outreach.ts`
- Contrôle avant `READY_FOR_REVIEW` : `scripts/sales-batch.ts`

---

## La règle d'or

> Si je recevais ce mail dans ma propre boîte, est-ce que je penserais qu'un
> humain a réellement pris deux minutes pour regarder mon entreprise et
> m'écrire personnellement ?

Si la réponse est non, le brouillon n'est pas prêt.

**L'humanisation vient après la vérification factuelle, jamais à sa place.**
Aucune règle de ce document n'autorise à contourner : contact observé,
suitability, identité, ICP, doublon, `DO_NOT_CONTACT`, faits sourcés,
approbation humaine. Un message chaleureux et faux reste faux.

---

## 1. Le contact nommé

Utiliser le prénom seulement si **les cinq** conditions tiennent :

- le nom est observé sur une source fiable ;
- le rôle est pertinent pour une prise de contact commerciale ;
- le contact n'est ni personnel ni non-commercial ;
- aucun doute ne subsiste sur l'identité ;
- **l'adresse utilisée désigne cette personne**, et non une boîte de service.

Cette dernière condition est celle qu'on oublie. Sur `k2tec.com`, Pascal Sartori
est bien dirigeant et son nom est publié — mais l'adresse retenue est
`contact@k2tec.com`, un guichet partagé. « Bonjour Pascal » y arrive comme un
publipostage qui a trouvé un nom quelque part et l'a collé sur la première
adresse venue. Dans ce cas : `Bonjour,`.

`p.sartori@` ou `pascal.sartori@` autorisent le prénom. `contact@`, `info@`,
`commercial@` ne l'autorisent pas.

`Bonjour Pascal,` — acceptable.
`Bonjour M. Pascal Sartori,` — trop formel, artificiel.
`Bonjour,` — le repli, dès qu'un doute existe.

**Ne jamais inventer un prénom ni un rôle.**

## 2. Le ton

Naturel, simple, professionnel, direct. Chaleureux sans familiarité. Court.

Bannis :

- « Je me permets de vous contacter afin de… »
- « Dans le cadre de… »
- « Notre solution innovante… », « approche révolutionnaire »
- « Grâce à l'intelligence artificielle… »
- le vocabulaire de pitch, les superlatifs, la flatterie
- les emojis, la fausse urgence
- les phrases longues et trop parfaites

## 3. L'ouverture doit être une vraie observation

Les deux premières lignes doivent faire penser : *cette personne a vraiment
regardé mon entreprise.*

Oui :

> J'ai vu sur votre site que vous cherchez actuellement des distributeurs pour
> vos produits.

Non :

> Je réalise des études de prospection B2B et je souhaiterais vous présenter
> mes services…

## 4. Un ou deux faits, pas neuf

Choisir les faits les plus **utiles commercialement**, pas les plus nombreux.
Vrais, vérifiés, pertinents, courts, compréhensibles. Un courriel n'est pas un
rapport d'audit.

## 5. Les sources

La preuve technique est pour ATLAS ; le message est pour un humain.

Les sources restent stockées et visibles dans Approvals. Dans le message,
préférer `J'ai vu sur votre page distributeurs que…` à une URL brute collée
après chaque phrase.

N'inclure un lien que s'il apporte réellement de la crédibilité, s'il est
naturel dans la phrase, ou si le destinataire a besoin de vérifier le point.

## 6. Ne jamais expliquer ATLAS

Le prospect achète un résultat, pas une architecture.

Interdits dans un message : agents, IA, modèles, Search Fabric, automatisation,
scoring, pipeline, sources internes, architecture.

Autorisés : prospects, distributeurs, clients potentiels, partenaires, marché,
opportunités.

## 7. L'offre

Sur un contact froid, la priorité est **d'obtenir une réponse**, pas de vendre.
Le prix n'a pas à figurer dans le premier message.

> Je peux vous préparer gratuitement trois entreprises correspondant à votre
> cible, pour que vous puissiez voir si le résultat est pertinent.

L'offre payante vient après une réponse positive. Exception assumée : un
contexte où annoncer le prix directement sert mieux — ce n'est pas le défaut.

## 8. Une question, une seule

Chaque message pose **une** question simple qui donne une raison de répondre.

> Vous cherchez plutôt des distributeurs en France ou à l'étranger ?
> Vous avez un pays que vous souhaitez développer en priorité ?

À éviter : « N'hésitez pas à me contacter. » Et ne pas finir uniquement sur
« répondez non merci » — la sortie doit exister, elle ne doit pas être le seul
appel.

## 9. Longueur

| | mots |
|---|---|
| premier contact | 70 – 140 |
| relance | ≈ 25 – 90, **sans minimum rigide** |
| réponse à un prospect | le plus court possible tout en répondant vraiment |

Une relance courte est acceptable, et souvent meilleure. **Ne jamais ajouter du
texte dans le seul but d'atteindre un nombre de mots** : un message allongé pour
remplir se lit exactement comme ce que cette politique cherche à éviter.

La relance donnée en exemple au §12 compte une trentaine de mots. C'est la
bonne longueur.

## 10. Variation

Ne pas décliner un squelette unique en changeant le nom. Les structures varient
selon le contexte : recherche de distributeurs, de clients, développement
export, nouveau marché, sous-traitance, intégrateur, fabricant, partenaire.

## 11. Mémoire commerciale

ATLAS conserve, par entreprise : nom commercial, personne contactée, rôle, ton
employé, faits déjà mentionnés, questions déjà posées, message envoyé, réponse
reçue, objections, préférences, dernière interaction, prochaine action.

**Une relance ne répète jamais ce qui a déjà été dit.** Une réponse tient compte
du fil entier.

## 12. Relances

> Bonjour,
>
> Je reviens simplement vers vous concernant les quelques distributeurs que je
> vous proposais de rechercher.
>
> Est-ce un sujet que vous souhaitez développer en ce moment ?
>
> Bien à vous,
> Noa Roy

Jamais : « Ceci est ma relance numéro 1 concernant mon précédent message. »

## 13. Réponses

Avant de répondre, comprendre : ce qui est demandé, le niveau d'intérêt, une
éventuelle objection, une décision interne en cours, et **s'il faut répondre ou
attendre**.

Ne jamais répondre automatiquement parce qu'un message arrive.

> ACRN, 7 septembre : « je dois en discuter avec ma direction ».
> → ne pas pousser, attendre.

Le comportement humain compte autant que le texte.

## 14. Signature

```
Bien à vous,
Noa Roy
```

ou `Bien cordialement,`. Rien de plus.

## 15. Contrôle avant READY_FOR_REVIEW

Chaque brouillon reçoit une évaluation `HUMANIZATION` :

`PASS` · `NEEDS_EDIT` · `BLOCKED`

Vérifications : ressemble-t-il à un gabarit ? contient-il une phrase générique
inutile ? le premier paragraphe est-il spécifique ? la question finale est-elle
naturelle ? parle-t-il d'ATLAS ou de technologie ? trop d'URL ? le ton
correspond-il au contexte ? répète-t-il un message précédent ? le nom du contact
est-il correctement employé ? la longueur est-elle raisonnable ?

Ne pas bloquer sur un détail de style. Le but est d'arrêter les messages
réellement robotiques.

## 16. Application

- Tous les nouveaux brouillons.
- Toutes les relances à venir.
- Les réponses, en tenant compte du fil.
- **L'historique n'est pas réécrit.** Les messages déjà envoyés ne changent pas.
- Un brouillon en attente n'est retravaillé qu'au moment où il doit être
  réellement examiné ou envoyé.
