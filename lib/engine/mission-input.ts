import { readPackFile } from "./packs/registry";
import type { PackManifest } from "./packs/types";

/** Entrée de mission : valeurs saisies, ou fixtures du pack (source publique datée ou seed « exemple »). */
export async function missionInput(manifest: PackManifest, b: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = (typeof b.input === "object" && b.input !== null ? b.input : {}) as Record<string, unknown>;
  const input: Record<string, unknown> = {};
  for (const i of manifest.procedures.flatMap((p) => p.inputs)) if (raw[i.id] !== undefined && raw[i.id] !== "") input[i.id] = raw[i.id];
  const fx = (id: unknown) => manifest.fixtures?.find((f) => f.id === id);
  const dao = fx(b.fixture);
  if (dao) {
    input.texte = await readPackFile(manifest.id, dao.file);
    input.titre = dao.title;
    input.daoId = dao.id;
  }
  const bpu = fx(b.bpuFixture);
  if (bpu) input.bpu = JSON.parse(await readPackFile(manifest.id, bpu.file));
  return input;
}
