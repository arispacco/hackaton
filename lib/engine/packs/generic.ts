import { loadDocumentChunks, searchDocuments } from "@/lib/documents";
import type { PackAction } from "./types";

/**
 * ACTIONS GÉNÉRIQUES DU MOTEUR — disponibles pour tout pack, y compris les brouillons générés :
 * recherche dans le corpus (citations réelles), brouillon de document à partir d'un modèle, contrôle d'une
 * checklist, préparation d'un envoi (approbation « envoyer », envoi simulé).
 */
export const GENERIC_ACTIONS: Record<string, PackAction> = {
  moteur_rechercher_corpus: {
    name: "moteur_rechercher_corpus",
    description: "Cherche dans le corpus officiel et renvoie des extraits citables (texte, page, extrait exact).",
    risk: "lire",
    async run(input) {
      const query = String(input.question ?? input.query ?? "");
      const results = searchDocuments(query, await loadDocumentChunks(), 4);
      const citations = results.map((r) => ({ ref: r.source, page: r.page, quote: r.text.split(/(?<=[.;])\s+/).find((x) => x.split(/\s+/).length >= 6)?.slice(0, 240) ?? r.text.slice(0, 200) }));
      return { output: { query, extraits: results.map((r) => ({ titre: r.title, page: r.page, officiel: true })), citations }, summary: `${citations.length} extrait(s) officiel(s) pour « ${query} »` };
    },
  },
  moteur_brouillon_document: {
    name: "moteur_brouillon_document",
    description: "Remplit un modèle de document ({{champ}}) avec les informations fournies ; les champs manquants restent visibles.",
    risk: "brouillon",
    async run(input) {
      const template = String(input.modele ?? "");
      const values = (input.valeurs ?? {}) as Record<string, string>;
      const missing: string[] = [];
      const text = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => {
        if (values[k]) return values[k];
        missing.push(k);
        return `[${k} — à compléter]`;
      });
      return { output: { texte: text, champs_manquants: missing }, summary: missing.length ? `Brouillon produit, ${missing.length} champ(s) à compléter` : "Brouillon complet" };
    },
  },
  moteur_checklist: {
    name: "moteur_checklist",
    description: "Compare une liste d'exigences aux éléments fournis.",
    risk: "lire",
    async run(input) {
      const required = (input.exigences as string[]) ?? [];
      const have = new Set(((input.fournis as string[]) ?? []).map((x) => x.toLowerCase()));
      const rows = required.map((r) => ({ exigence: r, fourni: have.has(r.toLowerCase()) }));
      return { output: { rows, complete: rows.every((r) => r.fourni) }, summary: `${rows.filter((r) => r.fourni).length}/${rows.length} exigence(s) couvertes` };
    },
  },
  moteur_preparer_envoi: {
    name: "moteur_preparer_envoi",
    description: "Prépare un message vers un tiers (approbation « envoyer », envoi simulé).",
    risk: "envoyer",
    async run() {
      return { output: null, summary: "géré par la file d'approbation" };
    },
    async preview(input) {
      const to = String(input.destinataire ?? "destinataire à compléter");
      const subject = String(input.objet ?? "Objet à compléter");
      const body = String(input.corps ?? "");
      return { title: subject, lines: [`Destinataire : ${to}`, `Objet : ${subject}`, "", body, "", "Envoi : SIMULÉ."], payload: { to, subject, body } };
    },
  },
};
