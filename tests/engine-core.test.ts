import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { useTempDb } from "./setup-db";
import { JsonAdapter, PostgresAdapter, type PgDriver, type StorageAdapter, __setStorage } from "@/lib/engine/storage";
import { appendAudit, listAudit, verifyChain, verifyCompanyChain, GENESIS } from "@/lib/engine/audit";
import { decideApproval, listApprovals, requestApproval } from "@/lib/engine/approvals";
import { fingerprint } from "@/lib/engine/hash";
import { evaluate, LocalExecutor } from "@/lib/engine/sandbox";
import { createMission, getMission, resolveEscalation, runMission } from "@/lib/engine/missions";
import type { PackRuntime } from "@/lib/engine/packs/types";
import { __setWorkspaceAdapter, readData, withData, __clearCache } from "@/lib/workspace/store";

/** Pilote PGlite (vrai Postgres en WASM) sérialisé : une seule connexion, transactions l'une après l'autre. */
function pgliteDriver(db: PGlite): PgDriver {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    withClient<T>(fn: (c: { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<T>) {
      const run = chain.then(() => fn({ query: (t, p) => db.query(t, p as unknown[]) as Promise<{ rows: Record<string, unknown>[] }> }));
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

const pg = new PGlite();
const adapters: [string, () => StorageAdapter][] = [
  ["json", () => new JsonAdapter(mkdtempSync(path.join(tmpdir(), "engine-")))],
  ["postgres (PGlite)", () => new PostgresAdapter(pgliteDriver(pg))],
];
afterAll(async () => {
  __setStorage(null);
  __setWorkspaceAdapter(null);
  await pg.close();
});

describe.each(adapters)("stockage %s", (_name, make) => {
  let store: StorageAdapter;
  beforeEach(() => {
    store = make();
    __setStorage(store);
  });

  it("isole les entreprises et refuse une portée invalide", async () => {
    const a = `co_a_${Date.now()}`;
    const b = `co_b_${Date.now()}`;
    await store.transaction(a, (tx) => tx.put("notes", "n1", { v: "secret A" }));
    await store.transaction(b, (tx) => tx.put("notes", "n1", { v: "B" }));
    expect(await store.read(a, (tx) => tx.get("notes", "n1"))).toEqual({ v: "secret A" });
    expect(await store.read(b, (tx) => tx.list("notes"))).toEqual([{ v: "B" }]);
    await expect(store.read("../etc", (tx) => tx.list("x"))).rejects.toThrow(/invalide/);
    await expect(store.transaction(a, (tx) => tx.put("notes", "x'; DROP TABLE engine_records; --", 1))).rejects.toThrow(/invalide/);
  });

  it("transaction atomique : une exception n'écrit rien", async () => {
    const c = `co_tx_${Date.now()}`;
    await expect(store.transaction(c, async (tx) => {
      await tx.put("k", "1", 1);
      throw new Error("coupure");
    })).rejects.toThrow("coupure");
    expect(await store.read(c, (tx) => tx.get("k", "1"))).toBeNull();
  });

  it("sérialise les écritures concurrentes d'une même entreprise (journal sans trou)", async () => {
    const c = `co_conc_${Date.now()}`;
    await Promise.all(Array.from({ length: 12 }, (_, i) => appendAudit(c, { actor: "t", action: "a", summary: `e${i}` })));
    const list = await listAudit(c);
    expect(list.map((e) => e.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(verifyChain(list).ok).toBe(true);
  });
});

describe("persistance du workspace existant sur Postgres", () => {
  it("lit / écrit le document workspace via l'adaptateur (seed au premier accès)", async () => {
    useTempDb();
    __setWorkspaceAdapter(new PostgresAdapter(pgliteDriver(pg)));
    try {
      const d = await readData();
      expect(d.companies.length).toBeGreaterThan(0);
      await withData((x) => {
        x.companies[0].name = "Renommée via Postgres";
      });
      __clearCache();
      expect((await readData()).companies[0].name).toBe("Renommée via Postgres");
      const rows = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM engine_records WHERE company_id = '_workspace'");
      expect(rows.rows[0].n).toBe(1);
    } finally {
      __setWorkspaceAdapter(null);
    }
  });
});

describe("journal d'audit chaîné SHA-256", () => {
  beforeEach(() => __setStorage(new JsonAdapter(mkdtempSync(path.join(tmpdir(), "audit-")))));

  it("chaîne les hash et détecte modification, suppression et réordonnancement", async () => {
    for (let i = 0; i < 4; i++) await appendAudit("co_x", { actor: "freddy", action: "test", summary: `entrée ${i}`, data: { i } });
    const list = await listAudit("co_x");
    expect(list[0].prevHash).toBe(GENESIS);
    expect(list[1].prevHash).toBe(list[0].hash);
    expect(list.every((e) => /^[0-9a-f]{64}$/.test(e.hash))).toBe(true);
    expect((await verifyCompanyChain("co_x")).ok).toBe(true);

    const modified = structuredClone(list);
    modified[1].summary = "entrée falsifiée";
    expect(verifyChain(modified)).toMatchObject({ ok: false, brokenAt: 2 });
    expect(verifyChain([list[0], list[2], list[3]])).toMatchObject({ ok: false, brokenAt: 3 });
    expect(verifyChain([list[1], list[0]]).ok).toBe(false);
    const rehashed = structuredClone(list);
    rehashed[2].data = { i: 99 }; // même en recalculant ce hash, l'entrée suivante ne pointe plus dessus
    expect(verifyChain(rehashed).ok).toBe(false);
  });
});

describe("approbations par niveau de risque", () => {
  beforeEach(() => __setStorage(new JsonAdapter(mkdtempSync(path.join(tmpdir(), "apr-")))));

  it("lire/brouillon auto-approuvés ; envoyer/payer exigent l'humain et l'empreinte exacte", async () => {
    const auto = await requestApproval("co_y", { level: "brouillon", action: "doc", title: "Brouillon", lines: ["x"], payload: { a: 1 }, requestedBy: "agent" });
    expect(auto.status).toBe("auto");
    const payload = { to: "Administration (exemple)", subject: "Renouvellement", body: "Texte exact" };
    const a = await requestApproval("co_y", { level: "envoyer", action: "mail", title: "Renouvellement", lines: ["Texte exact"], payload, requestedBy: "agent" });
    expect(a.status).toBe("en_attente");
    expect(a.contentHash).toBe(fingerprint({ subject: "Renouvellement", body: "Texte exact", to: "Administration (exemple)" })); // ordre des clés indifférent
    await expect(decideApproval("co_y", a.id, { decision: "approuver", by: "freddy", contentHash: fingerprint({ ...payload, body: "Autre texte" }) })).rejects.toThrow(/empreinte/);
    const ok = await decideApproval("co_y", a.id, { decision: "approuver", by: "freddy", contentHash: a.contentHash });
    expect(ok).toMatchObject({ status: "approuvee", execution: "simulee", approvedHash: a.contentHash });
    const dep = await requestApproval("co_y", { level: "payer_deposer", action: "coleps", title: "Dépôt", lines: [], payload: { f: 1 }, requestedBy: "agent" });
    expect((await decideApproval("co_y", dep.id, { decision: "approuver", by: "freddy", contentHash: dep.contentHash })).execution).toBe("humaine");
    expect((await listApprovals("co_y")).length).toBe(3);
    const audit = await listAudit("co_y");
    expect(audit.map((e) => e.action)).toEqual(["approbation.auto", "approbation.demandee", "approbation.approuvee", "approbation.demandee", "approbation.approuvee"]);
    expect(verifyChain(audit).ok).toBe(true);
  });
});

describe("exécuteur limité", () => {
  it("calcule l'arithmétique et refuse tout le reste", async () => {
    expect(evaluate("round(q * pu, 0)", { q: 45, pu: 15000 })).toBe(675000);
    expect(evaluate("(2 + 3) * -4 / 2")).toBe(-10);
    expect(evaluate("sum(1, 2, 3) + max(4, 9)")).toBe(15);
    for (const bad of ["process.exit()", "constructor", "a = 1", "1 +", "1/0", "require('fs')", "x"]) expect(() => evaluate(bad)).toThrow();
    const r = await new LocalExecutor().calc([{ id: "a", expression: "2*3" }, { id: "b", expression: "boom()" }]);
    expect(r[0].value).toBe(6);
    expect(r[1].error).toMatch(/non autorisée/);
  });
});

describe("missions : boucle planifier → agir → vérifier → présenter, reprise après coupure", () => {
  beforeEach(() => {
    useTempDb();
    __setStorage(new JsonAdapter(mkdtempSync(path.join(tmpdir(), "mission-"))));
  });

  const calls: Record<string, number> = {};
  let crashOnce = true;
  let flaky = 0;
  const runtime: PackRuntime = {
    manifest: {
      id: "pack-test", version: "1.0.0", name: "Test", description: "", audience: [], status: "valide", locale: "fr", templates: [], corpus: { needs: [] }, tools: [], verifiers: [], evaluation: { file: "" },
      procedures: [{
        id: "p", title: "Procédure test", description: "test", inputs: [{ id: "n", label: "n", required: true }], deliverables: ["A", "B", "C", "D"], outOfScope: ["rien de réel"], tokenBudget: 1000,
        steps: [
          { id: "a", title: "Étape A", action: "double", input: { n: "$input.n" }, criteria: [{ id: "c", label: "valeur paire", verifier: "pair" }] },
          { id: "b", title: "Étape B (coupure)", action: "crash", input: { v: "$step.a.v" }, criteria: [{ id: "c", label: "valeur paire", verifier: "pair" }] },
          { id: "c", title: "Étape C (instable)", action: "flaky", input: {}, maxAttempts: 2, criteria: [{ id: "c", label: "valeur paire", verifier: "pair" }] },
          { id: "d", title: "Envoi", action: "send", risk: "envoyer", input: { v: "$step.b.v" }, criteria: [] },
        ],
      }],
    },
    actions: {
      double: { name: "double", description: "", risk: "lire", async run(i) { calls.a = (calls.a ?? 0) + 1; return { output: { v: Number(i.n) * 2 }, summary: "doublé", tokens: 100 }; } },
      crash: { name: "crash", description: "", risk: "lire", async run(i) {
        calls.b = (calls.b ?? 0) + 1;
        if (crashOnce) { crashOnce = false; throw Object.assign(new Error("SIGKILL simulé"), { crash: true }); }
        return { output: { v: Number(i.v) + 2 }, summary: "ok", tokens: 100 };
      } },
      flaky: { name: "flaky", description: "", risk: "lire", async run() { flaky++; return { output: { v: flaky === 1 ? 3 : 4 }, summary: `essai ${flaky}` }; } },
      send: { name: "send", description: "", risk: "envoyer", async run() { throw new Error("ne doit jamais s'exécuter"); }, async preview(i) { return { title: "Envoi test", lines: [`valeur ${i.v}`], payload: { v: i.v } }; } },
    },
    verifiers: { pair: (o) => [{ label: "valeur paire", kind: "verification", ok: Number((o as { v: number }).v) % 2 === 0, detail: `v=${(o as { v: number }).v}` }] },
  };

  it("persiste, reprend sans rejouer, limite les essais, attend l'approbation puis présente", async () => {
    const m0 = await createMission("co_m", runtime, "p", { n: 5 }, "freddy");
    expect(m0.contract).toMatchObject({ deliverables: ["A", "B", "C", "D"], outOfScope: ["rien de réel"], tokenBudget: 1000, externalActions: [{ step: "d", level: "envoyer" }] });

    // 1er passage : A réussit, B plante en cours d'exécution (erreur = essai consommé, retenté dans la foulée).
    // On simule une vraie coupure de processus : maxSteps=2 → pause après B.
    let m = await runMission("co_m", runtime, m0.id, { maxSteps: 1 });
    expect(m.steps[0].status).toBe("reussie");
    expect(calls.a).toBe(1);

    // Coupure brutale : on relit l'état persisté depuis le stockage (nouvelle « instance »).
    m = await runMission("co_m", runtime, m0.id);
    const persisted = await getMission("co_m", m0.id);
    expect(calls.a).toBe(1); // A n'est PAS rejouée
    expect(persisted!.steps[1]).toMatchObject({ status: "reussie", attempts: 2 }); // 1 essai perdu dans la coupure + 1 réussi
    expect(persisted!.steps[2]).toMatchObject({ status: "reussie", attempts: 2 }); // 1er essai v=3 refusé par le critère, 2e essai OK
    expect(m.status).toBe("attente_approbation");
    expect(persisted!.steps[3].status).toBe("attente_approbation");
    expect(persisted!.checkpoints).toBeGreaterThan(5);

    const apr = (await listApprovals("co_m")).find((a) => a.id === persisted!.steps[3].approvalId)!;
    expect(apr.preview.lines).toEqual(["valeur 12"]);
    await decideApproval("co_m", apr.id, { decision: "approuver", by: "freddy", contentHash: apr.contentHash });
    m = await runMission("co_m", runtime, m0.id);
    expect(m.status).toBe("terminee");
    expect(m.phase).toBe("presenter");
    expect(m.report?.deliverables.every((d) => d.ok)).toBe(true);
    expect(m.steps[3].evidence.some((e) => /exécution simulée/.test(e.detail))).toBe(true);
    expect(m.tokensUsed).toBe(200);
    expect((await verifyCompanyChain("co_m")).ok).toBe(true);
  });

  it("remonte à l'humain après les essais autorisés et reprend sur décision", async () => {
    const strict: PackRuntime = { ...runtime, actions: { ...runtime.actions, flaky: { ...runtime.actions.flaky, async run() { return { output: { v: 1 }, summary: "toujours impair" }; } } } };
    crashOnce = false;
    const m0 = await createMission("co_h", strict, "p", { n: 1 }, "freddy");
    let m = await runMission("co_h", strict, m0.id);
    expect(m.status).toBe("attente_humain");
    expect(m.escalation?.stepId).toBe("c");
    expect(m.steps[2].attempts).toBe(2);
    expect((await runMission("co_h", strict, m0.id)).status).toBe("attente_humain"); // ne repart pas tout seul
    m = await resolveEscalation("co_h", m0.id, { stepId: "c", decision: "valider", by: "freddy", note: "écart accepté" });
    m = await runMission("co_h", strict, m0.id);
    expect(m.status).toBe("attente_approbation");
    expect(m.steps[2].manual).toBe(true);
  });

  it("stoppe la mission au-delà du plafond de jetons", async () => {
    const greedy: PackRuntime = { ...runtime, actions: { ...runtime.actions, double: { ...runtime.actions.double, async run() { return { output: { v: 2 }, summary: "", tokens: 5000 }; } } } };
    const m0 = await createMission("co_b", greedy, "p", { n: 1 }, "freddy");
    const m = await runMission("co_b", greedy, m0.id);
    expect(m.status).toBe("attente_humain");
    expect(m.escalation?.reason).toMatch(/plafond/);
  });
});

it("le stockage JSON écrit un fichier par entreprise", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "iso-"));
  const s = new JsonAdapter(dir);
  await s.transaction("co_1", (tx) => tx.put("x", "1", 1));
  await s.transaction("co_2", (tx) => tx.put("x", "1", 2));
  expect(readdirSync(dir).sort()).toEqual(["co_1.json", "co_2.json"]);
});

describe("reprise après coupure en plein milieu d'une action", () => {
  it("une étape restée « en_cours » est reprise par une nouvelle instance, les étapes réussies ne sont pas rejouées", async () => {
    useTempDb();
    __setStorage(new JsonAdapter(mkdtempSync(path.join(tmpdir(), "kill-"))));
    let firstDone = 0;
    let hang = true;
    const rt: PackRuntime = {
      manifest: {
        id: "pack-kill", version: "1.0.0", name: "K", description: "", audience: [], status: "valide", locale: "fr", templates: [], corpus: { needs: [] }, tools: [], verifiers: [], evaluation: { file: "" },
        procedures: [{ id: "p", title: "K", description: "", inputs: [], deliverables: ["1", "2"], outOfScope: [], tokenBudget: 10, steps: [
          { id: "un", title: "Un", action: "un", criteria: [{ id: "ok", label: "ok", verifier: "champs_presents" }] },
          { id: "deux", title: "Deux", action: "deux", criteria: [{ id: "ok", label: "ok", verifier: "champs_presents", params: { fields: ["fini"] } }] },
        ] }],
      },
      actions: {
        un: { name: "un", description: "", risk: "lire", async run() { firstDone++; return { output: { ok: true }, summary: "" }; } },
        deux: { name: "deux", description: "", risk: "lire", run() {
          if (hang) { hang = false; return new Promise(() => undefined); } // le processus « meurt » ici : la promesse ne se termine jamais
          return Promise.resolve({ output: { fini: true }, summary: "" });
        } },
      },
      verifiers: {},
    };
    const m0 = await createMission("co_k", rt, "p", {}, "freddy");
    void runMission("co_k", rt, m0.id); // instance 1, tuée pendant l'étape « deux »
    for (let i = 0; i < 50; i++) {
      const s = await getMission("co_k", m0.id);
      if (s?.steps[1].status === "en_cours") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const snapshot = await getMission("co_k", m0.id);
    expect(snapshot!.steps.map((s) => s.status)).toEqual(["reussie", "en_cours"]);
    const m = await runMission("co_k", rt, m0.id); // instance 2
    expect(m.status).toBe("terminee");
    expect(firstDone).toBe(1);
    expect(m.steps[1].attempts).toBe(2);
  });
});
