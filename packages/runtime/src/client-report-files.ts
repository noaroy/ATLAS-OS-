import type { Repositories } from '@atlas/data';
import type { ScoringModel } from '@atlas/contracts';
import { PIPELINE_VERSION } from '@atlas/departments';
import { loadClientRun } from './client-mission.ts';
import { buildClientRunReport, renderReviewQueue, type ClientRunReport } from './client-report-run.ts';

/**
 * Les fichiers d'un rapport client, écrits et enregistrés — sans les envoyer.
 *
 * Une seule fonction pour la commande `client:report` et pour le pilote
 * automatique : le PARTIAL que le pilote prépare est exactement celui que la
 * commande aurait écrit. L'écriture passe par `writeFile`, injectable, pour
 * que les tests écrivent en mémoire et que le pilote choisisse le dossier.
 */
export interface ReportFilesInput {
  status: 'PARTIAL' | 'FINAL';
  generatedAt: string;
  scoringModel: ScoringModel;
  executionMode: 'live' | 'simulation';
  sellingPriceEur?: number | null;
  /** Passe le rapport en PENDING_REVIEW une fois écrit. */
  submit?: boolean;
}

export interface ReportFiles {
  built: ClientRunReport;
  reportId: string;
  state: string;
  htmlPath: string;
  csvPath: string;
  exclusionsPath: string;
  reviewPath: string | null;
  reviewCounts: { P1: number; P2: number; P3: number };
}

export type WriteFile = (relativePath: string, content: string) => string;

export function writeClientReportFiles(repos: Repositories, runId: string, input: ReportFilesInput, writeFile: WriteFile): ReportFiles {
  const { brief } = loadClientRun(repos, runId);
  const built = buildClientRunReport(repos, runId, {
    status: input.status, generatedAt: input.generatedAt, scoringModel: input.scoringModel, executionMode: input.executionMode,
    sellingPriceEur: input.sellingPriceEur ?? null,
  });
  const stamp = input.generatedAt.slice(0, 16).replace(/[:T]/g, '-');
  const base = `client/${runId}/rapport-${input.status}-v${brief.version}-${stamp}`;
  const htmlPath = writeFile(`${base}.html`, built.html);
  const csvPath = writeFile(`${base}.csv`, built.csv);
  const exclusionsPath = writeFile(`${base}-ecartees.csv`, built.exclusionsCsv);

  // La file de revue, à côté : interne, jamais livrée.
  const revue = renderReviewQueue(repos, runId, input.generatedAt);
  let reviewPath: string | null = null;
  if (revue.items.length > 0) {
    reviewPath = writeFile(`client/${runId}/revue-v${brief.version}-${stamp}.html`, revue.html);
    writeFile(`client/${runId}/revue-v${brief.version}-${stamp}.csv`, revue.csv);
  }

  const row = repos.orders.recordReport({
    missionId: runId, htmlPath, csvPath, teaserPath: null,
    pipelineVersion: PIPELINE_VERSION, scoringVersion: 'client-criteria-v2', executionMode: input.executionMode,
    evidenceIds: built.evidenceIds, sources: built.report.sources, costUsd: built.costUsd,
    candidates: built.report.analysedCount, retained: built.retained.length, generatedAt: input.generatedAt,
  });
  const state = input.submit ? repos.orders.setReportState(row.id, 'PENDING_REVIEW').state : row.state;
  return {
    built, reportId: row.id, state, htmlPath, csvPath, exclusionsPath, reviewPath,
    reviewCounts: {
      P1: revue.items.filter((i) => i.priority === 'P1').length,
      P2: revue.items.filter((i) => i.priority === 'P2').length,
      P3: revue.items.filter((i) => i.priority === 'P3').length,
    },
  };
}
