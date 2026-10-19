/**
 * COUCHE DE STOCKAGE DU MOTEUR — deux adaptateurs derrière la même interface :
 *  - Postgres (si DATABASE_URL est définie) : table `engine_records`, transactions + verrou consultatif par entreprise ;
 *  - JSON (repli) : un fichier par entreprise sous ENGINE_DATA_DIR, /tmp sur Vercel, data/engine en local.
 * ISOLATION PAR ENTREPRISE : toute opération est bornée à un `scope` (= companyId). Il n'existe aucune
 * lecture inter-entreprises dans l'API ; un scope invalide est refusé.
 */
export type Tx = {
  get<T>(collection: string, id: string): Promise<T | null>;
  put<T>(collection: string, id: string, value: T): Promise<void>;
  list<T>(collection: string): Promise<T[]>;
  remove(collection: string, id: string): Promise<void>;
};

export interface StorageAdapter {
  readonly kind: "postgres" | "json";
  /** Transaction sérialisée pour UNE entreprise (lectures cohérentes + écritures atomiques). */
  transaction<T>(scope: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Lecture simple (sans verrou). */
  read<T>(scope: string, fn: (tx: Pick<Tx, "get" | "list">) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

const SCOPE_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const NAME_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

export function assertScope(scope: string): string {
  if (!SCOPE_RE.test(scope)) throw new Error(`Portée de stockage invalide : ${JSON.stringify(scope)}`);
  return scope;
}
export function assertName(name: string, what = "identifiant"): string {
  if (!NAME_RE.test(name)) throw new Error(`${what} de stockage invalide : ${JSON.stringify(name)}`);
  return name;
}
