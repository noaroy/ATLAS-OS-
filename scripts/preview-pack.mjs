/**
 * Rend un aperçu du Pack Expansion B2B Allemagne, sans rien dépenser.
 *
 * Sert à juger la forme du livrable avant qu'une mission payante ne produise le
 * fond. Les données sont des exemples et le disent : les domaines sont en
 * `.example`, réservé par la RFC 2606 pour ne jamais être résolu, et le titre
 * porte la mention. Un aperçu qui ressemblerait à un vrai pack finirait par
 * être pris pour un vrai pack.
 *
 *   node scripts/preview-pack.mjs [dossier de sortie]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildPack, packToHtml, packToCsv } from '../packages/departments/src/index.ts';

const outDir = process.argv[2] ?? '.';
mkdirSync(outDir, { recursive: true });

const iso = '2026-08-16T10:00:00.000Z';

const entry = (n, over = {}) => ({
  company: {
    id: `cmp_${n}`,
    canonicalKey: `d:exemple-${n}.example`,
    name: over.name ?? `Beispiel Verpackung ${n} GmbH`,
    legalName: null,
    country: 'Allemagne',
    region: over.region ?? 'Bavière',
    city: over.city ?? 'Nürnberg',
    website: `https://exemple-${n}.example`,
    domain: `exemple-${n}.example`,
    industries: over.industries ?? ['Machines d’emballage', 'Distribution industrielle'],
    sizeBand: 'medium',
    employeesEstimate: null,
    foundedYear: null,
    description: null,
    profile: {},
    enriched: true,
    dataOrigin: 'simulated',
    firstSeenAt: iso,
    lastVerifiedAt: null,
    createdAt: iso,
    updatedAt: iso,
  },
  opportunity: {
    id: `opp_${n}`,
    missionId: 'mis_apercu',
    departmentKey: 'business-expansion',
    companyId: `cmp_${n}`,
    targetTypes: over.roles ?? ['distributor'],
    stage: 'ranked',
    score: over.score ?? 82,
    scoreDetail: {
      total: over.score ?? 82,
      components: [],
      confidence: over.confidence ?? 0.74,
      roleFits: [],
      modelVersion: 'v1',
      scoredBy: 'analyst',
      scoredAt: iso,
    },
    qualification: {
      verdict: 'qualified',
      checks: [],
      rationale:
        over.rationale ??
        'Distributeur établi de machines d’emballage, couvrant la Bavière et l’Autriche, ' +
          'avec une gamme compatible et aucune marque concurrente déclarée.',
      confidence: 0.75,
      decidedBy: 'analyst',
      decidedAt: iso,
    },
    rank: n,
    justification:
      over.justification ??
      'Le mieux documenté du lot et le plus proche de la cible : à contacter en premier.',
  },
  evidence: over.evidence ?? [
    {
      id: `ev_${n}_1`,
      companyId: `cmp_${n}`,
      opportunityId: `opp_${n}`,
      missionId: 'mis_apercu',
      field: 'existence',
      claim: 'Société inscrite au registre du commerce de Nuremberg, active depuis 1998.',
      value: null,
      nature: 'observed',
      sourceKey: 'src_registry',
      sourceRef: `https://exemple-${n}.example/impressum`,
      sourceTitle: 'Impressum',
      basis: null,
      confidence: 0.9,
      simulated: true,
      collectedAt: iso,
      agentKey: 'explorer',
      createdAt: iso,
    },
    {
      id: `ev_${n}_2`,
      companyId: `cmp_${n}`,
      opportunityId: `opp_${n}`,
      missionId: 'mis_apercu',
      field: 'sector',
      claim:
        'Distribue des lignes de conditionnement et propose l’installation ; ' +
        'plusieurs postes ouverts au service export (Karriere).',
      value: null,
      nature: 'reported',
      sourceKey: 'src_site',
      sourceRef: `https://exemple-${n}.example/produkte`,
      sourceTitle: 'Produkte & Karriere',
      basis: null,
      confidence: 0.8,
      simulated: true,
      collectedAt: iso,
      agentKey: 'explorer',
      createdAt: iso,
    },
    {
      id: `ev_${n}_3`,
      companyId: `cmp_${n}`,
      opportunityId: `opp_${n}`,
      missionId: 'mis_apercu',
      field: 'fit',
      claim: 'Probablement ouverte à une représentation exclusive sur une gamme complémentaire.',
      value: null,
      nature: 'inferred',
      sourceKey: 'src_inference',
      sourceRef: null,
      sourceTitle: null,
      basis: 'Absence de marque concurrente déclarée sur la page « Produkte »',
      confidence: 0.5,
      simulated: true,
      collectedAt: iso,
      agentKey: 'analyst',
      createdAt: iso,
    },
  ],
  contacts: over.contacts ?? [],
});

const pack = buildPack({
  title: 'Pack Expansion B2B Allemagne — APERÇU (données d’exemple)',
  brief:
    'Aperçu de forme. Les entreprises ci-dessous n’existent pas : les domaines sont en ' +
    '« .example », réservé par la RFC 2606 pour ne jamais être résolu. Seule la structure ' +
    'du document est représentative.',
  generatedAt: iso,
  entries: [
    entry(1, {
      contacts: [
        {
          id: 'ct_1',
          companyId: 'cmp_1',
          name: 'Anna Weber',
          role: 'Leitung Vertrieb',
          email: 'a.weber@exemple-1.example',
          phone: '+49 911 000000',
          linkedin: null,
          confidence: 0.8,
          evidenceId: 'ev_1_1',
          createdAt: iso,
        },
      ],
    }),
    entry(2, {
      score: 76,
      confidence: 0.68,
      roles: ['distributor', 'integrator'],
      city: 'Stuttgart',
      region: 'Bade-Wurtemberg',
      justification: 'Double rôle confirmé, mais couverture géographique plus étroite.',
    }),
    entry(3, {
      score: 71,
      confidence: 0.61,
      city: 'Hambourg',
      region: 'Hambourg',
      justification: 'Correspond à la cible, dossier plus mince : à qualifier par un appel.',
      evidence: [
        {
          id: 'ev_3_1',
          companyId: 'cmp_3',
          opportunityId: 'opp_3',
          missionId: 'mis_apercu',
          field: 'existence',
          claim: 'Société active dans la distribution de machines industrielles à Hambourg.',
          value: null,
          nature: 'reported',
          sourceKey: 'src_site',
          sourceRef: 'https://exemple-3.example/ueber-uns',
          sourceTitle: 'Über uns',
          basis: null,
          confidence: 0.75,
          simulated: true,
          collectedAt: iso,
          agentKey: 'explorer',
          createdAt: iso,
        },
      ],
    }),
  ],
});

const htmlPath = join(outDir, 'pack-expansion-b2b-allemagne.html');
const csvPath = join(outDir, 'pack-expansion-b2b-allemagne.csv');
writeFileSync(htmlPath, packToHtml(pack), 'utf8');
writeFileSync(csvPath, packToCsv(pack), 'utf8');

console.log(`HTML : ${htmlPath}`);
console.log(`CSV  : ${csvPath}`);
console.log(`Prospects : ${pack.prospects.length} · limites signalées : ${pack.limitations.length}`);
