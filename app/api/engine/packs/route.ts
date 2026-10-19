import { handlePaid, readJson, s } from "@/lib/workspace/http";
import { asUserError, engineCtx, qp } from "@/lib/engine/http";
import { getPackRuntime, listPacks, saveDraft, validateManifest } from "@/lib/engine/packs/registry";
import { generatePackDraft } from "@/lib/engine/packs/generator";
import { storageInfo } from "@/lib/engine/storage";
import { executorInfo } from "@/lib/engine/sandbox";
import { RISK_LEVELS } from "@/lib/engine/approvals";
import { appendAudit } from "@/lib/engine/audit";
import { WorkspaceError } from "@/lib/workspace/service";

export const runtime = "nodejs";

/** Registre des packs (intégrés + brouillons de l'entreprise) et état du moteur. */
export async function GET(request: Request) {
  return handlePaid(async (viewer) => {
    const companyId = qp(request, "companyId");
    await engineCtx(companyId, viewer);
    const packs = await listPacks(companyId);
    const rows = await Promise.all(
      packs.map(async ({ manifest, builtin }) => {
        const rt = await getPackRuntime(companyId, manifest.id);
        return { id: manifest.id, name: manifest.name, version: manifest.version, status: manifest.status, description: manifest.description, audience: manifest.audience, builtin, procedures: manifest.procedures.map((p) => ({ id: p.id, title: p.title })), errors: validateManifest(manifest, rt ?? undefined) };
      }),
    );
    return { packs: rows, storage: storageInfo(), executor: executorInfo(), riskLevels: RISK_LEVELS };
  });
}

/** POST { description } : génère un brouillon de pack « à valider ». PATCH { id } : validation humaine d'un brouillon. */
export async function POST(request: Request) {
  return handlePaid(async (viewer) => {
    const b = await readJson(request);
    const companyId = s(b.companyId);
    const { actor } = await engineCtx(companyId, viewer);
    const description = s(b.description).trim();
    if (description.length > 2000) throw new WorkspaceError("Description trop longue (2 000 caractères maximum).");
    const draft = await asUserError(() => generatePackDraft(description, { author: actor }));
    const saved = await saveDraft(companyId, draft.manifest, actor);
    return { manifest: saved, coverage: draft.coverage, detected: draft.detected, errors: validateManifest(saved) };
  });
}

export async function PATCH(request: Request) {
  return handlePaid(async (viewer) => {
    const b = await readJson(request);
    const companyId = s(b.companyId);
    const { actor } = await engineCtx(companyId, viewer);
    const packs = await listPacks(companyId);
    const p = packs.find((x) => x.manifest.id === s(b.id));
    if (!p) throw new WorkspaceError("Pack introuvable.", 404);
    if (p.builtin) throw new WorkspaceError("Un pack intégré n'a pas à être revalidé.");
    const errors = validateManifest(p.manifest);
    if (errors.length) throw new WorkspaceError(`Validation impossible : ${errors.join(" ; ")}`);
    const saved = await saveDraft(companyId, { ...p.manifest, status: "valide" }, actor);
    await appendAudit(companyId, { actor, action: "pack.valide", summary: `Pack « ${saved.name} » validé par un humain`, data: { id: saved.id, version: saved.version } });
    return { manifest: saved };
  });
}
