import { handlePaid, readJson, s } from "@/lib/workspace/http";
import { asUserError, engineCtx, qp } from "@/lib/engine/http";
import { decideApproval, listApprovals } from "@/lib/engine/approvals";
import { getMission, runMission } from "@/lib/engine/missions";
import { getPackRuntime } from "@/lib/engine/packs/registry";
import { WorkspaceError } from "@/lib/workspace/service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  return handlePaid(async (viewer) => {
    const companyId = qp(request, "companyId");
    await engineCtx(companyId, viewer);
    return { approvals: await listApprovals(companyId) };
  });
}

/**
 * POST { id, decision: approuver|refuser, contentHash } — l'empreinte doit être celle de l'aperçu affiché :
 * si le contenu a changé depuis, la décision est refusée. Aucun envoi réel : « envoyer » est simulé,
 * « payer/déposer » reste une action humaine. Si l'approbation appartient à une mission, celle-ci reprend.
 */
export async function POST(request: Request) {
  return handlePaid(async (viewer) => {
    const b = await readJson(request);
    const companyId = s(b.companyId);
    const { actor } = await engineCtx(companyId, viewer);
    const decision = s(b.decision);
    if (decision !== "approuver" && decision !== "refuser") throw new WorkspaceError("Décision inconnue.");
    const approval = await asUserError(() => decideApproval(companyId, s(b.id), { decision, by: actor, contentHash: s(b.contentHash), note: s(b.note).slice(0, 500) || undefined }));
    let mission = null;
    if (approval.missionId) {
      const m = await getMission(companyId, approval.missionId);
      const rt = m ? await getPackRuntime(companyId, m.packId) : null;
      if (m && rt && m.status === "attente_approbation") mission = await asUserError(() => runMission(companyId, rt, m.id, { actor }));
    }
    return { approval, mission };
  });
}
