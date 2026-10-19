import { handlePaid, readJson, s } from "@/lib/workspace/http";
import { asUserError, engineCtx, qp } from "@/lib/engine/http";
import { bpuFrom, daoFromInput, fixtures, matrixFor, readDao, vaultState } from "@/lib/packs/appels-offres-cm/service";
import { PIECE_TYPES } from "@/lib/packs/appels-offres-cm/dao";
import { WorkspaceError } from "@/lib/workspace/service";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Fixtures (sources publiques datées / exemples), coffre-fort et alertes. */
export async function GET(request: Request) {
  return handlePaid(async (viewer) => {
    const companyId = qp(request, "companyId");
    const { company } = await engineCtx(companyId, viewer);
    return { fixtures: fixtures(), pieceTypes: PIECE_TYPES, vault: await vaultState(companyId, Boolean(company.isExample)) };
  });
}

/** POST { op: "lire_dao" | "matrice", texte? | fixture? } ou { op: "bpu", bpu? | bpuFixture? }. */
export async function POST(request: Request) {
  return handlePaid(async (viewer) => {
    const b = await readJson(request);
    const companyId = s(b.companyId);
    const { company } = await engineCtx(companyId, viewer);
    const op = s(b.op);
    if (op === "lire_dao") return asUserError(async () => readDao(await daoFromInput(b)));
    if (op === "matrice") return asUserError(async () => matrixFor(companyId, Boolean(company.isExample), await daoFromInput(b)));
    if (op === "bpu") return asUserError(() => bpuFrom(b));
    throw new WorkspaceError("Opération inconnue.");
  });
}
