import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { nowIso } from '@atlas/core';
import type { Db } from '../database.ts';

/**
 * Ce qui a déjà été lu ou jugé, pour ne pas le relire ni le repayer.
 *
 * Deux mémoires, distinctes parce que leurs clés le sont :
 *
 *   - une page, par adresse : le HTML compressé, ou l'échec qui l'a remplacé.
 *     Un chemin qui a rendu 404 hier rend 404 aujourd'hui ; le redemander
 *     coûte une requête et jusqu'à deux secondes et demie.
 *   - une qualification, par (société, brief, contenu) : la réponse du modèle
 *     à la même question sur les mêmes passages. Si le brief change — un
 *     critère, un mot-clé — la clé change, et la question est reposée.
 *
 * Aucune des deux n'est une vérité : ce sont des copies datées. Une entrée
 * plus vieille que sa durée de vie est ignorée, pas servie.
 */
export interface CachedPage {
  url: string;
  domain: string;
  ok: boolean;
  status: number | null;
  kind: string | null;
  /** L'adresse après redirections, quand elle diffère de celle demandée. */
  finalUrl: string | null;
  html: string | null;
  fetchedAt: string;
}

export interface CachedQualification {
  key: string;
  domain: string;
  briefHash: string;
  contentHash: string;
  model: string;
  output: unknown;
  createdAt: string;
}

export const PAGE_CACHE_TTL_MS = 14 * 86_400_000;
export const QUALIFICATION_CACHE_TTL_MS = 30 * 86_400_000;

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

interface PageRow {
  url: string; domain: string; ok: number; status: number | null; kind: string | null; final_url: string | null; html_gz: Buffer | null; fetched_at: string;
}
interface QualRow {
  key: string; domain: string; brief_hash: string; content_hash: string; model: string; output: string; created_at: string;
}

export class ClientCacheRepository {
  constructor(private readonly db: Db) {}

  getPage(url: string, maxAgeMs = PAGE_CACHE_TTL_MS, now = nowIso()): CachedPage | null {
    const row = this.db.prepare('SELECT * FROM page_cache WHERE url = ?').get(url) as PageRow | undefined;
    if (!row) return null;
    if (Date.parse(now) - Date.parse(row.fetched_at) > maxAgeMs) return null;
    return {
      url: row.url, domain: row.domain, ok: row.ok === 1, status: row.status, kind: row.kind, finalUrl: row.final_url,
      html: row.html_gz ? gunzipSync(row.html_gz).toString('utf8') : null, fetchedAt: row.fetched_at,
    };
  }

  putPage(page: { url: string; domain: string; ok: boolean; status?: number | null; kind?: string | null; finalUrl?: string | null; html?: string | null }): void {
    this.db.prepare(
      `INSERT INTO page_cache (url, domain, ok, status, kind, final_url, html_gz, fetched_at)
       VALUES (@url, @domain, @ok, @status, @kind, @final_url, @html_gz, @fetched_at)
       ON CONFLICT(url) DO UPDATE SET ok = excluded.ok, status = excluded.status, kind = excluded.kind,
         final_url = excluded.final_url, html_gz = excluded.html_gz, fetched_at = excluded.fetched_at`,
    ).run({
      url: page.url, domain: page.domain, ok: page.ok ? 1 : 0, status: page.status ?? null, kind: page.kind ?? null,
      final_url: page.finalUrl ?? null,
      html_gz: page.html ? gzipSync(Buffer.from(page.html, 'utf8')) : null, fetched_at: nowIso(),
    });
  }

  pagesForDomain(domain: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM page_cache WHERE domain = ?').get(domain) as { n: number }).n;
  }

  purgePages(olderThanMs = PAGE_CACHE_TTL_MS, now = nowIso()): number {
    const limite = new Date(Date.parse(now) - olderThanMs).toISOString();
    return this.db.prepare('DELETE FROM page_cache WHERE fetched_at < ?').run(limite).changes;
  }

  qualificationKey(domain: string, briefHash: string, contentHash: string): string {
    return sha256(`${domain}|${briefHash}|${contentHash}`);
  }

  getQualification(key: string, maxAgeMs = QUALIFICATION_CACHE_TTL_MS, now = nowIso()): CachedQualification | null {
    const row = this.db.prepare('SELECT * FROM qualification_cache WHERE key = ?').get(key) as QualRow | undefined;
    if (!row) return null;
    if (Date.parse(now) - Date.parse(row.created_at) > maxAgeMs) return null;
    return {
      key: row.key, domain: row.domain, briefHash: row.brief_hash, contentHash: row.content_hash, model: row.model,
      output: JSON.parse(row.output) as unknown, createdAt: row.created_at,
    };
  }

  putQualification(entry: { key: string; domain: string; briefHash: string; contentHash: string; model: string; output: unknown }): void {
    this.db.prepare(
      `INSERT INTO qualification_cache (key, domain, brief_hash, content_hash, model, output, created_at)
       VALUES (@key, @domain, @brief_hash, @content_hash, @model, @output, @created_at)
       ON CONFLICT(key) DO UPDATE SET output = excluded.output, model = excluded.model, created_at = excluded.created_at`,
    ).run({
      key: entry.key, domain: entry.domain, brief_hash: entry.briefHash, content_hash: entry.contentHash,
      model: entry.model, output: JSON.stringify(entry.output), created_at: nowIso(),
    });
  }

  counts(): { pages: number; qualifications: number } {
    return {
      pages: (this.db.prepare('SELECT COUNT(*) AS n FROM page_cache').get() as { n: number }).n,
      qualifications: (this.db.prepare('SELECT COUNT(*) AS n FROM qualification_cache').get() as { n: number }).n,
    };
  }
}
