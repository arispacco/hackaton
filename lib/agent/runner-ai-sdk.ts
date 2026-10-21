/**
 * RUNNER « ai-sdk » — même boucle planifier/agir que runOpenAI/runGemini, mais déléguée au Vercel AI SDK (`ai`).
 * Activé uniquement si AGENT_RUNNER=ai-sdk ; le runner maison reste le défaut.
 *
 * Garde-fous conservés à l'identique (ils restent dans NOTRE code, jamais délégués au SDK) :
 *  - exécution des outils par execTool (null → absent, trace, file d'approbation interne aux outils externes) ;
 *  - sélection des outils (selectFor), charger_outils via activeTools, schémas nullableOptionals (Groq) ;
 *  - budget de jetons : fitBudget sur chaque étape (résultats d'outils puis historique) ;
 *  - 429 : même attente retry-after (fetchWithRateLimitRetry), 400 tool_use_failed retenté une fois ;
 *  - 413/429 → QuotaError (repli démo dans runAgent), post-contrôle checkReferences dans runAgent.
 */
import { APICallError, generateText, jsonSchema, stepCountIs, tool, type ModelMessage, type ToolSet } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { Company, ToolTrace } from "@/lib/workspace/types";
import type { AgentTool, ToolContext } from "./tools";
import { AGENT_MODULES } from "./registry";
import { compactSchema, LOAD_TOOLS } from "./tool-selection";
import {
  compactForModel, compactHistory, estimateTokens, execTool, fetchWithRateLimitRetry, MAX_INPUT_TOKENS, MAX_STEPS, nullableOptionals,
  QuotaError, selectFor, systemPrompt, TOOL_RESULT_CHARS, truncate, type AgentTurn, type Provider,
} from "./runner";

const FALLBACK = "J'ai effectué plusieurs actions (voir le détail ci-dessous). Dites-moi si je dois continuer.";

/** fetch du fournisseur : attente 429 identique au runner maison + une relance si gpt-oss produit un appel d'outil mal formé. */
export function guardedFetch(): typeof fetch {
  let toolRetryUsed = false;
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const go = () => fetchWithRateLimitRetry(String(url), init ?? {});
    const res = await go();
    if (res.status === 400 && !toolRetryUsed) {
      const detail = await res.clone().text().catch(() => "");
      if (/"code"\s*:\s*"tool_use_failed"/.test(detail)) {
        toolRetryUsed = true;
        return go();
      }
    }
    return res;
  }) as typeof fetch;
}

/** Budget appliqué aux messages AI SDK (équivalent de fitBudget : résultats d'outils, puis historique ancien). */
export function fitModelBudget(messages: ModelMessage[], schemas: unknown[], budget = MAX_INPUT_TOKENS): ModelMessage[] {
  const size = () => estimateTokens(messages) + estimateTokens(schemas);
  for (const limit of [1200, 600, 250]) {
    if (size() <= budget) break;
    for (const m of messages) {
      if (m.role !== "tool") continue;
      for (const part of m.content) {
        if (part.type === "tool-result" && part.output.type === "text" && part.output.value.length > limit) part.output = { type: "text", value: `${part.output.value.slice(0, limit)}…(tronqué)` };
      }
    }
  }
  for (let i = 1; size() > budget && i < messages.length - 2; i += 1) {
    const m = messages[i];
    if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 200) m.content = `${m.content.slice(0, 200)}…`;
  }
  return messages;
}

/**
 * Groq (et d'autres API compatibles OpenAI) refusent `reasoning_content` dans les messages assistant renvoyés
 * après un appel d'outil (HTTP 400). On retire donc les parties « reasoning » de l'historique — le runner maison
 * ne renvoie jamais le raisonnement non plus (parité).
 */
export function stripReasoning(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || typeof m.content === "string") return m;
    const content = m.content.filter((part) => part.type !== "reasoning");
    return content.length === m.content.length ? m : { ...m, content };
  });
}

function toToolSet(tools: AgentTool[], ctx: ToolContext, trace: ToolTrace[], nullable: boolean, onLoad: (module: string) => string | null): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    const params = (compactSchema(t, nullable ? nullableOptionals : (x) => x) as { function: { description: string; parameters: unknown } }).function;
    set[t.name] = tool<Record<string, unknown>, string>({
      description: params.description,
      inputSchema: jsonSchema<Record<string, unknown>>(params.parameters as Parameters<typeof jsonSchema>[0]),
      execute: async (args) => {
        const input = (args ?? {}) as Record<string, unknown>;
        if (t.name === LOAD_TOOLS.name) {
          const list = onLoad(String(input.module ?? ""));
          trace.push({ tool: LOAD_TOOLS.name, input, summary: list ? `Outils du module ${input.module} chargés` : "Module inconnu", ok: Boolean(list) });
          return truncate(list ? { resume: `Outils disponibles : ${list}` } : { error: "Module inconnu" }, TOOL_RESULT_CHARS);
        }
        // execTool = même chemin que le runner maison (stripNulls, approbations internes, trace).
        return truncate(compactForModel(await execTool(t.name, input, ctx, trace)), TOOL_RESULT_CHARS);
      },
      toModelOutput: ({ output }) => ({ type: "text", value: String(output) }),
    });
  }
  return set;
}

export async function runWithAiSdk(p: Provider, company: Company, history: AgentTurn[], ctx: ToolContext, trace: ToolTrace[], grounding: string): Promise<string> {
  const openai = p.kind === "openai";
  let selected = selectFor(history, ctx).tools;
  // Tous les outils atteignables sont déclarés ; seuls ceux « actifs » sont envoyés au modèle (charger_outils les étend).
  const universe = new Map<string, AgentTool>();
  for (const t of [...selected, ...AGENT_MODULES.flatMap((m) => m.tools), ...(ctx.extraTools ?? [])]) if (!universe.has(t.name)) universe.set(t.name, t);
  const onLoad = (id: string) => {
    if (!openai) return null;
    const mod = AGENT_MODULES.find((m) => m.id === id);
    if (!mod) return null;
    const names = new Set(selected.map((t) => t.name));
    selected = [...selected.filter((t) => t.name !== LOAD_TOOLS.name), ...mod.tools.filter((t) => !names.has(t.name)), LOAD_TOOLS];
    return mod.tools.map((t) => t.name).join(", ");
  };
  const tools = toToolSet([...universe.values()], ctx, trace, openai, onLoad);
  if (!openai) {
    // Parité Gemini : charger_outils ne fait rien de plus (comme runGemini).
    const load = tools[LOAD_TOOLS.name];
    if (load) load.execute = async () => truncate({ resume: "Outils déjà disponibles via la requête suivante." });
  }

  const history2 = compactHistory(history);
  const messages: ModelMessage[] = openai
    ? [...history2.map((h) => ({ role: h.role, content: h.content }) as ModelMessage), { role: "system", content: grounding }]
    : history2.map((h, i) => ({ role: h.role, content: i === history2.length - 1 ? `${h.content}\n\n[${grounding}]` : h.content }) as ModelMessage);

  const model = openai
    ? createOpenAICompatible({ name: p.name, baseURL: p.url.replace(/\/chat\/completions$/, ""), apiKey: p.key, fetch: guardedFetch() }).chatModel(p.model)
    : createGoogleGenerativeAI({ apiKey: p.key, fetch: ((u: RequestInfo | URL, i?: RequestInit) => fetch(u, { ...i, signal: i?.signal ?? AbortSignal.timeout(45000) })) as typeof fetch })(p.model);

  try {
    const result = await generateText({
      model,
      system: systemPrompt(company),
      messages,
      allowSystemInMessages: true,
      tools,
      activeTools: selected.map((t) => t.name),
      toolChoice: "auto",
      temperature: 0.2,
      maxOutputTokens: openai ? 1000 : 3000,
      maxRetries: 0, // les relances 429 sont faites par guardedFetch (même politique que le runner maison)
      stopWhen: stepCountIs(MAX_STEPS),
      prepareStep: ({ messages: msgs }) => {
        const active = selected.map((t) => t.name);
        if (!openai) return { activeTools: active };
        const schemas = selected.map((t) => compactSchema(t, nullableOptionals));
        return { activeTools: active, messages: fitModelBudget(stripReasoning(msgs), [systemPrompt(company), ...schemas]) };
      },
    });
    const last = result.steps.at(-1);
    if (last && last.toolCalls.length && result.steps.length >= MAX_STEPS) return FALLBACK;
    return result.text.trim();
  } catch (error) {
    if (APICallError.isInstance(error)) {
      const code = /"code"\s*:\s*"([^"]+)"/.exec(error.responseBody ?? "")?.[1];
      const message = `${openai ? p.name : "Gemini"} HTTP ${error.statusCode}${openai && code ? ` (${code})` : ""}`;
      console.error(message, (error.responseBody ?? "").slice(0, 300));
      if (error.statusCode === 413 || error.statusCode === 429) throw new QuotaError(message);
      throw new Error(message);
    }
    throw error;
  }
}
