import { handlePaid, readJson, s } from "@/lib/workspace/http";
import { asUserError, engineCtx } from "@/lib/engine/http";
import { addPiece, listVault, requestRenewal } from "@/lib/packs/appels-offres-cm/vault";
import { PIECE_TYPES } from "@/lib/packs/appels-offres-cm/dao";
import { vaultState } from "@/lib/packs/appels-offres-cm/service";
import { WorkspaceError } from "@/lib/workspace/service";

export const runtime = "nodejs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST { op: "ajouter", type, label?, issuer, reference?, issuedAt?, expiresAt? } — la date d'expiration est celle
 * portée par la pièce (aucune durée de validité supposée).
 * POST { op: "renouveler", pieceId } — brouillon de demande dans la file d'approbation (envoi simulé, jamais réel).
 */
export async function POST(request: Request) {
  return handlePaid(async (viewer) => {
    const b = await readJson(request);
    const companyId = s(b.companyId);
    const { company, actor } = await engineCtx(companyId, viewer);
    const op = s(b.op);
    if (op === "ajouter") {
      const type = PIECE_TYPES.find((t) => t.id === s(b.type));
      if (!type) throw new WorkspaceError("Type de pièce inconnu.");
      const issuer = s(b.issuer).trim().slice(0, 200);
      if (!issuer) throw new WorkspaceError("Indiquez l'organisme émetteur.");
      for (const k of ["issuedAt", "expiresAt"]) if (s(b[k]) && !DATE.test(s(b[k]))) throw new WorkspaceError("Dates au format AAAA-MM-JJ.");
      const piece = await addPiece(companyId, { type: type.id, label: s(b.label).trim().slice(0, 200) || type.label, issuer, reference: s(b.reference).trim().slice(0, 120) || undefined, issuedAt: s(b.issuedAt) || null, expiresAt: s(b.expiresAt) || null, isExample: false }, actor);
      return { piece, vault: await vaultState(companyId, Boolean(company.isExample)) };
    }
    if (op === "renouveler") {
      const piece = (await listVault(companyId)).find((p) => p.id === s(b.pieceId));
      if (!piece) throw new WorkspaceError("Pièce introuvable.", 404);
      const approval = await asUserError(() => requestRenewal(companyId, piece, company, actor));
      return { approval };
    }
    throw new WorkspaceError("Opération inconnue.");
  });
}
