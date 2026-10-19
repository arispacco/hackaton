"use client";

import { useCallback, useEffect, useState } from "react";
import { api, Badge, Card, Empty, fmtDate } from "@/components/workspace/ui";
import type { EngineApproval } from "@/lib/engine/approvals";
import type { Evidence } from "@/lib/engine/packs/types";
import type { AuditEntry, ChainCheck } from "@/lib/engine/audit";

export type Notify = (text: string, type?: "success" | "error" | "info") => void;
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Erreur");

export const LEVEL_LABEL: Record<string, { label: string; tone: "neutral" | "accent" | "amber" | "rose" }> = {
  lire: { label: "Lire", tone: "neutral" },
  brouillon: { label: "Brouillon", tone: "accent" },
  envoyer: { label: "Envoyer", tone: "amber" },
  payer_deposer: { label: "Payer / déposer", tone: "rose" },
};

export const cleanQuote = (q: string) => q.replace(/[\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").trim();

export function short(hash?: string) {
  return hash ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : "—";
}

export function EvidenceList({ items }: { items: Evidence[] }) {
  if (!items.length) return <div className="ws-muted">Aucune preuve pour l'instant.</div>;
  const icon = (e: Evidence) => (e.warning ? "⚠️" : e.ok ? "✅" : "❌");
  const cites = items.filter((e) => e.kind === "citation");
  const others = items.filter((e) => e.kind !== "citation");
  const okCites = cites.filter((e) => e.ok).length;
  return (
    <ul className="pk-evidence">
      {others.map((e, i) => (
        <li key={i}>
          <span aria-hidden>{icon(e)}</span> <strong>{e.label}</strong> <span className="ws-muted">— {e.detail}</span>
        </li>
      ))}
      {cites.length > 0 && (
        <li>
          <details>
            <summary><span aria-hidden>{okCites === cites.length ? "✅" : "❌"}</span> <strong>Citations vérifiées dans la source</strong> <span className="ws-muted">— {okCites}/{cites.length} résolues (voir le détail)</span></summary>
            <ul className="pk-evidence">{cites.map((e, i) => <li key={i}><span aria-hidden>{icon(e)}</span> {(e.data as { quote?: string | null } | undefined)?.quote ? <>« {cleanQuote(String((e.data as { quote: string }).quote)).slice(0, 180)} » </> : null}<span className="ws-muted">— {e.detail}</span></li>)}</ul>
          </details>
        </li>
      )}
    </ul>
  );
}

/** Carte d'approbation : niveau de risque, aperçu EXACT, empreinte SHA-256 du contenu approuvé. */
export function ApprovalCard({ a, onDecide, busy }: { a: EngineApproval; onDecide?: (a: EngineApproval, d: "approuver" | "refuser") => void; busy?: boolean }) {
  const lvl = LEVEL_LABEL[a.level] ?? { label: a.level, tone: "neutral" as const };
  const status = a.status === "en_attente" ? <Badge tone="amber">En attente</Badge> : a.status === "approuvee" ? <Badge tone="green">Approuvée</Badge> : a.status === "auto" ? <Badge>Automatique</Badge> : <Badge tone="rose">Refusée</Badge>;
  return (
    <div className="pk-approval">
      <div className="pk-approval-head">
        <strong>{a.preview.title}</strong> <Badge tone={lvl.tone}>Risque : {lvl.label}</Badge> {status}
      </div>
      <pre className="pk-preview">{a.preview.lines.join("\n")}</pre>
      <div className="ws-muted" title={a.contentHash}>
        Empreinte du contenu (SHA-256) : <code>{short(a.contentHash)}</code> · demandée par {a.requestedBy} le {fmtDate(a.requestedAt, true)}
        {a.decidedBy && <> · décidée par {a.decidedBy} le {fmtDate(a.decidedAt, true)}</>}
      </div>
      {a.level === "envoyer" && <div className="ws-muted">Envoi SIMULÉ : rien ne part réellement, aucun contact réel n'est utilisé.</div>}
      {a.level === "payer_deposer" && <div className="ws-muted">Action HUMAINE : l'approbation autorise la personne responsable à la faire elle-même ; Co-founder ne paie et ne dépose rien.</div>}
      {a.status === "en_attente" && onDecide && (
        <div className="pk-actions">
          <button className="ws-btn ws-btn-sm ws-btn-primary" disabled={busy} onClick={() => onDecide(a, "approuver")}>Approuver ce contenu exact</button>
          <button className="ws-btn ws-btn-sm" disabled={busy} onClick={() => onDecide(a, "refuser")}>Refuser</button>
        </div>
      )}
    </div>
  );
}

/** État de la chaîne d'audit (vérifiée côté serveur à chaque affichage). */
export function AuditCard({ companyId, notify, version = 0 }: { companyId: string; notify: Notify; version?: number }) {
  const [st, setSt] = useState<{ check: ChainCheck; total: number; entries: AuditEntry[] } | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => api<{ check: ChainCheck; total: number; entries: AuditEntry[] }>(`/api/engine/audit?companyId=${companyId}`).then(setSt).catch((e) => notify(errMsg(e), "error")), [companyId, notify]);
  useEffect(() => void load(), [load, version]);
  if (!st) return null;
  return (
    <Card
      title="Journal d'audit chaîné"
      actions={<>{st.check.ok ? <Badge tone="green">Chaîne intègre</Badge> : <Badge tone="rose">Chaîne rompue à l'entrée {st.check.brokenAt}</Badge>}<button className="ws-btn ws-btn-sm ws-btn-ghost" onClick={() => setOpen(!open)}>{open ? "Masquer" : "Voir les entrées"}</button></>}
    >
      <div className="ws-muted">
        {st.total} entrée(s). Chaque entrée porte le hash SHA-256 de la précédente : toute modification ou suppression est détectée.
        {st.total > 0 && <> Dernier hash : <code title={st.check.headHash}>{short(st.check.headHash)}</code></>}
        {!st.check.ok && <> — {st.check.reason}</>}
      </div>
      {open && (st.entries.length ? (
        <table className="ws-table">
          <thead><tr><th>#</th><th>Quand</th><th>Qui</th><th>Quoi</th><th>Hash</th></tr></thead>
          <tbody>{st.entries.map((e) => <tr key={e.seq}><td>{e.seq}</td><td>{fmtDate(e.at, true)}</td><td>{e.actor}</td><td>{e.summary}</td><td><code title={e.hash}>{short(e.hash)}</code></td></tr>)}</tbody>
        </table>
      ) : <Empty>Aucune entrée.</Empty>)}
    </Card>
  );
}
