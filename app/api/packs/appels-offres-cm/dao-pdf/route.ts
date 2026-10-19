import { handlePaid } from "@/lib/workspace/http";
import { asUserError, engineCtx } from "@/lib/engine/http";
import { readDao } from "@/lib/packs/appels-offres-cm/service";
import { extractPdfText } from "@/lib/modules/entrepreneur/cv";
import { WorkspaceError } from "@/lib/workspace/service";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX = 5 * 1024 * 1024;

/** Import d'un DAO en PDF (texte extrait localement, pages séparées) → fiche d'une page. */
export async function POST(request: Request) {
  return handlePaid(async (viewer) => {
    const form = await request.formData().catch(() => null);
    if (!form) throw new WorkspaceError("Formulaire invalide.");
    const companyId = String(form.get("companyId") ?? "");
    await engineCtx(companyId, viewer);
    const file = form.get("file");
    if (!(file instanceof File)) throw new WorkspaceError("Aucun fichier reçu.");
    if (file.size > MAX) throw new WorkspaceError("PDF trop volumineux (5 Mo maximum). Collez le texte à la place.", 413);
    const text = await extractPdfText(new Uint8Array(await file.arrayBuffer()));
    const pages = text.split("\f");
    const title = file.name.replace(/\.pdf$/i, "").slice(0, 200) || "DAO importé";
    return asUserError(() => readDao({ text: pages.join("\n"), id: "dao_pdf", title, pages: pages.length > 1 ? pages : undefined }));
  });
}
