/** Montants : chiffres « 3 029 188 » et lettres « trois millions vingt-neuf mille cent quatre-vingt-huit » (français). */
const UNITS: Record<string, number> = {
  zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12,
  treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20, vingts: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60,
};
const SCALES: Record<string, number> = { mille: 1e3, million: 1e6, millions: 1e6, milliard: 1e9, milliards: 1e9 };
const strip = (w: string) => w.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export const isNumberWord = (w: string) => {
  const s = strip(w);
  return s in UNITS || s in SCALES || s === "cent" || s === "cents" || s === "et";
};

export function parseFrenchNumber(words: string): number | null {
  const tokens = strip(words).split(/[\s\-‑]+/).filter((t) => t && t !== "et");
  if (!tokens.length) return null;
  let total = 0;
  let current = 0;
  for (const t of tokens) {
    if (t in UNITS) {
      const n = UNITS[t];
      if (n === 20 && current % 100 === 4) current += 76; // quatre-vingt(s)
      else current += n;
    } else if (t === "cent" || t === "cents") current = (current || 1) * 100 + 0;
    else if (t in SCALES) {
      total += (current || 1) * SCALES[t];
      current = 0;
    } else return null;
  }
  return total + current;
}

export const parseFigures = (s: string) => {
  const digits = s.replace(/[\s.\u00a0\u202f]/g, "");
  return /^\d+$/.test(digits) ? Number(digits) : null;
};

export type AmountCheck = { figures: number; words: string; wordsValue: number | null; consistent: boolean; quote: string };

/** Repère les paires « chiffres (lettres) » et « lettres (chiffres) » et vérifie leur concordance. */
export function checkAmountsInText(text: string): AmountCheck[] {
  const out: AmountCheck[] = [];
  const num = String.raw`(\d{1,3}(?:[ .\u00a0\u202f]\d{3})+|\d{4,})`;
  const reA = new RegExp(`${num}\\s*\\(([A-Za-zÀ-ÿ\\-‑ ]{4,200})\\)`, "g");
  for (const m of text.matchAll(reA)) {
    const figures = parseFigures(m[1]);
    const wordsValue = parseFrenchNumber(m[2]);
    if (figures === null || wordsValue === null) continue;
    out.push({ figures, words: m[2].trim(), wordsValue, consistent: figures === wordsValue, quote: m[0] });
  }
  const reB = new RegExp(`([A-Za-zÀ-ÿ\\-‑ ]{4,200})\\(\\s*${num}\\s*\\)`, "g");
  for (const m of text.matchAll(reB)) {
    const words = m[1].trim().split(/\s+/);
    const tail: string[] = [];
    for (let i = words.length - 1; i >= 0 && words[i].split(/[-‑]/).every(isNumberWord); i--) tail.unshift(words[i]);
    if (!tail.length) continue;
    const figures = parseFigures(m[2]);
    const wordsValue = parseFrenchNumber(tail.join(" "));
    if (figures === null || wordsValue === null || wordsValue < 10) continue;
    out.push({ figures, words: tail.join(" "), wordsValue, consistent: figures === wordsValue, quote: `${tail.join(" ")} (${m[2]})` });
  }
  return out;
}

export const fmtXaf = (n: number) => `${new Intl.NumberFormat("fr-FR").format(Math.round(n)).replace(/\u202f/g, " ")} FCFA`;
