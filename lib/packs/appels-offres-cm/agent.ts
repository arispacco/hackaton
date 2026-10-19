import type { AgentModule } from "@/lib/agent/registry";
import { createMission, runMission } from "@/lib/engine/missions";
import { LocalExecutor } from "@/lib/engine/sandbox";
import { recalcBpu, type BpuRow } from "./bpu";
import { parseDao, sheetMarkdown } from "./dao";
import { fmtXaf } from "./numbers";
import { aoRuntime } from "./runtime";
import { ensureExampleVault, listVault, vaultAlerts } from "./vault";
import { readData } from "@/lib/workspace/store";

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Outils agent du pack « appels-offres-cm » (le pack reste aussi utilisable sans l'agent, via l'écran Packs). */
export const agentModule: AgentModule = {
  id: "appels_offres",
  tools: [
    {
      name: "ao_lire_dao",
      description: "Lit le texte d'un DAO ou d'un avis d'appel d'offres et renvoie la fiche d'une page (date limite, caution, pièces, grille, limites de fichiers) avec citations exactes.",
      parameters: { type: "object", properties: { texte: { type: "string", description: "Texte intégral du DAO / de l'avis" } }, required: ["texte"] },
      async run(input) {
        const text = str(input.texte);
        if (text.length < 200) return { summary: "Texte du DAO trop court", data: { erreur: "Collez le texte intégral du DAO ou de l'avis (200 caractères minimum), ou utilisez l'écran Packs › Appels d'offres pour un PDF." } };
        const { sheet } = parseDao(text, { id: "dao_agent", title: "DAO fourni" });
        return { summary: `Fiche DAO : ${sheet.pieces.length} pièce(s), date limite ${sheet.dateLimite.value?.texte ?? "non trouvée"}`, data: { fiche: sheetMarkdown(sheet), non_trouves: sheet.manquants, incoherences_montants: sheet.montants.filter((m) => !m.consistent) } };
      },
    },
    {
      name: "ao_recalcul_bpu",
      description: "Recalcule un bordereau des prix (quantité × prix unitaire, total HT, TVA si taux fourni) et liste les écarts.",
      parameters: { type: "object", properties: { lignes: { type: "array", items: { type: "object", properties: { code: { type: "string" }, designation: { type: "string" }, quantite: { type: "number" }, prixUnitaire: { type: "number" }, montant: { type: "number" } } } }, taux_tva: { type: "number", description: "Taux indiqué dans le DAO (facultatif)" } }, required: ["lignes"] },
      async run(input) {
        const rows = (Array.isArray(input.lignes) ? input.lignes : []) as BpuRow[];
        const r = await recalcBpu({ rows, tvaRate: typeof input.taux_tva === "number" ? input.taux_tva : null }, new LocalExecutor());
        return { summary: `Total HT recalculé ${fmtXaf(r.totalHt)} — ${r.issues.length} écart(s)`, data: { total_ht: r.totalHt, tva: r.tva, total_ttc: r.totalTtc, ecarts: r.issues.map((i) => i.message) } };
      },
    },
    {
      name: "ao_coffre_alertes",
      description: "Liste les pièces administratives du coffre-fort qui sont expirées ou expirent bientôt (ou avant une date limite de dépôt).",
      parameters: { type: "object", properties: { date_limite: { type: "string", description: "Date limite de dépôt AAAA-MM-JJ (facultatif)" } } },
      async run(input, ctx) {
        const company = (await readData()).companies.find((c) => c.id === ctx.companyId);
        await ensureExampleVault(ctx.companyId, Boolean(company?.isExample));
        const pieces = await listVault(ctx.companyId);
        const alerts = vaultAlerts(pieces, { deadline: str(input.date_limite) || null });
        return { summary: `${alerts.length} alerte(s) sur ${pieces.length} pièce(s)`, data: { alertes: alerts.map((a) => a.message), exemple: pieces.some((p) => p.isExample) } };
      },
    },
    {
      name: "ao_preparer_offre",
      description: "Lance la mission « Préparer une offre » du pack appels d'offres à partir du texte du DAO (fiche, matrice, assemblage ; renouvellements et dépôt passent par l'approbation).",
      parameters: { type: "object", properties: { texte: { type: "string", description: "Texte intégral du DAO / de l'avis" }, titre: { type: "string" } }, required: ["texte"] },
      external: true,
      async run(input, ctx) {
        const text = str(input.texte);
        if (text.length < 200) return { summary: "Texte du DAO trop court", data: { erreur: "200 caractères minimum" } };
        const m0 = await createMission(ctx.companyId, aoRuntime, "preparer_offre", { texte: text, titre: str(input.titre) || "DAO fourni", daoId: "dao_agent" }, "agent");
        const m = await runMission(ctx.companyId, aoRuntime, m0.id, { actor: "agent" });
        return { summary: `Mission ${m.id} : ${m.status.replace(/_/g, " ")}`, data: { mission: m.id, statut: m.status, etapes: m.steps.map((s) => `${s.title} — ${s.status}`), escalade: m.escalation?.reason ?? null, ecran: "Packs › Missions" } };
      },
    },
  ],
};
