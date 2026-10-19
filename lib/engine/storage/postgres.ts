import { assertName, assertScope, type StorageAdapter, type Tx } from "./types";

/** Client minimal : compatible `pg` (Pool/PoolClient) et PGlite (tests). */
export type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };
export type PgDriver = {
  /** Exécute `fn` dans une transaction sur une connexion dédiée. */
  withClient<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
  end?(): Promise<void>;
};

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS engine_records (
  company_id text NOT NULL,
  collection text NOT NULL,
  id text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, collection, id)
);
CREATE INDEX IF NOT EXISTS engine_records_scope ON engine_records (company_id, collection);`;

/**
 * Adaptateur Postgres. Isolation : chaque requête porte `company_id = $1` (jamais de requête sans portée),
 * et chaque transaction prend un verrou consultatif sur l'entreprise (sérialisation inter-instances serverless).
 */
export class PostgresAdapter implements StorageAdapter {
  readonly kind = "postgres" as const;
  private ready: Promise<void> | null = null;
  constructor(private readonly driver: PgDriver) {}

  private ensureSchema() {
    this.ready ??= this.driver.withClient(async (c) => {
      for (const stmt of SCHEMA_SQL.split(";").map((x) => x.trim()).filter(Boolean)) await c.query(stmt);
    }).catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  private tx(c: Queryable, scope: string): Tx {
    return {
      async get<T>(col: string, id: string) {
        const r = await c.query("SELECT value FROM engine_records WHERE company_id = $1 AND collection = $2 AND id = $3", [scope, assertName(col, "collection"), assertName(id)]);
        return r.rows.length ? (r.rows[0].value as T) : null;
      },
      async put<T>(col: string, id: string, value: T) {
        await c.query(
          `INSERT INTO engine_records (company_id, collection, id, value, updated_at) VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (company_id, collection, id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [scope, assertName(col, "collection"), assertName(id), JSON.stringify(value)],
        );
      },
      async list<T>(col: string) {
        const r = await c.query("SELECT value FROM engine_records WHERE company_id = $1 AND collection = $2 ORDER BY id", [scope, assertName(col, "collection")]);
        return r.rows.map((row) => row.value as T);
      },
      async remove(col: string, id: string) {
        await c.query("DELETE FROM engine_records WHERE company_id = $1 AND collection = $2 AND id = $3", [scope, col, id]);
      },
    };
  }

  async transaction<T>(scope: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    assertScope(scope);
    await this.ensureSchema();
    return this.driver.withClient(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [scope]);
        const result = await fn(this.tx(c, scope));
        await c.query("COMMIT");
        return result;
      } catch (error) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  async read<T>(scope: string, fn: (tx: Pick<Tx, "get" | "list">) => Promise<T>): Promise<T> {
    assertScope(scope);
    await this.ensureSchema();
    return this.driver.withClient((c) => fn(this.tx(c, scope)));
  }

  close() {
    return this.driver.end?.() ?? Promise.resolve();
  }
}

/** Pilote `pg` (Neon, Supabase, RDS…) — chargé à la demande pour ne rien coûter en mode JSON. */
export async function pgDriver(url: string): Promise<PgDriver> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url, max: 3, ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
  return {
    async withClient(fn) {
      const client = await pool.connect();
      try {
        return await fn(client as unknown as Queryable);
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}
