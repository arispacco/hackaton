import { readFile } from "node:fs/promises";
import path from "node:path";
import { corpusCoverage } from "@/lib/engine/coverage";
import { verifyCitation } from "@/lib/engine/citations";
import { LocalExecutor } from "@/lib/engine/sandbox";
import type { EvalOutcome, PackManifest } from "@/lib/engine/packs/types";
import { recalcBpu, type BpuInput } from "./bpu";
import { parseDao } from "./dao";

type Case = { id: string; fixture?: string; expect: Record<string, unknown> };
const dir = path.join(process.cwd(), "packs", "appels-offres-cm");

/** Exécute le jeu d'évaluation du pack (eval/cases.json) : attendus lus dans les textes sources réels. */
export async function evaluateAoPack(manifest: PackManifest): Promise<EvalOutcome[]> {
  const { cases } = JSON.parse(await readFile(path.join(dir, manifest.evaluation.file), "utf8")) as { cases: Case[] };
  const out: EvalOutcome[] = [];
  for (const c of cases) {
    const checks: EvalOutcome["checks"] = [];
    const chk = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail });
    const e = c.expect;
    if (c.fixture?.endsWith(".txt")) {
      const text = await readFile(path.join(dir, c.fixture), "utf8");
      const { sheet, doc } = parseDao(text, { id: c.id, title: c.id });
      if (e.reference) chk("référence", sheet.reference.value === e.reference, String(sheet.reference.value));
      if (e.dateLimiteIso) chk("date limite", sheet.dateLimite.value?.iso === e.dateLimiteIso, String(sheet.dateLimite.value?.iso));
      if (e.modeDepot) chk("mode de dépôt", sheet.dateLimite.value?.mode === e.modeDepot, String(sheet.dateLimite.value?.mode));
      if (e.cautionMontant) chk("caution", sheet.caution.value?.montant === e.cautionMontant, String(sheet.caution.value?.montant));
      if (e.coutPrevisionnel) chk("coût prévisionnel", sheet.coutPrevisionnel.value?.montant === e.coutPrevisionnel, String(sheet.coutPrevisionnel.value?.montant));
      if (e.limitesMo) chk("limites de fichiers", JSON.stringify(sheet.limitesFichiers.items.map((i) => i.tailleMo)) === JSON.stringify(e.limitesMo), sheet.limitesFichiers.items.map((i) => i.tailleMo).join(","));
      if (e.formats) chk("formats", (e.formats as string[]).every((f) => sheet.limitesFichiers.formats.includes(f)), sheet.limitesFichiers.formats.join(","));
      if (e.piecesIncluent) {
        const ids = sheet.pieces.map((p) => p.id);
        const miss = (e.piecesIncluent as string[]).filter((p) => !ids.includes(p));
        chk("pièces exigées", !miss.length, miss.length ? `manquantes : ${miss.join(", ")}` : `${ids.length} pièce(s)`);
      }
      if (e.eliminatoiresMin) chk("critères éliminatoires", sheet.grille.eliminatoires.length >= Number(e.eliminatoiresMin), String(sheet.grille.eliminatoires.length));
      if (e.montantsIncoherents !== undefined) chk("montants chiffres / lettres", sheet.montants.filter((m) => !m.consistent).length === e.montantsIncoherents, String(sheet.montants.filter((m) => !m.consistent).length));
      const bad = sheet.citations.filter((q) => verifyCitation(q, [doc]).status !== "verifiee");
      chk("citations résolues dans le DAO", bad.length === 0, `${sheet.citations.length - bad.length}/${sheet.citations.length}`);
    } else if (c.fixture?.endsWith(".json")) {
      const bpu = JSON.parse(await readFile(path.join(dir, c.fixture), "utf8")) as BpuInput;
      const r = await recalcBpu(bpu, new LocalExecutor());
      const lines = r.issues.filter((i) => i.kind === "ligne").map((i) => i.code);
      if (e.ecartsLignes) chk("écarts détectés", JSON.stringify(lines) === JSON.stringify(e.ecartsLignes), lines.join(","));
      if (e.totalHt) chk("total HT recalculé", r.totalHt === e.totalHt, String(r.totalHt));
    } else if (e.coverage) {
      const map = await corpusCoverage(manifest.corpus.needs);
      for (const [id, status] of Object.entries(e.coverage as Record<string, string>)) {
        const got = map.needs.find((n) => n.id === id)?.status;
        chk(`couverture ${id}`, got === status, String(got));
      }
    }
    out.push({ id: c.id, ok: checks.every((x) => x.ok), checks });
  }
  return out;
}
