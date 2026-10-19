import { appendAuditTx } from "@/lib/engine/audit";
import { requestApproval, type EngineApproval } from "@/lib/engine/approvals";
import { getStorage } from "@/lib/engine/storage";

/**
 * COFFRE-FORT DE PIÈCES : pièces administratives avec date de validité, alertes avant expiration (ou avant la
 * date limite d'un appel d'offres) et BROUILLONS de demande de renouvellement — soumis à approbation « envoyer »,
 * jamais envoyés réellement. Les durées de validité ne sont PAS supposées : seule la date d'expiration saisie
 * (ou lue sur la pièce) fait foi.
 */
export type VaultPiece = {
  id: string;
  type: string;
  label: string;
  issuer: string;
  reference?: string;
  issuedAt?: string | null;
  expiresAt?: string | null;
  fileName?: string;
  isExample?: boolean;
  addedAt: string;
};
export type VaultAlert = { pieceId: string; label: string; level: "expiree" | "expire_avant_depot" | "bientot" ; daysLeft: number; message: string };

const COL = "ao_vault";
const DAY = 86_400_000;

export async function listVault(companyId: string): Promise<VaultPiece[]> {
  const store = await getStorage();
  return (await store.read(companyId, (tx) => tx.list<VaultPiece>(COL))).sort((a, b) => a.label.localeCompare(b.label));
}

export async function addPiece(companyId: string, p: Omit<VaultPiece, "id" | "addedAt">, actor: string): Promise<VaultPiece> {
  const store = await getStorage();
  const piece: VaultPiece = { ...p, id: `pc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, addedAt: new Date().toISOString() };
  await store.transaction(companyId, async (tx) => {
    await tx.put(COL, piece.id, piece);
    await appendAuditTx(tx, { actor, action: "coffre.ajout", summary: `Pièce ajoutée : ${piece.label}${piece.expiresAt ? ` (valable jusqu'au ${piece.expiresAt.slice(0, 10)})` : ""}`, data: { pieceId: piece.id } });
  });
  return piece;
}

/** Seed de démonstration (marqué « exemple ») : dates relatives à aujourd'hui pour montrer les alertes. */
export async function ensureExampleVault(companyId: string, isExampleCompany: boolean): Promise<void> {
  if (!isExampleCompany) return;
  const existing = await listVault(companyId);
  if (existing.length) return;
  const d = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
  const seed: Omit<VaultPiece, "id" | "addedAt">[] = [
    { type: "rccm", label: "Registre du commerce (RCCM) — exemple", issuer: "Greffe du tribunal (exemple)", issuedAt: d(-400), expiresAt: null, isExample: true },
    { type: "non_faillite", label: "Attestation de non-faillite — exemple", issuer: "Tribunal de première instance (exemple)", issuedAt: d(-70), expiresAt: d(20), isExample: true },
    { type: "acf", label: "Attestation de conformité fiscale — exemple", issuer: "Administration fiscale (exemple)", issuedAt: d(-30), expiresAt: d(60), isExample: true },
    { type: "cnps", label: "Attestation CNPS de non-redevance — exemple", issuer: "CNPS (exemple)", issuedAt: d(-100), expiresAt: d(-5), isExample: true },
    { type: "categorisation", label: "Attestation de catégorisation (routes, cat. D) — exemple", issuer: "Ministère technique (exemple)", issuedAt: d(-350), expiresAt: d(12), isExample: true },
    { type: "capacite_fin", label: "Attestation de capacité financière — exemple", issuer: "Banque (exemple)", issuedAt: d(-10), expiresAt: d(80), isExample: true },
  ];
  const store = await getStorage();
  await store.transaction(companyId, async (tx) => {
    for (const p of seed) {
      const piece: VaultPiece = { ...p, id: `pc_ex_${p.type}`, addedAt: new Date().toISOString() };
      await tx.put(COL, piece.id, piece);
    }
    await appendAuditTx(tx, { actor: "systeme", action: "coffre.seed_exemple", summary: `${seed.length} pièces d'EXEMPLE ajoutées au coffre (données fictives)` });
  });
}

export function vaultAlerts(pieces: VaultPiece[], opts: { now?: Date; horizonDays?: number; deadline?: string | null } = {}): VaultAlert[] {
  const now = (opts.now ?? new Date()).getTime();
  const horizon = opts.horizonDays ?? 30;
  const deadline = opts.deadline ? new Date(opts.deadline).getTime() : null;
  const out: VaultAlert[] = [];
  for (const p of pieces) {
    if (!p.expiresAt) continue;
    const exp = new Date(`${p.expiresAt.slice(0, 10)}T23:59:59+01:00`).getTime();
    const daysLeft = Math.floor((exp - now) / DAY);
    if (exp < now) out.push({ pieceId: p.id, label: p.label, level: "expiree", daysLeft, message: `${p.label} : expirée depuis ${-daysLeft} jour(s)` });
    else if (deadline && exp < deadline) out.push({ pieceId: p.id, label: p.label, level: "expire_avant_depot", daysLeft, message: `${p.label} : expire le ${p.expiresAt.slice(0, 10)}, AVANT la date limite de dépôt` });
    else if (daysLeft <= horizon) out.push({ pieceId: p.id, label: p.label, level: "bientot", daysLeft, message: `${p.label} : expire dans ${daysLeft} jour(s)` });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

/** Brouillon de demande de renouvellement (texte exact), soumis à approbation « envoyer » — aucun envoi réel. */
export function renewalDraft(p: VaultPiece, company: { name: string }): { title: string; lines: string[]; payload: { to: string; subject: string; body: string; pieceId: string } } {
  const subject = `Demande de renouvellement — ${p.label.replace(/ — exemple$/, "")}`;
  const body = [
    "Madame, Monsieur,",
    "",
    `Nous sollicitons la délivrance d'une nouvelle « ${p.label.replace(/ — exemple$/, "")} » au nom de ${company.name}${p.expiresAt ? `, la pièce en notre possession expirant le ${p.expiresAt.slice(0, 10)}` : ""}.`,
    "Vous trouverez ci-joint les pièces justificatives requises par vos services (liste à confirmer auprès de l'administration émettrice).",
    "",
    "Veuillez agréer, Madame, Monsieur, l'expression de nos salutations distinguées.",
    "",
    `[Signature — ${company.name}]`,
  ].join("\n");
  const to = `${p.issuer} — adresse à compléter par l'utilisateur (aucun contact réel enregistré)`;
  return { title: subject, lines: [`Destinataire : ${to}`, `Objet : ${subject}`, "", body, "", "Envoi : SIMULÉ (aucun envoi réel par Co-founder)."], payload: { to, subject, body, pieceId: p.id } };
}

export async function requestRenewal(companyId: string, p: VaultPiece, company: { name: string }, actor: string, missionId?: string): Promise<EngineApproval> {
  const d = renewalDraft(p, company);
  return requestApproval(companyId, { level: "envoyer", action: "ao_demande_renouvellement", title: d.title, lines: d.lines, payload: d.payload, requestedBy: actor, missionId });
}
