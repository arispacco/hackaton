import { handlePaid, readJson, s } from "@/lib/workspace/http";
import { asUserError, engineCtx, qp } from "@/lib/engine/http";
import { getPackRuntime } from "@/lib/engine/packs/registry";
import { createMission, listMissions, runMission } from "@/lib/engine/missions";
import { missionInput } from "@/lib/engine/mission-input";
import { WorkspaceError } from "@/lib/workspace/service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  return handlePaid(async (viewer) => {
    const companyId = qp(request, "companyId");
    await engineCtx(companyId, viewer);
    return { missions: await listMissions(companyId) };
  });
}

/** POST { packId, procedureId, input?, fixture?, bpuFixture?, run? } : crée la mission (plan + contrat), puis la lance. */
export async function POST(request: Request) {
  return handlePaid(async (viewer) => {
    const b = await readJson(request);
    const companyId = s(b.companyId);
    const { actor } = await engineCtx(companyId, viewer);
    const rt = await getPackRuntime(companyId, s(b.packId));
    if (!rt) throw new WorkspaceError("Pack introuvable.", 404);
    if (rt.manifest.status !== "valide") throw new WorkspaceError("Ce pack est un brouillon « à valider » : faites-le valider avant de lancer une mission.");
    const input = await missionInput(rt.manifest, b);
    let mission = await asUserError(() => createMission(companyId, rt, s(b.procedureId) || rt.manifest.procedures[0].id, input, actor));
    if (b.run !== false) mission = await asUserError(() => runMission(companyId, rt, mission.id, { actor }));
    return { mission };
  });
}
