import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertName, assertScope, type StorageAdapter, type Tx } from "./types";

type FileData = Record<string, Record<string, unknown>>;

export function defaultJsonDir(): string {
  if (process.env.ENGINE_DATA_DIR) return process.env.ENGINE_DATA_DIR;
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return path.join("/tmp", "cofounder-engine");
  return path.join(process.cwd(), "data", "engine");
}

/** Adaptateur JSON : un fichier par entreprise (isolation physique), écriture atomique (tmp unique + rename). */
export class JsonAdapter implements StorageAdapter {
  readonly kind = "json" as const;
  private queues = new Map<string, Promise<unknown>>();
  private seq = 0;
  constructor(private readonly dir = defaultJsonDir()) {}

  private file(scope: string) {
    return path.join(this.dir, `${assertScope(scope).replace(/[:.]/g, "_")}.json`);
  }

  private async load(scope: string): Promise<FileData> {
    try {
      const parsed = JSON.parse(await readFile(this.file(scope), "utf8")) as FileData;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async persist(scope: string, data: FileData) {
    const file = this.file(scope);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${++this.seq}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(data), "utf8");
      await rename(tmp, file);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  private tx(data: FileData, dirty: { v: boolean }): Tx {
    return {
      async get<T>(c: string, id: string) {
        const v = data[assertName(c, "collection")]?.[assertName(id)];
        return v === undefined ? null : (structuredClone(v) as T);
      },
      async put<T>(c: string, id: string, value: T) {
        (data[assertName(c, "collection")] ??= {})[assertName(id)] = structuredClone(value) as unknown;
        dirty.v = true;
      },
      async list<T>(c: string) {
        return Object.values(data[assertName(c, "collection")] ?? {}).map((v) => structuredClone(v) as T);
      },
      async remove(c: string, id: string) {
        if (data[c]?.[id] !== undefined) {
          delete data[c][id];
          dirty.v = true;
        }
      },
    };
  }

  transaction<T>(scope: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    assertScope(scope);
    const prev = this.queues.get(scope) ?? Promise.resolve();
    const run = prev.then(async () => {
      const data = await this.load(scope);
      const dirty = { v: false };
      const result = await fn(this.tx(data, dirty)); // une exception ⇒ rien n'est écrit (atomicité)
      if (dirty.v) await this.persist(scope, data);
      return result;
    });
    this.queues.set(scope, run.catch(() => undefined));
    return run;
  }

  async read<T>(scope: string, fn: (tx: Pick<Tx, "get" | "list">) => Promise<T>): Promise<T> {
    assertScope(scope);
    await (this.queues.get(scope) ?? Promise.resolve());
    return fn(this.tx(await this.load(scope), { v: false }));
  }
}
