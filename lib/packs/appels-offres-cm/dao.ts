import { documentFromText, type CitationInput, type SourceDoc } from "@/lib/engine/citations";
import { checkAmountsInText, fmtXaf, parseFigures, type AmountCheck } from "./numbers";

/**
 * LECTEUR DE DAO — extraction DÉTERMINISTE (règles + expressions régulières, aucun modèle) d'un avis / DAO :
 * éligibilité, pièces, caution, date limite, limites de fichiers, grille de notation. Chaque champ porte la
 * citation EXACTE du texte source (vérifiable par le vérificateur de citations). Un champ non trouvé est
 * signalé « non trouvé dans le texte fourni » — jamais deviné.
 */
export type Field<T = string> = { value: T | null; quote: string | null };
export type Piece = { id: string; label: string; envelope: "A" | "B" | "C"; quote: string; position: number; produce?: "rediger" | "obtenir" | "joindre" };
export type DaoSheet = {
  daoId: string;
  title: string;
  reference: Field;
  autorite: Field;
  objet: Field;
  coutPrevisionnel: Field<{ montant: number; libelle: string }>;
  eligibilite: { conditions: { text: string; quote: string }[] };
  caution: Field<{ montant: number | null; libelle: string; validite: string | null; accompagnement: string | null }>;
  dateLimite: Field<{ iso: string; texte: string; mode: "COLEPS" | "physique" | "inconnu" }>;
  ouverturePlis: Field;
  limitesFichiers: { items: { quoi: string; tailleMo: number; quote: string }[]; formats: string[]; exemplaires: Field; formatsQuote: string | null };
  grille: { eliminatoires: { text: string; quote: string }[]; essentiels: { text: string; quote: string }[]; seuil: Field };
  pieces: Piece[];
  montants: AmountCheck[];
  citations: CitationInput[];
  manquants: string[];
};

// Puces de polices symboles (zone d'usage privé Unicode, ex. Wingdings U+F0A7) retirées de l'affichage.
const clean = (s: string) => s.replace(/[\uE000-\uF8FF]/g, " ").replace(/\s+/g, " ").trim();

/** Phrase (ou ligne) du texte original qui contient l'index — tranche EXACTE du texte source. */
function sentenceAt(text: string, index: number, max = 420): string {
  let start = index;
  while (start > 0 && !/[.\n;•]/.test(text[start - 1]) && index - start < max) start--;
  let end = index;
  while (end < text.length && !/[\n;•]/.test(text[end]) && !(text[end] === "." && /\s/.test(text[end + 1] ?? " ") && !/\d/.test(text[end - 1] ?? "")) && end - index < max) end++;
  return text.slice(start, end + (text[end] === "." ? 1 : 0)).trim();
}
function find(text: string, re: RegExp): { m: RegExpExecArray; quote: string } | null {
  const m = new RegExp(re.source, re.flags.replace("g", "")).exec(text);
  return m ? { m, quote: sentenceAt(text, m.index) } : null;
}
const AMOUNT = String.raw`(\d{1,3}(?:[ .\u00a0\u202f]\d{3})+|\d{4,})`;
const MONTHS: Record<string, number> = { janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12 };

function parseDate(d: string, h?: string, mn?: string): string | null {
  let day: number, month: number, year: number;
  const num = d.match(/(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
  if (num) [day, month, year] = [Number(num[1]), Number(num[2]), Number(num[3].length === 2 ? `20${num[3]}` : num[3])];
  else {
    const w = d.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/(\d{1,2})(?:er)?\s+([a-z]+)\s+(\d{4})/);
    if (!w || !MONTHS[w[2]]) return null;
    [day, month, year] = [Number(w[1]), MONTHS[w[2]], Number(w[3])];
  }
  const hh = String(Number(h ?? 0)).padStart(2, "0");
  const mm = String(Number(mn ?? 0)).padStart(2, "0");
  // Heure légale du Cameroun : UTC+1 (Afrique/Douala), sans heure d'été.
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${hh}:${mm}:00+01:00`;
}

/** Liste d'éléments entre deux ancres (puces « • », « l », « · », « - », « * », ou « ; »). */
function itemsBetween(text: string, startRe: RegExp, endRe: RegExp): { text: string; quote: string }[] {
  const s = new RegExp(startRe.source, startRe.flags.replace("g", "")).exec(text);
  if (!s) return [];
  const from = s.index + s[0].length;
  const rest = text.slice(from);
  const e = new RegExp(endRe.source, endRe.flags.replace("g", "")).exec(rest);
  const block = rest.slice(0, e ? e.index : 2500);
  return block
    .split(/\n|;|(?:^|\s)[•·]\s|\s\s[l]\s{2,}|^\s*[l*\-]\s+/m)
    .map((x) => x.replace(/^[\s•·*\-l]+(?=\S)/, "").trim())
    .filter((x) => x.length > 12 && !/^(il s'agit|les crit[eè]res (essentiels|éliminatoires|eliminatoires) (fixent|à la qualification|a la qualification))/i.test(x))
    .map((x) => ({ text: clean(x).replace(/^(De |Du |Des |La |Le |L’|L')/, (m) => m), quote: x.slice(0, 400) }))
    .slice(0, 30);
}

const PIECES: { id: string; label: string; envelope: Piece["envelope"]; re: RegExp; produce?: Piece["produce"] }[] = [
  { id: "caution", label: "Caution (cautionnement) de soumission", envelope: "A", re: /caution(?:nement)? (?:de soumission|provisoire)/i, produce: "obtenir" },
  { id: "recepisse_cdec", label: "Récépissé de consignation CDEC (accompagnant la caution)", envelope: "A", re: /r[ée]c[ée]piss[ée][^.;]{0,60}(CDEC|Caisse des D[ée]p[ôo]ts)/i, produce: "obtenir" },
  { id: "quittance_dao", label: "Quittance d'achat du DAO", envelope: "A", re: /quittance[^.;]{0,120}(achat|acquisition|frais)|(achat|acquisition) du (DAO|dossier)[^.;]{0,60}quittance/i, produce: "obtenir" },
  { id: "categorisation", label: "Attestation de catégorisation / classification", envelope: "A", re: /attestation de cat[ée]gorisation|classification dans la cat[ée]gorie/i, produce: "joindre" },
  { id: "non_faillite", label: "Attestation de non-faillite", envelope: "A", re: /non[- ]faillite/i, produce: "obtenir" },
  { id: "acf", label: "Attestation de conformité fiscale (ACF)", envelope: "A", re: /attestation de conformit[ée] fiscale|\bACF\b/i, produce: "obtenir" },
  { id: "cnps", label: "Attestation CNPS (non-redevance)", envelope: "A", re: /\bCNPS\b|non[- ]redevance/i, produce: "obtenir" },
  { id: "rccm", label: "Registre du commerce (RCCM)", envelope: "A", re: /registre (?:du|de) commerce|\bRCCM\b/i, produce: "joindre" },
  { id: "decl_abandon", label: "Déclaration sur l'honneur de non-abandon de chantier", envelope: "A", re: /d[ée]claration sur l[’']honneur[^.;]{0,80}abandon/i, produce: "rediger" },
  { id: "charte", label: "Charte d'intégrité datée et signée", envelope: "A", re: /charte d[’']int[ée]grit[ée]/i, produce: "rediger" },
  { id: "engagement_es", label: "Déclaration d'engagement (clauses environnementales et sociales)", envelope: "A", re: /engagement[^.;]{0,60}clauses environnementales/i, produce: "rediger" },
  { id: "ccap_cctp", label: "CCAP / CCTP paraphés « lu et approuvé »", envelope: "A", re: /\bCCAP\b|\bCCTP\b|Cahiers? des Clauses (?:Administratives|Techniques)/i, produce: "joindre" },
  { id: "capacite_fin", label: "Justificatif de capacité / surface financière", envelope: "A", re: /(capacit[ée]|surface) financi[èe]re/i, produce: "obtenir" },
  { id: "references", label: "Références / expérience similaires", envelope: "B", re: /(prestations|exp[ée]rience|r[ée]f[ée]rences)[^.;]{0,100}(similaires?|derni[èe]res ann[ée]es|domaine d)/i, produce: "joindre" },
  { id: "materiel", label: "Liste et justificatifs du matériel", envelope: "B", re: /\bmat[ée]riel\b|bulldozer|niveleuse|camion benne/i, produce: "joindre" },
  { id: "personnel", label: "Personnel clé (CV, diplômes)", envelope: "B", re: /\bpersonnel\b/i, produce: "joindre" },
  { id: "methodologie", label: "Méthodologie / proposition technique", envelope: "B", re: /m[ée]thodologie|proposition technique/i, produce: "rediger" },
  { id: "soumission", label: "Lettre de soumission", envelope: "C", re: /\bla soumission\b|lettre de soumission/i, produce: "rediger" },
  { id: "bpu", label: "Bordereau des prix unitaires (BPU)", envelope: "C", re: /\bBPU\b|bordereau des prix/i, produce: "rediger" },
  { id: "dqe", label: "Détail quantitatif et estimatif (DQE)", envelope: "C", re: /\bDQE\b|d[ée]tail quantitatif|devis quantitatif/i, produce: "rediger" },
];

export function parseDao(text: string, opts: { id: string; title: string; pages?: string[] }): { sheet: DaoSheet; doc: SourceDoc } {
  const t = text.replace(/\r/g, "");
  const doc = documentFromText(opts.id, opts.title, t, opts.pages);
  const manquants: string[] = [];
  const field = <T>(value: T | null, quote: string | null, label: string): Field<T> => {
    if (value === null) manquants.push(label);
    return { value, quote };
  };

  const ref = find(t, /APPEL D[’']OFFRES[^\n]{0,60}?N\s*[°*º]\s*_*\s*([0-9][0-9A-Za-z/_\-.]{5,70}?)(?=_*\s+(?:DU|du)\b|\s|$)/i);
  const aut = find(t, /(?:le|la|l[’'])\s*([A-ZÉ][^,\n]{4,140}?),\s*(?:Autorit[ée] Contractante|Ma[îi]tre d[’']Ouvrage)/);
  const autLine = !aut ? find(t, /^(COMMUNE|MINIST[ÈE]RE|AGENCE|PROGRAMME|DIRECTION|R[ÉE]GION|SOCI[ÉE]T[ÉE])[^\n]{3,160}$/m) : null;
  const obj = find(t, /\blance\b[^.]{0,40}(?:un |une )?(?:Appel d[’']Offres|consultation)[^.]{10,400}/i) ?? find(t, /\bPOUR (?:LA|LE|LES|L[’'])[^\n]{10,300}/);
  const cout = find(t, new RegExp(`co[uû]ts? pr[ée]visionnels?[^.]{0,160}?${AMOUNT}`, "i"));
  const coutVal = cout ? parseFigures(cout.m[1]) : null;

  const elig = [find(t, /\bLa participation[^.]{0,80}ouverte[^.]{5,300}/i), find(t, /(?:surface|capacit[ée]) financi[èe]re[^.;\n]{5,200}/i), find(t, /cat[ée]gorie\s+[A-F]\b[^.;\n]{0,160}/i), find(t, /montant cumul[ée][^.;\n]{5,200}/i)]
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .map((x) => ({ text: clean(x.quote).replace(/^[l•·*\-]\s+/, ""), quote: x.quote }));

  const cau = find(t, new RegExp(`caution(?:nement)? (?:de soumission|provisoire)[^]{0,500}?${AMOUNT}\\s*(?:\\([^)]*\\))?\\s*(?:F\\s*CFA|FCFA|Francs? CFA)`, "i"));
  const cauVal = cau ? parseFigures(cau.m[1]) : null;
  const cauQuote = cau ? sentenceAt(t, cau.m.index + cau.m[0].lastIndexOf(cau.m[1])) : null;
  const valid = find(t, /valable jusqu[’']\s*(?:à|a)[^.;]{3,160}/i);
  const cdec = find(t, /r[ée]c[ée]piss[ée][^.;]{0,80}(CDEC|Caisse des D[ée]p[ôo]ts)/i);

  const dl = find(t, /au plus tard le\s+(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}(?:er)?\s+[A-Za-zéû]+\s+\d{4})(?:\s*(?:à|a)\s*(\d{1,2})\s*(?:h|heures?)\s*(\d{2})?)?/i);
  const dlIso = dl ? parseDate(dl.m[1], dl.m[2], dl.m[3]) : null;
  const ouv = find(t, /L[’']\s*ouverture des (?:plis|offres)[^.\n]{0,40}aura lieu[^.]{5,250}/i);

  const sizes = [...t.matchAll(/(\d{1,3})\s*(?:MO|Mo|MB|mo)\b\s*(?:pour\s*)?(?:l[’']\s*)?([^;.\n]{3,60})/g)].map((m) => ({ quoi: clean(m[2]), tailleMo: Number(m[1]), quote: sentenceAt(t, m.index) }));
  const fmt = find(t, /formats? accept[ée]s?[^]{0,200}/i);
  const formats = fmt ? [...new Set([...fmt.quote.matchAll(/\b(PDF|JPEG|JPG|PNG|ZIP|DOCX?|XLSX?)\b/gi), ...t.slice(t.indexOf(fmt.quote), t.indexOf(fmt.quote) + 300).matchAll(/\b(PDF|JPEG|JPG|PNG|ZIP|DOCX?|XLSX?)\b/gi)].map((m) => m[1].toUpperCase()))] : [];
  const ex = find(t, /\b([a-zé\-]+)\s*\((\d{1,2})\)\s*exemplaires[^.]{0,120}/i);

  const ELIM_HEAD = /\n\s*(?:[\d.]+\s*)?(?:Les )?Crit[èe]res (?:dits )?[ée]liminatoires\s*:?\s*\n/i;
  const ESS_HEAD = /\n\s*(?:[\d.]+\s*)?(?:Les )?crit[èe]res (?:dits )?essentiels\b[^\n]{0,30}\n/i;
  const elim = itemsBetween(t, ELIM_HEAD.test(t) ? ELIM_HEAD : /crit[èe]res [ée]liminatoires[^.]*?(?:notamment|suivants)\s*:?/i, ESS_HEAD.test(t) ? ESS_HEAD : /crit[èe]res (?:dits )?essentiels/i);
  const essStart = /crit[èe]res essentiels [àa] la qualification[^:]*:|crit[èe]res dits essentiels[^\n]*\n[^:]*:/i;
  const ess = itemsBetween(t, essStart, /\n\s*\d{1,2}\s*[.)]\s*[A-Z]|NB\s*:|\bAttribution\b/i);
  const seuil = find(t, /(\d{1,3})\s*%\s*(?:de OUI|crit[èe]res essentiels)|(\d{1,2})\s*oui sur les\s*(\d{1,2})/i);

  const pieces: Piece[] = [];
  for (const p of PIECES) {
    const f = find(t, p.re);
    if (f) pieces.push({ id: p.id, label: p.label, envelope: p.envelope, quote: f.quote, position: f.m.index, produce: p.produce });
  }
  pieces.sort((a, b) => a.envelope.localeCompare(b.envelope) || a.position - b.position);

  const sheet: DaoSheet = {
    daoId: opts.id,
    title: opts.title,
    reference: field(ref ? ref.m[1].replace(/_+$/, "") : null, ref?.quote ?? null, "référence"),
    autorite: field(aut ? clean(aut.m[1]) : autLine ? clean(autLine.m[0]) : null, aut?.quote ?? autLine?.quote ?? null, "autorité contractante"),
    objet: field(obj ? (clean(obj.quote).length > 400 ? `${clean(obj.quote).slice(0, 400)}…` : clean(obj.quote)) : null, obj?.quote ?? null, "objet"),
    coutPrevisionnel: field(coutVal !== null ? { montant: coutVal, libelle: fmtXaf(coutVal) } : null, cout?.quote ?? null, "coût prévisionnel"),
    eligibilite: { conditions: elig },
    caution: field(cau ? { montant: cauVal, libelle: cauVal !== null ? fmtXaf(cauVal) : "montant non lisible", validite: valid ? clean(valid.m[0]) : null, accompagnement: cdec ? clean(cdec.quote) : null } : null, cauQuote, "caution de soumission"),
    dateLimite: field(dlIso ? { iso: dlIso, texte: clean(dl!.m[0]), mode: /COLEPS|en ligne/i.test(dl!.quote) ? "COLEPS" : /exemplaires|pli|bureau|courrier/i.test(dl!.quote) ? "physique" : "inconnu" } : null, dl?.quote ?? null, "date limite de dépôt"),
    ouverturePlis: field(ouv ? clean(ouv.quote) : null, ouv?.quote ?? null, "ouverture des plis"),
    limitesFichiers: { items: sizes, formats, exemplaires: { value: ex ? `${ex.m[2]} exemplaires` : null, quote: ex?.quote ?? null }, formatsQuote: fmt?.quote ?? null },
    grille: { eliminatoires: elim, essentiels: ess, seuil: { value: seuil ? clean(seuil.m[0]) : null, quote: seuil?.quote ?? null } },
    pieces,
    montants: checkAmountsInText(t),
    citations: [],
    manquants,
  };
  if (!sizes.length) manquants.push("limites de taille de fichiers");
  if (!elim.length) manquants.push("critères éliminatoires");

  // Citations : chaque champ trouvé renvoie à sa phrase source exacte (vérifiable).
  const q = (quote: string | null) => (quote && quote.split(/\s+/).length >= 3 ? [{ ref: opts.id, quote }] : []);
  sheet.citations = [
    sheet.reference.quote, sheet.autorite.quote, sheet.objet.quote, sheet.coutPrevisionnel.quote, sheet.caution.quote, sheet.dateLimite.quote, sheet.ouverturePlis.quote,
    ...elig.map((e) => e.quote), ...sizes.map((s) => s.quote), ...elim.map((e) => e.quote), ...ess.map((e) => e.quote), ...pieces.map((p) => p.quote),
  ].flatMap(q);
  return { sheet, doc };
}

const fmtDateFr = (iso: string) => new Date(iso).toLocaleString("fr-FR", { timeZone: "Africa/Douala", dateStyle: "full", timeStyle: "short" });

/** Fiche d'une page (Markdown). */
export function sheetMarkdown(s: DaoSheet): string {
  const nf = "⚠️ non trouvé dans le texte fourni — à vérifier dans le DAO complet";
  const lines = [
    `## Fiche DAO — ${s.reference.value ?? s.title}`,
    `**Autorité contractante** : ${s.autorite.value ?? nf}`,
    `**Objet** : ${s.objet.value ?? nf}`,
    `**Coût prévisionnel** : ${s.coutPrevisionnel.value?.libelle ?? nf}`,
    `**Date limite** : ${s.dateLimite.value ? `${fmtDateFr(s.dateLimite.value.iso)} (heure de Douala) — dépôt ${s.dateLimite.value.mode === "COLEPS" ? "en ligne sur COLEPS" : s.dateLimite.value.mode}` : nf}`,
    `**Caution de soumission** : ${s.caution.value ? `${s.caution.value.libelle}${s.caution.value.validite ? ` — ${s.caution.value.validite}` : ""}` : nf}`,
    `**Ouverture des plis** : ${s.ouverturePlis.value ?? nf}`,
    `**Limites de fichiers** : ${s.limitesFichiers.items.length ? s.limitesFichiers.items.map((i) => `${i.tailleMo} Mo — ${i.quoi}`).join(" ; ") : nf}${s.limitesFichiers.formats.length ? ` · formats : ${s.limitesFichiers.formats.join(", ")}` : ""}${s.limitesFichiers.exemplaires.value ? ` · ${s.limitesFichiers.exemplaires.value}` : ""}`,
    "",
    `### Éligibilité`,
    ...(s.eligibilite.conditions.length ? s.eligibilite.conditions.map((c) => `- ${c.text}`) : [`- ${nf}`]),
    `### Pièces exigées (${s.pieces.length}) — dans l'ordre des enveloppes`,
    ...s.pieces.map((p) => `- [${p.envelope}] ${p.label}`),
    `### Grille`,
    `- Critères éliminatoires : ${s.grille.eliminatoires.length || "non trouvés"}${s.grille.seuil.value ? ` · seuil : ${s.grille.seuil.value}` : ""}`,
    ...s.grille.essentiels.map((e) => `- ${e.text}`),
  ];
  const bad = s.montants.filter((m) => !m.consistent);
  if (bad.length) lines.push("### ⚠️ Incohérences chiffres / lettres dans le texte source", ...bad.map((b) => `- « ${b.quote} » : ${fmtXaf(b.figures)} en chiffres ≠ ${fmtXaf(b.wordsValue ?? 0)} en lettres — à faire préciser par l'autorité contractante`));
  if (s.manquants.length) lines.push(`### Non trouvé dans le texte`, `- ${s.manquants.join(" · ")}`);
  return lines.join("\n");
}

/** Catalogue des types de pièces reconnus (pour le coffre-fort et la matrice). */
export const PIECE_TYPES = PIECES.map(({ id, label, envelope, produce }) => ({ id, label, envelope, produce: produce ?? null }));
