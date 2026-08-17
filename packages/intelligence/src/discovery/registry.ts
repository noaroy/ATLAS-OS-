import { nowIso } from '@atlas/core';
import type { Repositories } from '@atlas/data';
import type {
  Availability,
  DiscoveredCandidate,
  DiscoveryProvider,
  DiscoveryProviderContext,
  DiscoveryQuery,
  ProviderResult,
} from './types.ts';

/**
 * Découverte par le registre d'entreprises d'ATLAS.
 *
 * Ce que l'organisation a déjà étudié est une vraie source, et la moins chère
 * de toutes : une entreprise qualifiée le mois dernier n'a pas besoin d'être
 * redécouverte (Article XI). Ce provider passe en premier, et son coût est nul.
 *
 * Il ne rend que des entreprises réellement enrichies : une simple mention
 * laissée par une mission précédente n'est pas une découverte.
 *
 * ── La barrière de lignée ──────────────────────────────────────────────────
 *
 * En mode réel, il ne rend **que** des fiches de lignée `live`. VAL-003 a
 * montré pourquoi : quatre entreprises fabriquées lors d'une démonstration
 * cinq jours plus tôt sont ressorties comme candidats d'une mission réelle,
 * parce que ce provider relisait la table sans savoir ce qu'il y trouvait.
 *
 * `unknown` est refusé au même titre que `simulated`. Une fiche dont la
 * provenance n'est pas établie n'est pas présumée bonne : le sens de l'erreur
 * compte, et accepter à tort coûte la confiance dans tout le reste.
 *
 * Le préfixe « [SIMULÉ] » du nom n'est jamais consulté. Il existait déjà
 * pendant tout l'incident et n'a rien empêché — un nom s'affiche, il ne
 * contraint pas.
 */
export class RegistryDiscoveryProvider implements DiscoveryProvider {
  readonly key = 'registry';
  readonly label = 'Mémoire ATLAS';
  readonly kind = 'registry' as const;
  readonly synthetic = false;

  constructor(
    private readonly repos: Repositories,
    /**
     * Le mode d'exécution du déploiement.
     *
     * Passé à la construction plutôt que lu par requête : la barrière ne doit
     * pas dépendre d'un paramètre qu'un appelant pourrait omettre.
     */
    private readonly mode: 'live' | 'simulation' = 'live',
  ) {}

  availability(): Availability {
    const known = this.repos.companies.count();
    return {
      available: true,
      reason:
        known === 0
          ? 'Le registre est vide pour le moment ; il se remplira au fil des missions.'
          : `${known} entreprise(s) déjà connues d'ATLAS.`,
    };
  }

  async search(query: DiscoveryQuery, _ctx: DiscoveryProviderContext): Promise<ProviderResult> {
    const retrievedAt = nowIso();
    const seen = new Map<string, DiscoveredCandidate>();

    // Une recherche par pays, car c'est le filtre que le registre indexe.
    for (const country of query.countries.length ? query.countries : [undefined]) {
      for (const company of this.repos.companies.search({ country, limit: query.limit * 3 })) {
        if (!company.enriched) continue;
        // La barrière de lignée. En mode réel, seule une fiche dont la
        // provenance est établie comme réelle peut ressortir — `simulated` et
        // `unknown` sont écartées sans distinction.
        if (this.mode === 'live' && company.dataOrigin !== 'live') continue;
        if (seen.has(company.id)) continue;
        if (!matchesIndustry(company.industries, query.industries)) continue;

        seen.set(company.id, {
          name: company.name,
          website: company.website,
          country: company.country,
          region: company.region,
          city: company.city,
          description: company.description,
          industries: company.industries,
          relevance:
            "Déjà étudiée par ATLAS lors d'une mission précédente ; le profil enregistré est réutilisé.",
          // Le registre ne sait pas quel rôle convient ici : la qualification
          // tranchera. Affirmer un rôle sans preuve serait une invention.
          roles: [],
          sources: [
            {
              kind: 'registry',
              ref: company.domain,
              title: "Registre d'entreprises ATLAS",
              retrievedAt,
              provider: this.key,
            },
          ],
          // La confiance suit la fraîcheur : une fiche vérifiée il y a deux ans
          // vaut moins qu'une fiche vérifiée le mois dernier.
          confidence: freshnessConfidence(company.lastVerifiedAt),
        });
      }
    }

    const candidates = [...seen.values()].slice(0, query.limit);
    return {
      candidates,
      notes: candidates.length
        ? [`${candidates.length} entreprise(s) reprises du registre, sans nouvelle recherche.`]
        : ['Le registre ne contient encore aucune entreprise réutilisable.'],
      tokensUsed: 0,
      // Un registre vide n'est pas une panne : c'est un système jeune.
      outcome: candidates.length > 0 ? 'success-with-results' : 'success-empty',
    };
  }
}

/** Sans secteur demandé, tout passe ; sinon un recoupement lexical suffit. */
function matchesIndustry(companyIndustries: string[], wanted: string[]): boolean {
  if (wanted.length === 0 || companyIndustries.length === 0) return true;
  const haystack = companyIndustries.join(' ').toLowerCase();
  return wanted.some((industry) => {
    const needle = industry.toLowerCase().trim();
    return needle.length > 2 && haystack.includes(needle);
  });
}

function freshnessConfidence(lastVerifiedAt: string | null): number {
  if (!lastVerifiedAt) return 0.4;
  const ageDays = (Date.now() - Date.parse(lastVerifiedAt)) / 86_400_000;
  if (ageDays <= 30) return 0.85;
  if (ageDays <= 90) return 0.7;
  if (ageDays <= 365) return 0.55;
  return 0.4;
}
