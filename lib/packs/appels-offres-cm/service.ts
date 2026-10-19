import { verifyCitations } from "@/lib/engine/citations";
import { getExecutor } from "@/lib/engine/sandbox";
import { readPackFile } from "@/lib/engine/packs/registry";
import { recalcBpu, type BpuInput } from "./bpu";
import { parseDao, sheetMarkdown } from "./dao";
import { assembleDossier, buildMatrix } from "./matrix";
import { manifest } from "./runtime";
import { ensureExampleVault, listVault, vaultAlerts } from "./vault";

/** Services de l'écran « Appels d'offres » (hors mission) — mêmes briques que la mission, appel direct. */
export function fixtures() {
  return (manifest.fixtures ?? []).map(({ id, title, origin, source, verifiedAt, file }) => ({ id, title, origin, source: source ?? null, verifiedAt: verifiedAt ?? null, kind: file.endsWith(".json") ? "bpu" : "dao" }));
}

export async function daoFromInput(b: Record<string, unknown>): Promise<{ text: string; id: string; title: string; pages?: string[] }> {
  const fx = manifest.fixtures?.find((f) => f.id === b.fixture && f.file.endsWith(".txt"));
  if (fx) return { text: await readPackFile(manifest.id, fx.file), id: fx.id, title: fx.title };
  const text = typeof b.texte === "string" ? b.texte : "";
  return { text, id: "dao_saisi", title: typeof b.titre === "string" && b.titre.trim() ? b.titre.trim().slice(0, 200) : "DAO fourni" };
}

/** Fiche d'une page + vérification de chaque citation contre le texte même du DAO. */
export async function readDao(input: { text: string; id: string; title: string; pages?: string[] }) {
  if (input.text.trim().length < 200) throw new Error("Texte du DAO trop court (200 caractères minimum). Collez le texte intégral ou importez le PDF.");
  if (input.text.length > 400_000) throw new Error("Texte trop long (400 000 caractères maximum).");
  const { sheet, doc } = parseDao(input.text, input);
  const citations = await verifyCitations(sheet.citations, [doc]);
  return { sheet, markdown: sheetMarkdown(sheet), citations };
}

export async function matrixFor(companyId: string, isExample: boolean, input: { text: string; id: string; title: string }) {
  const { sheet } = await readDao(input);
  await ensureExampleVault(companyId, isExample);
  const vault = await listVault(companyId);
  const matrix = buildMatrix(sheet, vault);
  return { sheet: { title: sheet.title, reference: sheet.reference, dateLimite: sheet.dateLimite, limitesFichiers: sheet.limitesFichiers }, matrix, dossier: assembleDossier(matrix, sheet) };
}

export async function bpuFrom(b: Record<string, unknown>) {
  const fx = manifest.fixtures?.find((f) => f.id === b.bpuFixture && f.file.endsWith(".json"));
  const input = (fx ? JSON.parse(await readPackFile(manifest.id, fx.file)) : b.bpu) as BpuInput;
  if (!input?.rows?.length) throw new Error("Bordereau vide : ajoutez au moins une ligne (quantité × prix unitaire).");
  if (input.rows.length > 500) throw new Error("Bordereau trop long (500 lignes maximum).");
  return { input, result: await recalcBpu(input, await getExecutor()) };
}

export async function vaultState(companyId: string, isExample: boolean) {
  await ensureExampleVault(companyId, isExample);
  const pieces = await listVault(companyId);
  return { pieces, alerts: vaultAlerts(pieces) };
}
