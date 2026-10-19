import { appendAuditTx } from "./audit";
import { fingerprint } from "./hash";
import { getStorage } from "./storage";

/**
 * APPROBATIONS PAR NIVEAU DE RISQUE.
 *  - lire          : consultation, aucune trace externe → auto-approuvé (journalisé) ;
 *  - brouillon     : production interne (document, fiche) → auto-approuvé (journalisé), rien ne sort ;
 *  - envoyer       : message ou courrier vers un tiers → approbation humaine OBLIGATOIRE ;
 *  - payer_deposer : paiement, dépôt d'offre (COLEPS), signature → approbation humaine OBLIGATOIRE, exécution humaine.
 * L'approbation porte sur l'APERÇU EXACT et l'EMPREINTE SHA-256 du contenu : si le contenu change, l'empreinte
 * ne correspond plus et l'approbation est refusée. Aucune exécution réelle ici : envoi / dépôt restent simulés ou humains.
 */
export type RiskLevel = "lire" | "brouillon" | "envoyer" | "payer_deposer";
export const RISK_LEVELS: { id: RiskLevel; label: string; human: boolean; description: string }[] = [
  { id: "lire", label: "Lire", human: false, description: "Consultation, aucune trace externe." },
  { id: "brouillon", label: "Brouillon", human: false, description: "Production interne, rien ne sort de l'entreprise." },
  { id: "envoyer", label: "Envoyer", human: true, description: "Message vers un tiers : approbation humaine, envoi simulé par défaut." },
  { id: "payer_deposer", label: "Payer / déposer", human: true, description: "Paiement, dépôt d'offre, signature : approbation humaine, exécution par un humain." },
];
export const needsHuman = (level: RiskLevel) => RISK_LEVELS.find((r) => r.id === level)?.human ?? true;

export type EngineApproval = {
  id: string;
  level: RiskLevel;
  action: string;
  /** Aperçu exact de ce qui sera fait (destinataire, objet, corps, montant, fichier…). */
  preview: { title: string; lines: string[]; payload: unknown };
  contentHash: string;
  status: "en_attente" | "approuvee" | "refusee" | "auto";
  requestedBy: string;
  requestedAt: string;
  missionId?: string;
  decidedBy?: string;
  decidedAt?: string;
  approvedHash?: string;
  note?: string;
  /** Exécution : toujours simulée (envoyer) ou laissée à l'humain (payer_deposer). */
  execution?: "simulee" | "humaine" | "interne";
};

const COL = "approvals";
const newId = () => `apr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export async function requestApproval(companyId: string, input: { level: RiskLevel; action: string; title: string; lines: string[]; payload: unknown; requestedBy: string; missionId?: string }): Promise<EngineApproval> {
  const store = await getStorage();
  return store.transaction(companyId, async (tx) => {
    const auto = !needsHuman(input.level);
    const contentHash = fingerprint(input.payload);
    const a: EngineApproval = {
      id: newId(),
      level: input.level,
      action: input.action,
      preview: { title: input.title, lines: input.lines, payload: input.payload },
      contentHash,
      status: auto ? "auto" : "en_attente",
      requestedBy: input.requestedBy,
      requestedAt: new Date().toISOString(),
      missionId: input.missionId,
      ...(auto ? { approvedHash: contentHash, execution: "interne" as const } : {}),
    };
    await tx.put(COL, a.id, a);
    await appendAuditTx(tx, { actor: input.requestedBy, action: auto ? "approbation.auto" : "approbation.demandee", summary: `[${input.level}] ${input.title}`, data: { approvalId: a.id, contentHash } });
    return a;
  });
}

export class ApprovalError extends Error {}

/** Décision humaine : l'empreinte présentée doit être celle du contenu actuellement en attente. */
export async function decideApproval(companyId: string, id: string, input: { decision: "approuver" | "refuser"; by: string; contentHash: string; note?: string }): Promise<EngineApproval> {
  const store = await getStorage();
  return store.transaction(companyId, async (tx) => {
    const a = await tx.get<EngineApproval>(COL, id);
    if (!a) throw new ApprovalError("Approbation introuvable.");
    if (a.status !== "en_attente") throw new ApprovalError("Cette approbation a déjà été traitée.");
    if (fingerprint(a.preview.payload) !== a.contentHash) throw new ApprovalError("Le contenu a été modifié depuis la demande : nouvelle approbation nécessaire.");
    if (input.contentHash !== a.contentHash) throw new ApprovalError("L'empreinte présentée ne correspond pas au contenu en attente : approbation refusée.");
    a.status = input.decision === "approuver" ? "approuvee" : "refusee";
    a.decidedBy = input.by;
    a.decidedAt = new Date().toISOString();
    a.note = input.note;
    if (a.status === "approuvee") {
      a.approvedHash = a.contentHash;
      a.execution = a.level === "payer_deposer" ? "humaine" : "simulee";
    }
    await tx.put(COL, a.id, a);
    await appendAuditTx(tx, { actor: input.by, action: `approbation.${a.status}`, summary: `[${a.level}] ${a.preview.title}`, data: { approvalId: a.id, contentHash: a.contentHash, execution: a.execution ?? null } });
    return a;
  });
}

export async function listApprovals(companyId: string): Promise<EngineApproval[]> {
  const store = await getStorage();
  return (await store.read(companyId, (tx) => tx.list<EngineApproval>(COL))).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export async function getApproval(companyId: string, id: string): Promise<EngineApproval | null> {
  const store = await getStorage();
  return store.read(companyId, (tx) => tx.get<EngineApproval>(COL, id));
}
