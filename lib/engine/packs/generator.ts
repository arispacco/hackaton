import { ALL_TOOLS } from "@/lib/agent/registry";
import { selectTools } from "@/lib/agent/tool-selection";
import { corpusCoverage, type CoverageMap, type CoverageNeed } from "../coverage";
import type { PackManifest, Procedure } from "./types";

/**
 * GÉNÉRATEUR DE PACKS : l'utilisateur décrit son métier en langage courant ; le moteur produit un BROUILLON de
 * manifest (statut « brouillon_a_valider ») — procédure type, outils pertinents, besoins de corpus avec la carte
 * de couverture réelle, vérificateurs, jeu d'évaluation à compléter. Déterministe : aucun texte de loi, aucun
 * chiffre n'est inventé ; tout ce qui relève du métier est marqué « à valider ».
 */
const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const DOMAINS: { id: string; test: RegExp; label: string; audience: string[]; tasks: string[] }[] = [
  { id: "btp", test: /\b(btp|batiment|construction|chantier|genie civil|travaux|architecte|bureau d.etudes)\b/, label: "BTP et ingénierie", audience: ["PME du BTP", "bureaux d'études"], tasks: ["Préparer un devis ou une offre", "Suivre un chantier", "Rassembler les pièces administratives"] },
  { id: "transport", test: /\b(transport|logistique|livraison|fret|camion|colis)\b/, label: "Transport et logistique", audience: ["transporteurs", "sociétés de livraison"], tasks: ["Préparer une cotation de transport", "Suivre les documents des véhicules", "Répondre à une consultation"] },
  { id: "restauration", test: /\b(restaurant|restauration|traiteur|cuisine|boulangerie|patisserie)\b/, label: "Restauration", audience: ["restaurants", "traiteurs"], tasks: ["Préparer une offre traiteur", "Suivre les contrôles d'hygiène", "Gérer les fournisseurs"] },
  { id: "sante", test: /\b(pharmacie|clinique|sante|medical|cabinet medical|laboratoire)\b/, label: "Santé", audience: ["pharmacies", "cliniques"], tasks: ["Suivre les autorisations", "Gérer les commandes", "Préparer les déclarations"] },
  { id: "agri", test: /\b(agricole|agriculture|agro|elevage|plantation|cacao|cafe)\b/, label: "Agriculture et agro-industrie", audience: ["coopératives", "exploitations"], tasks: ["Préparer un dossier de financement", "Suivre les certifications", "Vendre à un acheteur"] },
  { id: "conseil", test: /\b(conseil|consultant|cabinet|comptable|avocat|juriste|formation)\b/, label: "Services professionnels", audience: ["cabinets", "consultants"], tasks: ["Répondre à une demande de proposition", "Rédiger une lettre de mission", "Suivre les échéances clients"] },
  { id: "commerce", test: /\b(commerce|boutique|vente|distribution|import|export|grossiste)\b/, label: "Commerce et distribution", audience: ["commerçants", "distributeurs"], tasks: ["Préparer une offre commerciale", "Suivre les stocks et fournisseurs", "Gérer les formalités d'import"] },
];

const STOP = new Set("alors aussi avec avoir dans des donc elle elles entre est etre faire fait leur leurs mais mes mon nos notre nous par pas pour que qui sans ses son sont sur une vous votre vos les aux du de la le un et en au ou je j ai suis nous sommes besoin aide aider veux voudrais".split(" "));

function keyPhrases(text: string): string[] {
  const words = norm(text).match(/[a-z]{4,}/g) ?? [];
  const counts = new Map<string, number>();
  for (const w of words) if (!STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 6).map(([w]) => w);
}

export type PackDraftResult = { manifest: PackManifest; coverage: CoverageMap; detected: string };

export async function generatePackDraft(description: string, opts: { author?: string } = {}): Promise<PackDraftResult> {
  const text = description.trim();
  if (text.length < 20) throw new Error("Décrivez le métier en une ou deux phrases (20 caractères minimum).");
  const n = norm(text);
  const domain = DOMAINS.find((d) => d.test.test(n));
  const phrases = keyPhrases(text);
  const label = domain?.label ?? (phrases.slice(0, 2).map((p) => p[0].toUpperCase() + p.slice(1)).join(" / ") || "Métier");
  const id = `brouillon-${(domain?.id ?? (phrases[0] ?? "metier")).slice(0, 20)}-${Date.now().toString(36).slice(-5)}`;
  const tools = selectTools(text, ALL_TOOLS, { max: 12 }).tools.map((t) => t.name).filter((t) => t !== "charger_outils");

  const needs: CoverageNeed[] = phrases.slice(0, 4).map((p) => ({ id: `besoin_${p}`, label: `Textes sur « ${p} »`, match: [p], why: "Déduit de la description — à préciser par un expert du métier." }));
  const coverage = await corpusCoverage(needs);

  const tasks = domain?.tasks ?? ["Traiter une demande client", "Préparer un document", "Suivre les échéances"];
  const procedure: Procedure = {
    id: "traiter_demande",
    title: tasks[0],
    description: `Procédure type générée pour : ${text.slice(0, 200)} — À VALIDER par un expert du métier.`,
    inputs: [
      { id: "question", label: "Question ou demande à traiter", required: true },
      { id: "modele", label: "Modèle de document ({{champ}})", required: false },
      { id: "valeurs", label: "Informations pour remplir le modèle", required: false },
    ],
    deliverables: ["Extraits du corpus officiel cités", "Brouillon de document", "Message préparé (envoi simulé après approbation)"],
    outOfScope: ["Toute action externe réelle (envoi, paiement, dépôt) sans approbation humaine", "Avis juridique sur des textes absents du corpus"],
    tokenBudget: 4000,
    steps: [
      { id: "rechercher", title: "Rechercher les textes applicables", action: "moteur_rechercher_corpus", input: { question: "$input.question" }, criteria: [{ id: "cit", label: "Citations résolues dans le corpus", verifier: "citations_resolues" }] },
      { id: "brouillon", title: "Produire le brouillon", action: "moteur_brouillon_document", when: "$input.modele", input: { modele: "$input.modele", valeurs: "$input.valeurs" }, criteria: [{ id: "present", label: "Brouillon produit", verifier: "champs_presents", params: { fields: ["texte"] } }] },
      { id: "envoi", title: "Préparer l'envoi (approbation)", action: "moteur_preparer_envoi", risk: "envoyer", when: "$step.brouillon", input: { objet: "$input.question", corps: "$step.brouillon.texte", destinataire: "à compléter" }, criteria: [] },
    ],
  };

  const manifest: PackManifest = {
    id,
    version: "0.0.1",
    name: `${label} (brouillon)`,
    description: `Pack généré à partir de la description : « ${text.slice(0, 300)} ». Brouillon à valider : procédures, pièces, corpus et jeu d'évaluation doivent être relus par un expert du métier.`,
    audience: domain?.audience ?? ["à préciser"],
    status: "brouillon_a_valider",
    locale: "fr-CM",
    procedures: [procedure],
    templates: [],
    corpus: { needs },
    tools: [...new Set(["moteur_rechercher_corpus", "moteur_brouillon_document", "moteur_preparer_envoi", ...tools])],
    verifiers: ["citations_resolues", "champs_presents"],
    evaluation: { file: "eval/cases.json", cases: 0 },
    notes: [
      "BROUILLON GÉNÉRÉ AUTOMATIQUEMENT — à valider.",
      ...tasks.slice(1).map((t) => `Procédure suggérée à détailler : ${t}.`),
      ...coverage.needs.filter((x) => x.status !== "couvert").map((x) => `Corpus : « ${x.match[0]} » ${x.status === "absent" ? "absent du corpus" : "seulement mentionné dans d'autres textes"} — à compléter avant toute citation.`),
      "Jeu d'évaluation vide : ajouter des cas réels (entrée → attendu vérifiable) avant validation.",
    ],
    generatedFrom: text.slice(0, 1000),
  };
  return { manifest, coverage, detected: domain ? domain.label : "domaine non reconnu (procédure générique)" };
}
