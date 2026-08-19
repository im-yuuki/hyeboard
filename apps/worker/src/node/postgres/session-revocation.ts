import { derivePostgresOpaqueHash, toPostgresEpochMilliseconds, type PostgresHmacSecret } from "./crypto";
import type { PostgresPoolLike } from "./pool";

export type SessionRevocationSubject = "token" | "session";
export type SessionRevocationExpiry = Date | string | number;

export interface SessionRevocationStore {
  revoke(subject: SessionRevocationSubject, value: string, expiresAt: SessionRevocationExpiry): Promise<void>;
  isRevoked(subject: SessionRevocationSubject, value: string, now?: number): Promise<boolean>;
  revokeToken(token: string, expiresAt: SessionRevocationExpiry): Promise<void>;
  isTokenRevoked(token: string, now?: number): Promise<boolean>;
  revokeSession(sessionId: string, expiresAt: SessionRevocationExpiry): Promise<void>;
  isSessionRevoked(sessionId: string, now?: number): Promise<boolean>;
}

export class PostgresSessionRevocationStore implements SessionRevocationStore {
  constructor(private readonly pool: PostgresPoolLike, private readonly secret: PostgresHmacSecret) {}

  async revoke(subject: SessionRevocationSubject, value: string, expiresAt: SessionRevocationExpiry): Promise<void> {
    const subjectHash = derivePostgresOpaqueHash(this.secret, subject, value);
    const expiry = toPostgresEpochMilliseconds(expiresAt);
    await this.pool.query(
      `INSERT INTO hyeboard_session_revocations (subject_kind, subject_hash, expires_at_ms)
       VALUES ($1, $2, $3)
       ON CONFLICT (subject_kind, subject_hash)
       DO UPDATE SET expires_at_ms = GREATEST(hyeboard_session_revocations.expires_at_ms, EXCLUDED.expires_at_ms)`,
      [subject, subjectHash, expiry],
    );
  }

  async isRevoked(subject: SessionRevocationSubject, value: string, now = Date.now()): Promise<boolean> {
    const subjectHash = derivePostgresOpaqueHash(this.secret, subject, value);
    await this.pool.query(
      "DELETE FROM hyeboard_session_revocations WHERE subject_kind = $1 AND subject_hash = $2 AND expires_at_ms <= $3",
      [subject, subjectHash, now],
    );
    const result = await this.pool.query<{ subject_hash: string }>(
      "SELECT subject_hash FROM hyeboard_session_revocations WHERE subject_kind = $1 AND subject_hash = $2 AND expires_at_ms > $3",
      [subject, subjectHash, now],
    );
    return result.rows.length > 0;
  }

  revokeToken(token: string, expiresAt: SessionRevocationExpiry): Promise<void> {
    return this.revoke("token", token, expiresAt);
  }

  isTokenRevoked(token: string, now?: number): Promise<boolean> {
    return this.isRevoked("token", token, now);
  }

  revokeSession(sessionId: string, expiresAt: SessionRevocationExpiry): Promise<void> {
    return this.revoke("session", sessionId, expiresAt);
  }

  isSessionRevoked(sessionId: string, now?: number): Promise<boolean> {
    return this.isRevoked("session", sessionId, now);
  }
}
