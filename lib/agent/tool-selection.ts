import type { AgentTool } from "./tools";
import { AGENT_MODULES } from "./registry";

/**
 * SÉLECTION DES OUTILS PAR REQUÊTE — avec les 5 modules, l'agent expose ~80 outils (≈ 12 000 jetons) :
 * une seule requête dépasse les paliers gratuits (Groq : 8 000 jetons/min). On n'envoie donc au modèle que
 * le noyau + les outils pertinents (intention / mots-clés), ≈ 15 au maximum. Aucun outil n'est retiré :
 * l'outil `charger_outils` permet au modèle d'ajouter à la volée ceux d'un autre module.
 */
export const MAX_TOOLS = 15;
export const ALWAYS = ["rechercher_textes_juridiques", "creer_tache", "lister_taches", "briefing_cofondateur"];

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Groupes d'outils et intentions qui les déclenchent (message normalisé : minuscules, sans accents). */
export const TOOL_GROUPS: { id: string; test: RegExp; tools?: string[]; module?: string }[] = [
  { id: "email", test: /\b(e-?mails?|mail|courriel|ecris|ecrire|envoie|envoyer|contacte|contacter|message)\b/, tools: ["rediger_email"] },
  { id: "fournisseurs", test: /\b(fournisseurs?|devis|prestataires?|acheter|achat|commander|cotation|relanc\w*)\b/, tools: ["lister_fournisseurs", "demander_devis", "suivre_devis", "relancer_fournisseur"] },
  { id: "documents", test: /business ?plan|plan d.affaires|roadmap|feuille de route|\b(statuts|contrat|nda|confidentialite|proces-verbal|pv|trame|document)\b/, tools: ["generer_business_plan", "generer_roadmap", "generer_document_juridique"] },
  { id: "demarches", test: /\b(demarches?|checklist|etapes?|immatricul\w*|formalites?|creer (mon|une|l.)entreprise|creation d.entreprise)\b/, tools: ["checklist_creation_entreprise", "mettre_a_jour_demarche"] },
  { id: "conformite", test: /\b(conformite|obligations?|echeances?|calendrier|impots?|fiscal\w*|declarations?|cnps)\b/, tools: ["score_conformite", "calendrier_obligations"] },
  { id: "veille", test: /\b(veille|nouveaux textes|reglementaire)\b/, tools: ["veille_reglementaire"] },
  { id: "structure", module: "structure", test: /forme juridique|structure juridique|statut juridique|\b(sarlu?|sasu?|sa|gie|snc|pacte|vesting|cliff|associes?|rccm)\b|simul\w* (la )?creation/ },
  { id: "law-watch", module: "law-watch", test: /changements? de (la )?loi|loi a change|textes? (a|ont) change|textes? modifies?|documents? a revoir|mise a jour du corpus/ },
  { id: "connecteurs", module: "connecteurs", test: /\b(mcp|connecteurs?|integrations?|boite (de reception|unifiee)|inbox|recus|non lus?|whatsapp|gmail|outlook|slack|notion|hubspot|repondre)\b/ },
  { id: "idea", module: "idea", test: /\b(idee|viabilite|diagnostic|concurrents?|pivots?|valider mon)\b/ },
  { id: "fund", module: "fund", test: /\b(financ\w*|subventions?|investisseurs?|levee|lever des fonds|accelerateurs?|incubat\w*|concours|bourses?|programmes?|candidatures?)\b/ },
  { id: "team", module: "team", test: /\b(recrut\w*|co-?fondateurs?|competences?|fiche de poste|candidat\w*|cv|embauch\w*|equipe|biais)\b/ },
  { id: "mentor", module: "mentor", test: /\b(mentors?|mentorat|parrain\w*|mise en relation)\b/ },
  { id: "market", module: "market", test: /\b(b2b|marketplace|place de marche|partenaires?)\b/ },
  { id: "etat", module: "etat", test: /\b(macro\w*|crise|citoyens?|politiques? publiques?|inflation|pib|chomage|gouvernement|ministere|communique)\b/ },
  { id: "entreprise", module: "entreprise", test: /\b(donnees|csv|excel|xlsx|importer|tableau de bord|dashboard|kpi|anomalies?|rapports?|tresorerie|budget|cash|runway|depenses|revenus|appels? d.offres|marches? publics?|risques?|stress|scenarios?|due diligence|data ?room|salle de donnees)\b/ },
  { id: "appels_offres", module: "appels_offres", test: /\b(dao|appels? d.offres|soumission\w*|caution\w*|coleps|armp|bordereau|bpu|dqe|marches? publics?|pieces administratives|coffre)\b/ },
  { id: "memoire", module: "memoire", test: /\b(memoire|souviens|rappelle-toi|decisions?|reunions?|compte rendu|ce que j.ai manque|score co-?founder|attestation|vocal|audio)\b/ },
];

const MODULE_IDS = AGENT_MODULES.map((m) => m.id).filter((id) => id !== "core");

/** Outil méta : ajoute les outils d'un module à la requête suivante (garantit l'accès à tous les outils). */
export const LOAD_TOOLS: AgentTool = {
  name: "charger_outils",
  description: `Ajoute les outils d'un module absent de la liste. Modules : ${MODULE_IDS.join(", ")}, core.`,
  parameters: { type: "object", properties: { module: { type: "string", enum: [...MODULE_IDS, "core"] } }, required: ["module"] },
  async run(input) {
    const id = String(input.module ?? "");
    const mod = AGENT_MODULES.find((m) => m.id === id);
    if (!mod) return { summary: "Module inconnu", data: { modules: MODULE_IDS } };
    return { summary: `Outils du module ${id} chargés`, data: { outils: mod.tools.map((t) => t.name) } };
  },
};

const stems = (s: string) => new Set(norm(s).match(/[a-z0-9]{4,}/g)?.map((w) => w.slice(0, 6)) ?? []);

/** Pertinence lexicale d'un outil (nom + description) pour le message. */
function lexical(tool: AgentTool, msg: Set<string>): number {
  let score = 0;
  for (const w of stems(`${tool.name.replace(/_/g, " ")} ${tool.description}`)) if (msg.has(w)) score += 1;
  for (const w of stems(tool.name.replace(/_/g, " "))) if (msg.has(w)) score += 2;
  return score;
}

export type Selection = { tools: AgentTool[]; groups: string[] };

/**
 * Choisit ≤ MAX_TOOLS outils : noyau toujours présent, puis groupes détectés (message courant prioritaire,
 * messages précédents de l'utilisateur pour les relances du type « oui, fais-le »), départagés par pertinence lexicale.
 */
export function selectTools(message: string, all: AgentTool[], options: { previous?: string[]; extra?: AgentTool[]; force?: string[]; max?: number } = {}): Selection {
  const max = options.max ?? MAX_TOOLS;
  const byName = new Map([...all, ...(options.extra ?? [])].map((t) => [t.name, t]));
  const current = norm(message);
  const before = norm((options.previous ?? []).slice(-2).join(" \n "));
  const msgStems = stems(`${message} ${(options.previous ?? []).slice(-1).join(" ")}`);
  const scores = new Map<string, number>();
  const bump = (name: string, v: number) => byName.has(name) && scores.set(name, Math.max(scores.get(name) ?? 0, v + lexical(byName.get(name)!, msgStems)));
  const groups: string[] = [];
  for (const g of TOOL_GROUPS) {
    const weight = g.test.test(current) ? 100 : g.test.test(before) ? 40 : 0;
    if (!weight) continue;
    groups.push(g.id);
    const names = g.tools ?? AGENT_MODULES.find((m) => m.id === g.module)?.tools.map((t) => t.name) ?? [];
    for (const n of names) bump(n, weight);
    // Outils des connecteurs branchés (connecteurs_<id>_…) : seulement si l'intention « connecteurs » est présente.
    if (g.id === "connecteurs") for (const t of options.extra ?? []) bump(t.name, weight - 10);
  }
  for (const name of options.force ?? []) bump(name, 1000);
  // Aucun groupe détecté : actions cœur les plus courantes.
  if (!groups.length) ["rediger_email", "generer_document_juridique", "checklist_creation_entreprise", "score_conformite", "lister_fournisseurs", "demander_devis", "veille_reglementaire"].forEach((n) => bump(n, 10));
  const ranked = [...scores.entries()].filter(([n]) => !ALWAYS.includes(n)).sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const room = Math.max(0, max - ALWAYS.length - 1);
  const names = [...ALWAYS.filter((n) => byName.has(n)), ...ranked.slice(0, room)];
  return { tools: [...names.map((n) => byName.get(n)!), LOAD_TOOLS], groups };
}

/** Description courte pour le modèle (le texte complet reste dans le registre et l'UI). */
export function compactSchema(tool: AgentTool, nullable: (s: unknown) => unknown) {
  const shorten = (s: unknown, n: number) => (typeof s === "string" && s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : s);
  const firstSentence = (d: string) => {
    const cut = d.search(/[.;:](\s|$)/);
    return cut > 40 && cut < 200 ? d.slice(0, cut + 1) : (shorten(d, 200) as string);
  };
  const strip = (schema: unknown): unknown => {
    if (!schema || typeof schema !== "object") return schema;
    if (Array.isArray(schema)) return schema.map(strip);
    return Object.fromEntries(Object.entries(schema as Record<string, unknown>).map(([k, v]) => [k, k === "description" ? shorten(v, 70) : strip(v)]));
  };
  return { type: "function", function: { name: tool.name, description: tool.name === "rechercher_textes_juridiques" ? tool.description : firstSentence(tool.description), parameters: nullable(strip(tool.parameters)) } };
}
