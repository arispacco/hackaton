import { readFile } from "node:fs/promises";
import path from "node:path";
import { aoRuntime } from "@/lib/packs/appels-offres-cm/runtime";
import { TOOL_MAP } from "@/lib/agent/registry";
import { appendAuditTx } from "../audit";
import { getStorage } from "../storage";
import { CORE_VERIFIERS } from "../verifiers";
import { GENERIC_ACTIONS } from "./generic";
import type { PackManifest, PackRuntime } from "./types";

/**
 * REGISTRE DES PACKS : packs intégrés (dossier versionné packs/<id>/ + code lib/packs/<id>/) et brouillons générés
 * (stockés par entreprise, statut « brouillon_a_valider » tant qu'un humain ne les a pas validés).
 * Ajouter un pack intégré : une ligne dans BUILTIN.
 */
const BUILTIN: PackRuntime[] = [aoRuntime];
const DRAFTS = "pack_drafts";

export function builtinPacks(): PackRuntime[] {
  return BUILTIN;
}

/** Runtime d'un brouillon : actions génériques du moteur + vérificateurs génériques. */
function draftRuntime(manifest: PackManifest): PackRuntime {
  return { manifest, actions: GENERIC_ACTIONS, verifiers: {} };
}

export async function listDrafts(companyId: string): Promise<PackManifest[]> {
  const store = await getStorage();
  return store.read(companyId, (tx) => tx.list<PackManifest>(DRAFTS));
}

export async function listPacks(companyId: string): Promise<{ manifest: PackManifest; builtin: boolean }[]> {
  return [...BUILTIN.map((r) => ({ manifest: r.manifest, builtin: true })), ...(await listDrafts(companyId)).map((m) => ({ manifest: m, builtin: false }))];
}

export async function getPackRuntime(companyId: string, id: string): Promise<PackRuntime | null> {
  const b = BUILTIN.find((r) => r.manifest.id === id);
  if (b) return b;
  const store = await getStorage();
  const m = await store.read(companyId, (tx) => tx.get<PackManifest>(DRAFTS, id));
  return m ? draftRuntime(m) : null;
}

export async function saveDraft(companyId: string, manifest: PackManifest, actor: string): Promise<PackManifest> {
  if (BUILTIN.some((r) => r.manifest.id === manifest.id)) throw new Error("Identifiant réservé par un pack intégré.");
  const store = await getStorage();
  await store.transaction(companyId, async (tx) => {
    await tx.put(DRAFTS, manifest.id, manifest);
    await appendAuditTx(tx, { actor, action: manifest.status === "valide" ? "pack.valide" : "pack.brouillon", summary: `Pack « ${manifest.name} » v${manifest.version} (${manifest.status === "valide" ? "validé par un humain" : "brouillon à valider"})`, data: { packId: manifest.id } });
  });
  return manifest;
}

/** Validation structurelle d'un manifest : actions, vérificateurs et outils doivent exister. */
export function validateManifest(m: PackManifest, runtime?: PackRuntime): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(m.id)) errors.push("identifiant invalide (minuscules, chiffres, tirets)");
  if (!/^\d+\.\d+\.\d+$/.test(m.version)) errors.push("version invalide (format x.y.z)");
  if (!m.procedures?.length) errors.push("aucune procédure");
  const actions = { ...GENERIC_ACTIONS, ...(runtime?.actions ?? {}) };
  const verifiers = { ...CORE_VERIFIERS, ...(runtime?.verifiers ?? {}) };
  for (const p of m.procedures ?? []) {
    for (const s of p.steps) {
      if (!actions[s.action]) errors.push(`procédure ${p.id}, étape ${s.id} : action « ${s.action} » inconnue`);
      for (const c of s.criteria) if (!verifiers[c.verifier]) errors.push(`étape ${s.id} : vérificateur « ${c.verifier} » inconnu`);
      if ((s.risk === "envoyer" || s.risk === "payer_deposer") && s.criteria.length) errors.push(`étape ${s.id} : une action à risque passe par l'approbation, pas par des critères`);
    }
    if (!(p.tokenBudget > 0)) errors.push(`procédure ${p.id} : plafond de jetons manquant`);
  }
  for (const t of m.tools ?? []) if (!actions[t] && !TOOL_MAP.has(t)) errors.push(`outil « ${t} » inconnu`);
  for (const v of m.verifiers ?? []) if (!verifiers[v]) errors.push(`vérificateur « ${v} » inconnu`);
  return errors;
}

/** Lecture d'un fichier d'un pack intégré (modèle, fixture) — chemin confiné au dossier du pack. */
export async function readPackFile(id: string, rel: string): Promise<string> {
  if (!BUILTIN.some((r) => r.manifest.id === id)) throw new Error("Pack inconnu.");
  const root = path.join(process.cwd(), "packs", id);
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) throw new Error("Chemin refusé.");
  return readFile(file, "utf8");
}
