import { describeError } from '@atlas/core';
import type { BudgetLedger } from './budget.ts';
import type { LlmProvider, LlmRequest, LlmResponse } from './types.ts';
import { toolCallsOf } from './types.ts';

/**
 * Le passage obligé de tout appel au modèle.
 *
 * C'est un décorateur plutôt qu'une vérification dans l'orchestrateur, et ce
 * choix est le fond de la correction. LIVE #001 a dépensé 1,37 million de
 * jetons dans une étape parce que le contrôle vivait *au-dessus* des appels :
 * il fallait que chaque appelant pense à le consulter. Ici la vérification est
 * en dessous. Le runtime des agents, le planificateur, l'extraction de brief,
 * la recherche web — tous appellent `complete`, donc tous sont plafonnés, y
 * compris ceux qui n'existent pas encore.
 *
 * Un appelant qui voudrait contourner le budget devrait délibérément
 * s'emparer du provider brut. Ce n'est pas une impossibilité formelle, mais
 * c'est la meilleure garantie qu'une architecture puisse offrir sans rendre le
 * système inutilisable : il n'y a plus d'oubli possible, seulement une fraude.
 */
export class BudgetedProvider implements LlmProvider {
  readonly kind: LlmProvider['kind'];

  constructor(
    private readonly inner: LlmProvider,
    private readonly ledger: BudgetLedger,
  ) {
    this.kind = inner.kind;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    // Refuse avant de dépenser. Lève BUDGET_EXCEEDED, non réessayable.
    this.ledger.authorise(request);

    // La sortie est bornée même quand l'appelant demande davantage : une
    // réponse non plafonnée est le seul poste de coût qu'on ne peut pas
    // interrompre une fois lancé.
    const capped: LlmRequest = {
      ...request,
      maxTokens: this.ledger.cappedMaxTokens(request),
    };

    const started = Date.now();
    try {
      const response = await this.inner.complete(capped);
      this.ledger.record(capped, response, {
        provider: this.inner.kind,
        durationMs: Date.now() - started,
        toolCalls: toolCallsOf(response.content).length,
      });
      return response;
    } catch (err) {
      // Un échec est comptabilisé lui aussi : il alimente le coupe-circuit, et
      // c'est la répétition d'une panne qui coûte cher, pas l'échec isolé.
      this.ledger.recordFailure(capped, describeError(err), {
        provider: this.inner.kind,
        durationMs: Date.now() - started,
      });
      throw err;
    }
  }
}
