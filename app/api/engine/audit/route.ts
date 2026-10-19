import { handlePaid } from "@/lib/workspace/http";
import { engineCtx, qp } from "@/lib/engine/http";
import { listAudit, verifyChain } from "@/lib/engine/audit";

export const runtime = "nodejs";

/** Journal d'audit chaîné (SHA-256) + vérification de la chaîne complète. */
export async function GET(request: Request) {
  return handlePaid(async (viewer) => {
    const companyId = qp(request, "companyId");
    await engineCtx(companyId, viewer);
    const entries = await listAudit(companyId);
    return { check: verifyChain(entries), total: entries.length, entries: entries.slice(-100).reverse() };
  });
}
