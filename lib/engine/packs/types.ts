import type { RiskLevel } from "../approvals";
import type { CoverageNeed } from "../coverage";
import type { Executor } from "../sandbox";
import type { SourceDoc } from "../citations";

/**
 * PACK MÉTIER = dossier versionné `packs/<id>/` :
 *   manifest.json   — identité, version, procédures (étapes + critères), modèles, sous-corpus, outils, vérificateurs, évaluation
 *   templates/*.md  — modèles de documents
 *   eval/cases.json — jeu d'évaluation (entrées → attendus vérifiables)
 *   fixtures/       — données de test (sources réelles datées, ou seed marqué « exemple »)
 * Le code exécutable d'un pack (actions, vérificateurs) vit dans lib/packs/<id>/ et est déclaré dans le registre.
 */
export type Criterion = { id: string; label: string; verifier: string; params?: Record<string, unknown> };
export type StepSpec = {
  id: string;
  title: string;
  /** Action du pack (ou du moteur) exécutée à l'étape « agir ». */
  action: string;
  /** Entrée : valeurs littérales ou références « $input.x » (entrée de mission) / « $step.<id> » (sortie d'une étape). */
  input?: Record<string, unknown>;
  criteria: Criterion[];
  maxAttempts?: number;
  /** Niveau de risque : envoyer / payer_deposer ⇒ approbation humaine avant exécution. */
  risk?: RiskLevel;
  /** Étape facultative : sautée si la condition (référence) est vide/fausse. */
  when?: string;
};
export type Procedure = { id: string; title: string; description: string; inputs: { id: string; label: string; required: boolean; example?: string }[]; deliverables: string[]; outOfScope: string[]; tokenBudget: number; steps: StepSpec[] };
export type PackManifest = {
  id: string;
  version: string;
  name: string;
  description: string;
  audience: string[];
  status: "valide" | "brouillon_a_valider";
  locale: string;
  procedures: Procedure[];
  templates: { id: string; title: string; file: string; description: string }[];
  corpus: { needs: CoverageNeed[]; categories?: string[] };
  tools: string[];
  verifiers: string[];
  evaluation: { file: string; cases?: number };
  fixtures?: { id: string; title: string; file: string; origin: "source_publique" | "exemple"; source?: string; verifiedAt?: string }[];
  humanOnly?: string[];
  notes?: string[];
  generatedFrom?: string;
};

export type Evidence = { label: string; kind: "verification" | "citation" | "calcul" | "piece" | "approbation" | "info"; ok: boolean; detail: string; warning?: boolean; data?: unknown };
export type ActionCtx = { companyId: string; missionId?: string; actor: string; executor: Executor; docs: SourceDoc[] };
export type ActionResult = { output: unknown; summary: string; tokens?: number; docs?: SourceDoc[] };
export type PackAction = {
  name: string;
  description: string;
  risk: RiskLevel;
  run(input: Record<string, unknown>, ctx: ActionCtx): Promise<ActionResult>;
  /** Pour les actions à risque : aperçu EXACT de ce qui sera fait (soumis à approbation). */
  preview?(input: Record<string, unknown>, ctx: ActionCtx): Promise<{ title: string; lines: string[]; payload: unknown }>;
};
export type PackVerifier = (output: unknown, params: Record<string, unknown>, ctx: ActionCtx) => Promise<Evidence[]> | Evidence[];
export type EvalOutcome = { id: string; ok: boolean; checks: { label: string; ok: boolean; detail: string }[] };
export type PackRuntime = { manifest: PackManifest; actions: Record<string, PackAction>; verifiers: Record<string, PackVerifier>; evaluate?: () => Promise<EvalOutcome[]> };
