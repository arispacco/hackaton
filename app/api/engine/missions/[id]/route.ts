import { handlePaid, readJson, s } from "@/lib/workspace/http";
import { asUserError, engineCtx, qp } from "@/lib/engine/http";
import { getPackRuntime } from "@/lib/engine/packs/registry";
import { getMission, resolveEscalation, runMission } from "@/lib/engine/missions";
import { listApprovals } from "@/lib/engine/approvals";
import { WorkspaceError } from "@/lib/workspace/service";

export const runtime = "nodejs";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  return handlePaid(async (viewer) => {
    const { id } = await params;
    const companyId = qp(request, "companyId");
    await engineCtx(companyId, viewer);
    const mission = await getMission(companyId, id);
    if (!mission) throw new WorkspaceError("Mission introuvable.", 404);
    const approvals = (await listApprovals(companyId)).filter((a) => a.missionId === id);
    return { mission, approvals };
  });
}

/** POST { op: "reprendre" } ou { op: "decider", stepId, decision: reessayer|valider|abandonner, note? }. */
export async function POST(request: Request, { params }: Ctx) {
  return handlePaid(async (viewer) => {
    const { id } = await params;
    const b = await readJson(request);
    const companyId = s(b.companyId);
    const { actor } = await engineCtx(companyId, viewer);
    const m = await getMission(companyId, id);
    if (!m) throw new WorkspaceError("Mission introuvable.", 404);
    const rt = await getPackRuntime(companyId, m.packId);
    if (!rt) throw new WorkspaceError("Le pack de cette mission n'est plus disponible.");
    const op = s(b.op);
    if (op === "decider") {
      const decision = s(b.decision);
      if (!["reessayer", "valider", "abandonner"].includes(decision)) throw new WorkspaceError("Décision inconnue.");
      const after = await asUserError(() => resolveEscalation(companyId, id, { stepId: s(b.stepId), decision: decision as "reessayer", by: actor, note: s(b.note).slice(0, 500) || undefined }));
      if (after.status !== "en_cours") return { mission: after };
    } else if (op !== "reprendre") throw new WorkspaceError("Opération inconnue.");
    return { mission: await asUserError(() => runMission(companyId, rt, id, { actor })) };
  });
}
