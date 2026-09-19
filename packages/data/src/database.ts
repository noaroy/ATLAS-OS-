import Database from 'better-sqlite3';
import { statSync, copyFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import type { Logger } from '@atlas/core';
import { AtlasError } from '@atlas/core';
import { MIGRATIONS } from './migrations.ts';

export type Db = Database.Database;

/**
 * Opens the ATLAS database and brings it to the current schema version.
 *
 * SQLite in WAL mode is a deliberate choice: ATLAS is a single-writer system
 * (one orchestrator process) with a read-heavy console. WAL gives concurrent
 * reads during writes, backups are a file copy, and there is no external
 * service to keep alive on the VPS — which directly serves the 24/7 goal.
 */
export interface OpenOptions {
  /**
   * Lecture seule, au sens de SQLite (SQLITE_OPEN_READONLY) : toute écriture
   * — INSERT, UPDATE, PRAGMA persistant, VACUUM, migration — est refusée par
   * le moteur lui-même, pas par notre discipline. C'est ce qu'une épreuve
   * (restauration, instantané) doit exiger d'une base vivante qu'un daemon
   * écrit en même temps : on la lit, et l'on ne peut pas la toucher.
   */
  readonly?: boolean;
}

export function openDatabase(file: string, logger: Logger, options: OpenOptions = {}): Db {
  const log = logger.child({ scope: 'db' });
  if (options.readonly) {
    const db = new Database(file, { readonly: true });
    // Rien ici n'écrit : busy_timeout, temp_store et mmap sont propres à la
    // connexion. journal_mode et synchronous ne se posent pas — la base est
    // déjà en WAL, et une connexion en lecture n'a pas de durabilité à régler.
    db.pragma('busy_timeout = 5000');
    db.pragma('temp_store = MEMORY');
    db.pragma('mmap_size = 268435456');
    try {
      assertSchemaCurrent(db);
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  }
  const db = new Database(file);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // NORMAL is safe under WAL: a crash can lose the last commit, never the file.
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');

  migrate(db, log);
  return db;
}

/**
 * En lecture seule on ne migre pas ; on vérifie que rien n'est à migrer. Une
 * base en retard se lirait avec des colonnes manquantes — mieux vaut le dire.
 */
function assertSchemaCurrent(db: Db): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").all();
  const applied = tables.length === 0
    ? new Set<number>()
    : new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version));
  const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).map((m) => m.version);
  if (pending.length > 0) {
    throw new AtlasError('INVALID_STATE', `base en retard de migration (${pending.join(', ')} manquante(s)) : elle ne se lit pas en lecture seule avant d’avoir été ouverte en écriture`, { details: { reason: 'SCHEMA_BEHIND', pending } });
  }
}

/**
 * Une écriture d'essai que SQLite doit refuser.
 *
 * La preuve qu'une connexion est en lecture seule ne se déclare pas : elle
 * se constate. Un UPDATE qui ne touche aucune ligne (WHERE 0) demande
 * pourtant une transaction d'écriture ; sur une connexion SQLITE_OPEN_READONLY
 * il tombe en SQLITE_READONLY, et c'est ce refus qu'on rapporte. Sur une
 * connexion en écriture il passerait — sans rien changer — et la preuve
 * échouerait : c'est bien ce qu'on veut savoir.
 */
export function proveReadonly(db: Db): { readonly: boolean; detail: string } {
  try {
    db.prepare('UPDATE schema_migrations SET version = version WHERE 0').run();
    return { readonly: false, detail: 'une écriture d’essai a été ACCEPTÉE : la connexion n’est pas en lecture seule' };
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    return code === 'SQLITE_READONLY'
      ? { readonly: true, detail: 'écriture d’essai refusée par SQLite (SQLITE_READONLY)' }
      : { readonly: false, detail: `écriture d’essai refusée pour une autre raison (${code || 'inconnue'})` };
  }
}

function migrate(db: Db, log: Logger): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version),
  );

  const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);
  if (pending.length === 0) {
    log.debug('schema up to date', { version: Math.max(0, ...applied) });
    return;
  }

  for (const migration of pending) {
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });

    try {
      run();
      log.info('migration applied', { version: migration.version, name: migration.name });
    } catch (err) {
      throw new AtlasError('INTERNAL', `Migration ${migration.version} (${migration.name}) failed`, {
        cause: err,
      });
    }
  }
}

/** Size of the database file plus its WAL, in megabytes. */
export function databaseSizeMb(file: string): number {
  let bytes = 0;
  for (const path of [file, `${file}-wal`]) {
    if (existsSync(path)) bytes += statSync(path).size;
  }
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

/**
 * Consistent online backup. `VACUUM INTO` produces a compacted, fully valid
 * database without blocking writers — safe to run on a live system.
 */
/**
 * Une sauvegarde atomique et verifiee.
 *
 * `VACUUM INTO` ecrit une base compactee et coherente pendant que le systeme
 * tourne — mais il ecrit directement au nom final. Un processus tue au milieu
 * laissait un fichier partiel portant le nom d'une sauvegarde, et c'est ce
 * fichier qu'une restauration aurait choisi comme « le plus recent ». La copie
 * est donc ecrite sous un nom temporaire, ouverte en lecture pour un
 * `integrity_check`, mesuree, puis renommee d'un seul geste. Un echec ne
 * laisse rien derriere lui.
 */
export function backupDatabase(db: Db, destination: string): number {
  const temporaire = `${destination}.tmp-${process.pid}`;
  try {
    db.prepare('VACUUM INTO ?').run(temporaire);
    const bytes = statSync(temporaire).size;
    if (bytes === 0) throw new AtlasError('INTERNAL', 'sauvegarde vide : le fichier ecrit fait 0 octet', { details: { reason: 'BACKUP_EMPTY' } });
    const copie = new Database(temporaire, { readonly: true });
    try {
      const verdict = (copie.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>)
        .map((r) => r.integrity_check);
      if (verdict.length !== 1 || verdict[0] !== 'ok') {
        throw new AtlasError('INTERNAL', `sauvegarde corrompue — integrity_check : ${verdict.join(' | ').slice(0, 200)}`, { details: { reason: 'BACKUP_CORRUPT' } });
      }
    } finally {
      copie.close();
    }
    renameSync(temporaire, destination);
    return bytes;
  } catch (error) {
    try {
      if (existsSync(temporaire)) unlinkSync(temporaire);
    } catch {
      /* un residu illisible se voit au prochain passage ; l erreur d origine prime */
    }
    throw error;
  }
}

/**
 * Un instantane coherent d'une base VIVANTE, sans y ecrire.
 *
 * La source est ouverte en lecture seule ; `VACUUM INTO` lit une image
 * coherente (WAL compris) pendant que le serveur continue d'ecrire. C'est ce
 * qu'utilisent les epreuves — restauration, daemon — pour travailler sur une
 * copie fidele de la base canonique sans jamais la toucher. Meme verification
 * qu'une sauvegarde : non vide, integre, renommee d'un seul geste.
 */
export function snapshotDatabase(source: string, destination: string): number {
  const lecture = new Database(source, { readonly: true });
  try {
    return backupDatabase(lecture, destination);
  } finally {
    lecture.close();
  }
}

/** Copies the file directly — used only when the connection is already closed. */
export function copyDatabase(source: string, destination: string): number {
  copyFileSync(source, destination);
  return statSync(destination).size;
}

// ─── JSON column helpers ────────────────────────────────────────────────────
// SQLite stores JSON as text. These keep parsing consistent and never throw on
// malformed data — a corrupt row degrades to a default instead of killing a
// mission mid-flight.

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export const toBool = (value: unknown): boolean => value === 1 || value === true;
export const fromBool = (value: boolean): number => (value ? 1 : 0);
