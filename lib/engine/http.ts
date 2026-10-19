import { assertCompanyAccess, type Viewer } from "@/lib/workspace/access";
import { WorkspaceError } from "@/lib/workspace/service";

/** Contexte commun des routes du moteur : accès à l'entreprise + nom de l'acteur (pour l'audit). */
export async function engineCtx(companyId: string, viewer: Viewer) {
  if (!companyId) throw new WorkspaceError("companyId manquant.");
  const company = await assertCompanyAccess(companyId, viewer);
  const actor = viewer.user?.name || viewer.email || "utilisateur";
  return { company, actor };
}

/** Convertit les erreurs métier du moteur (Error simples) en 400 lisibles, sans fuite de pile. */
export async function asUserError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WorkspaceError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/ENOENT|ECONN|password|DATABASE_URL/i.test(msg)) throw e; // erreurs techniques : 500 générique
    throw new WorkspaceError(msg.slice(0, 300));
  }
}

export const qp = (request: Request, k: string) => new URL(request.url).searchParams.get(k) ?? "";
