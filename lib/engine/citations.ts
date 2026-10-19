import { loadDocumentChunks, type DocumentChunk } from "@/lib/documents";
import { loadIngestedOfficial } from "@/lib/legal/corpus";

/**
 * VÉRIFICATEUR DE CITATIONS DÉTERMINISTE (aucun modèle, aucune approximation sémantique).
 * Une citation = un texte (titre, fichier ou numéro), éventuellement un article, une page et un extrait.
 *  1. le texte doit être RÉSOLU dans le corpus (ou dans un document fourni, ex. le DAO) — sinon BLOQUÉE ;
 *  2. la page citée doit exister dans ce texte ;
 *  3. l'article cité doit apparaître dans ce texte (sur la page citée si elle est donnée) ;
 *  4. l'extrait cité doit figurer MOT POUR MOT dans le texte (après normalisation : casse, accents, espaces,
 *     apostrophes et tirets typographiques) — sinon NON VÉRIFIÉE.
 * Les gabarits vides (« décret n° … / … », « XXX ») sont BLOQUÉS.
 */
export type CitationInput = { ref: string; article?: string | null; page?: number | null; quote?: string | null };
export type SourceDoc = { id: string; title: string; source: string; kind: "corpus" | "document"; pages: { page: number; text: string }[] };
export type CitationStatus = "verifiee" | "non_verifiee" | "bloquee";
export type CitationResult = {
  input: CitationInput;
  status: CitationStatus;
  reasons: string[];
  resolved?: { id: string; title: string; source: string; kind: SourceDoc["kind"]; page?: number };
  checks: { texte: boolean; page: boolean | null; article: boolean | null; extrait: boolean | null };
};

export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/(\w)-\s*\n\s*(\w)/g, "$1$2")
    .replace(/[^a-z0-9°]+/g, " ")
    .trim();
}

export const PLACEHOLDER_RE = /…|\.{3}|_{2,}|\bX{2,}\b|\/X+\b|\bX+\//i;
const isPlaceholder = (s: string) => PLACEHOLDER_RE.test(s) || /^\s*(n\s*[°º]?)?\s*[/\-]?\s*$/i.test(s);

/** Paires numériques « 2010/013 » → « 2010/13 » (et variantes 2 chiffres) pour résoudre un numéro de texte. */
function numberKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const m of text.matchAll(/(\d{2,4})\s*[/_.\-\u2010-\u2015 ]\s*0*(\d{1,4})/g)) {
    const a = String(Number(m[1]));
    const b = String(Number(m[2]));
    keys.add(`${a}/${b}`);
    if (m[1].length === 2) keys.add(`19${m[1]}/${b}`).add(`20${m[1]}/${b}`);
  }
  return keys;
}

let corpusDocs: SourceDoc[] | null = null;
export async function loadCorpusDocs(): Promise<SourceDoc[]> {
  if (corpusDocs) return corpusDocs;
  const chunks: DocumentChunk[] = [...(await loadDocumentChunks()), ...(await loadIngestedOfficial())];
  const byId = new Map<string, SourceDoc>();
  for (const c of chunks) {
    const doc = byId.get(c.source) ?? { id: c.source, title: c.title, source: c.source, kind: "corpus" as const, pages: [] };
    doc.pages.push({ page: c.page, text: c.text });
    byId.set(c.source, doc);
  }
  for (const d of byId.values()) d.pages.sort((a, b) => a.page - b.page);
  corpusDocs = [...byId.values()];
  return corpusDocs;
}

/** Résout une référence de texte : identifiant exact, titre/fichier contenant la référence, ou même numéro de texte. */
export function resolveDoc(ref: string, docs: SourceDoc[]): SourceDoc | null {
  const r = normalize(ref);
  if (!r) return null;
  const exact = docs.find((d) => d.id === ref || normalize(d.title) === r || normalize(d.source) === r);
  if (exact) return exact;
  const contains = docs.filter((d) => normalize(d.title).includes(r) || normalize(d.source).includes(r));
  if (contains.length === 1) return contains[0];
  const keys = numberKeys(ref);
  if (keys.size) {
    const kind = r.match(/\b(loi|decret|arrete|decision|ordonnance|circulaire)\b/)?.[1];
    const byNumber = docs.filter((d) => {
      const dk = numberKeys(`${d.title} ${d.source}`);
      return [...keys].some((k) => dk.has(k)) && (!kind || normalize(`${d.title} ${d.source}`).includes(kind));
    });
    if (byNumber.length === 1) return byNumber[0];
  }
  return contains.length ? contains[0] : null;
}

const articleRe = (article: string) => {
  const n = article.replace(/^\s*(article|art\.?)\s*/i, "").trim();
  const num = n.replace(/^0+(?=\d)/, "").replace(/[^0-9a-z]/gi, "");
  return new RegExp(`\\b(article|art)\\s*0*${num}(?:er|e)?\\b`, "i");
};

export function verifyCitation(input: CitationInput, docs: SourceDoc[]): CitationResult {
  const checks: CitationResult["checks"] = { texte: false, page: null, article: null, extrait: null };
  const reasons: string[] = [];
  if (!input.ref?.trim() || isPlaceholder(input.ref)) return { input, status: "bloquee", reasons: ["référence vide ou gabarit (« … », « XXX ») : citation bloquée"], checks };
  if (input.quote && PLACEHOLDER_RE.test(input.quote) && normalize(input.quote).split(" ").length < 4) return { input, status: "bloquee", reasons: ["extrait vide ou gabarit : citation bloquée"], checks };
  const doc = resolveDoc(input.ref, docs);
  if (!doc) return { input, status: "bloquee", reasons: [`texte « ${input.ref} » absent du corpus et des documents fournis : citation bloquée`], checks };
  checks.texte = true;
  let pages = doc.pages;
  if (input.page != null) {
    const found = doc.pages.filter((p) => p.page === input.page);
    checks.page = found.length > 0;
    if (!found.length) reasons.push(`page ${input.page} inexistante dans « ${doc.title} »`);
    else pages = found;
  }
  if (input.article) {
    const re = articleRe(input.article);
    checks.article = pages.some((p) => re.test(p.text));
    if (!checks.article) reasons.push(`article « ${input.article} » introuvable${input.page != null ? ` page ${input.page}` : ""} dans « ${doc.title} »`);
  }
  if (input.quote) {
    const q = normalize(input.quote);
    if (q.split(" ").length < 3) {
      checks.extrait = false;
      reasons.push("extrait trop court pour être vérifié (3 mots minimum)");
    } else {
      // Fenêtre glissante page + page suivante : un extrait peut chevaucher deux pages.
      const hay = pages.map((p) => normalize(p.text));
      const joined = input.page != null ? normalize(doc.pages.filter((p) => p.page === input.page || p.page === input.page! + 1).map((p) => p.text).join(" ")) : hay.join(" ");
      checks.extrait = joined.includes(q);
      if (!checks.extrait) reasons.push("l'extrait cité ne figure pas mot pour mot dans le texte");
    }
  }
  if (checks.extrait === null && checks.article === null) reasons.push("aucun extrait ni article à contrôler : seule l'existence du texte est vérifiée");
  const failed = [checks.page, checks.article, checks.extrait].some((c) => c === false);
  const status: CitationStatus = failed || (checks.extrait === null && checks.article === null) ? "non_verifiee" : "verifiee";
  const page = input.page ?? (input.quote ? doc.pages.find((p) => normalize(p.text).includes(normalize(input.quote!)))?.page : undefined);
  return { input, status, reasons, resolved: { id: doc.id, title: doc.title, source: doc.source, kind: doc.kind, page }, checks };
}

/** Document fourni (ex. DAO collé ou extrait d'un PDF) → SourceDoc vérifiable comme le corpus. */
export function documentFromText(id: string, title: string, text: string, pages?: string[]): SourceDoc {
  const list = pages?.length ? pages : [text];
  return { id, title, source: id, kind: "document", pages: list.map((t, i) => ({ page: i + 1, text: t })) };
}

export async function verifyCitations(inputs: CitationInput[], extra: SourceDoc[] = []): Promise<CitationResult[]> {
  const docs = [...extra, ...(await loadCorpusDocs())];
  return inputs.map((c) => verifyCitation(c, docs));
}

/** Rendu Markdown d'une citation vérifiée / bloquée. */
export function citationLabel(r: CitationResult): string {
  const where = [r.input.article ? `art. ${r.input.article.replace(/^\s*(article|art\.?)\s*/i, "")}` : "", r.resolved?.page ? `p. ${r.resolved.page}` : ""].filter(Boolean).join(", ");
  const head = `${r.resolved?.title ?? r.input.ref}${where ? ` (${where})` : ""}`;
  return r.status === "verifiee" ? `✅ ${head}` : r.status === "bloquee" ? `⛔ citation bloquée — ${r.reasons[0]}` : `⚠️ ${head} — non vérifiée : ${r.reasons.join(" ; ")}`;
}
