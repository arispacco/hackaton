import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSeed } from "./seed";
import { resetModuleStates } from "@/lib/modules/state";
import type { WorkspaceData } from "./types";
import type { StorageAdapter } from "@/lib/engine/storage/types";

/** Postgres actif ? (DATABASE_URL ou POSTGRES_URL posée par l'intégration Neon de Vercel.) */
const pgEnabled = () => Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL) && !process.env.WORKSPACE_DB_PATH;
const PG_SCOPE = "_workspace";
let pgOverride: StorageAdapter | null = null;
async function pgStore(): Promise<StorageAdapter> {
  if (pgOverride) return pgOverride;
  const { getStorage } = await import("@/lib/engine/storage");
  return getStorage();
}
/** Réservé aux tests : force un adaptateur (ex. PGlite) pour le document workspace. */
export function __setWorkspaceAdapter(adapter: StorageAdapter | null) {
  pgOverride = adapter;
}
const usePg = () => Boolean(pgOverride) || pgEnabled();

/**
 * Persistance fichier JSON (zéro dépendance) derrière une API transactionnelle.
 * Remplaçable par Postgres/SQLite : seules `readData`/`withData` sont utilisées par les services.
 */
export const DATA_VERSION = 2;

function dbPath(): string {
  if (process.env.WORKSPACE_DB_PATH) return process.env.WORKSPACE_DB_PATH;
  // Vercel / serverless : système de fichiers en lecture seule sauf /tmp. Le fichier est
  // (re)créé depuis le seed de démo au premier accès de chaque instance (données éphémères).
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return path.join("/tmp", "workspace.db.json");
  return path.join(process.cwd(), "data", "workspace.db.json");
}

let cache: { path: string; data: WorkspaceData } | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** Chargement en cours, partagé : deux lectures simultanées sur une base vierge ne créent qu'un seul seed. */
let loading: { path: string; promise: Promise<WorkspaceData> } | null = null;

function load(): Promise<WorkspaceData> {
  const file = dbPath();
  if (cache && cache.path === file) return Promise.resolve(cache.data);
  if (loading && loading.path === file) return loading.promise;
  const promise = (async () => {
    let data: WorkspaceData;
    let raw: string | null = null;
    try {
      raw = await readFile(file, "utf8");
      data = migrate(JSON.parse(raw) as WorkspaceData);
    } catch {
      // Fichier illisible : on le met de côté au lieu de l'écraser silencieusement.
      if (raw !== null) await rename(file, `${file}.corrompu-${Date.now()}`).catch(() => undefined);
      data = buildSeed();
      await persist(file, data);
    }
    cache = { path: file, data };
    return data;
  })();
  loading = { path: file, promise };
  return promise.finally(() => {
    if (loading?.promise === promise) loading = null;
  });
}

/** Migrations non destructives : on conserve les données existantes. */
function migrate(data: WorkspaceData): WorkspaceData {
  if (!data || typeof data !== "object" || !Array.isArray(data.companies)) throw new Error("format");
  if (data.version < 2) {
    const seed = buildSeed();
    data.users = seed.users;
    data.loginCodes = [];
    data.systemEmails = [];
    data.subscriptions = seed.subscriptions;
    data.version = 2;
  }
  if (data.version !== DATA_VERSION) throw new Error("version");
  return data;
}

let writeSeq = 0;
async function persist(file: string, data: WorkspaceData) {
  await mkdir(path.dirname(file), { recursive: true });
  // Nom temporaire unique par écriture (pid + compteur + aléa) puis rename atomique :
  // aucune collision entre écritures concurrentes, même entre instances serverless partageant /tmp.
  const tmp = `${file}.${process.pid}.${++writeSeq}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/** Lecture seule (copie profonde pour éviter les mutations accidentelles). */
export async function readData(): Promise<WorkspaceData> {
  if (usePg()) {
    // Postgres : lecture fraîche à chaque appel (plusieurs instances serverless partagent la même base).
    const store = await pgStore();
    const doc = await store.read(PG_SCOPE, (tx) => tx.get<WorkspaceData>("doc", "main"));
    if (doc) return migrate(doc);
    return withData((d) => structuredClone(d));
  }
  await queue;
  return structuredClone(await load());
}

/** Exécute une mutation sérialisée puis persiste le résultat. */
export function withData<T>(mutator: (data: WorkspaceData) => T | Promise<T>): Promise<T> {
  if (usePg()) {
    // Postgres : transaction + verrou consultatif ⇒ mutations sérialisées entre instances.
    return pgStore().then((store) =>
      store.transaction(PG_SCOPE, async (tx) => {
        const existing = await tx.get<WorkspaceData>("doc", "main");
        const data = existing ? migrate(existing) : buildSeed();
        const result = await mutator(data);
        await tx.put("doc", "main", data);
        return result;
      }),
    );
  }
  const run = queue.then(async () => {
    const data = await load();
    const result = await mutator(data);
    await persist(dbPath(), data);
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Réinitialise le workspace avec le seed de démonstration. */
export function resetData(): Promise<void> {
  return withData((data) => {
    const fresh = buildSeed();
    Object.assign(data, fresh);
  });
}

const COMPANY_SCOPED = ["members", "documents", "tasks", "quotes", "emails", "approvals", "activity", "checklist", "obligations", "messages"] as const;

/**
 * Réinitialise uniquement les données de DÉMONSTRATION : les entreprises réelles des utilisateurs,
 * leurs comptes, abonnements et historiques sont conservés.
 */
export function resetDemoData(): Promise<void> {
  return withData((data) => {
    const fresh = buildSeed();
    const realIds = new Set(data.companies.filter((c) => !c.isExample).map((c) => c.id));
    const keep = <T extends { companyId: string }>(list: T[]) => list.filter((x) => realIds.has(x.companyId));
    data.companies = [...fresh.companies, ...data.companies.filter((c) => realIds.has(c.id))];
    for (const key of COMPANY_SCOPED) {
      (data as Record<string, unknown>)[key] = [...(fresh[key] as { companyId: string }[]), ...keep(data[key] as { companyId: string }[])];
    }
    data.suppliers = fresh.suppliers;
    const seedUserIds = new Set(fresh.users.map((u) => u.id));
    data.users = [...fresh.users, ...data.users.filter((u) => !seedUserIds.has(u.id))];
    const seedSubIds = new Set(fresh.subscriptions.map((x) => x.id));
    data.subscriptions = [...fresh.subscriptions, ...data.subscriptions.filter((x) => !seedSubIds.has(x.id) && !seedUserIds.has(x.userId))];
    resetModuleStates(data, realIds);
  });
}

/** Réservé aux tests. */
export function __clearCache() {
  cache = null;
  loading = null;
  queue = Promise.resolve();
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
