import type { Executor } from "@/lib/engine/sandbox";
import { fmtXaf } from "./numbers";

/**
 * RECALCUL DU BORDEREAU (BPU / DQE) par l'exécuteur limité : montant = quantité × prix unitaire, totaux HT,
 * TVA et TTC (si un taux est FOURNI — le pack n'invente aucun taux), et comparaison avec les montants saisis.
 */
export type BpuRow = { code: string; designation: string; unite?: string; quantite: number; prixUnitaire: number; montant?: number | null };
export type BpuInput = { rows: BpuRow[]; tvaRate?: number | null; totalHtDeclare?: number | null; totalTtcDeclare?: number | null; isExample?: boolean };
export type BpuIssue = { code: string; kind: "ligne" | "total_ht" | "tva" | "total_ttc" | "donnee"; declared: number | null; computed: number | null; ecart: number | null; message: string };
export type BpuResult = {
  rows: (BpuRow & { montantCalcule: number | null; ok: boolean })[];
  totalHt: number;
  tva: number | null;
  totalTtc: number | null;
  tvaRate: number | null;
  issues: BpuIssue[];
  executor: string;
  calculs: number;
  corrected: BpuRow[];
};

const TOL = 1; // tolérance d'arrondi : 1 FCFA

export async function recalcBpu(input: BpuInput, executor: Executor): Promise<BpuResult> {
  const rows = (input.rows ?? []).slice(0, 2000);
  const issues: BpuIssue[] = [];
  const items = rows.map((r, i) => ({ id: `l${i}`, expression: "round(q * pu, 0)", vars: { q: Number(r.quantite), pu: Number(r.prixUnitaire) } }));
  const lines = await executor.calc(items);
  const outRows = rows.map((r, i) => {
    const v = lines[i]?.value ?? null;
    if (v === null) issues.push({ code: r.code, kind: "donnee", declared: r.montant ?? null, computed: null, ecart: null, message: `ligne ${r.code} : quantité ou prix illisible (${lines[i]?.error ?? "valeur manquante"})` });
    const declared = r.montant ?? null;
    const ok = v !== null && (declared === null || Math.abs(declared - v) <= TOL);
    if (v !== null && declared !== null && !ok) issues.push({ code: r.code, kind: "ligne", declared, computed: v, ecart: declared - v, message: `ligne ${r.code} (${r.designation}) : ${fmtXaf(declared)} saisi ≠ ${fmtXaf(v)} recalculé (${r.quantite} × ${fmtXaf(r.prixUnitaire)})` });
    if (!(Number(r.prixUnitaire) > 0)) issues.push({ code: r.code, kind: "donnee", declared: null, computed: null, ecart: null, message: `ligne ${r.code} : prix unitaire absent ou nul (critère éliminatoire fréquent : « absence d'un prix unitaire quantifié »)` });
    return { ...r, montantCalcule: v, ok };
  });
  const sumVars = Object.fromEntries(outRows.map((r, i) => [`m${i}`, r.montantCalcule ?? 0]));
  const [ht] = await executor.calc([{ id: "ht", expression: outRows.length ? `sum(${outRows.map((_, i) => `m${i}`).join(",")})` : "0", vars: sumVars }]);
  const totalHt = ht.value ?? 0;
  let tva: number | null = null;
  let ttc: number | null = null;
  const rate = input.tvaRate ?? null;
  if (rate !== null) {
    const [t, c] = await executor.calc([
      { id: "tva", expression: "round(ht * taux / 100, 0)", vars: { ht: totalHt, taux: rate } },
      { id: "ttc", expression: "ht + round(ht * taux / 100, 0)", vars: { ht: totalHt, taux: rate } },
    ]);
    tva = t.value;
    ttc = c.value;
  }
  if (input.totalHtDeclare != null && Math.abs(input.totalHtDeclare - totalHt) > TOL) issues.push({ code: "TOTAL", kind: "total_ht", declared: input.totalHtDeclare, computed: totalHt, ecart: input.totalHtDeclare - totalHt, message: `total HT saisi ${fmtXaf(input.totalHtDeclare)} ≠ ${fmtXaf(totalHt)} recalculé` });
  if (input.totalTtcDeclare != null) {
    if (ttc === null) issues.push({ code: "TTC", kind: "tva", declared: input.totalTtcDeclare, computed: null, ecart: null, message: "total TTC saisi mais aucun taux de TVA fourni : TTC non vérifiable (renseignez le taux indiqué dans le DAO)" });
    else if (Math.abs(input.totalTtcDeclare - ttc) > TOL) issues.push({ code: "TTC", kind: "total_ttc", declared: input.totalTtcDeclare, computed: ttc, ecart: input.totalTtcDeclare - ttc, message: `total TTC saisi ${fmtXaf(input.totalTtcDeclare)} ≠ ${fmtXaf(ttc)} recalculé` });
  }
  return {
    rows: outRows,
    totalHt,
    tva,
    totalTtc: ttc,
    tvaRate: rate,
    issues,
    executor: executor.name,
    calculs: items.length + 1 + (rate !== null ? 2 : 0),
    corrected: outRows.map(({ montantCalcule, ok: _ok, ...r }) => ({ ...r, montant: montantCalcule })),
  };
}
