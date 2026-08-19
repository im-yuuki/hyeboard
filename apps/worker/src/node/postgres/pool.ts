import pg from "pg";
import type { PoolConfig, QueryResult, QueryResultRow } from "pg";

export type PostgresQueryResult<Row> = { rows: Row[] };

export interface PostgresQueryable {
  query<Row extends QueryResultRow = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresConnection extends PostgresQueryable {
  release(error?: Error): void;
}

export interface PostgresPoolLike extends PostgresQueryable {
  connect(): Promise<PostgresConnection>;
  transaction<T>(body: (connection: PostgresConnection) => Promise<T>): Promise<T>;
}

export type PostgresPoolConfig = PoolConfig | string;

export class PostgresPool implements PostgresPoolLike {
  private readonly pool: pg.Pool;

  constructor(config?: PostgresPoolConfig) {
    this.pool = typeof config === "string" ? new pg.Pool({ connectionString: config }) : new pg.Pool(config);
  }

  async query<Row extends QueryResultRow = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, values as unknown[] | undefined);
  }

  async connect(): Promise<PostgresConnection> {
    return await this.pool.connect();
  }

  async transaction<T>(body: (connection: PostgresConnection) => Promise<T>): Promise<T> {
    const connection = await this.connect();
    let discardConnection = false;
    let failure: unknown;
    let transactionStarted = false;
    let commitAttempted = false;
    try {
      await connection.query("BEGIN");
      transactionStarted = true;
      try {
        const result = await body(connection);
        commitAttempted = true;
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        failure = error;
        try {
          await connection.query("ROLLBACK");
        } catch {
          discardConnection = true;
        }
        if (commitAttempted) discardConnection = true;
        throw error;
      }
    } catch (error) {
      failure = error;
      if (!transactionStarted) discardConnection = true;
      throw error;
    } finally {
      // A failed BEGIN/COMMIT or rollback failure can leave the session unusable.
      // Passing an error to pg releases and destroys that pooled connection.
      connection.release(discardConnection
        ? (failure instanceof Error ? failure : new Error("PostgreSQL transaction connection is not reusable"))
        : undefined);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
