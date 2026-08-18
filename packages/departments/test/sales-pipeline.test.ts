import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSalesPipeline, funnelBalances, type PipelineCandidate } from '../src/sales-pipeline.ts';

/**
 * Un fournisseur qui compte ses appels et rend une réponse vide.
 *
 * Le test statique sur le source prouve que le résolveur ne *peut pas*
 * appeler ; celui-ci prouve que le pipeline ne l'appelle pas. Ce ne sont pas
 * les mêmes affirmations : la première porte sur un module, la seconde sur
 * l'ordre dans lequel on s'en sert.
 */
function spyProvider() {
  const calls: string[] = [];
  return {
    calls,
    qualify: async (s: { identity: { companyName: string } }) => {
      calls.push(s.identity.companyName);
      return { score: 80 };
    },
  };
}

const MARKET_REPORT: PipelineCandidate = {
  searchTitle: 'Entreprises du secteur Automatisation Industrielle Et Contrôles ...',
  url: 'https://www.mordorintelligence.com/fr/industry-reports/france-factory-automation-and-industrial-controls-market/companies',
  domain: 'mordorintelligence.com',
};

const GENERIC_TITLE: PipelineCandidate = {
  // Domaine trop court pour servir de repli, titre purement descriptif :
  // personne n'est nommé, donc personne n'est qualifié.
  searchTitle: 'Solutions techniques industrielles',
  url: 'https://abc.fr/',
  domain: 'abc.fr',
};

const DIRECTORY: PipelineCandidate = {
  searchTitle: 'Entreprises Construction de machines spéciales',
  url: 'https://fr.kompass.com/annuaire/machines-speciales',
  domain: 'kompass.com',
};

const AGENCY: PipelineCandidate = {
  searchTitle: 'Industriailes, l’agence marketing & communication B2B pour l’industrie',
  url: 'https://www.industri-ailes.fr/communication-industrie-b2b/',
  domain: 'industri-ailes.fr',
};

const REAL: PipelineCandidate = {
  searchTitle: 'CIRMECA',
  url: 'https://cirmeca.com/',
  domain: 'cirmeca.com',
  snippet: 'Fabricant français de machines spéciales pour l’industrie.',
};

test('aucun appel au modèle sur un candidat que les gardes refusent', async () => {
  for (const candidate of [MARKET_REPORT, GENERIC_TITLE, DIRECTORY, AGENCY]) {
    const spy = spyProvider();
    const outcome = await runSalesPipeline({
      candidates: [candidate],
      maxRetained: 10,
      qualify: spy.qualify,
    });
    assert.equal(spy.calls.length, 0, `« ${candidate.searchTitle.slice(0, 40)} » a déclenché un appel`);
    assert.equal(outcome.survivors.length, 0);
    assert.equal(outcome.qualifications.length, 0);
    assert.equal(outcome.rejections.length, 1, 'un candidat écarté doit l’être une seule fois');
  }
});

test('un lot entièrement invalide ne coûte rien', async () => {
  const spy = spyProvider();
  const outcome = await runSalesPipeline({
    candidates: [MARKET_REPORT, GENERIC_TITLE, DIRECTORY, AGENCY],
    maxRetained: 10,
    qualify: spy.qualify,
  });
  assert.equal(spy.calls.length, 0);
  assert.equal(outcome.funnel.retained, 0);
  assert.equal(funnelBalances(outcome.funnel).balanced, true);
});

test('le modèle n’est appelé qu’après une identité validée', async () => {
  const order: string[] = [];
  const outcome = await runSalesPipeline({
    candidates: [MARKET_REPORT, REAL, DIRECTORY],
    maxRetained: 10,
    qualify: async (s) => {
      // Au moment où la qualification s'exécute, l'identité existe déjà :
      // c'est elle qui est passée en argument.
      assert.ok(s.identity.companyName, 'la qualification reçoit une identité résolue');
      assert.ok(s.identity.canonicalDomain, 'et un domaine officiel');
      assert.ok(s.identity.identityConfidence > 0, 'et une confiance non nulle');
      order.push(s.identity.companyName);
      return { score: 80 };
    },
  });

  assert.deepEqual(order, ['CIRMECA'], 'seul le survivant est qualifié');
  assert.equal(outcome.qualifications.length, 1);
  assert.equal(outcome.qualifications[0]!.survivor.identity.companyName, 'CIRMECA');
});

test('le plafond de qualifications borne la dépense, pas la résolution', async () => {
  const spy = spyProvider();
  const many: PipelineCandidate[] = ['cirmeca.com', 'seraap.com', 'asm-indus.com'].map((d) => ({
    searchTitle: d.split('.')[0]!.toUpperCase(),
    url: `https://${d}/`,
    domain: d,
    snippet: 'Fabricant français de machines spéciales.',
  }));

  const outcome = await runSalesPipeline({
    candidates: many,
    maxRetained: 10,
    maxQualifications: 2,
    qualify: spy.qualify,
  });
  assert.equal(outcome.survivors.length, 3, 'la résolution est gratuite, elle ne se rationne pas');
  assert.equal(spy.calls.length, 2, 'la qualification est payante, elle se rationne');
});

test('l’entonnoir ferme : chaque résultat finit dans exactement une case', async () => {
  const spy = spyProvider();
  const outcome = await runSalesPipeline({
    candidates: [MARKET_REPORT, REAL, DIRECTORY, AGENCY, GENERIC_TITLE, { ...REAL, url: 'https://cirmeca.com/contact' }],
    maxRetained: 10,
    qualify: spy.qualify,
  });
  const balance = funnelBalances(outcome.funnel);
  assert.equal(balance.balanced, true, `entonnoir déséquilibré : ${balance.missing} résultat(s) sans case`);
  assert.equal(outcome.funnel.searchResults, 6);
  assert.equal(outcome.funnel.deduplicated, 1, 'deux pages d’un même site font une entreprise');
});
