import { loadCorpusDocs, normalize } from "./citations";

/**
 * CARTE DE COUVERTURE DU CORPUS : ce que contient réellement le corpus (par catégorie, avec pages),
 * et ce qui manque par rapport aux besoins déclarés d'un pack (`needs`). Un besoin est « couvert » si un
 * texte du corpus le porte dans son titre ; « mentionné seulement » si on ne le trouve que cité dans d'autres
 * textes (le texte intégral manque — il ne doit alors JAMAIS être présenté comme cité).
 */
export type CoverageNeed = { id: string; label: string; match: string[]; why?: string };
export type CoverageItem = CoverageNeed & { status: "couvert" | "mentionne_seulement" | "absent"; documents: string[]; mentions: number; mentionedIn: string[] };
export type CoverageMap = {
  totals: { documents: number; pages: number };
  categories: { category: string; documents: number; pages: number; titles: string[] }[];
  needs: CoverageItem[];
};

export async function corpusCoverage(needs: CoverageNeed[] = []): Promise<CoverageMap> {
  const docs = await loadCorpusDocs();
  const { loadDocumentChunks } = await import("@/lib/documents");
  const chunks = await loadDocumentChunks();
  const catOf = new Map(chunks.map((c) => [c.source, c.category]));
  const cats = new Map<string, { documents: number; pages: number; titles: string[] }>();
  for (const d of docs) {
    const cat = catOf.get(d.source) ?? "officiel (ingéré)";
    const e = cats.get(cat) ?? { documents: 0, pages: 0, titles: [] };
    e.documents++;
    e.pages += d.pages.length;
    e.titles.push(d.title);
    cats.set(cat, e);
  }
  const items: CoverageItem[] = needs.map((n) => {
    const terms = n.match.map(normalize);
    const squash = (x: string) => x.replace(/ /g, "");
    // Titres de fichiers souvent sans apostrophes ni espaces (« AVIS DAPPEL DOFFRES ») : comparaison aussi sans espaces.
    const inTitle = docs.filter((d) => terms.some((t) => normalize(`${d.title} ${d.source}`).includes(t) || squash(normalize(`${d.title} ${d.source}`)).includes(squash(t))));
    const mentionedIn = new Map<string, number>();
    for (const d of docs) for (const p of d.pages) if (terms.some((t) => normalize(p.text).includes(t))) mentionedIn.set(d.title, (mentionedIn.get(d.title) ?? 0) + 1);
    const mentions = [...mentionedIn.values()].reduce((a, b) => a + b, 0);
    return {
      ...n,
      status: inTitle.length ? "couvert" : mentions ? "mentionne_seulement" : "absent",
      documents: inTitle.map((d) => d.title),
      mentions,
      mentionedIn: [...mentionedIn.keys()].slice(0, 5),
    };
  });
  return {
    totals: { documents: docs.length, pages: docs.reduce((a, d) => a + d.pages.length, 0) },
    categories: [...cats.entries()].map(([category, v]) => ({ category, ...v, titles: v.titles.slice(0, 12) })).sort((a, b) => b.pages - a.pages),
    needs: items,
  };
}
