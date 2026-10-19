import { JsonAdapter } from "./json";
import { PostgresAdapter, pgDriver } from "./postgres";
import type { StorageAdapter } from "./types";

export type { StorageAdapter, Tx } from "./types";
export { JsonAdapter } from "./json";
export { PostgresAdapter, SCHEMA_SQL, type PgDriver, type Queryable } from "./postgres";

let current: StorageAdapter | null = null;
let pending: Promise<StorageAdapter> | null = null;

/** Adaptateur actif : Postgres si DATABASE_URL (ou POSTGRES_URL, posé par l'intégration Neon de Vercel), sinon JSON. */
export function getStorage(): Promise<StorageAdapter> {
  if (current) return Promise.resolve(current);
  pending ??= (async () => {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    current = url ? new PostgresAdapter(await pgDriver(url)) : new JsonAdapter();
    return current;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/** Description publique (sans secret) de la persistance active. */
export function storageInfo(): { kind: "postgres" | "json"; durable: boolean; note: string } {
  const pg = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (pg) return { kind: "postgres", durable: true, note: "Postgres (DATABASE_URL) — données durables, isolées par entreprise." };
  const ephemeral = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) && !process.env.ENGINE_DATA_DIR;
  return {
    kind: "json",
    durable: !ephemeral,
    note: ephemeral
      ? "Repli JSON dans /tmp (Vercel) : données ÉPHÉMÈRES, propres à chaque instance. Définir DATABASE_URL pour les rendre durables."
      : "Repli JSON (data/engine) : un fichier par entreprise.",
  };
}

/** Réservé aux tests. */
export function __setStorage(adapter: StorageAdapter | null) {
  current = adapter;
}
