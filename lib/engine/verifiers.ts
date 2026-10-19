import { verifyCitation, loadCorpusDocs, citationLabel, type CitationInput } from "./citations";
import type { Evidence, PackVerifier } from "./packs/types";

/** Vérificateurs génériques du moteur, utilisables par tous les packs. */
export const CORE_VERIFIERS: Record<string, PackVerifier> = {
  /** La sortie existe et les champs listés sont non vides. */
  champs_presents(output, params) {
    const fields = (params.fields as string[]) ?? [];
    const o = (output ?? {}) as Record<string, unknown>;
    if (!fields.length) return [{ label: "Sortie produite", kind: "verification", ok: output != null, detail: output != null ? "sortie présente" : "aucune sortie" }];
    return fields.map((f) => {
      const v = o[f];
      const ok = !(v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length));
      return { label: `Champ « ${f} »`, kind: "verification", ok, detail: ok ? "présent" : "absent" } satisfies Evidence;
    });
  },
  /** Toutes les citations de la sortie (`citations: CitationInput[]`) sont résolues dans le corpus ou les documents de la mission. */
  async citations_resolues(output, _params, ctx) {
    const list = ((output ?? {}) as { citations?: CitationInput[] }).citations ?? [];
    if (!list.length) return [{ label: "Citations", kind: "citation", ok: true, detail: "aucune citation à vérifier" }];
    const docs = [...ctx.docs, ...(await loadCorpusDocs())];
    return list.map((c) => {
      const r = verifyCitation(c, docs);
      return { label: `Citation : ${(c.ref ?? "").slice(0, 40)}`, kind: "citation", ok: r.status === "verifiee", detail: citationLabel(r), data: { status: r.status, page: r.resolved?.page, quote: c.quote ?? null } } satisfies Evidence;
    });
  },
};
