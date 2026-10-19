import manifestJson from "@/packs/appels-offres-cm/manifest.json";
import { readData } from "@/lib/workspace/store";
import type { Evidence, PackAction, PackManifest, PackRuntime, PackVerifier } from "@/lib/engine/packs/types";
import { recalcBpu, type BpuInput, type BpuResult } from "./bpu";
import { parseDao, sheetMarkdown, type DaoSheet } from "./dao";
import { assembleDossier, buildMatrix, type Matrix } from "./matrix";
import { fmtXaf } from "./numbers";
import { evaluateAoPack } from "./evaluate";
import { ensureExampleVault, listVault, renewalDraft, vaultAlerts } from "./vault";

export const manifest = manifestJson as unknown as PackManifest;

async function companyOf(companyId: string) {
  const data = await readData();
  return data.companies.find((c) => c.id === companyId) ?? { id: companyId, name: "Entreprise", isExample: false };
}
async function vaultFor(companyId: string) {
  const c = await companyOf(companyId);
  await ensureExampleVault(companyId, Boolean(c.isExample));
  return { company: c, vault: await listVault(companyId) };
}
const daoArgs = (input: Record<string, unknown>) => ({ text: String(input.texte ?? ""), id: String(input.daoId ?? "dao"), title: String(input.titre ?? "DAO fourni") });

const actions: Record<string, PackAction> = {
  ao_lire_dao: {
    name: "ao_lire_dao",
    description: "Lit un DAO / avis (texte) et produit la fiche d'une page avec citations exactes.",
    risk: "lire",
    async run(input) {
      const a = daoArgs(input);
      if (a.text.trim().length < 200) throw new Error("texte du DAO trop court (200 caractères minimum)");
      const { sheet, doc } = parseDao(a.text, { id: a.id, title: a.title });
      return { output: { sheet, markdown: sheetMarkdown(sheet), citations: sheet.citations }, summary: `Fiche DAO : ${sheet.pieces.length} pièce(s), ${sheet.manquants.length} élément(s) non trouvé(s)`, docs: [doc] };
    },
  },
  ao_matrice: {
    name: "ao_matrice",
    description: "Matrice de conformité : pièces exigées × coffre-fort.",
    risk: "lire",
    async run(input, ctx) {
      const sheet = input.sheet as DaoSheet;
      const { vault } = await vaultFor(ctx.companyId);
      const matrix = buildMatrix(sheet, vault);
      const renouveler = matrix.rows.filter((r) => r.status === "expiree" || r.status === "expire_avant_depot").map((r) => r.vaultPiece!.id);
      return { output: { matrix, renouveler }, summary: `Matrice : ${matrix.counts.valide} valide(s), ${matrix.counts.expiree + matrix.counts.expire_avant_depot} à renouveler, ${matrix.counts.a_rediger} à rédiger, ${matrix.counts.manquante} manquante(s)` };
    },
  },
  ao_recalcul_bpu: {
    name: "ao_recalcul_bpu",
    description: "Recalcule le bordereau des prix (quantité × PU, totaux, TVA si taux fourni).",
    risk: "brouillon",
    async run(input, ctx) {
      const bpu = input.bpu as BpuInput;
      if (!bpu?.rows?.length) throw new Error("bordereau vide");
      const r = await recalcBpu(bpu, ctx.executor);
      return { output: r, summary: `Bordereau recalculé (${r.calculs} calculs, exécuteur ${r.executor}) : total HT ${fmtXaf(r.totalHt)}${r.totalTtc !== null ? `, TTC ${fmtXaf(r.totalTtc)}` : ""} — ${r.issues.length} écart(s)` };
    },
  },
  ao_demande_renouvellement: {
    name: "ao_demande_renouvellement",
    description: "Brouillons de demandes de renouvellement des pièces expirées (envoi simulé après approbation).",
    risk: "envoyer",
    async run() {
      return { output: null, summary: "géré par la file d'approbation" };
    },
    async preview(input, ctx) {
      const { company, vault } = await vaultFor(ctx.companyId);
      const ids = (input.pieces as string[]) ?? [];
      const drafts = vault.filter((p) => ids.includes(p.id)).map((p) => renewalDraft(p, company));
      return {
        title: `${drafts.length} demande(s) de renouvellement de pièces`,
        lines: drafts.flatMap((d, i) => [`— Brouillon ${i + 1} —`, ...d.lines]),
        payload: { drafts: drafts.map((d) => d.payload), mode: "simulation" },
      };
    },
  },
  ao_assembler: {
    name: "ao_assembler",
    description: "Assemble le dossier dans l'ordre demandé et vérifie la complétude.",
    risk: "brouillon",
    async run(input, ctx) {
      const sheet = input.sheet as DaoSheet;
      const { vault } = await vaultFor(ctx.companyId);
      const matrix = buildMatrix(sheet, vault); // reconstruit : prend en compte les pièces ajoutées depuis
      const dossier = assembleDossier(matrix, sheet);
      return { output: { matrix, dossier }, summary: dossier.missing.length ? `Dossier assemblé — ${dossier.missing.length} pièce(s) à compléter` : "Dossier complet assemblé" };
    },
  },
  ao_depot_coleps: {
    name: "ao_depot_coleps",
    description: "Dépôt de l'offre sur COLEPS — TOUJOURS effectué par un humain, après approbation.",
    risk: "payer_deposer",
    async run() {
      return { output: null, summary: "action humaine" };
    },
    async preview(input) {
      const sheet = input.sheet as DaoSheet;
      const dossier = (input.dossier as ReturnType<typeof assembleDossier> | undefined) ?? { sections: [], missing: [] };
      return {
        title: `Dépôt sur COLEPS — ${sheet.reference.value ?? sheet.title}`,
        lines: [
          `Date limite : ${sheet.dateLimite.value ? `${sheet.dateLimite.value.texte} (heure de Douala)` : "non trouvée — à vérifier"}`,
          `Mode : ${sheet.dateLimite.value?.mode ?? "inconnu"}`,
          ...dossier.sections.flatMap((s) => [s.envelope, ...s.files.map((f) => `  ${f.name}`)]),
          ...(dossier.missing.length ? [`ATTENTION : ${dossier.missing.length} pièce(s) non conforme(s) au moment de la demande`] : []),
          "Exécution : par un HUMAIN sur la plateforme COLEPS. Co-founder ne se connecte pas et ne dépose rien.",
        ],
        payload: { reference: sheet.reference.value, deadline: sheet.dateLimite.value?.iso ?? null, files: dossier.sections.flatMap((s) => s.files.map((f) => f.name)), missing: dossier.missing },
      };
    },
  },
};

const ev = (label: string, ok: boolean, detail: string, extra: Partial<Evidence> = {}): Evidence => ({ label, kind: "verification", ok, detail, ...extra });

const verifiers: Record<string, PackVerifier> = {
  /** Fiche : date limite et caution trouvées (ou explicitement signalées), au moins une pièce. */
  fiche_essentielle(output) {
    const s = (output as { sheet: DaoSheet }).sheet;
    return [
      ev("Date limite extraite", Boolean(s.dateLimite.value), s.dateLimite.value ? `${s.dateLimite.value.texte}` : "non trouvée dans le texte — à saisir par l'humain"),
      ev("Caution extraite", Boolean(s.caution.value), s.caution.value ? s.caution.value.libelle : "non trouvée dans le texte"),
      ev("Pièces exigées identifiées", s.pieces.length > 0, `${s.pieces.length} pièce(s)`),
    ];
  },
  /** Montants chiffres / lettres du DAO : une incohérence est une ALERTE (à faire préciser), pas un échec. */
  montants_lettres(output) {
    const s = (output as { sheet: DaoSheet }).sheet;
    const bad = s.montants.filter((m) => !m.consistent);
    if (!s.montants.length) return [ev("Montants chiffres / lettres", true, "aucune paire chiffres/lettres dans le texte", { kind: "calcul" })];
    return [
      ev("Montants chiffres / lettres", true, bad.length ? `${bad.length} incohérence(s) dans le texte source : ${bad.map((b) => `« ${b.quote} » (${fmtXaf(b.figures)} ≠ ${fmtXaf(b.wordsValue ?? 0)})`).join(" ; ")} — à faire préciser par l'autorité contractante` : `${s.montants.length} montant(s) concordant(s)`, { kind: "calcul", warning: bad.length > 0 }),
    ];
  },
  matrice_couvre_pieces(output, _p) {
    const { matrix } = output as { matrix: Matrix };
    const ok = matrix.rows.length > 0 && matrix.rows.every((r) => Boolean(r.status));
    return [ev("Chaque pièce exigée a un statut", ok, `${matrix.rows.length} ligne(s) — ${Object.entries(matrix.counts).map(([k, v]) => `${k.replace(/_/g, " ")} : ${v}`).join(", ")}`)];
  },
  /** Le bordereau corrigé est cohérent ; les écarts du bordereau saisi sont montrés en alerte. */
  recalcul_coherent(output) {
    const r = output as BpuResult;
    const corrected = r.corrected.every((row) => row.montant === Math.round(row.quantite * row.prixUnitaire));
    const out = [ev("Bordereau corrigé cohérent", corrected && r.rows.every((x) => x.montantCalcule !== null), `${r.rows.length} ligne(s), total HT ${fmtXaf(r.totalHt)} (exécuteur ${r.executor})`, { kind: "calcul" })];
    if (r.issues.length) out.push(ev("Écarts dans le bordereau saisi", true, r.issues.map((i) => i.message).join(" ; "), { kind: "calcul", warning: true }));
    return out;
  },
  completude(output) {
    const { matrix, dossier } = output as { matrix: Matrix; dossier: ReturnType<typeof assembleDossier> };
    return [ev("Dossier complet par rapport à la checklist", matrix.complete, matrix.complete ? "toutes les pièces sont valides à la date limite" : `à compléter : ${dossier.missing.join(" ; ")}`, { kind: "piece" })];
  },
};

export const aoRuntime: PackRuntime = { manifest, actions, verifiers, evaluate: () => evaluateAoPack(manifest) };
export { vaultAlerts };
