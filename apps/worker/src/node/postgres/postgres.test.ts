import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { derivePostgresOpaqueHash, toPostgresEpochMilliseconds } from "./crypto";
import { runPostgresMigrations } from "./migrations";
import { PostgresSessionRevocationStore } from "./session-revocation";
import { PostgresVnuRefreshControlCoordinator } from "./vnu-refresh-coordinator";
import type { PostgresConnection, PostgresPoolLike } from "./pool";
import type { LinkedPair } from "../../vnu-refresh-control";

const SECRET = "postgres-test-secret-with-at-least-32-bytes";
const PAIR: LinkedPair = {
  accessTokenId: "A".repeat(22),
  accessExpiresAt: Date.parse("2036-02-03T12:00:00.000Z"),
  grantId: "B".repeat(22),
  grantExpiresAt: Date.parse("2036-02-03T13:00:00.000Z"),
};

class FakeConnection implements PostgresConnection {
  readonly queries: Array<{ text: string; values?: readonly unknown[] }> = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, values });
    if (text.includes("FROM hyeboard_vnu_refresh_principals")) return { rows: [] as Row[] };
    if (text.includes("FROM hyeboard_vnu_refresh_tombstones")) return { rows: [] as Row[] };
    return { rows: [] as Row[] };
  }

  release(): void {}
}

class FakePool implements PostgresPoolLike {
  readonly connection = new FakeConnection();

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    return this.connection.query<Row>(text, values);
  }

  async connect(): Promise<PostgresConnection> {
    return this.connection;
  }

  async transaction<T>(body: (connection: PostgresConnection) => Promise<T>): Promise<T> {
    return body(this.connection);
  }
}

describe("PostgreSQL HA boundaries", () => {
  it("derives domain-separated opaque hashes without retaining the subject", () => {
    const tokenHash = derivePostgresOpaqueHash(SECRET, "token", "raw-session-token");
    const sessionHash = derivePostgresOpaqueHash(SECRET, "session", "raw-session-token");
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toBe(sessionHash);
    expect(tokenHash).not.toContain("raw-session-token");
  });

  it("normalizes only valid expiry timestamps", () => {
    expect(toPostgresEpochMilliseconds("2036-02-03T12:00:00.000Z")).toBe(PAIR.accessExpiresAt);
    expect(toPostgresEpochMilliseconds(new Date(PAIR.accessExpiresAt))).toBe(PAIR.accessExpiresAt);
    expect(() => toPostgresEpochMilliseconds("not-a-date")).toThrow();
  });

  it("uses hashed values for generic token revocation", async () => {
    const pool = new FakePool();
    const store = new PostgresSessionRevocationStore(pool, SECRET);
    await store.revokeToken("raw-session-token", PAIR.accessExpiresAt);
    expect(pool.connection.queries[0].values).not.toContain("raw-session-token");
    expect(pool.connection.queries[0].values?.[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("locks a principal before applying the pure activation transition", async () => {
    const pool = new FakePool();
    const coordinator = new PostgresVnuRefreshControlCoordinator(pool);
    await expect(coordinator.activatePair("a".repeat(64), PAIR)).resolves.toEqual({ kind: "activated" });
    const sql = pool.connection.queries.map(({ text }) => text).join("\n");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("WHERE principal_key = $1\n      FOR UPDATE");
    expect(JSON.stringify(pool.connection.queries)).not.toMatch(/password|cookie|raw.?token/i);
  });

  it("runs migrations under a session advisory lock and records applied SQL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hyeboard-postgres-migrations-"));
    try {
      await writeFile(join(directory, "001_test.sql"), "CREATE TABLE migration_test (id integer);\n", "utf8");
      const pool = new FakePool();
      const applied = await runPostgresMigrations(pool, directory);
      expect(applied).toHaveLength(1);
      expect(applied[0].name).toBe("001_test.sql");
      const sql = pool.connection.queries.map(({ text }) => text).join("\n");
      expect(sql).toContain("pg_advisory_lock");
      expect(sql).toContain("hyeboard_schema_migrations");
      expect(sql).toContain("pg_advisory_unlock");
      const statements = pool.connection.queries.map(({ text }) => text);
      expect(statements.indexOf("BEGIN")).toBeLessThan(statements.indexOf("CREATE TABLE migration_test (id integer);\n"));
      expect(statements.indexOf("CREATE TABLE migration_test (id integer);\n")).toBeLessThan(statements.findIndex((text) => text.includes("INSERT INTO hyeboard_schema_migrations")));
      expect(statements.findIndex((text) => text.includes("INSERT INTO hyeboard_schema_migrations"))).toBeLessThan(statements.indexOf("COMMIT"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("orders migrations by numeric version and rejects an unknown applied version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hyeboard-postgres-migration-order-"));
    try {
      await writeFile(join(directory, "10_later.sql"), "SELECT 10;\n", "utf8");
      await writeFile(join(directory, "2_earlier.sql"), "SELECT 2;\n", "utf8");
      const pool = new FakePool();
      const applied = await runPostgresMigrations(pool, directory);
      expect(applied.map((migration) => migration.version)).toEqual([2, 10]);
      expect(pool.connection.queries.map(({ text }) => text)).toEqual(expect.arrayContaining(["SELECT 2;\n", "SELECT 10;\n"]));

      class AppliedVersionPool extends FakePool {
        override readonly connection = new class extends FakeConnection {
          override async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
            this.queries.push({ text, values });
            if (text.includes("SELECT version, name, checksum")) return { rows: [{ version: "99", name: "099_missing.sql", checksum: "x" }] as unknown as Row[] };
            return { rows: [] as Row[] };
          }
        }();
        override async connect(): Promise<PostgresConnection> { return this.connection; }
      }
      await expect(runPostgresMigrations(new AppliedVersionPool(), directory)).rejects.toThrow(/missing locally/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed principals before querying PostgreSQL", async () => {
    const pool = new FakePool();
    const coordinator = new PostgresVnuRefreshControlCoordinator(pool);
    await expect(coordinator.activatePair("not-a-principal", PAIR)).rejects.toMatchObject({ code: "VNU_REFRESH_UNAVAILABLE" });
    expect(pool.connection.queries).toHaveLength(0);
  });
});
