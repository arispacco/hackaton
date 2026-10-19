"use client";

import { useCallback, useEffect, useState } from "react";
import type { TabProps } from "@/components/workspace/Tabs";
import { api, Badge, Card, Empty, ExampleBadge, fmtDate, Markdown } from "@/components/workspace/ui";
import type { Mission, MissionStep } from "@/lib/engine/missions";
import type { EngineApproval } from "@/lib/engine/approvals";
import { ApprovalCard, AuditCard, errMsg, EvidenceList, LEVEL_LABEL } from "./shared";

type PackRow = { id: string; name: string; status: string; procedures: { id: string; title: string }[] };
type Fixture = { id: string; title: string; origin: string; kind: "dao" | "bpu"; verifiedAt: string | null };

const MSTATUS: Record<Mission["status"], { label: string; tone: "neutral" | "accent" | "green" | "amber" | "rose" }> = {
  planifiee: { label: "Planifiée", tone: "neutral" },
  en_cours: { label: "En cours", tone: "accent" },
  attente_humain: { label: "Attend votre décision", tone: "amber" },
  attente_approbation: { label: "Attend une approbation", tone: "amber" },
  terminee: { label: "Terminée", tone: "green" },
  abandonnee: { label: "Abandonnée", tone: "rose" },
};
const SSTATUS: Record<MissionStep["status"], string> = { a_faire: "À faire", en_cours: "En cours", reussie: "Réussie", sautee: "Sans objet", attente_humain: "Attend votre décision", attente_approbation: "Attend une approbation", abandonnee: "Abandonnée" };
const stepClass = (s: MissionStep) => (s.status === "reussie" ? "is-ok" : s.status.startsWith("attente") ? "is-wait" : s.status === "abandonnee" ? "is-ko" : "");

/** Onglet « Missions » : plan, preuves, décisions humaines, file d'approbation et journal d'audit. */
export default function MissionsPanel({ snap, notify }: TabProps) {
  const companyId = snap.company.id;
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [approvals, setApprovals] = useState<EngineApproval[]>([]);
  const [packs, setPacks] = useState<PackRow[]>([]);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [launch, setLaunch] = useState({ packId: "appels-offres-cm", fixture: "", texte: "", bpuExample: true });

  const load = useCallback(async () => {
    try {
      const [m, a] = await Promise.all([api<{ missions: Mission[] }>(`/api/engine/missions?companyId=${companyId}`), api<{ approvals: EngineApproval[] }>(`/api/engine/approvals?companyId=${companyId}`)]);
      setMissions(m.missions);
      setApprovals(a.approvals);
      setSel((s) => s ?? m.missions[0]?.id ?? null);
    } catch (e) {
      notify(errMsg(e), "error");
    }
  }, [companyId, notify]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    api<{ packs: PackRow[] }>(`/api/engine/packs?companyId=${companyId}`).then((r) => setPacks(r.packs.filter((p) => p.status === "valide"))).catch(() => {});
    api<{ fixtures: Fixture[] }>(`/api/packs/appels-offres-cm?companyId=${companyId}`).then((r) => { setFixtures(r.fixtures); setLaunch((l) => ({ ...l, fixture: l.fixture || r.fixtures.find((f) => f.kind === "dao")?.id || "" })); }).catch(() => {});
  }, [companyId]);

  async function run<T>(fn: () => Promise<T>, ok?: string) {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) notify(ok, "success");
      await load();
      setVersion((v) => v + 1);
      return r;
    } catch (e) {
      notify(errMsg(e), "error");
      return null;
    } finally {
      setBusy(false);
    }
  }
  const decide = (a: EngineApproval, decision: "approuver" | "refuser") =>
    run(() => api("/api/engine/approvals", "POST", { companyId, id: a.id, decision, contentHash: a.contentHash }), decision === "approuver" ? "Approuvé (empreinte vérifiée)" : "Refusé");

  if (!missions) return <Empty>Chargement des missions…</Empty>;
  const pending = approvals.filter((a) => a.status === "en_attente");
  const mission = missions.find((m) => m.id === sel) ?? null;
  const isAo = launch.packId === "appels-offres-cm";
  const daoFx = fixtures.filter((f) => f.kind === "dao");
  const bpuFx = fixtures.find((f) => f.kind === "bpu");

  return (
    <div className="ws-stack">
      <div className="ws-info">
        <strong>Missions</strong> — chaque mission suit un contrat (livrables, hors périmètre, actions externes, plafond de coût) et la boucle planifier → agir → vérifier → présenter. Vous voyez le plan et les preuves ; les actions externes attendent votre approbation.
        {pending.length > 0 && <Badge tone="amber">{pending.length} approbation(s) en attente</Badge>}
      </div>

      {pending.length > 0 && (
        <Card title="File d'approbation">
          {pending.map((a) => <ApprovalCard key={a.id} a={a} busy={busy} onDecide={decide} />)}
        </Card>
      )}

      <Card title="Nouvelle mission">
        <div className="st-form">
          <label>Pack<select value={launch.packId} onChange={(e) => setLaunch({ ...launch, packId: e.target.value })}>{packs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          {isAo && <label>DAO / avis<select value={launch.fixture} onChange={(e) => setLaunch({ ...launch, fixture: e.target.value })}>{daoFx.map((f) => <option key={f.id} value={f.id}>Avis public : {f.title}</option>)}<option value="">Coller le texte…</option></select></label>}
          {isAo && bpuFx && <label><input type="checkbox" checked={launch.bpuExample} onChange={(e) => setLaunch({ ...launch, bpuExample: e.target.checked })} /> Joindre le bordereau d'exemple (chiffres fictifs)</label>}
        </div>
        {(!isAo || !launch.fixture) && <textarea className="pk-textarea" value={launch.texte} onChange={(e) => setLaunch({ ...launch, texte: e.target.value })} placeholder={isAo ? "Texte intégral du DAO ou de l'avis (200 caractères minimum)" : "Décrivez la demande à traiter"} />}
        <button className="ws-btn ws-btn-primary" disabled={busy || !packs.length} onClick={async () => {
          const p = packs.find((x) => x.id === launch.packId);
          const r = await run(() => api<{ mission: Mission }>("/api/engine/missions", "POST", {
            companyId, packId: launch.packId, procedureId: p?.procedures[0]?.id,
            ...(isAo ? { fixture: launch.fixture || undefined, bpuFixture: launch.bpuExample && bpuFx ? bpuFx.id : undefined, input: launch.fixture ? {} : { texte: launch.texte } } : { input: { demande: launch.texte, texte: launch.texte } }),
          }), "Mission lancée");
          if (r) setSel(r.mission.id);
        }}>Planifier et lancer</button>
      </Card>

      <div className="ws-split">
        <Card title="Missions">
          {missions.length ? (
            <div className="pk-list">{missions.map((m) => (
              <button key={m.id} className="pk-item" aria-current={sel === m.id} onClick={() => setSel(m.id)}>
                <strong>{m.title}</strong>
                <div><Badge tone={MSTATUS[m.status].tone}>{MSTATUS[m.status].label}</Badge> <span className="ws-muted">{fmtDate(m.createdAt, true)}</span></div>
              </button>
            ))}</div>
          ) : <Empty>Aucune mission pour l'instant.</Empty>}
        </Card>
        {mission ? <MissionView m={mission} approvals={approvals.filter((a) => a.missionId === mission.id)} busy={busy} decide={decide}
          resume={() => run(() => api(`/api/engine/missions/${mission.id}`, "POST", { companyId, op: "reprendre" }), "Mission reprise")}
          humanDecision={(stepId, decision) => run(() => api(`/api/engine/missions/${mission.id}`, "POST", { companyId, op: "decider", stepId, decision }), "Décision enregistrée")} />
          : <Empty>Sélectionnez une mission.</Empty>}
      </div>

      <AuditCard companyId={companyId} notify={notify} version={version} />
    </div>
  );
}

function MissionView({ m, approvals, busy, decide, resume, humanDecision }: { m: Mission; approvals: EngineApproval[]; busy: boolean; decide: (a: EngineApproval, d: "approuver" | "refuser") => void; resume: () => void; humanDecision: (stepId: string, d: "reessayer" | "valider" | "abandonner") => void }) {
  const byId = new Map(approvals.map((a) => [a.id, a]));
  const pct = Math.min(100, Math.round((m.tokensUsed / Math.max(1, m.contract.tokenBudget)) * 100));
  const usesExample = m.input && typeof m.input.bpu === "object" && (m.input.bpu as { isExample?: boolean }).isExample;
  return (
    <div className="ws-stack">
      <Card title={m.title} actions={<><Badge tone={MSTATUS[m.status].tone}>{MSTATUS[m.status].label}</Badge>{(m.status === "en_cours" || m.status === "planifiee") && <button className="ws-btn ws-btn-sm" disabled={busy} onClick={resume}>Reprendre</button>}</>}>
        <div className="ws-grid">
          <div><strong>Livrables</strong><ul>{m.contract.deliverables.map((d) => <li key={d}>{d}</li>)}</ul></div>
          <div><strong>Hors périmètre</strong><ul>{m.contract.outOfScope.map((d) => <li key={d}>{d}</li>)}</ul></div>
          <div>
            <strong>Actions externes prévues</strong>
            {m.contract.externalActions.length ? <ul>{m.contract.externalActions.map((a) => <li key={a.step}>{a.description} <Badge tone={LEVEL_LABEL[a.level]?.tone}>{LEVEL_LABEL[a.level]?.label ?? a.level}</Badge></li>)}</ul> : <div className="ws-muted">aucune</div>}
            <strong>Coût</strong><div className="ws-muted">{m.tokensUsed.toLocaleString("fr-FR")} / {m.contract.tokenBudget.toLocaleString("fr-FR")} jetons ({pct} %)</div>
          </div>
        </div>
        {usesExample && <div><ExampleBadge /> <span className="ws-muted">Cette mission utilise le bordereau d'exemple (chiffres fictifs).</span></div>}
        <div className="ws-muted">Point de reprise n° {m.checkpoints} — l'état est enregistré avant chaque action : après une coupure, la mission reprend à l'étape en cours.</div>
      </Card>

      {m.escalation && m.status === "attente_humain" && (
        <Card title="Votre décision est nécessaire">
          <p>{m.escalation.reason}</p>
          <div className="pk-actions">
            <button className="ws-btn ws-btn-sm ws-btn-primary" disabled={busy} onClick={() => humanDecision(m.escalation!.stepId, "reessayer")}>Réessayer (après avoir complété)</button>
            <button className="ws-btn ws-btn-sm" disabled={busy} onClick={() => humanDecision(m.escalation!.stepId, "valider")}>Valider quand même (les écarts restent visibles)</button>
            <button className="ws-btn ws-btn-sm" disabled={busy} onClick={() => humanDecision(m.escalation!.stepId, "abandonner")}>Abandonner la mission</button>
          </div>
        </Card>
      )}

      <Card title="Plan et preuves">
        <ol className="pk-steps">
          {m.steps.map((s) => {
            const a = s.approvalId ? byId.get(s.approvalId) : undefined;
            const md = s.output && typeof s.output === "object" ? (s.output as { markdown?: string; dossier?: { markdown?: string } }) : null;
            const text = md?.markdown ?? md?.dossier?.markdown;
            return (
              <li key={s.id} className={`pk-step ${stepClass(s)}`}>
                <div><strong>{s.title}</strong> <Badge>{SSTATUS[s.status]}</Badge> {s.attempts > 0 && <span className="ws-muted">essai {s.attempts}/{s.maxAttempts}</span>} {s.manual && <Badge tone="amber">Validée manuellement</Badge>}</div>
                {s.summary && <div className="ws-muted">{s.summary}</div>}
                {s.error && <div className="ws-muted">⚠️ {s.error}</div>}
                {s.criteria.length > 0 && <div className="ws-muted">Critères : {s.criteria.map((c) => c.label).join(" · ")}</div>}
                <EvidenceList items={s.evidence} />
                {a && <ApprovalCard a={a} busy={busy} onDecide={decide} />}
                {text && <details><summary className="ws-muted">Voir le livrable de l'étape</summary><Markdown text={text} /></details>}
              </li>
            );
          })}
        </ol>
      </Card>

      {m.report && (
        <Card title="Présentation des résultats">
          <p>{m.report.summary}</p>
          <ul>{m.report.deliverables.map((d) => <li key={d.label}>{d.ok ? "✅" : "⚠️"} {d.label} <span className="ws-muted">— {d.detail}</span></li>)}</ul>
          {m.report.humanActions.length > 0 && <><strong>Reste à faire par un humain</strong><ul>{m.report.humanActions.map((h) => <li key={h}>{h}</li>)}</ul></>}
          <div className="ws-muted">{m.report.evidence} preuve(s) au total.</div>
        </Card>
      )}
    </div>
  );
}
