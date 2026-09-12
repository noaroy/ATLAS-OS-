import type { LlmRequest, LlmResponse } from '@atlas/llm';
import type { SearchProvider, SearchRequest, SearchResponse } from '@atlas/intelligence';
import { parseClientBrief, type ClientBrief } from '@atlas/departments';
import assert from 'node:assert/strict';

/**
 * Le marché suédois en réduction : cinq sites, un moteur, un modèle scripté.
 *
 * Partagé entre les tests et le dry-run : ce que le test vérifie et ce que le
 * fondateur ouvre dans son navigateur viennent des mêmes fixtures. Aucun
 * réseau, aucun modèle réel — et chaque site incarne un cas que l'audit avait
 * nommé : le bon distributeur, le revendeur d'un concurrent, le généraliste,
 * l'intrus allemand, le site sans matière.
 */
// ─── Le brief de test ────────────────────────────────────────────────────────

export const BRIEF_JSON = {
  client: { name: 'INTERNAL_TEST', offering: 'machines de contrôle et de conditionnement', internalTest: true },
  market: { country: 'Suède', countryLabel: 'Suède' },
  targetRoles: ['distributor'],
  productKeywords: ['förpackningsmaskiner', 'kontrollutrustning'],
  industries: ['kosmetik', 'läkemedel'],
  requiredCriteria: [
    { key: 'specialisation-technique', label: 'Vend ou distribue des machines industrielles', weight: 3 },
    { key: 'secteurs', label: 'Sert la cosmétique, la pharma ou l’agroalimentaire', weight: 2 },
  ],
  preferredCriteria: [{ key: 'service', label: 'Assure installation et service', weight: 1 }],
  exclusionCriteria: [],
  competitorExclusions: ['Mettler', 'Ishida'],
  preferSpecialist: true,
};

export function brief(): ClientBrief {
  const v = parseClientBrief(BRIEF_JSON);
  assert.ok(v.ok, v.errors.join(' ; '));
  return v.brief!;
}

// ─── Les fixtures ────────────────────────────────────────────────────────────

export const SITES: Record<string, string> = {
  'nordpack.se': `<html><head><title>Nordpack AB</title></head><body>
    <p>Nordpack AB är distributör av förpackningsmaskiner och kontrollutrustning för kosmetik och läkemedel i Sverige.</p>
    <p>Vi installerar och servar alla maskiner vi levererar.</p>
    <p>Org.nr 556123-4567 · Göteborg · <a href="mailto:info@nordpack.se">info@nordpack.se</a> · +46 31 123 45 67</p>
    <a href="/kontakta-oss">Kontakta oss</a></body></html>`,
  'allmaskin.se': `<html><head><title>Allmaskin</title></head><body>
    <p>Allmaskin säljer allt inom industri: pumpar, verktyg, kontorsmöbler, förpackningsmaskiner, städutrustning och belysning.</p>
    <p>Vi är återförsäljare för Ishida i Sverige.</p>
    <p>Organisationsnummer: 556999-0001 · Stockholm</p></body></html>`,
  'generalbolaget.se': `<html><head><title>Generalbolaget</title></head><body>
    <p>Generalbolaget är en grossist med ett brett sortiment: pumpar, verktyg, kontorsmöbler, förpackningsmaskiner, städutrustning, belysning och trädgård.</p>
    <p>Org.nr 556555-1234 · Malmö</p></body></html>`,
  'packmaschinen.de': `<html><head><title>Packmaschinen GmbH</title></head><body>
    <p>Packmaschinen GmbH vertreibt Verpackungsmaschinen in Deutschland.</p>
    <p>Impressum: Packmaschinen GmbH, Hamburg, Deutschland. USt-IdNr. DE123456789</p></body></html>`,
  'tystbolag.se': `<html><head><title>Tyst</title></head><body><p>Välkommen.</p></body></html>`,
  // Trinex : une adresse personnelle publiée avant l'adresse générale.
  'trinexlik.se': `<html><head><title>Trinexlik AB</title></head><body>
    <p>Trinexlik AB är distributör av förpackningsmaskiner och kontrollutrustning för läkemedel.</p>
    <p>Kontakt: <a href="mailto:per.heidnert@trinexlik.se">per.heidnert@trinexlik.se</a> · <a href="mailto:info@trinexlik.se">info@trinexlik.se</a></p>
    <p>Org.nr 556732-8884 · Stockholm</p></body></html>`,
  // Kafeko : un site suédois qui déclare SE, avec un téléphone finlandais.
  'kafekolik.se': `<html><head><title>Kafekolik Nordic</title>
    <script type="application/ld+json">{"@type":"Organization","name":"Kafekolik Nordic","address":{"@type":"PostalAddress","addressCountry":"SE"}}</script></head><body>
    <p>Kafekolik är distributör av förpackningsmaskiner för läkemedel på den nordiska marknaden.</p>
    <p>Tel +358 9 4131 5400 · <a href="mailto:info@kafekolik.se">info@kafekolik.se</a></p></body></html>`,
};

export function searchFixture(results: Array<{ domain: string; title: string }>, outcome: SearchResponse['outcome'] = 'ok'): SearchProvider & { calls: number } {
  const p = {
    key: 'searxng', label: 'fixture', calls: 0,
    availability: () => ({ available: true, reason: 'fixture' }),
    async search(request: SearchRequest): Promise<SearchResponse> {
      p.calls += 1;
      return {
        results: outcome === 'ok' ? results.map((r, i) => ({
          title: r.title, url: `https://${r.domain}/`, snippet: '', provider: 'fixture', rank: i + 1,
          query: request.query, retrievedAt: '2026-09-11T00:00:00.000Z',
        })) : [],
        outcome, detail: outcome, costUsd: 0, durationMs: 1,
      };
    },
  };
  return p;
}

export const fetchFixture = (pannes: Set<string> = new Set()) => async (urls: readonly string[]) => {
  const out: Array<{ url: string; html: string }> = [];
  for (const url of urls) {
    const host = new URL(url).hostname;
    if (pannes.has(host)) throw new Error(`ECONNRESET ${host}`);
    const html = SITES[host];
    if (html && new URL(url).pathname === '/') out.push({ url, html });
  }
  return out;
};

/** Un modèle scripté : il lit les passages et rend les numéros qui contiennent un mot-clé. */
export function llmFixture(): { complete(r: LlmRequest): Promise<LlmResponse>; calls: number } {
  const p = {
    calls: 0,
    async complete(request: LlmRequest): Promise<LlmResponse> {
      p.calls += 1;
      const texte = request.messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((c) => ('text' in c ? c.text : '')).join('\n'))).join('\n');
      const blocs = [...texte.matchAll(/^\[(\d+)\] (.+)$/gm)].map((m) => ({ id: Number(m[1]), text: m[2]! }));
      const trouve = (re: RegExp) => blocs.filter((b) => re.test(b.text)).map((b) => b.id);
      const spec = trouve(/distributör.*förpackningsmaskiner|förpackningsmaskiner.*kontrollutrustning/i);
      const secteurs = trouve(/kosmetik|läkemedel/i);
      const service = trouve(/installerar|servar/i);
      const general = trouve(/allt inom industri|brett sortiment/i);
      const json = {
        activity: 'Résumé de test', sectors: ['emballage'],
        criteria: [
          { key: 'specialisation-technique', verdict: spec.length ? 'ESTABLISHED' : 'TO_CONFIRM', evidenceBlockIds: spec, note: 'distributeur de machines d’emballage' },
          { key: 'secteurs', verdict: secteurs.length ? 'ESTABLISHED' : 'TO_CONFIRM', evidenceBlockIds: secteurs, note: 'cosmétique et pharma' },
          { key: 'service', verdict: service.length ? 'ESTABLISHED' : 'TO_CONFIRM', evidenceBlockIds: service, note: 'installation et service' },
        ],
        specialisation: general.length
          ? { verdict: 'GENERALIST', evidenceBlockIds: general, note: 'catalogue large et hétérogène' }
          : { verdict: 'SPECIALIST', evidenceBlockIds: spec, note: 'machines d’emballage au cœur' },
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(json) }],
        stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 }, model: request.model,
      } as unknown as LlmResponse;
    },
  };
  return p;
}

export const TOUS = [
  { domain: 'nordpack.se', title: 'Nordpack' }, { domain: 'allmaskin.se', title: 'Allmaskin' },
  { domain: 'generalbolaget.se', title: 'Generalbolaget' }, { domain: 'packmaschinen.de', title: 'Packmaschinen' },
  { domain: 'europages.se', title: 'Annuaire' }, { domain: 'tystbolag.se', title: 'Tyst' },
];
