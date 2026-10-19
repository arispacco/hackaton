import {
  Activity, AlertTriangle, BarChart3, Bot, CalendarCheck, ClipboardList, FileSearch, FileText, FolderLock,
  Gavel, GraduationCap, HandCoins, Inbox, Landmark, Lightbulb, LineChart, ListTodo, MessagesSquare, Mic, Plug, Radar, Scale,
  ShieldCheck, ShieldAlert, Sparkles, Store, Truck, Users, UserSearch, Wallet, BadgeCheck, Brain, SlidersHorizontal,
  LayoutDashboard, Boxes, Route, FileCheck2, type LucideIcon,
} from "lucide-react";

/**
 * CATALOGUE DE NAVIGATION DU WORKSPACE — groupé par niveau (vision « 3 niveaux » + connecteurs).
 *
 * Convention (voir /workspace/hackaton-plan/conventions.md) :
 *  - les onglets « core » sont rendus par app/workspace/page.tsx ;
 *  - les onglets « module » sont rendus via MODULE_SLOTS (components/workspace/module-slots.tsx) ;
 *    tant qu'un module n'a pas de composant, un emplacement « en construction » s'affiche.
 *  - pour ajouter un module : une ligne dans la liste de son niveau (ici) + une ligne dans module-slots.tsx.
 */
export type Level = "general" | "entrepreneur" | "entreprise" | "etat" | "packs" | "connecteurs";

export type NavEntry = {
  id: string;
  label: string;
  icon: LucideIcon;
  level: Level;
  /** core = onglet historique ; module = rendu via MODULE_SLOTS. */
  kind: "core" | "module";
  /** Équipe responsable (pour l'emplacement « en construction »). */
  team?: string;
  description?: string;
  /** true : données entièrement fictives (niveau État). */
  demoOnly?: boolean;
};

export const LEVELS: { id: Level; label: string; hint: string }[] = [
  { id: "general", label: "Pilotage", hint: "Agent, approbations, tâches" },
  { id: "entrepreneur", label: "Entrepreneur", hint: "De l'idée à la startup opérationnelle" },
  { id: "entreprise", label: "Entreprise", hint: "Données, finances, risques, équipe" },
  { id: "etat", label: "État (démo)", hint: "Macroéconomie et crise — données fictives" },
  { id: "packs", label: "Packs métier", hint: "Moteur d'agents par métier : missions vérifiées, approbations" },
  { id: "connecteurs", label: "Connecteurs", hint: "MCP et outils externes" },
];

export const NAV: NavEntry[] = [
  // ── Pilotage (core)
  { id: "tableau", label: "Tableau de bord", icon: LayoutDashboard, level: "general", kind: "core" },
  { id: "agent", label: "Agent co-fondateur", icon: Bot, level: "general", kind: "core" },
  { id: "approbations", label: "Approbations", icon: ShieldCheck, level: "general", kind: "core" },
  { id: "envoi", label: "Boîte d'envoi", icon: Inbox, level: "general", kind: "core" },
  { id: "taches", label: "Tâches", icon: ListTodo, level: "general", kind: "core" },
  { id: "journal", label: "Journal d'audit", icon: Activity, level: "general", kind: "core" },

  // ── Niveau 1 : Entrepreneur
  { id: "idea", label: "Idée (diagnostic)", icon: Lightbulb, level: "entrepreneur", kind: "module", team: "entrepreneur", description: "Diagnostic honnête de l'idée : forces, faiblesses, concurrents, obstacles réglementaires cités, pivots." },
  { id: "structure", label: "Structure juridique", icon: Scale, level: "entrepreneur", kind: "module", team: "fondation", description: "Choix guidé de la structure, simulateur de création, pacte d'associés avec vesting, guide d'immatriculation." },
  { id: "demarches", label: "Démarches", icon: ClipboardList, level: "entrepreneur", kind: "core" },
  { id: "juridique", label: "Recherche juridique", icon: Gavel, level: "entrepreneur", kind: "core" },
  { id: "documents", label: "Documents", icon: FileText, level: "entrepreneur", kind: "core" },
  { id: "fund", label: "Financements", icon: HandCoins, level: "entrepreneur", kind: "module", team: "entrepreneur", description: "Base de financements, éligibilité, dossier, suivi et relances avec approbation." },
  { id: "team", label: "Équipe & recrutement", icon: UserSearch, level: "entrepreneur", kind: "module", team: "entrepreneur", description: "Écarts de compétences, fiches de poste, filtrage des candidatures, prévention du biais affinitaire." },
  { id: "mentor", label: "Mentors", icon: GraduationCap, level: "entrepreneur", kind: "module", team: "entrepreneur", description: "Réseau de mentors (seed) et mise en relation." },
  { id: "market", label: "Marché B2B", icon: Store, level: "entrepreneur", kind: "module", team: "entrepreneur", description: "Place de marché B2B à partir de l'annuaire fournisseurs (seed)." },
  { id: "studio", label: "Studio co-fondateur", icon: Sparkles, level: "entrepreneur", kind: "core" },

  // ── Niveau 2 : Entreprise
  { id: "fournisseurs", label: "Fournisseurs & devis", icon: Truck, level: "entreprise", kind: "core" },
  { id: "data", label: "Données", icon: BarChart3, level: "entreprise", kind: "module", team: "entreprise", description: "Import CSV/Excel, tableaux de bord, anomalies, trésorerie prévisionnelle, rapport hebdomadaire." },
  { id: "finance", label: "Finances", icon: Wallet, level: "entreprise", kind: "module", team: "entreprise", description: "Budget, dépenses, revenus, trésorerie, alertes." },
  { id: "intel", label: "Veille & appels d'offres", icon: Radar, level: "entreprise", kind: "module", team: "entreprise", description: "Veille sectorielle, alertes d'appels d'offres (seed)." },
  { id: "risk", label: "Risques", icon: ShieldAlert, level: "entreprise", kind: "module", team: "entreprise", description: "Profil de risque et simulation de stress." },
  { id: "due-diligence", label: "Due diligence", icon: FileSearch, level: "entreprise", kind: "module", team: "entreprise", description: "Analyse des partenaires et fournisseurs (données seedées)." },
  { id: "data-room", label: "Data room", icon: FolderLock, level: "entreprise", kind: "module", team: "entreprise", description: "Data room investisseur générée automatiquement." },
  { id: "memoire", label: "Mémoire", icon: Brain, level: "entreprise", kind: "module", team: "memoire", description: "Questions/réponses sur l'historique avec liens vers les sources." },
  { id: "reunions", label: "Salle de réunion", icon: Mic, level: "entreprise", kind: "module", team: "memoire", description: "Transcription, résumé, décisions, tâches, « ce que j'ai manqué »." },
  { id: "score", label: "Score de crédibilité", icon: BadgeCheck, level: "entreprise", kind: "module", team: "memoire", description: "Score signé cryptographiquement et vérifiable publiquement." },
  { id: "comms", label: "Communications", icon: MessagesSquare, level: "entreprise", kind: "module", team: "mcp-connecteurs", description: "Boîte unifiée (emails, WhatsApp en démo) via les connecteurs MCP, classement, réponses suggérées (envois via approbation, simulés par défaut)." },
  { id: "conformite", label: "Conformité & calendrier", icon: CalendarCheck, level: "entreprise", kind: "core" },
  { id: "veille", label: "Veille réglementaire", icon: Radar, level: "entreprise", kind: "core" },
  { id: "equipe", label: "Membres", icon: Users, level: "entreprise", kind: "core" },

  // ── Niveau 3 : État (démo, données fictives)
  { id: "macro", label: "Tableau de bord macro", icon: LineChart, level: "etat", kind: "module", team: "etat", demoOnly: true, description: "Indicateurs macroéconomiques (données fictives)." },
  { id: "crise", label: "Crise & communication", icon: AlertTriangle, level: "etat", kind: "module", team: "etat", demoOnly: true, description: "Alertes et plan de communication citoyenne segmenté (démo)." },
  { id: "citizen", label: "Citizen Econ", icon: Landmark, level: "etat", kind: "module", team: "etat", demoOnly: true, description: "Conseils économiques citoyens (démo)." },
  { id: "policy", label: "Simulateur de politiques", icon: SlidersHorizontal, level: "etat", kind: "module", team: "etat", demoOnly: true, description: "Simulation de politiques publiques (démo)." },

  // ── Connecteurs
  { id: "connecteurs", label: "Connecteurs MCP", icon: Plug, level: "connecteurs", kind: "module", team: "mcp-connecteurs", description: "Connexions réelles (MCP, API officielles) avec bascule démo." },
  // ↓ nouveaux onglets : une ligne par entrée, ajoutée en fin de liste
  { id: "bas-debit", label: "Bas débit & vocal", icon: Mic, level: "general", kind: "module", team: "memoire", description: "Interface allégée, réponses courtes, file hors ligne, dictée et lecture vocale." },
  { id: "packs", label: "Packs", icon: Boxes, level: "packs", kind: "module", team: "moteur", description: "Registre des packs métier, couverture du corpus, évaluation, générateur de brouillons." },
  { id: "ao", label: "Appels d'offres (CM)", icon: FileCheck2, level: "packs", kind: "module", team: "moteur", description: "Lecture de DAO, matrice de conformité, recalcul du bordereau, coffre-fort de pièces." },
  { id: "missions", label: "Missions & approbations", icon: Route, level: "packs", kind: "module", team: "moteur", description: "Plan, preuves, décisions humaines, file d'approbation, journal d'audit chaîné." },
];

