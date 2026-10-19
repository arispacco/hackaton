import { appendAuditTx } from "./audit";
import { getApproval, requestApproval, type EngineApproval } from "./approvals";
import { getExecutor } from "./sandbox";
import { getStorage } from "./storage";
import { CORE_VERIFIERS } from "./verifiers";
import type { ActionCtx, Evidence, PackRuntime, Procedure, StepSpec } from "./packs/types";

/**
 * MISSIONS — contrat de mission + boucle planifier → agir → vérifier → présenter.
 *  - contrat : livrables, hors périmètre, actions externes prévues (avec niveau de risque), plafond de jetons ;
 *  - chaque étape a des critères VÉRIFIABLES (vérificateurs déterministes) ; essais limités, puis remontée à l'humain ;
 *  - l'état est persisté à chaque transition (point de reprise) : après une coupure, `runMission` reprend à l'étape
 *    en cours sans rejouer les étapes réussies ;
 *  - les actions « envoyer » / « payer_deposer » attendent une approbation sur l'aperçu exact (empreinte SHA-256),
 *    et ne sont jamais exécutées réellement par le moteur (envoi simulé, dépôt humain).
 */
export type MissionContract = {
  objective: string;
  deliverables: string[];
  outOfScope: string[];
  externalActions: { step: string; action: string; level: string; description: string }[];
  tokenBudget: number;
};
export type StepStatus = "a_faire" | "en_cours" | "reussie" | "sautee" | "attente_humain" | "attente_approbation" | "abandonnee";
export type MissionStep = StepSpec & { status: StepStatus; attempts: number; maxAttempts: number; output?: unknown; summary?: string; evidence: Evidence[]; error?: string; approvalId?: string; startedAt?: string; finishedAt?: string; manual?: boolean };
export type MissionStatus = "planifiee" | "en_cours" | "attente_humain" | "attente_approbation" | "terminee" | "abandonnee";
export type Mission = {
  id: string;
  packId: string;
  packVersion: string;
  procedureId: string;
  title: string;
  contract: MissionContract;
  status: MissionStatus;
  phase: "planifier" | "agir" | "verifier" | "presenter";
  steps: MissionStep[];
  input: Record<string, unknown>;
  outputs: Record<string, unknown>;
  tokensUsed: number;
  checkpoints: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  escalation?: { stepId: string; reason: string };
  report?: { summary: string; deliverables: { label: string; ok: boolean; detail: string }[]; evidence: number; humanActions: string[] };
};

const COL = "missions";
const nowIso = () => new Date().toISOString();

export class MissionError extends Error {}

/** PLANIFIER : contrat + étapes à partir de la procédure du pack (déterministe, relisible). */
export function planMission(runtime: PackRuntime, procedure: Procedure, input: Record<string, unknown>, createdBy: string): Mission {
  for (const p of procedure.inputs) if (p.required && (input[p.id] === undefined || input[p.id] === "")) throw new MissionError(`Entrée requise manquante : ${p.label}`);
  const id = `mis_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    packId: runtime.manifest.id,
    packVersion: runtime.manifest.version,
    procedureId: procedure.id,
    title: procedure.title,
    contract: {
      objective: procedure.description,
      deliverables: procedure.deliverables,
      outOfScope: procedure.outOfScope,
      externalActions: procedure.steps.filter((s) => s.risk === "envoyer" || s.risk === "payer_deposer").map((s) => ({ step: s.id, action: s.action, level: s.risk!, description: s.title })),
      tokenBudget: procedure.tokenBudget,
    },
    status: "planifiee",
    phase: "planifier",
    steps: procedure.steps.map((s) => ({ ...s, status: "a_faire", attempts: 0, maxAttempts: s.maxAttempts ?? 2, evidence: [] })),
    input,
    outputs: {},
    tokensUsed: 0,
    checkpoints: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    createdBy,
  };
}

/** Résout « $input.x » et « $step.id(.champ) » dans l'entrée d'une étape. */
export function resolveRefs(value: unknown, m: Pick<Mission, "input" | "outputs">): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    const [root, ...rest] = value.slice(1).split(".");
    let cur: unknown = root === "input" ? m.input : root === "step" ? m.outputs : undefined;
    for (const k of rest) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
    return cur;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, m));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, m)]));
  return value;
}
const truthy = (v: unknown) => !(v === undefined || v === null || v === false || v === "" || (Array.isArray(v) && v.length === 0));

async function save(companyId: string, m: Mission, audit?: { actor: string; action: string; summary: string; data?: unknown }) {
  m.updatedAt = nowIso();
  m.checkpoints++;
  const store = await getStorage();
  await store.transaction(companyId, async (tx) => {
    await tx.put(COL, m.id, m);
    if (audit) await appendAuditTx(tx, { ...audit, data: { missionId: m.id, ...(audit.data as object | undefined) } });
  });
}

export async function createMission(companyId: string, runtime: PackRuntime, procedureId: string, input: Record<string, unknown>, actor: string): Promise<Mission> {
  const procedure = runtime.manifest.procedures.find((p) => p.id === procedureId);
  if (!procedure) throw new MissionError("Procédure inconnue pour ce pack.");
  const m = planMission(runtime, procedure, input, actor);
  await save(companyId, m, { actor, action: "mission.planifiee", summary: `Mission « ${m.title} » planifiée (${m.steps.length} étapes, plafond ${m.contract.tokenBudget} jetons)` });
  return m;
}

export async function getMission(companyId: string, id: string): Promise<Mission | null> {
  const store = await getStorage();
  return store.read(companyId, (tx) => tx.get<Mission>(COL, id));
}
export async function listMissions(companyId: string): Promise<Mission[]> {
  const store = await getStorage();
  return (await store.read(companyId, (tx) => tx.list<Mission>(COL))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function verifyStep(runtime: PackRuntime, step: MissionStep, ctx: ActionCtx): Promise<Evidence[]> {
  const out: Evidence[] = [];
  for (const c of step.criteria) {
    const v = runtime.verifiers[c.verifier] ?? CORE_VERIFIERS[c.verifier];
    if (!v) {
      out.push({ label: c.label, kind: "verification", ok: false, detail: `vérificateur « ${c.verifier} » introuvable` });
      continue;
    }
    try {
      const ev = await v(step.output, c.params ?? {}, ctx);
      out.push(...ev.map((e) => ({ ...e, label: e.label || c.label })));
    } catch (error) {
      out.push({ label: c.label, kind: "verification", ok: false, detail: `erreur du vérificateur : ${(error as Error).message}` });
    }
  }
  return out;
}

export type RunOptions = { actor?: string; maxSteps?: number };

/** Boucle principale. Reprend là où l'état persisté s'est arrêté. */
export async function runMission(companyId: string, runtime: PackRuntime, missionId: string, opts: RunOptions = {}): Promise<Mission> {
  const m = await getMission(companyId, missionId);
  if (!m) throw new MissionError("Mission introuvable.");
  if (m.status === "terminee" || m.status === "abandonnee" || m.status === "attente_humain") return m;
  const actor = opts.actor ?? "moteur";
  const ctx: ActionCtx = { companyId, missionId, actor, executor: await getExecutor(), docs: [] };
  let budget = opts.maxSteps ?? Infinity;

  for (const step of m.steps) {
    if (step.status === "reussie" || step.status === "sautee" || step.status === "abandonnee") {
      continue;
    }
    if (budget-- <= 0) return m; // pause volontaire (reprise ultérieure)

    // Approbation en attente : on regarde si l'humain a décidé.
    if (step.status === "attente_approbation" && step.approvalId) {
      const a = (await getApproval(companyId, step.approvalId)) as EngineApproval | null;
      if (!a || a.status === "en_attente") {
        m.status = "attente_approbation";
        return m;
      }
      if (a.status === "refusee") {
        step.status = "abandonnee";
        step.evidence.push({ label: "Approbation", kind: "approbation", ok: false, detail: `refusée par ${a.decidedBy}${a.note ? ` : ${a.note}` : ""}` });
        await save(companyId, m, { actor: a.decidedBy ?? actor, action: "mission.etape_refusee", summary: `${step.title} : action refusée`, data: { stepId: step.id } });
        continue;
      }
      step.status = "reussie";
      step.finishedAt = nowIso();
      step.evidence.push({
        label: "Approbation",
        kind: "approbation",
        ok: true,
        detail: `approuvée par ${a.decidedBy} — empreinte ${a.approvedHash?.slice(0, 16)}… — ${a.execution === "humaine" ? "exécution par un humain (le moteur n'effectue aucun dépôt ni paiement)" : "exécution simulée (aucun envoi réel)"}`,
      });
      m.outputs[step.id] = { approvalId: a.id, execution: a.execution, contentHash: a.contentHash };
      await save(companyId, m, { actor: a.decidedBy ?? actor, action: "mission.etape_approuvee", summary: `${step.title} : approuvée (${a.execution})`, data: { stepId: step.id, approvalId: a.id } });
      continue;
    }

    if (step.when && !truthy(resolveRefs(step.when, m))) {
      step.status = "sautee";
      step.evidence.push({ label: "Condition", kind: "info", ok: true, detail: "étape non nécessaire pour cette mission" });
      await save(companyId, m);
      continue;
    }

    const action = runtime.actions[step.action];
    if (!action) throw new MissionError(`Action « ${step.action} » absente du pack ${runtime.manifest.id}.`);
    const input = resolveRefs(step.input ?? {}, m) as Record<string, unknown>;

    // Actions à risque : aperçu exact → file d'approbation, rien n'est exécuté.
    if (step.risk === "envoyer" || step.risk === "payer_deposer") {
      const preview = action.preview ? await action.preview(input, ctx) : { title: step.title, lines: [step.title], payload: input };
      const a = await requestApproval(companyId, { level: step.risk, action: step.action, title: preview.title, lines: preview.lines, payload: preview.payload, requestedBy: actor, missionId: m.id });
      step.status = "attente_approbation";
      step.approvalId = a.id;
      step.evidence.push({ label: "Aperçu soumis à approbation", kind: "approbation", ok: true, detail: `${preview.title} — empreinte ${a.contentHash.slice(0, 16)}…` });
      m.status = "attente_approbation";
      m.phase = "agir";
      await save(companyId, m, { actor, action: "mission.attente_approbation", summary: `${step.title} : en attente d'approbation [${step.risk}]`, data: { stepId: step.id, approvalId: a.id } });
      return m;
    }

    while (step.attempts < step.maxAttempts) {
      // Point de reprise AVANT d'agir : une coupure ici laisse l'étape « en_cours », reprise au prochain appel.
      step.status = "en_cours";
      step.attempts++;
      step.startedAt = nowIso();
      m.status = "en_cours";
      m.phase = "agir";
      await save(companyId, m);

      try {
        const res = await action.run(input, ctx);
        if (res.docs) ctx.docs.push(...res.docs);
        step.output = res.output;
        step.summary = res.summary;
        step.error = undefined;
        m.tokensUsed += res.tokens ?? 0;
      } catch (error) {
        step.error = (error as Error).message;
        step.evidence = [{ label: "Exécution", kind: "verification", ok: false, detail: `essai ${step.attempts}/${step.maxAttempts} : ${step.error}` }];
        await save(companyId, m, { actor, action: "mission.etape_erreur", summary: `${step.title} : erreur (essai ${step.attempts})`, data: { stepId: step.id } });
        continue;
      }
      if (m.tokensUsed > m.contract.tokenBudget) {
        step.status = "attente_humain";
        m.status = "attente_humain";
        m.escalation = { stepId: step.id, reason: `plafond de coût dépassé (${m.tokensUsed} / ${m.contract.tokenBudget} jetons)` };
        await save(companyId, m, { actor, action: "mission.escalade", summary: `Plafond de jetons dépassé à « ${step.title} »`, data: { stepId: step.id } });
        return m;
      }

      m.phase = "verifier";
      step.evidence = await verifyStep(runtime, step, ctx);
      const ok = step.evidence.every((e) => e.ok);
      if (ok) {
        step.status = "reussie";
        step.finishedAt = nowIso();
        m.outputs[step.id] = step.output;
        await save(companyId, m, { actor, action: "mission.etape_reussie", summary: `${step.title} : critères vérifiés (${step.evidence.length} preuve(s))`, data: { stepId: step.id } });
        break;
      }
      await save(companyId, m, { actor, action: "mission.etape_echec", summary: `${step.title} : critère(s) non satisfait(s) (essai ${step.attempts}/${step.maxAttempts})`, data: { stepId: step.id } });
    }

    if (step.status !== "reussie") {
      step.status = "attente_humain";
      m.status = "attente_humain";
      const failed = step.evidence.filter((e) => !e.ok).map((e) => `${e.label} : ${e.detail}`);
      m.escalation = { stepId: step.id, reason: failed.join(" ; ") || step.error || "critères non satisfaits" };
      await save(companyId, m, { actor, action: "mission.escalade", summary: `« ${step.title} » remonte à l'humain après ${step.attempts} essai(s)`, data: { stepId: step.id } });
      return m;
    }
  }

  // PRÉSENTER
  m.phase = "presenter";
  m.status = "terminee";
  const evidence = m.steps.flatMap((s) => s.evidence);
  m.report = {
    summary: `${m.steps.filter((s) => s.status === "reussie").length}/${m.steps.length} étapes réussies, ${evidence.filter((e) => e.ok).length} preuve(s) vérifiée(s), ${evidence.filter((e) => e.warning).length} alerte(s).`,
    deliverables: m.contract.deliverables.map((d, i) => {
      const s = m.steps[i];
      return { label: d, ok: s ? s.status === "reussie" : true, detail: s ? s.summary ?? s.status : "" };
    }),
    evidence: evidence.length,
    humanActions: m.steps.filter((s) => s.risk === "payer_deposer").map((s) => `${s.title} — à faire par un humain`),
  };
  await save(companyId, m, { actor, action: "mission.terminee", summary: `Mission « ${m.title} » terminée : ${m.report.summary}` });
  return m;
}

/** Décision humaine sur une étape remontée : réessayer (essais remis à zéro, entrée éventuellement corrigée), valider manuellement, abandonner. */
export async function resolveEscalation(companyId: string, missionId: string, input: { stepId: string; decision: "reessayer" | "valider" | "abandonner"; by: string; note?: string; patchInput?: Record<string, unknown> }): Promise<Mission> {
  const m = await getMission(companyId, missionId);
  if (!m) throw new MissionError("Mission introuvable.");
  const step = m.steps.find((s) => s.id === input.stepId);
  if (!step || step.status !== "attente_humain") throw new MissionError("Cette étape n'attend pas de décision humaine.");
  if (input.decision === "reessayer") {
    step.status = "a_faire";
    step.attempts = 0;
    if (input.patchInput) m.input = { ...m.input, ...input.patchInput };
    m.status = "en_cours";
  } else if (input.decision === "valider") {
    step.status = "reussie";
    step.manual = true;
    step.finishedAt = nowIso();
    step.evidence.push({ label: "Validation humaine", kind: "approbation", ok: true, detail: `validée manuellement par ${input.by}${input.note ? ` : ${input.note}` : ""} (les écarts restent visibles ci-dessus)` });
    m.outputs[step.id] = step.output;
    m.status = "en_cours";
  } else {
    step.status = "abandonnee";
    m.status = "abandonnee";
  }
  m.escalation = undefined;
  await save(companyId, m, { actor: input.by, action: `mission.humain_${input.decision}`, summary: `« ${step.title} » : ${input.decision}${input.note ? ` (${input.note})` : ""}`, data: { stepId: step.id } });
  return m;
}
