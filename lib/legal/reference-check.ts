import { loadDocumentChunks } from "@/lib/documents";
import { loadIngestedOfficial } from "./corpus";
import type { Citation } from "./citations";

/**
 * POST-CONTRÔLE DES RÉFÉRENCES DE TEXTES — le modèle ne doit citer aucun numéro de loi, décret, ordonnance,
 * arrêté… qui n'existe ni dans le corpus officiel (titres / fichiers) ni dans les extraits réellement cités.
 * Les références à gabarit (« 2015/XXX ») sont retirées ; les autres références inconnues sont signalées
 * « référence non vérifiée ». Contrôle côté serveur, indépendant du fournisseur d'IA.
 */
const REF_RE =
  /\b(lois?(?:[- ]cadre)?|d[ée]crets?|ordonnances?|arr[êe]t[ée]s?(?: (?:conjoint|minist[ée]riel))?|d[ée]cisions?|circulaires?)(\s+(?:n\s*[°ºo]\.?\s*|no\.?\s+|num[ée]ro\s+)?)((?:[A-Z]{2,12}\s*[/\-\u2010-\u2015]\s*)?[0-9X]{2,4}(?:\s*[/.\-\u2010-\u2015]\s*[0-9A-Z]{1,6}){1,3})/giu;
const PAIR_RE = /(\d{2,4})\s*[/_.\-\u2010-\u2015]\s*0*(\d{1,4})/gu;
const isPlaceholder = (n: string) => /X{2,}|\bX+\b|\/X|X\//i.test(n);

function pairsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PAIR_RE)) {
    const a = String(Number(m[1]));
    const b = String(Number(m[2]));
    out.push(`${a}/${b}`);
    if (m[1].length === 4 && /^(19|20)/.test(m[1])) out.push(`${m[1].slice(2)}/${b}`.replace(/^0/, ""));
    if (m[1].length === 2) out.push(`19${m[1]}/${b}`, `20${m[1]}/${b}`);
  }
  return out;
}

function refKey(num: string): string | null {
  const parts = num.split(/\s*[/.\-\u2010-\u2015]\s*/u).filter(Boolean);
  if (parts.length < 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
  return `${Number(parts[0])}/${Number(parts[1])}`;
}

let corpusKeys: { size: number; keys: Set<string> } | null = null;
async function corpusReferenceKeys(): Promise<Set<string>> {
  const [pdf, ingested] = await Promise.all([loadDocumentChunks(), loadIngestedOfficial()]);
  const size = pdf.length + ingested.length;
  if (corpusKeys?.size === size) return corpusKeys.keys;
  const keys = new Set<string>();
  const seen = new Set<string>();
  for (const c of [...pdf, ...ingested]) {
    const id = `${c.source}|${c.title}`;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const k of pairsOf(`${c.source} ${c.title}`)) keys.add(k);
  }
  corpusKeys = { size, keys };
  return keys;
}

export type ReferenceCheck = { text: string; unverified: string[]; removed: string[]; articles?: string[] };

/** Gabarits vides : « décret n° … / … », « loi n° ___ », « arrêté n° …/2020 » → retirés (jamais affichés comme référence). */
const KIND = String.raw`(?:lois?(?:[- ]cadre)?|d[ée]crets?|ordonnances?|arr[êe]t[ée]s?|d[ée]cisions?|circulaires?)`;
const HOLE = String.raw`(?:…|\.{3}|_{2,})`;
const PLACEHOLDER_REF_RE = new RegExp(
  String.raw`\b${KIND}\s+(?:(?:n\s*[°ºo]\.?|no\.?|num[ée]ro)\s*${HOLE}(?:\s*[/\-\u2010-\u2015]\s*(?:${HOLE}|\d{1,4}))*|(?:(?:n\s*[°ºo]\.?|no\.?)\s*)?(?:${HOLE}|\d{2,4})\s*[/\-\u2010-\u2015]\s*${HOLE}(?:\s*[/\-\u2010-\u2015]\s*(?:${HOLE}|\d{1,4}))*)`,
  "giu",
);

export function stripPlaceholderRefs(answer: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const text = answer.replace(PLACEHOLDER_REF_RE, (full) => {
    removed.push(full.trim());
    return "[référence non vérifiée retirée]";
  });
  return { text, removed };
}

/** Vérifie (et assainit) les références de textes d'une réponse. `extraKnown` : textes de confiance supplémentaires (extraits cités). */
export function checkReferencesWith(answer: string, known: Set<string>, citedTexts: string[] = []): ReferenceCheck {
  const keys = new Set(known);
  for (const t of citedTexts) for (const k of pairsOf(t)) keys.add(k);
  const unverified: string[] = [];
  const stripped = stripPlaceholderRefs(answer);
  const removed: string[] = [...stripped.removed];
  const text = stripped.text.replace(REF_RE, (full, _kind: string, _sep: string, num: string) => {
    if (isPlaceholder(num)) {
      removed.push(full.trim());
      return "[référence non vérifiée retirée]";
    }
    const key = refKey(num.replace(/^[A-Z]{2,12}\s*[/\-\u2010-\u2015]\s*/u, ""));
    if (!key || keys.has(key)) return full;
    unverified.push(full.trim());
    return `${full} (⚠️ référence non vérifiée)`;
  });
  const uniq = [...new Set(unverified)];
  const notes: string[] = [];
  if (removed.length) notes.push(`${removed.length} référence(s) incomplète(s) ou inventée(s) retirée(s)`);
  if (uniq.length) notes.push(`référence(s) absente(s) du corpus officiel et des extraits cités : ${uniq.join(" ; ")}`);
  return {
    text: notes.length ? `${text}\n\n> ⚠️ Contrôle des références : ${notes.join(" · ")}. Ne vous y fiez pas sans vérification auprès de l'administration ou d'un professionnel.` : text,
    unverified: [...new Set(unverified)],
    removed: [...new Set(removed)],
  };
}

/** « article 12 de la loi n° 2010/013 » : si la loi est dans le corpus, l'article doit y figurer (contrôle déterministe). */
const ARTICLE_RE = /\b(articles?|art\.)\s+(\d{1,4})(?:er|e)?\b([^.\n]{0,60}?)\b(lois?(?:[- ]cadre)?|d[ée]crets?|ordonnances?)\s+(?:n\s*[°ºo]\.?\s*)?(\d{2,4}\s*[/\-\u2010-\u2015]\s*\d{1,4})/giu;

export async function checkArticles(answer: string): Promise<{ text: string; flagged: string[] }> {
  if (!ARTICLE_RE.test(answer)) return { text: answer, flagged: [] };
  ARTICLE_RE.lastIndex = 0;
  const { loadCorpusDocs, resolveDoc, verifyCitation } = await import("@/lib/engine/citations");
  const docs = await loadCorpusDocs();
  const flagged: string[] = [];
  const text = answer.replace(ARTICLE_RE, (full: string, _a: string, num: string, _mid: string, kind: string, ref: string) => {
    const doc = resolveDoc(`${kind} ${ref}`, docs);
    if (!doc) return full; // texte absent : déjà signalé par le contrôle des références
    const r = verifyCitation({ ref: doc.id, article: num }, docs);
    if (r.checks.article) return full;
    flagged.push(`article ${num} — ${doc.title}`);
    return `${full} (⚠️ article introuvable dans le texte du corpus)`;
  });
  return { text, flagged };
}

export async function checkReferences(answer: string, citations: Pick<Citation, "excerpt" | "title" | "legalTitle" | "file">[] = []): Promise<ReferenceCheck> {
  const known = await corpusReferenceKeys();
  const base = checkReferencesWith(answer, known, citations.map((c) => `${c.title ?? ""} ${c.legalTitle ?? ""} ${c.file ?? ""} ${c.excerpt ?? ""}`));
  const art = await checkArticles(base.text);
  if (!art.flagged.length) return base;
  const note = `\n\n> ⚠️ Contrôle des articles : ${art.flagged.join(" ; ")} — numéro d'article absent du texte officiel du corpus.`;
  return { ...base, text: art.text + note, articles: art.flagged };
}

export const REFERENCE_RULE =
  "Ne cite AUCUN numéro de loi, décret, ordonnance, arrêté ou décision qui ne figure pas mot pour mot dans les extraits fournis ; n'écris jamais de numéro à compléter (ex. « 2015/XXX »). Si le texte applicable n'est pas dans le corpus, écris « texte non identifié dans le corpus officiel ». Toute référence non vérifiable sera retirée ou signalée automatiquement.";
