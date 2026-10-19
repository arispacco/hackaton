"use client";

import { useCallback, useEffect, useState } from "react";
import type { TabProps } from "@/components/workspace/Tabs";
import { api, Badge, Card, Empty, ExampleBadge, Markdown } from "@/components/workspace/ui";
import type { PackManifest, EvalOutcome } from "@/lib/engine/packs/types";
import type { CoverageMap } from "@/lib/engine/coverage";
import { AuditCard, errMsg, LEVEL_LABEL } from "./shared";

type PackRow = { id: string; name: string; version: string; status: PackManifest["status"]; description: string; audience: string[]; builtin: boolean; procedures: { id: string; title: string }[]; errors: string[] };
type Registry = { packs: PackRow[]; storage: { kind: string; durable: boolean; note: string }; executor: { requested: string; active: string }; riskLevels: { id: string; label: string; human: boolean; description: string }[] };
type Detail = { manifest: PackManifest; builtin: boolean; errors: string[]; coverage: CoverageMap; templates: { id: string; title: string; description: string; content: string }[]; hasEvaluation: boolean };

const COV: Record<string, { label: string; tone: "green" | "amber" | "rose" }> = {
  couvert: { label: "Couvert", tone: "green" },
  mentionne_seulement: { label: "Mentionné seulement — texte absent, jamais cité", tone: "amber" },
  absent: { label: "Absent", tone: "rose" },
};

/** Onglet « Packs métier » : registre, manifeste lisible, couverture du corpus, évaluation, générateur. */
export default function PacksPanel({ snap, notify, goTo }: TabProps) {
  const companyId = snap.company.id;
  const [reg, setReg] = useState<Registry | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [desc, setDesc] = useState("");
  const [evals, setEvals] = useState<EvalOutcome[] | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await api<Registry>(`/api/engine/packs?companyId=${companyId}`);
      setReg(r);
      setSel((s) => s ?? r.packs[0]?.id ?? null);
    } catch (e) {
      notify(errMsg(e), "error");
    }
  }, [companyId, notify]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!sel) return;
    setDetail(null);
    setEvals(null);
    api<Detail>(`/api/engine/packs/${encodeURIComponent(sel)}?companyId=${companyId}`).then(setDetail).catch((e) => notify(errMsg(e), "error"));
  }, [sel, companyId, notify]);

  async function run<T>(fn: () => Promise<T>, ok?: string) {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) notify(ok, "success");
      setVersion((v) => v + 1);
      return r;
    } catch (e) {
      notify(errMsg(e), "error");
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (!reg) return <Empty>Chargement des packs…</Empty>;
  return (
    <div className="ws-stack">
      <div className="ws-info">
        <strong>Packs métier</strong> — chaque métier est un pack versionné : procédures vérifiables, modèles, sous-corpus, outils autorisés, vérificateurs et jeu d'évaluation.
        <Badge tone={reg.storage.durable ? "green" : "amber"} title={reg.storage.note}>Stockage : {reg.storage.kind === "postgres" ? "Postgres" : "fichiers JSON (repli)"}</Badge>
        <Badge title="Les calculs (bordereaux, totaux) sont refaits par un exécuteur isolé, jamais « de tête ».">Calculs : {reg.executor.active.startsWith("local") ? "exécuteur local limité" : "Vercel Sandbox"}</Badge>
      </div>
      {!reg.storage.durable && <div className="ws-muted">⚠️ {reg.storage.note}</div>}

      <div className="ws-split">
        <Card title="Registre">
          <div className="pk-list">
            {reg.packs.map((p) => (
              <button key={p.id} className="pk-item" aria-current={sel === p.id} onClick={() => setSel(p.id)}>
                <strong>{p.name}</strong> <span className="ws-muted">v{p.version}</span>
                <div>{p.status === "valide" ? <Badge tone="green">Validé</Badge> : <Badge tone="amber">À valider</Badge>} {p.builtin ? <Badge>Intégré</Badge> : <Badge tone="violet">Brouillon de l'entreprise</Badge>}</div>
              </button>
            ))}
          </div>
        </Card>

        <div className="ws-stack">
          {!detail ? <Empty>Chargement du pack…</Empty> : <PackDetail d={detail} busy={busy} evals={evals}
            onEval={async () => { const r = await run(() => api<{ outcomes: EvalOutcome[]; note?: string }>(`/api/engine/packs/${encodeURIComponent(detail.manifest.id)}`, "POST", { companyId, op: "evaluer" })); if (r) { setEvals(r.outcomes); if (r.note) notify(r.note, "info"); } }}
            onValidate={async () => { const r = await run(() => api(`/api/engine/packs`, "PATCH", { companyId, id: detail.manifest.id }), "Pack validé"); if (r) { await load(); setSel(null); setTimeout(() => setSel(detail.manifest.id), 0); } }}
            onLaunch={() => goTo("missions")} onOpenAo={() => goTo("ao")} />}
        </div>
      </div>

      <Card title="Créer un pack à partir d'une description">
        <p className="ws-muted">Décrivez votre métier en langage courant. Le moteur prépare un BROUILLON de pack « à valider » : procédure type, outils autorisés, besoins de corpus et ce qui manque. Rien n'est inventé : les textes absents du corpus sont signalés comme manquants.</p>
        <textarea className="pk-textarea" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ex. : Je gère une petite entreprise de transport de marchandises entre Douala et Yaoundé ; je veux préparer mes devis, suivre les documents des camions et répondre aux demandes des clients." maxLength={2000} />
        <div className="pk-actions">
          <button className="ws-btn ws-btn-primary" disabled={busy || desc.trim().length < 20} onClick={async () => { const r = await run(() => api<{ manifest: PackManifest }>(`/api/engine/packs`, "POST", { companyId, description: desc }), "Brouillon de pack créé — à valider"); if (r) { setDesc(""); await load(); setSel(r.manifest.id); } }}>Générer le brouillon</button>
        </div>
      </Card>

      <Card title="Niveaux de risque et approbations">
        <table className="ws-table">
          <thead><tr><th>Niveau</th><th>Approbation</th><th>Ce que cela couvre</th></tr></thead>
          <tbody>{reg.riskLevels.map((r) => <tr key={r.id}><td><Badge tone={LEVEL_LABEL[r.id]?.tone}>{r.label}</Badge></td><td>{r.human ? "Humaine, sur l'aperçu exact" : "Automatique (tracée)"}</td><td>{r.description}</td></tr>)}</tbody>
        </table>
      </Card>
      <AuditCard companyId={companyId} notify={notify} version={version} />
    </div>
  );
}

function PackDetail({ d, busy, evals, onEval, onValidate, onLaunch, onOpenAo }: { d: Detail; busy: boolean; evals: EvalOutcome[] | null; onEval: () => void; onValidate: () => void; onLaunch: () => void; onOpenAo: () => void }) {
  const m = d.manifest;
  const [tpl, setTpl] = useState<string | null>(null);
  const t = d.templates.find((x) => x.id === tpl);
  return (
    <>
      <Card title={<>{m.name} <span className="ws-muted">v{m.version}</span></>} actions={<>
        {m.status === "valide" ? <Badge tone="green">Validé</Badge> : <Badge tone="amber">Brouillon à valider</Badge>}
        {m.id === "appels-offres-cm" && <button className="ws-btn ws-btn-sm" onClick={onOpenAo}>Ouvrir l'outil</button>}
        {m.status === "valide" && <button className="ws-btn ws-btn-sm ws-btn-primary" onClick={onLaunch}>Lancer une mission</button>}
      </>}>
        <p>{m.description}</p>
        {m.audience.length > 0 && <div className="ws-muted">Pour : {m.audience.join(", ")}</div>}
        {m.generatedFrom && <div className="ws-muted">Généré à partir de : « {m.generatedFrom} »</div>}
        {d.errors.length > 0 && <div className="ws-muted">⚠️ Points à corriger avant validation : {d.errors.join(" ; ")}</div>}
        {!d.builtin && m.status !== "valide" && (
          <div className="pk-actions">
            <button className="ws-btn ws-btn-primary" disabled={busy || d.errors.length > 0} onClick={onValidate}>J'ai relu ce pack : le valider</button>
            <span className="ws-muted">La validation est une décision humaine, tracée dans le journal d'audit.</span>
          </div>
        )}
      </Card>

      {m.procedures.map((p) => (
        <Card key={p.id} title={`Procédure : ${p.title}`}>
          <p className="ws-muted">{p.description}</p>
          <ol className="pk-steps">
            {p.steps.map((s) => (
              <li key={s.id} className="pk-step">
                <strong>{s.title}</strong> {s.risk && s.risk !== "lire" && <Badge tone={LEVEL_LABEL[s.risk]?.tone}>Risque : {LEVEL_LABEL[s.risk]?.label}</Badge>} {s.when && <Badge>Si nécessaire</Badge>}
                {s.criteria.length > 0 && <ul>{s.criteria.map((c) => <li key={c.id} className="ws-muted">Critère vérifié : {c.label}</li>)}</ul>}
                {(s.risk === "envoyer" || s.risk === "payer_deposer") && <div className="ws-muted">Passe par la file d'approbation (aperçu exact + empreinte).</div>}
              </li>
            ))}
          </ol>
          <div className="ws-grid">
            <div><strong>Livrables</strong><ul>{p.deliverables.map((x) => <li key={x}>{x}</li>)}</ul></div>
            <div><strong>Hors périmètre</strong><ul>{p.outOfScope.map((x) => <li key={x}>{x}</li>)}</ul></div>
            <div><strong>Plafond de coût</strong><div className="ws-muted">{p.tokenBudget.toLocaleString("fr-FR")} jetons maximum par mission</div>{m.humanOnly?.length ? <><strong>Toujours humain</strong><ul>{m.humanOnly.map((x) => <li key={x}>{x}</li>)}</ul></> : null}</div>
          </div>
        </Card>
      ))}

      <Card title="Couverture du corpus" actions={<span className="ws-muted">{d.coverage.totals.documents} textes · {d.coverage.totals.pages} pages</span>}>
        {d.coverage.needs.length ? (
          <table className="ws-table">
            <thead><tr><th>Besoin du pack</th><th>État</th><th>Textes</th></tr></thead>
            <tbody>{d.coverage.needs.map((n) => (
              <tr key={n.id}>
                <td>{n.label}{n.why && <div className="ws-muted">{n.why}</div>}</td>
                <td><Badge tone={COV[n.status].tone}>{COV[n.status].label}</Badge></td>
                <td className="ws-muted">{n.documents.length ? n.documents.slice(0, 3).join(" · ") : n.mentionedIn.length ? `cité dans : ${n.mentionedIn.slice(0, 3).join(" · ")}` : "—"}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>Ce pack ne déclare pas de besoins de corpus.</Empty>}
        <details><summary className="ws-muted">Ce que contient le corpus ({d.coverage.categories.length} catégories)</summary>
          <ul>{d.coverage.categories.map((c) => <li key={c.category}><strong>{c.category}</strong> — {c.documents} texte(s), {c.pages} page(s)</li>)}</ul>
        </details>
      </Card>

      {(m.fixtures?.length ?? 0) > 0 && (
        <Card title="Données de test">
          <table className="ws-table"><thead><tr><th>Donnée</th><th>Origine</th><th>Vérifiée le</th></tr></thead>
            <tbody>{m.fixtures!.map((f) => <tr key={f.id}><td>{f.title}</td><td>{f.origin === "exemple" ? <ExampleBadge /> : f.source ? <a href={f.source} target="_blank" rel="noreferrer">Source publique</a> : "Source publique"}</td><td>{f.verifiedAt ?? "—"}</td></tr>)}</tbody>
          </table>
          {m.notes?.length ? <ul className="ws-muted">{m.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
        </Card>
      )}

      {d.templates.length > 0 && (
        <Card title="Modèles de documents">
          <div className="pk-actions">{d.templates.map((x) => <button key={x.id} className={`ws-btn ws-btn-sm ${tpl === x.id ? "ws-btn-primary" : ""}`} onClick={() => setTpl(tpl === x.id ? null : x.id)}>{x.title}</button>)}</div>
          {t && (t.content ? <Markdown text={t.content} /> : <div className="ws-muted">{t.description} (modèle à rédiger lors de la validation du brouillon)</div>)}
        </Card>
      )}

      <Card title="Évaluation" actions={<button className="ws-btn ws-btn-sm" disabled={busy || !d.hasEvaluation} onClick={onEval}>Lancer le jeu d'évaluation</button>}>
        {!d.hasEvaluation && <div className="ws-muted">Pas encore de jeu d'évaluation exécutable pour ce pack.</div>}
        {evals && (evals.length ? (
          <>
            <div><Badge tone={evals.every((e) => e.ok) ? "green" : "rose"}>{evals.filter((e) => e.ok).length}/{evals.length} cas réussis</Badge></div>
            {evals.map((e) => <div key={e.id}><strong>{e.ok ? "✅" : "❌"} {e.id}</strong><ul className="pk-evidence">{e.checks.map((c, i) => <li key={i}>{c.ok ? "✅" : "❌"} {c.label} <span className="ws-muted">— {c.detail}</span></li>)}</ul></div>)}
          </>
        ) : <Empty>Aucun cas.</Empty>)}
      </Card>
    </>
  );
}
