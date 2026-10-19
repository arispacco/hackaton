import type { DaoSheet, Piece } from "./dao";
import { vaultAlerts, type VaultPiece } from "./vault";

/**
 * MATRICE DE CONFORMITÉ et ASSEMBLAGE : chaque pièce exigée par le DAO (dans l'ordre demandé, par enveloppe)
 * est rapprochée du coffre-fort. Statuts : valide · expire_avant_depot · expiree · a_rediger · manquante.
 */
export type MatrixRow = { order: number; envelope: Piece["envelope"]; requirement: string; pieceType: string; quote: string; status: "valide" | "expire_avant_depot" | "expiree" | "a_rediger" | "manquante"; vaultPiece?: { id: string; label: string; expiresAt?: string | null; isExample?: boolean }; action: string };
export type Matrix = { rows: MatrixRow[]; deadline: string | null; complete: boolean; counts: Record<MatrixRow["status"], number> };

const ENVELOPES: Record<Piece["envelope"], string> = { A: "Enveloppe A — pièces administratives", B: "Enveloppe B — offre technique", C: "Enveloppe C — offre financière" };

export function buildMatrix(sheet: Pick<DaoSheet, "pieces" | "dateLimite">, vault: VaultPiece[], now = new Date()): Matrix {
  const deadline = sheet.dateLimite.value?.iso ?? null;
  const alerts = vaultAlerts(vault, { now, deadline, horizonDays: 0 });
  const rows: MatrixRow[] = sheet.pieces.map((p, i) => {
    const vp = vault.find((v) => v.type === p.id);
    const alert = vp ? alerts.find((a) => a.pieceId === vp.id) : undefined;
    let status: MatrixRow["status"];
    let action: string;
    if (vp) {
      status = alert?.level === "expiree" ? "expiree" : alert?.level === "expire_avant_depot" ? "expire_avant_depot" : "valide";
      action = status === "valide" ? "joindre la pièce du coffre" : "renouveler la pièce (brouillon de demande proposé, envoi après approbation)";
    } else if (p.produce === "rediger") {
      status = "a_rediger";
      action = "rédiger à partir du modèle du pack, puis faire signer";
    } else {
      status = "manquante";
      action = p.produce === "obtenir" ? "obtenir auprès de l'organisme émetteur" : "ajouter au coffre";
    }
    return { order: i + 1, envelope: p.envelope, requirement: p.label, pieceType: p.id, quote: p.quote, status, action, vaultPiece: vp ? { id: vp.id, label: vp.label, expiresAt: vp.expiresAt, isExample: vp.isExample } : undefined };
  });
  const counts = { valide: 0, expire_avant_depot: 0, expiree: 0, a_rediger: 0, manquante: 0 };
  for (const r of rows) counts[r.status]++;
  return { rows, deadline, complete: rows.every((r) => r.status === "valide"), counts };
}

/** Plan d'assemblage du dossier, dans l'ordre demandé, avec noms de fichiers normalisés. */
export function assembleDossier(m: Matrix, sheet: Pick<DaoSheet, "limitesFichiers" | "reference">): { sections: { envelope: string; files: { name: string; requirement: string; status: MatrixRow["status"] }[] }[]; markdown: string; missing: string[] } {
  const slug = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 50);
  const sections = (["A", "B", "C"] as const).map((e) => ({
    envelope: ENVELOPES[e],
    files: m.rows.filter((r) => r.envelope === e).map((r, i) => ({ name: `${e}${String(i + 1).padStart(2, "0")}_${slug(r.requirement)}.pdf`, requirement: r.requirement, status: r.status })),
  })).filter((s) => s.files.length);
  const missing = m.rows.filter((r) => r.status !== "valide").map((r) => `${r.requirement} (${r.status.replace(/_/g, " ")})`);
  const sizes = sheet.limitesFichiers.items.map((i) => `${i.quoi} ≤ ${i.tailleMo} Mo`).join(" ; ");
  const markdown = [
    `## Bordereau des pièces — ${sheet.reference.value ?? "appel d'offres"}`,
    ...(sizes ? [`Limites COLEPS (d'après le texte) : ${sizes}`] : []),
    ...sections.flatMap((s) => [`### ${s.envelope}`, ...s.files.map((f) => `- ${f.status === "valide" ? "✅" : "⬜"} ${f.name} — ${f.requirement}`)]),
    missing.length ? `\n**À compléter avant dépôt (${missing.length})** : ${missing.join(" ; ")}` : "\n**Dossier complet** au regard de la liste extraite.",
    "\n> Le dépôt sur COLEPS est effectué par un HUMAIN, après approbation. Co-founder ne dépose rien.",
  ].join("\n");
  return { sections, markdown, missing };
}
