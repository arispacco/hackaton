"use client";

import { useCallback, useEffect, useState } from "react";
import type { TabProps } from "@/components/workspace/Tabs";
import { api, Badge, Card, Empty, ExampleBadge, fmtDate, fmtMoney, Markdown } from "@/components/workspace/ui";
import type { CitationResult } from "@/lib/engine/citations";
import type { DaoSheet } from "@/lib/packs/appels-offres-cm/dao";
import type { Matrix, MatrixRow } from "@/lib/packs/appels-offres-cm/matrix";
import type { BpuInput, BpuResult, BpuRow } from "@/lib/packs/appels-offres-cm/bpu";
import type { VaultAlert, VaultPiece } from "@/lib/packs/appels-offres-cm/vault";
import { cleanQuote, errMsg } from "./shared";

type Fixture = { id: string; title: string; origin: "source_publique" | "exemple"; source: string | null; verifiedAt: string | null; kind: "dao" | "bpu" };
type PieceType = { id: string; label: string; envelope: string };
type State = { fixtures: Fixture[]; pieceTypes: PieceType[]; vault: { pieces: VaultPiece[]; alerts: VaultAlert[] } };
type DaoRead = { sheet: DaoSheet; markdown: string; citations: CitationResult[] };
type MatrixRes = { matrix: Matrix; dossier: { sections: { envelope: string; files: { name: string; requirement: string; status: string }[] }[]; missing: string[]; notes?: string[] } };

const MSTATUS: Record<MatrixRow["status"], { label: string; tone: "green" | "amber" | "rose" | "accent" | "neutral" }> = {
  valide: { label: "Valide", tone: "green" },
  expire_avant_depot: { label: "Expire avant le dépôt", tone: "amber" },
  expiree: { label: "Expirée", tone: "rose" },
  a_rediger: { label: "À rédiger", tone: "accent" },
  manquante: { label: "Manquante", tone: "rose" },
};
const CIT: Record<string, { label: string; tone: "green" | "amber" | "rose" }> = { verifiee: { label: "Vérifiée", tone: "green" }, non_verifiee: { label: "Non vérifiée", tone: "amber" }, bloquee: { label: "Bloquée", tone: "rose" } };
type Section = "dao" | "bpu" | "coffre";

/** Onglet « Appels d'offres (Cameroun) » : lecteur de DAO, matrice de conformité, recalcul du bordereau, coffre-fort. */
export default function AoPanel({ snap, notify, goTo }: TabProps) {
  const companyId = snap.company.id;
  const [st, setSt] = useState<State | null>(null);
  const [section, setSection] = useState<Section>("dao");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<State>(`/api/packs/appels-offres-cm?companyId=${companyId}`).then(setSt).catch((e) => notify(errMsg(e), "error")), [companyId, notify]);
  useEffect(() => void load(), [load]);

  async function run<T>(fn: () => Promise<T>, ok?: string): Promise<T | null> {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) notify(ok, "success");
      return r;
    } catch (e) {
      notify(errMsg(e), "error");
      return null;
    } finally {
      setBusy(false);
    }
  }
  const post = <T,>(body: Record<string, unknown>) => api<T>("/api/packs/appels-offres-cm", "POST", { companyId, ...body });

  if (!st) return <Empty>Chargement du pack Appels d'offres…</Empty>;
  const alertCount = st.vault.alerts.length;
  return (
    <div className="ws-stack">
      <div className="ws-info">
        <strong>Appels d'offres publics — Cameroun</strong> (pack v0.1) — lecture du DAO, pièces exigées, calculs vérifiés, coffre-fort.
        <Badge tone="rose">Dépôt COLEPS : toujours humain</Badge>
        <button className="ws-btn ws-btn-sm" onClick={() => goTo("missions")}>Mission « Préparer une offre »</button>
      </div>
      <div className="st-tabs" role="tablist">
        {([["dao", "Lire un DAO & matrice"], ["bpu", "Recalcul du bordereau"], ["coffre", `Coffre-fort de pièces${alertCount ? ` (${alertCount} alerte${alertCount > 1 ? "s" : ""})` : ""}`]] as [Section, string][]).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={section === id} className={`ws-btn ws-btn-sm ${section === id ? "ws-btn-primary" : ""}`} onClick={() => setSection(id)}>{label}</button>
        ))}
      </div>
      {section === "dao" && <DaoSection st={st} busy={busy} run={run} post={post} companyId={companyId} />}
      {section === "bpu" && <BpuSection st={st} busy={busy} run={run} post={post} />}
      {section === "coffre" && <VaultSection st={st} busy={busy} run={run} companyId={companyId} reload={load} goTo={goTo} />}
    </div>
  );
}

type Run = <T>(fn: () => Promise<T>, ok?: string) => Promise<T | null>;
type Post = <T>(body: Record<string, unknown>) => Promise<T>;

function DaoSection({ st, busy, run, post, companyId }: { st: State; busy: boolean; run: Run; post: Post; companyId: string }) {
  const daos = st.fixtures.filter((f) => f.kind === "dao");
  const [src, setSrc] = useState<string>(daos[0]?.id ?? "texte");
  const [texte, setTexte] = useState("");
  const [read, setRead] = useState<DaoRead | null>(null);
  const [mx, setMx] = useState<MatrixRes | null>(null);
  const fx = daos.find((f) => f.id === src);
  const body = () => (src === "texte" ? { texte } : { fixture: src });

  async function upload(file: File) {
    const fd = new FormData();
    fd.set("companyId", companyId);
    fd.set("file", file);
    const r = await run(async () => {
      const res = await fetch("/api/packs/appels-offres-cm/dao-pdf", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || `Erreur ${res.status}`);
      return data as DaoRead;
    }, "PDF lu");
    if (r) { setRead(r); setMx(null); }
  }

  return (
    <>
      <Card title="1. Le DAO ou l'avis d'appel d'offres">
        <div className="st-form">
          <label>Source
            <select value={src} onChange={(e) => { setSrc(e.target.value); setRead(null); setMx(null); }}>
              {daos.map((f) => <option key={f.id} value={f.id}>Avis public : {f.title}</option>)}
              <option value="texte">Coller le texte d'un DAO</option>
            </select>
          </label>
          <label>Ou importer un PDF (5 Mo max.)<input type="file" accept="application/pdf" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} /></label>
        </div>
        {fx && <div className="ws-muted">Source publique {fx.source && <a href={fx.source} target="_blank" rel="noreferrer">armp.cm</a>} — texte vérifié le {fx.verifiedAt}. Les noms et contacts de personnes ont été retirés.</div>}
        {src === "texte" && <textarea className="pk-textarea" value={texte} onChange={(e) => setTexte(e.target.value)} placeholder="Collez ici le texte intégral du DAO ou de l'avis (200 caractères minimum)." />}
        <div className="pk-actions">
          <button className="ws-btn ws-btn-primary" disabled={busy || (src === "texte" && texte.trim().length < 200)} onClick={async () => { const r = await run(() => post<DaoRead>({ op: "lire_dao", ...body() }), "Fiche établie"); if (r) { setRead(r); setMx(null); } }}>Établir la fiche d'une page</button>
          <button className="ws-btn" disabled={busy || (src === "texte" && texte.trim().length < 200)} onClick={async () => { const r = await run(() => post<MatrixRes>({ op: "matrice", ...body() })); if (r) setMx(r); }}>Matrice de conformité & dossier</button>
        </div>
      </Card>

      {read && (
        <Card title="Fiche du DAO" actions={read.sheet.manquants.length ? <Badge tone="amber">{read.sheet.manquants.length} élément(s) non trouvé(s)</Badge> : <Badge tone="green">Fiche complète</Badge>}>
          <Markdown text={read.markdown} />
          <details>
            <summary className="ws-muted">Citations vérifiées dans le texte du DAO ({read.citations.filter((c) => c.status === "verifiee").length}/{read.citations.length})</summary>
            <table className="ws-table"><thead><tr><th>Extrait cité</th><th>État</th></tr></thead>
              <tbody>{read.citations.map((c, i) => <tr key={i}><td>« {cleanQuote(c.input.quote ?? "")} »</td><td><Badge tone={CIT[c.status].tone}>{CIT[c.status].label}</Badge>{c.reasons.length > 0 && <div className="ws-muted">{c.reasons.join(" ; ")}</div>}</td></tr>)}</tbody>
            </table>
          </details>
        </Card>
      )}

      {mx && (
        <Card title="Matrice de conformité" actions={mx.matrix.complete ? <Badge tone="green">Dossier complet</Badge> : <Badge tone="amber">{mx.dossier.missing.length} pièce(s) à traiter</Badge>}>
          {mx.matrix.deadline && <div className="ws-muted">Date limite de dépôt : {fmtDate(mx.matrix.deadline, true)} (heure de Douala)</div>}
          <table className="ws-table">
            <thead><tr><th>#</th><th>Env.</th><th>Pièce exigée</th><th>État</th><th>Action</th></tr></thead>
            <tbody>{mx.matrix.rows.map((r) => (
              <tr key={r.order}>
                <td>{r.order}</td><td>{r.envelope}</td>
                <td>{r.requirement}<div className="ws-muted" title="Extrait exact du DAO">« {cleanQuote(r.quote).slice(0, 160)}{cleanQuote(r.quote).length > 160 ? "…" : ""} »</div></td>
                <td><Badge tone={MSTATUS[r.status].tone}>{MSTATUS[r.status].label}</Badge>{r.vaultPiece?.isExample && <> <ExampleBadge /></>}{r.vaultPiece?.expiresAt && <div className="ws-muted">expire le {fmtDate(r.vaultPiece.expiresAt)}</div>}</td>
                <td className="ws-muted">{r.action}</td>
              </tr>
            ))}</tbody>
          </table>
          <h4>Dossier dans l'ordre demandé</h4>
          {mx.dossier.sections.map((s) => <div key={s.envelope}><strong>{s.envelope}</strong><ol>{s.files.map((f) => <li key={f.name}>{f.name} <span className="ws-muted">— {f.status.replace(/_/g, " ")}</span></li>)}</ol></div>)}
          {mx.dossier.notes?.map((n) => <div key={n} className="ws-muted">ℹ️ {n}</div>)}
        </Card>
      )}
    </>
  );
}

type EditRow = { code: string; designation: string; unite: string; quantite: string; prixUnitaire: string; montant: string };
const toEdit = (r: BpuRow): EditRow => ({ code: r.code, designation: r.designation, unite: r.unite ?? "", quantite: String(r.quantite), prixUnitaire: String(r.prixUnitaire), montant: r.montant == null ? "" : String(r.montant) });
const num = (s: string) => Number(s.replace(/\s/g, "").replace(",", "."));

function BpuSection({ st, busy, run, post }: { st: State; busy: boolean; run: Run; post: Post }) {
  const ex = st.fixtures.find((f) => f.kind === "bpu");
  const [rows, setRows] = useState<EditRow[]>([{ code: "1", designation: "", unite: "", quantite: "", prixUnitaire: "", montant: "" }]);
  const [tva, setTva] = useState("");
  const [totalHt, setTotalHt] = useState("");
  const [isExample, setIsExample] = useState(false);
  const [res, setRes] = useState<BpuResult | null>(null);
  const set = (i: number, k: keyof EditRow, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  async function loadExample() {
    const r = await run(() => post<{ input: BpuInput; result: BpuResult }>({ op: "bpu", bpuFixture: ex?.id }));
    if (r) {
      setRows(r.input.rows.map(toEdit));
      setTva(r.input.tvaRate == null ? "" : String(r.input.tvaRate));
      setTotalHt(r.input.totalHtDeclare == null ? "" : String(r.input.totalHtDeclare));
      setIsExample(true);
      setRes(r.result);
    }
  }
  async function recalc() {
    const bpu: BpuInput = {
      rows: rows.filter((r) => r.designation.trim() || r.quantite || r.prixUnitaire).map((r) => ({ code: r.code, designation: r.designation, unite: r.unite || undefined, quantite: num(r.quantite), prixUnitaire: num(r.prixUnitaire), montant: r.montant ? num(r.montant) : null })),
      tvaRate: tva ? num(tva) : null,
      totalHtDeclare: totalHt ? num(totalHt) : null,
      isExample,
    };
    const r = await run(() => post<{ result: BpuResult }>({ op: "bpu", bpu }));
    if (r) setRes(r.result);
  }

  return (
    <>
      <Card title="Bordereau des prix (BPU / DQE)" actions={<>{isExample && <ExampleBadge />}{ex && <button className="ws-btn ws-btn-sm" disabled={busy} onClick={loadExample}>Charger l'exemple</button>}</>}>
        <p className="ws-muted">Saisissez quantités et prix unitaires (et, si vous les avez, les montants déjà écrits). Chaque montant et chaque total sont recalculés et comparés. Le taux de TVA n'est jamais supposé : laissez vide si vous ne le connaissez pas.</p>
        <div className="st-scroll">
          <table className="ws-table">
            <thead><tr><th>N°</th><th>Désignation</th><th>Unité</th><th>Quantité</th><th>Prix unitaire</th><th>Montant écrit</th><th /></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i}>
                {(["code", "designation", "unite", "quantite", "prixUnitaire", "montant"] as (keyof EditRow)[]).map((k) => <td key={k}><input className="pk-table-input" value={r[k]} onChange={(e) => { set(i, k, e.target.value); setIsExample(false); }} inputMode={["quantite", "prixUnitaire", "montant"].includes(k) ? "decimal" : undefined} aria-label={k} /></td>)}
                <td><button className="ws-btn ws-btn-sm ws-btn-ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Supprimer la ligne">✕</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div className="st-form">
          <label>Taux de TVA (en %, si connu)<input value={tva} onChange={(e) => setTva(e.target.value)} inputMode="decimal" placeholder="laisser vide si inconnu" /></label>
          <label>Total HT écrit sur le bordereau<input value={totalHt} onChange={(e) => setTotalHt(e.target.value)} inputMode="decimal" /></label>
        </div>
        <div className="pk-actions">
          <button className="ws-btn" onClick={() => setRows([...rows, { code: String(rows.length + 1), designation: "", unite: "", quantite: "", prixUnitaire: "", montant: "" }])}>Ajouter une ligne</button>
          <button className="ws-btn ws-btn-primary" disabled={busy} onClick={recalc}>Recalculer et vérifier</button>
        </div>
      </Card>
      {res && (
        <Card title="Résultat du recalcul" actions={res.issues.length ? <Badge tone="rose">{res.issues.length} écart(s)</Badge> : <Badge tone="green">Aucun écart</Badge>}>
          <div className="ws-grid">
            <div><strong>Total HT recalculé</strong><div>{fmtMoney(res.totalHt, "FCFA")}</div></div>
            <div><strong>TVA</strong><div>{res.tva === null ? "non calculée (taux non fourni)" : `${fmtMoney(res.tva, "FCFA")} (${res.tvaRate} %)`}</div></div>
            <div><strong>Total TTC</strong><div>{res.totalTtc === null ? "—" : fmtMoney(res.totalTtc, "FCFA")}</div></div>
          </div>
          {res.issues.length > 0 && <ul className="pk-evidence">{res.issues.map((x, i) => <li key={i}>❌ {x.message}</li>)}</ul>}
          <div className="ws-muted">{res.calculs} calcul(s) refaits par l'exécuteur {res.executor.startsWith("local") ? "local limité" : "Vercel Sandbox"} — aucun calcul « de tête ».</div>
        </Card>
      )}
    </>
  );
}

function VaultSection({ st, busy, run, companyId, reload, goTo }: { st: State; busy: boolean; run: Run; companyId: string; reload: () => Promise<void>; goTo: (t: string) => void }) {
  const [f, setF] = useState({ type: st.pieceTypes[0]?.id ?? "", label: "", issuer: "", reference: "", issuedAt: "", expiresAt: "" });
  const alertOf = new Map(st.vault.alerts.map((a) => [a.pieceId, a]));
  const anyExample = st.vault.pieces.some((p) => p.isExample);
  return (
    <>
      <Card title="Alertes">
        {st.vault.alerts.length ? <ul className="pk-evidence">{st.vault.alerts.map((a) => <li key={a.pieceId}>{a.level === "expiree" ? "❌" : "⚠️"} {a.message}</li>)}</ul> : <Empty>Aucune pièce expirée ou proche de l'expiration.</Empty>}
      </Card>
      <Card title="Pièces administratives" actions={anyExample ? <ExampleBadge /> : undefined}>
        {anyExample && <div className="ws-muted">Les pièces marquées « exemple » sont un seed de démonstration (dates fictives relatives à aujourd'hui), pas de vrais documents.</div>}
        {st.vault.pieces.length ? (
          <table className="ws-table">
            <thead><tr><th>Pièce</th><th>Émetteur</th><th>Délivrée</th><th>Expire</th><th /></tr></thead>
            <tbody>{st.vault.pieces.map((p) => {
              const a = alertOf.get(p.id);
              return (
                <tr key={p.id} className={a?.level === "expiree" ? "is-late" : undefined}>
                  <td>{p.label} {p.isExample && <ExampleBadge />}</td>
                  <td>{p.issuer}</td>
                  <td>{p.issuedAt ? fmtDate(p.issuedAt) : "—"}</td>
                  <td>{p.expiresAt ? fmtDate(p.expiresAt) : "sans date d'expiration"}{a && <div><Badge tone={a.level === "expiree" ? "rose" : "amber"}>{a.level === "expiree" ? "expirée" : `J-${a.daysLeft}`}</Badge></div>}</td>
                  <td>{a && <button className="ws-btn ws-btn-sm" disabled={busy} onClick={async () => { const r = await run(() => api("/api/packs/appels-offres-cm/vault", "POST", { companyId, op: "renouveler", pieceId: p.id }), "Brouillon de demande placé dans la file d'approbation (envoi simulé)"); if (r) goTo("missions"); }}>Préparer la demande de renouvellement</button>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        ) : <Empty>Aucune pièce. Ajoutez vos attestations ci-dessous.</Empty>}
      </Card>
      <Card title="Ajouter une pièce">
        <div className="st-form">
          <label>Type<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{st.pieceTypes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
          <label>Intitulé (facultatif)<input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
          <label>Organisme émetteur<input value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} /></label>
          <label>Référence<input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>
          <label>Date de délivrance<input type="date" value={f.issuedAt} onChange={(e) => setF({ ...f, issuedAt: e.target.value })} /></label>
          <label>Date d'expiration (portée sur la pièce)<input type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></label>
        </div>
        <button className="ws-btn ws-btn-primary" disabled={busy || !f.issuer.trim()} onClick={async () => { const r = await run(() => api("/api/packs/appels-offres-cm/vault", "POST", { companyId, op: "ajouter", ...f }), "Pièce ajoutée"); if (r) { setF({ ...f, label: "", issuer: "", reference: "", issuedAt: "", expiresAt: "" }); await reload(); } }}>Ajouter au coffre-fort</button>
        <div className="ws-muted">Aucune durée de validité n'est supposée : seule la date portée sur la pièce fait foi.</div>
      </Card>
    </>
  );
}
