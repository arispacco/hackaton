import { canonicalJson, sha256 } from "./hash";
import { getStorage, type Tx } from "./storage";

/**
 * JOURNAL D'AUDIT CHAÎNÉ (SHA-256). Chaque entrée porte `prevHash` (hash de l'entrée précédente) et
 * `hash = SHA-256(JSON canonique de {seq, at, actor, action, summary, data, prevHash})`.
 * Modifier, supprimer ou réordonner une entrée casse la chaîne : `verifyChain` indique la première entrée fautive.
 */
export type AuditEntry = {
  seq: number;
  at: string;
  actor: string;
  action: string;
  summary: string;
  data?: unknown;
  prevHash: string;
  hash: string;
};

export const GENESIS = "0".repeat(64);
const COL = "audit";
const HEAD = "audit_head";
const id = (seq: number) => String(seq).padStart(9, "0");

export function entryHash(e: Omit<AuditEntry, "hash">): string {
  return sha256(canonicalJson({ seq: e.seq, at: e.at, actor: e.actor, action: e.action, summary: e.summary, data: e.data ?? null, prevHash: e.prevHash }));
}

/** Ajoute une entrée DANS une transaction existante (pour lier atomiquement l'action et sa trace). */
export async function appendAuditTx(tx: Tx, input: { actor: string; action: string; summary: string; data?: unknown; at?: string }): Promise<AuditEntry> {
  const head = (await tx.get<{ seq: number; hash: string }>(HEAD, "head")) ?? { seq: 0, hash: GENESIS };
  const base = { seq: head.seq + 1, at: input.at ?? new Date().toISOString(), actor: input.actor, action: input.action, summary: input.summary, data: input.data ?? null, prevHash: head.hash };
  const entry: AuditEntry = { ...base, hash: entryHash(base) };
  await tx.put(COL, id(entry.seq), entry);
  await tx.put(HEAD, "head", { seq: entry.seq, hash: entry.hash });
  return entry;
}

export async function appendAudit(companyId: string, input: Parameters<typeof appendAuditTx>[1]): Promise<AuditEntry> {
  const store = await getStorage();
  return store.transaction(companyId, (tx) => appendAuditTx(tx, input));
}

export async function listAudit(companyId: string): Promise<AuditEntry[]> {
  const store = await getStorage();
  const list = await store.read(companyId, (tx) => tx.list<AuditEntry>(COL));
  return list.sort((a, b) => a.seq - b.seq);
}

export type ChainCheck = { ok: boolean; count: number; headHash: string; brokenAt?: number; reason?: string };

/** Vérification déterministe de toute la chaîne. */
export function verifyChain(entries: AuditEntry[]): ChainCheck {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i + 1) return { ok: false, count: entries.length, headHash: prev, brokenAt: e.seq, reason: `séquence attendue ${i + 1}, trouvée ${e.seq} (entrée supprimée ou réordonnée)` };
    if (e.prevHash !== prev) return { ok: false, count: entries.length, headHash: prev, brokenAt: e.seq, reason: "prevHash ne correspond pas au hash de l'entrée précédente" };
    const { hash, ...rest } = e;
    if (entryHash(rest) !== hash) return { ok: false, count: entries.length, headHash: prev, brokenAt: e.seq, reason: "contenu modifié après coup (hash recalculé différent)" };
    prev = hash;
  }
  return { ok: true, count: entries.length, headHash: prev };
}

export async function verifyCompanyChain(companyId: string): Promise<ChainCheck> {
  return verifyChain(await listAudit(companyId));
}
