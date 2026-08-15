# Departments

ATLAS OS is the platform. Departments are the products.

A department is a domain ATLAS can be sold on: it owns a method, a scoring
model, a set of teams and a kind of result. The platform underneath knows none
of that — it knows about companies, evidence, opportunities and explainable
scores, and it applies the same guarantees whichever department is running.

The first department is **Business Expansion Intelligence**.

---

## What a department is made of

Everything that distinguishes one department from another is data in its
definition (`packages/departments/src/`), stored in the `departments` table at
first boot. Nothing outside that package needs to change to add another.

| Part | What it decides |
|---|---|
| `targetTypes` | The kinds of counterparty it knows how to look for |
| `briefSchema` | The structure a founder's sentence must become |
| `playbook` | The method: ordered stages, each owned by a team and an agent |
| `scoringModel` | The weighted dimensions, and the shortlist threshold |
| `teams` | Which agents are accountable for which pipeline stages |
| `triggers` | Keywords that let Hermes recognise the work as this department's |
| `kpis` | What the founder should judge the department on |

A department is stored rather than compiled in, so weights and method can be
tuned — by the founder or by a validated improvement — without a redeploy. The
code ships the *initial* definition; the table owns the current one.

---

## The pipeline

Every intelligence department runs the same six stages. They are platform
concepts; what happens inside each is the department's business.

```
discovered → enriched → qualified → scored → shortlisted
                             ↘ rejected
```

An opportunity's stage is the honest answer to *how far has this candidate
actually got*, which is what the console funnel and the village both read. The
funnel is counted from rows, never tracked in a counter.

---

## What the platform guarantees

These are enforced in `@atlas/intelligence`, where an agent cannot skip them.
Anything an agent merely *promises* is worth nothing.

**Deduplication is automatic.** A candidate is reconciled against the company
registry as it is written: same batch, same mission, and same organisation
across missions. Identity is the registrable domain where there is one, and
normalised name plus country otherwise. This is deliberately *not* a skill —
an agent that forgot to call it could otherwise inflate a shortlist.

**Evidence is disciplined.** Every claim states how it was obtained:

| Nature | Means | Rule |
|---|---|---|
| `observed` | An agent read it at the cited source | Must cite a source |
| `reported` | A third party states it | Must cite a source |
| `inferred` | The model concluded it | Must state its basis; confidence capped at 0.7 |

Evidence is append-only: a later contradiction is another row, never an edit.
In simulation mode nothing can be recorded as observed, and every row is stamped
`simulated` by the platform rather than by the agent.

**Verification precedes qualification.** A "qualified" verdict whose required
fields rest only on inference is downgraded to "uncertain", with the reason
written into the record. Verification is this check, not a separate stage
staffed by another agent who promises to have looked.

**Scores are arithmetic.** A total is the sum of named, weighted contributions,
each carrying its own rationale, confidence and evidence. `evidence-quality` is
computed by the platform from the ledger and an agent cannot assert it — so a
thinly-researched candidate scores worse than a well-researched one however
confident the agent sounds. Justifications are generated from the components,
so the written reason and the number cannot disagree.

**Knowledge is reused.** A company already researched and verified recently is
answered from the registry instead of researched again, and the opportunity is
marked `reusedKnowledge`. Stale knowledge is re-verified rather than trusted.

---

## How a mission reaches a department

```
Founder states an objective
   ↓
Hermes recognises the department (or the founder chooses it)
   ↓
Hermes reads the objective into the department's brief          ← department.brief event
   ↓
Hermes instantiates the department's playbook as the mission plan
   ↓
Hermes dispatches, supervises, retries, replans                 ← unchanged
   ↓
Opportunities move through the pipeline, stage by stage
   ↓
Hermes synthesises, reading the shortlist from storage
```

Hermes still owns orchestration. It delegates the *shape* of the work to the
department that owns the method — as a CEO does not redesign a division's
process for every job (Articles III and IV). An objective that matches no
department stays generic and Hermes plans it itself.

Recognition is a cheap keyword match, never a model call: it runs on every
mission, and the console lets the founder override it.

---

## Préconditions d'étape

Une étape déclare ce qu'elle exige d'avoir reçu, distinct de ce dont elle
dépend. `dependsOn` répond à « l'amont s'est-il terminé ? » ; une précondition
répond à « la matière est-elle là ? ».

Les quatre étapes qui travaillent sur des candidats — enrichissement,
qualification, score, classement — exigent au moins un élément dans le
pipeline. Sans candidat, elles sont sautées sans qu'aucun appel au modèle ne
soit émis, et la mission conclut honnêtement « aucun candidat suffisamment
documenté ».

L'étape de rapport n'en déclare pas : Hermès rend compte de ce qui s'est passé,
y compris de l'absence de résultat.

Voir [ECONOMIE.md](ECONOMIE.md) pour le détail et l'incident qui l'a motivé.

---

## Economics

Every department mission records what it cost and what it bought:

- tokens used, and estimated spend where the model has a known price
- external calls — the metered part of a live run
- duration
- opportunities discovered, qualified and shortlisted
- how many candidates were answered from existing knowledge
- **cost per qualified opportunity**

That last number is the one that decides whether a department is a business. It
is computed from stored facts rather than estimated from logs, and it is `null`
rather than a guess when the model has no configured price.

Depuis la migration 7, chaque appel au modèle est comptabilisé séparément —
modèle, agent, étape, jetons d'entrée et de sortie, coût, durée. `measured`
porte cette décomposition, et vaut `null` pour les missions antérieures.

---

## Adding a department

1. Declare it in `packages/departments/src/<key>.ts` and add it to
   `DEPARTMENT_DEFINITIONS`.
2. Add any genuinely new skill to `packages/agents/src/skills.ts`, and grant it
   to the roles that will use it. Reuse before you add: a skill only justifies
   its existence if more than one department could hold it (Article VII).
3. Nothing else. The migration, the API, the console and the village all read
   departments generically.

At boot ATLAS checks that every playbook stage names an agent that exists, is
enabled, and holds the skills the stage requires. A department that cannot run
its own method raises an alert and says which stage is broken — a broken product
must be visible at boot, not discovered halfway through a founder's first
mission.

---

## Business Expansion Intelligence

**Question it answers:** who abroad should we be talking to, and why them?

**Targets:** distributor · supplier · system integrator · OEM partner ·
reseller · commercial partner.

**Teams**

| Team | Owns | Agent |
|---|---|---|
| Research | discovery, enrichment | Explorer |
| Qualification | qualification | Ambassador |
| Intelligence | scoring, ranking | Analyst |
| Reporting | the deliverable | Architect |

**Scoring model**

| Dimension | Weight | |
|---|---|---|
| Sector fit | 20 | Do they already sell into our customers' industries? |
| Geographic fit | 18 | Real presence in the territory, not a mailing address |
| Portfolio fit | 16 | Complementary — neither redundant nor unrelated |
| Commercial reach | 14 | Sales force, service capability, installed base |
| Strategic relevance | 12 | A reason for *them* to say yes, this year |
| Size fit | 10 | Big enough to matter, small enough that we would matter |
| Evidence quality | 10 | Computed by ATLAS from the ledger |

Shortlist threshold: 45/100. A run where nothing clears it reports an empty
shortlist rather than lowering the bar.

---

## Real-world readiness

### Discovery providers

Discovery is an abstraction, not a vendor. A provider answers *which organisations
match this profile, in this country, in this sector*, and returns candidates that
each carry their own provenance. The service combines several, deduplicates
across them, and keeps every origin.

| Provider | Kind | Available when |
|---|---|---|
| Mémoire ATLAS | `registry` | Always. Free. Reuses companies already researched. |
| Recherche web | `web-search` | `ANTHROPIC_API_KEY` is set — uses provider-side web search, cites its URLs. |
| Simulation | `simulation` | Only when ATLAS runs on simulated inference. |

Two rules are enforced by the service, not by the providers:

- **In live mode a `synthetic` provider is never even called.** No fabricated
  company can reach a real shortlist.
- **A candidate seen by two providers keeps both sources.** That is
  corroboration, and collapsing it would make one sighting look like two.

`GET /api/discovery/capabilities` reports what the deployment can actually
search, before anything is spent.

### Contacts

`find_contacts` reads the pages where an organisation publishes its own details —
contact, Impressum, mentions légales — and records only what is literally there,
with the URL. It never derives `prenom.nom@societe.de` from a name: a fabricated
address is plausible and wrong, which is worse than no address. Contacts cannot
be supplied by an agent through any other tool.

### Human review

```
découverte → qualifiée → notée → retenue → revue → approuvée
```

`POST /api/opportunities/:id/review` records the founder's own verdict, kept
apart from qualification and scoring so it stays clear who concluded what. The
export defaults to `scope=approved`: a file leaves ATLAS and is then read without
its context, so what nobody signed off should not be the easy thing to send.

### Export

- `GET /api/missions/:id/export?format=csv` — UTF-8 with BOM so Excel reads
  accents; formula-injection guarded; 15 commercial columns.
- `GET /api/missions/:id/export?format=html` — a print-ready report the browser
  turns into a PDF.

Both state what they are worth: a simulated run is marked on every row, and an
unreviewed shortlist carries a warning banner.

### Plusieurs rôles pour une même entreprise

Une mission peut viser plusieurs types de cible à la fois — distributeurs *et*
intégrateurs — et une organisation peut correspondre aux deux.

**Une entreprise reste une opportunité.** Elle porte plusieurs rôles
(`targetTypes`), jamais plusieurs lignes : la dupliquer fausserait l'entonnoir
et ferait apparaître la même entreprise deux fois dans une shortlist.

Le rôle se précise au fil du pipeline :

| Étape | Ce qui arrive aux rôles |
|---|---|
| Découverte | Le provider dit les rôles qu'il constate. S'il ne sait pas, tous les rôles demandés restent ouverts. |
| Qualification | L'agent peut **restreindre** les rôles après vérification — c'est souvent le résultat le plus utile de l'étape. |
| Score | Une compatibilité par rôle (`roleFits`), avec sa valeur, sa raison, sa confiance et ses preuves. |

**La compatibilité par rôle n'entre pas dans le total.** Le classement doit
rester comparable d'un candidat à l'autre, et porter deux rôles ne rend pas une
entreprise meilleure qu'une autre qui en tient un seul superbement. Les rôles
répondent à une autre question : *quelle relation ouvrir ?* La justification
générée le dit explicitement — « À approcher d'abord comme Distributeur ».

Un rôle retenu mais jamais évalué apparaît à 0 avec une confiance nulle plutôt
que d'être omis : le taire laisserait croire qu'il a été examiné.

Le CSV porte deux colonnes (`Rôles pertinents`, `Compatibilité par rôle`) et le
rapport imprimable ouvre chaque fiche par les rôles, avant le score.

**Compatibilité.** La migration 6 convertit chaque `target_type` unique en
tableau d'un élément, si bien qu'une shortlist antérieure reste lisible. Le
brief accepte encore `targetType` au singulier et le normalise à l'entrée.
