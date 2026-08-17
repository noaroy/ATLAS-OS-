import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { User, UserRole, AuthSession } from '@atlas/contracts';
import { id, nowIso, addMs, unauthorized } from '@atlas/core';
import type { Db } from '../database.ts';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  password_hash: string;
  password_salt: string;
  created_at: string;
  last_login_at: string | null;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
});

/** scrypt with a per-user salt — no external dependency, no reversible storage. */
function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password: string, salt: string, expected: string): boolean {
  const actual = hashPassword(password, salt);
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Tokens are stored hashed, so a database leak cannot be replayed as a login. */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export class UserRepository {
  constructor(private readonly db: Db) {}

  findByEmail(email: string): User | null {
    const row = this.db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email.toLowerCase()) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  findById(userId: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  /** Tous les comptes, sans le moindre élément d'authentification. */
  list(): User[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[];
    return rows.map(toUser);
  }

  /**
   * La *forme* des identifiants stockés — jamais leur contenu.
   *
   * Permet d'affirmer « le mot de passe est stocké de façon sûre » après
   * l'avoir relu dans la base, plutôt que sur la foi du code qui vient de
   * l'écrire. Ne rend que des longueurs : rien ici ne rapproche d'un secret.
   */
  credentialShape(userId: string): { algorithm: 'scrypt'; hashBytes: number; saltBytes: number } {
    const row = this.db
      .prepare('SELECT length(password_hash) AS h, length(password_salt) AS s FROM users WHERE id = ?')
      .get(userId) as { h: number; s: number } | undefined;

    if (!row) throw unauthorized('Unknown account');
    // Les colonnes sont hexadécimales : deux caractères par octet.
    return { algorithm: 'scrypt', hashBytes: row.h / 2, saltBytes: row.s / 2 };
  }

  create(input: { email: string; name: string; role: UserRole; password: string }): User {
    const salt = randomBytes(16).toString('hex');
    const row: UserRow = {
      id: id('usr'),
      email: input.email.toLowerCase(),
      name: input.name,
      role: input.role,
      password_hash: hashPassword(input.password, salt),
      password_salt: salt,
      created_at: nowIso(),
      last_login_at: null,
    };

    this.db
      .prepare(
        `INSERT INTO users (id, email, name, role, password_hash, password_salt, created_at, last_login_at)
         VALUES (@id, @email, @name, @role, @password_hash, @password_salt, @created_at, @last_login_at)`,
      )
      .run(row);
    return toUser(row);
  }

  setPassword(userId: string, password: string): void {
    const salt = randomBytes(16).toString('hex');
    this.db
      .prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
      .run(hashPassword(password, salt), salt, userId);
  }

  /** Verifies credentials and issues a session. Throws on any mismatch. */
  authenticate(email: string, password: string, userAgent?: string): AuthSession {
    const row = this.db
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email.toLowerCase()) as UserRow | undefined;

    if (!row || !verifyPassword(password, row.password_salt, row.password_hash)) {
      throw unauthorized('Invalid email or password');
    }

    const now = nowIso();
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, row.id);
    return this.createSession({ ...toUser(row), lastLoginAt: now }, userAgent);
  }

  createSession(user: User, userAgent?: string): AuthSession {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = addMs(nowIso(), SESSION_TTL_MS);

    this.db
      .prepare(
        `INSERT INTO auth_sessions (id, user_id, expires_at, created_at, user_agent)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hashToken(token), user.id, expiresAt, nowIso(), userAgent ?? null);

    return { token, user, expiresAt };
  }

  /** Resolves a session token to its user, or null if invalid/expired. */
  resolveSession(token: string): User | null {
    return this.resolveSessionDetailed(token)?.user ?? null;
  }

  /** Resolves a token and reports how much life the session has left. */
  resolveSessionDetailed(token: string): { user: User; expiresAt: string } | null {
    const row = this.db
      .prepare('SELECT user_id, expires_at FROM auth_sessions WHERE id = ?')
      .get(hashToken(token)) as { user_id: string; expires_at: string } | undefined;

    if (!row) return null;
    if (Date.parse(row.expires_at) < Date.now()) {
      this.revoke(token);
      return null;
    }

    const user = this.findById(row.user_id);
    return user ? { user, expiresAt: row.expires_at } : null;
  }

  /**
   * Issues a fresh session and retires the old one, atomically.
   *
   * Rotating rather than extending means a stolen token stops working as soon
   * as the real session slides forward, and the window of a leak is bounded by
   * the refresh interval rather than the full session lifetime.
   */
  rotateSession(oldToken: string, user: User, userAgent?: string): AuthSession {
    const rotate = this.db.transaction(() => {
      this.revoke(oldToken);
      return this.createSession(user, userAgent);
    });
    return rotate();
  }

  /**
   * Rotates only when the session has passed the halfway point of its life.
   *
   * Rotating on every request would churn the table and invalidate tokens held
   * by concurrent in-flight requests from the same client.
   */
  refreshIfNeeded(token: string, userAgent?: string): AuthSession | null {
    const current = this.resolveSessionDetailed(token);
    if (!current) return null;

    const remaining = Date.parse(current.expiresAt) - Date.now();
    if (remaining > SESSION_TTL_MS / 2) return null;

    return this.rotateSession(token, current.user, userAgent);
  }

  /** Lifetime of a session, in seconds — used to set the cookie's Max-Age. */
  static get sessionTtlSeconds(): number {
    return Math.floor(SESSION_TTL_MS / 1000);
  }

  revoke(token: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(hashToken(token));
  }

  /**
   * Termine toutes les sessions d'un compte.
   *
   * Appelé après un changement de mot de passe. Sans cela, un jeton déjà volé
   * continuerait de fonctionner quatorze jours — précisément la durée que le
   * changement de mot de passe était censé interrompre. Un mot de passe change
   * pour reprendre le contrôle ; laisser vivre les sessions ouvertes revient à
   * ne changer que la serrure de la porte d'entrée.
   */
  revokeAllForUser(userId: string): number {
    return this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId).changes;
  }

  /** Housekeeping run by the supervisor; returns how many rows were removed. */
  purgeExpiredSessions(): number {
    return this.db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(nowIso()).changes;
  }
}
