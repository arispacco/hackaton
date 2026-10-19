import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempDb } from "./setup-db";
import { JsonAdapter, __setStorage } from "@/lib/engine/storage";
import { decideApproval, listApprovals } from "@/lib/engine/approvals";
import { verifyCompanyChain } from "@/lib/engine/audit";
import { verifyCitation } from "@/lib/engine/citations";
import { createMission, resolveEscalation, runMission } from "@/lib/engine/missions";
import { LocalExecutor } from "@/lib/engine/sandbox";
import { validateManifest, listPacks, saveDraft, getPackRuntime } from "@/lib/engine/packs/registry";
import { generatePackDraft } from "@/lib/engine/packs/generator";
import { aoRuntime, manifest } from "@/lib/packs/appels-offres-cm/runtime";
import { parseDao, sheetMarkdown } from "@/lib/packs/appels-offres-cm/dao";
import { recalcBpu } from "@/lib/packs/appels-offres-cm/bpu";
import { checkAmountsInText, parseFrenchNumber } from "@/lib/packs/appels-offres-cm/numbers";
import { addPiece, listVault, renewalDraft, vaultAlerts, type VaultPiece } from "@/lib/packs/appels-offres-cm/vault";
import { buildMatrix } from "@/lib/packs/appels-offres-cm/matrix";
import { ALL_TOOLS, AGENT_MODULES } from "@/lib/agent/registry";
import { selectTools } from "@/lib/agent/tool-selection";

const fx = (f: string) => readFileSync(path.join("packs/appels-offres-cm/fixtures", f), "utf8");
const SANG = fx("armp-ao-65436-sangmelima-pistes.txt");
const GUIDER = fx("armp-ao-65438-guider-bas-fond.txt");

beforeEach(() => {
  useTempDb();
  __setStorage(new JsonAdapter(mkdtempSync(path.join(tmpdir(), "ao-"))));
});

describe("pack appels-offres-cm : manifest et jeu d'évaluation", () => {
  it("le manifest est valide et déclare le dépôt COLEPS comme humain", () => {
    expect(validateManifest(manifest, aoRuntime)).toEqual([]);
    expect(manifest.humanOnly).toContain("Dépôt sur COLEPS");
    expect(manifest.procedures[0].steps.find((s) => s.id === "depot")?.risk).toBe("payer_deposer");
    expect(manifest.fixtures?.filter((f) => f.origin === "source_publique").every((f) => f.source?.startsWith("https://armp.cm/") && f.verifiedAt)).toBe(true);
  });

  it("toutes les fixtures sont expurgées (aucun téléphone ni e-mail)", () => {
    for (const t of [SANG, GUIDER]) {
      expect(t).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/);
      expect(t).not.toMatch(/\b6\d{2}\s?\d{3}\s?\d{3}\b/);
    }
  });

  it("le jeu d'évaluation passe entièrement (attendus lus dans les avis réels)", async () => {
    const results = await aoRuntime.evaluate!();
    const failed = results.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => `${r.id} › ${c.label} : ${c.detail}`));
    expect(failed).toEqual([]);
    expect(results).toHaveLength(4);
  });
});

describe("lecteur de DAO", () => {
  it("extrait la fiche d'un avis réel avec des citations toutes résolues dans le texte", () => {
    const { sheet, doc } = parseDao(SANG, { id: "sang", title: "Sangmélima" });
    expect(sheet.reference.value).toBe("014/AONO/CS/SIGAMP/CDPM/2026");
    expect(sheet.autorite.value).toBe("Préfet du Département du Dja et Lobo");
    expect(sheet.dateLimite.value).toMatchObject({ iso: "2026-11-11T14:00:00+01:00", mode: "physique" });
    expect(sheet.caution.value?.montant).toBe(3029188);
    expect(sheet.caution.value?.validite).toMatch(/trente \(30\) jours/);
    expect(sheet.grille.eliminatoires.length).toBeGreaterThanOrEqual(8);
    expect(sheet.limitesFichiers.items).toEqual([]);
    expect(sheet.manquants).toContain("limites de taille de fichiers"); // signalé, jamais deviné
    for (const c of sheet.citations) expect(verifyCitation(c, [doc]).status).toBe("verifiee");
    const md = sheetMarkdown(sheet);
    expect(md).toContain("non trouvé dans le texte fourni");
    expect(md.split("\n").length).toBeLessThan(60); // une page
  });

  it("repère une incohérence chiffres / lettres réelle dans l'avis de Guider", () => {
    const { sheet } = parseDao(GUIDER, { id: "g", title: "Guider" });
    expect(sheet.dateLimite.value?.mode).toBe("COLEPS");
    expect(sheet.limitesFichiers.items.map((i) => i.tailleMo)).toEqual([5, 15, 5]);
    const bad = sheet.montants.filter((m) => !m.consistent);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ figures: 3500000, wordsValue: 3005000 });
  });

  it("convertit les montants en lettres", () => {
    expect(parseFrenchNumber("Cent cinquante un millions quatre cent cinquante-neuf mille quatre cent vingt-cinq")).toBe(151459425);
    expect(parseFrenchNumber("quatre-vingt-dix-neuf mille")).toBe(99000);
    expect(parseFrenchNumber("soixante-dix")).toBe(70);
    expect(checkAmountsInText("une somme de Cent Vingt Mille (120.000) Francs CFA")[0]).toMatchObject({ figures: 120000, consistent: true });
  });
});

describe("bordereau, coffre-fort, matrice", () => {
  it("recalcule le bordereau d'exemple et trouve l'erreur volontaire ligne 103", async () => {
    const bpu = JSON.parse(fx("bpu-exemple.json"));
    const r = await recalcBpu(bpu, new LocalExecutor());
    expect(r.issues.filter((i) => i.kind === "ligne").map((i) => i.code)).toEqual(["103"]);
    expect(r.totalHt).toBe(38375000);
    expect(r.issues.find((i) => i.kind === "total_ht")?.declared).toBe(38465000);
    expect(r.tva).toBeNull(); // aucun taux inventé
    const withTva = await recalcBpu({ ...bpu, tvaRate: 10, totalTtcDeclare: 42212500 }, new LocalExecutor());
    expect(withTva.totalTtc).toBe(42212500);
  });

  it("alerte avant expiration et avant la date limite ; brouillon de renouvellement sans contact réel", () => {
    const now = new Date("2026-10-19T08:00:00+01:00");
    const pieces: VaultPiece[] = [
      { id: "1", type: "cnps", label: "CNPS", issuer: "CNPS (exemple)", expiresAt: "2026-10-10", addedAt: "" },
      { id: "2", type: "acf", label: "ACF", issuer: "Impôts (exemple)", expiresAt: "2026-11-05", addedAt: "" },
      { id: "3", type: "non_faillite", label: "NF", issuer: "Tribunal (exemple)", expiresAt: "2026-10-30", addedAt: "" },
      { id: "4", type: "rccm", label: "RCCM", issuer: "Greffe", expiresAt: null, addedAt: "" },
    ];
    const alerts = vaultAlerts(pieces, { now, deadline: "2026-11-11T14:00:00+01:00", horizonDays: 30 });
    expect(alerts.map((a) => [a.pieceId, a.level])).toEqual([["1", "expiree"], ["3", "expire_avant_depot"], ["2", "expire_avant_depot"]]);
    const d = renewalDraft(pieces[0], { name: "Kmer BTP (exemple)" });
    expect(d.payload.to).toMatch(/à compléter/);
    expect(d.lines.join("\n")).toMatch(/SIMULÉ/);
  });

  it("matrice dans l'ordre des enveloppes, avec statuts", () => {
    const { sheet } = parseDao(SANG, { id: "s", title: "s" });
    const m = buildMatrix(sheet, [{ id: "c", type: "categorisation", label: "Catégorisation", issuer: "x", expiresAt: "2027-06-01", addedAt: "" }], new Date("2026-10-19"));
    expect(m.rows.map((r) => r.envelope).join("")).toMatch(/^A+B*C+$/);
    expect(m.rows.find((r) => r.pieceType === "categorisation")?.status).toBe("valide");
    expect(m.rows.find((r) => r.pieceType === "charte")?.status).toBe("a_rediger");
    expect(m.rows.find((r) => r.pieceType === "caution")?.status).toBe("manquante");
    expect(m.complete).toBe(false);
  });
});

describe("mission « Préparer une offre » de bout en bout (seed exemple)", () => {
  // Date figée : le seed « exemple » est relatif à aujourd'hui, la date limite de l'avis réel est fixe.
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-19T08:00:00+01:00"), toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());
  it("fiche → matrice → bordereau → renouvellements (approbation) → assemblage (remonte à l'humain) → dépôt humain", async () => {
    const company = "co_kmerlog"; // entreprise de démonstration : coffre seedé « exemple »
    const bpu = JSON.parse(fx("bpu-exemple.json"));
    const m0 = await createMission(company, aoRuntime, "preparer_offre", { texte: SANG, titre: "AAO Sangmélima", daoId: "armp-65436", bpu }, "freddy");
    let m = await runMission(company, aoRuntime, m0.id);
    const st = () => Object.fromEntries(m.steps.map((s) => [s.id, s.status]));
    expect(st()).toMatchObject({ lire_dao: "reussie", matrice: "reussie", bpu: "reussie", renouvellements: "attente_approbation" });
    expect(m.steps[0].evidence.filter((e) => e.kind === "citation").every((e) => e.ok)).toBe(true);
    expect(m.steps[2].evidence.some((e) => e.warning && /ligne 103/.test(e.detail))).toBe(true);
    expect((await listVault(company)).every((p) => p.isExample)).toBe(true);

    const renew = (await listApprovals(company)).find((a) => a.action === "ao_demande_renouvellement")!;
    expect(renew.level).toBe("envoyer");
    expect(renew.preview.lines.join("\n")).toMatch(/catégorisation/);
    await decideApproval(company, renew.id, { decision: "approuver", by: "freddy", contentHash: renew.contentHash });
    m = await runMission(company, aoRuntime, m0.id);
    expect(st()).toMatchObject({ renouvellements: "reussie", assembler: "attente_humain" });
    expect(m.escalation?.reason).toMatch(/à compléter/);

    // L'humain ajoute une pièce puis valide l'écart restant en connaissance de cause.
    await addPiece(company, { type: "caution", label: "Caution de soumission — exemple", issuer: "Banque (exemple)", expiresAt: "2027-03-01", isExample: true }, "freddy");
    m = await resolveEscalation(company, m0.id, { stepId: "assembler", decision: "valider", by: "freddy", note: "pièces à rédiger en cours" });
    m = await runMission(company, aoRuntime, m0.id);
    expect(m.status).toBe("attente_approbation");
    const dep = (await listApprovals(company)).find((a) => a.action === "ao_depot_coleps")!;
    expect(dep.level).toBe("payer_deposer");
    expect(dep.preview.lines.join("\n")).toMatch(/HUMAIN/);
    await decideApproval(company, dep.id, { decision: "approuver", by: "freddy", contentHash: dep.contentHash });
    m = await runMission(company, aoRuntime, m0.id);
    expect(m.status).toBe("terminee");
    expect(m.report?.humanActions[0]).toMatch(/COLEPS/);
    expect((await verifyCompanyChain(company)).ok).toBe(true);
  });
});

describe("générateur de packs et registre", () => {
  it("produit un brouillon valide, marqué à valider, sans référence inventée", async () => {
    const { manifest: draft, coverage, detected } = await generatePackDraft("Je dirige une petite entreprise de transport et logistique à Douala : je réponds à des consultations de livraison de colis et je dois suivre les papiers de mes camions.");
    expect(detected).toBe("Transport et logistique");
    expect(draft.status).toBe("brouillon_a_valider");
    expect(draft.notes?.[0]).toMatch(/BROUILLON/);
    expect(validateManifest(draft)).toEqual([]);
    expect(JSON.stringify(draft)).not.toMatch(/\b(loi|décret|arrêté)\s+n\s*°/i);
    expect(coverage.needs.length).toBeGreaterThan(0);
    expect(draft.tools.length).toBeLessThanOrEqual(16);

    await saveDraft("co_gen", draft, "freddy");
    const packs = await listPacks("co_gen");
    expect(packs.map((p) => p.manifest.id)).toEqual(["appels-offres-cm", draft.id]);
    expect((await listPacks("co_autre")).length).toBe(1); // brouillon isolé par entreprise
    const rt = await getPackRuntime("co_gen", draft.id);
    expect(rt?.actions.moteur_rechercher_corpus).toBeDefined();
  });

  it("refuse une description trop courte et un identifiant réservé", async () => {
    await expect(generatePackDraft("BTP")).rejects.toThrow(/20 caractères/);
    await expect(saveDraft("co_gen", { ...manifest }, "x")).rejects.toThrow(/réservé/);
  });
});

describe("intégration agent (aucun module existant retiré)", () => {
  it("les outils du pack sont sélectionnés pour une question d'appel d'offres, les autres modules restent", () => {
    const ids = AGENT_MODULES.map((m) => m.id);
    for (const id of ["core", "structure", "law-watch", "connecteurs", "idea", "fund", "team", "mentor", "market", "etat", "entreprise", "memoire", "appels_offres"]) expect(ids).toContain(id);
    const sel = selectTools("Voici un DAO, quelles pièces et quelle caution pour la soumission ?", ALL_TOOLS);
    expect(sel.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["ao_lire_dao", "ao_coffre_alertes"]));
    expect(sel.tools.length).toBeLessThanOrEqual(16);
  });
});

describe("entrée de mission depuis les fixtures (écran Missions)", () => {
  it("charge l'avis réel et le bordereau d'exemple, ignore les champs inconnus", async () => {
    const { missionInput } = await import("@/lib/engine/mission-input");
    const { manifest } = await import("@/lib/packs/appels-offres-cm/runtime");
    const input = await missionInput(manifest, { fixture: "armp-ao-65436", bpuFixture: "bpu-exemple", input: { inconnu: "x" } });
    expect(String(input.texte)).toMatch(/Sangm/);
    expect(input.daoId).toBe("armp-ao-65436");
    expect((input.bpu as { isExample?: boolean }).isExample).toBe(true);
    expect(input.inconnu).toBeUndefined();
  });
});
