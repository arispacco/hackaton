import { handlePaid, readJson, s } from "@/lib/workspace/http";
import { asUserError, engineCtx, qp } from "@/lib/engine/http";
import { getPackRuntime, listPacks, readPackFile, validateManifest } from "@/lib/engine/packs/registry";
import { corpusCoverage } from "@/lib/engine/coverage";
import { appendAudit } from "@/lib/engine/audit";
import { WorkspaceError } from "@/lib/workspace/service";

export const runtime = "nodejs";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/** Détail d'un pack : manifeste, validation, carte de couverture du corpus, modèles de documents. */
export async function GET(request: Request, { params }: Ctx) {
  return handlePaid(async (viewer) => {
    const { id } = await params;
    const companyId = qp(request, "companyId");
    await engineCtx(companyId, viewer);
    const p = (await listPacks(companyId)).find((x) => x.manifest.id === id);
    if (!p) throw new WorkspaceError("Pack introuvable.", 404);
    const rt = await getPackRuntime(companyId, id);
    const coverage = await corpusCoverage(p.manifest.corpus?.needs ?? []);
    const templates = p.builtin
      ? await Promise.all(p.manifest.templates.map(async (t) => ({ ...t, content: await readPackFile(id, t.file).catch(() => "") })))
      : p.manifest.templates.map((t) => ({ ...t, content: "" }));
    return { manifest: p.manifest, builtin: p.builtin, errors: validateManifest(p.manifest, rt ?? undefined), coverage, templates, hasEvaluation: Boolean(rt?.evaluate) };
  });
}

/** POST { op: "evaluer" } : exécute le jeu d'évaluation du pack (déterministe, aucun appel externe). */
export async function POST(request: Request, { params }: Ctx) {
  return handlePaid(async (viewer) => {
    const { id } = await params;
    const b = await readJson(request);
    const companyId = s(b.companyId);
    const { actor } = await engineCtx(companyId, viewer);
    if (s(b.op) !== "evaluer") throw new WorkspaceError("Opération inconnue.");
    const rt = await getPackRuntime(companyId, id);
    if (!rt) throw new WorkspaceError("Pack introuvable.", 404);
    if (!rt.evaluate) return { outcomes: [], note: "Ce pack n'a pas encore de jeu d'évaluation exécutable (brouillon)." };
    const outcomes = await asUserError(() => rt.evaluate!());
    await appendAudit(companyId, { actor, action: "pack.evaluation", summary: `Évaluation du pack ${id} : ${outcomes.filter((o) => o.ok).length}/${outcomes.length} cas réussis` });
    return { outcomes };
  });
}
