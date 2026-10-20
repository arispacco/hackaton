import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempDb } from "./setup-db";
import { runAgent, agentRunner } from "@/lib/agent/runner";
import { getSnapshot } from "@/lib/workspace/service";
import { estimateTokens, MAX_INPUT_TOKENS } from "@/lib/agent/runner";

/**
 * PARITÉ des deux runners (maison vs Vercel AI SDK) : mêmes scénarios, même LLM simulé (fetch),
 * on compare réponse, mode, trace d'outils, effets en base (approbations) et requêtes envoyées.
 */
type Body = { messages?: { role: string; content: unknown }[]; tools?: { function: { name: string; parameters: unknown } }[]; contents?: unknown[] };
type Script = (n: number, body: Body) => { status?: number; json: unknown };

const toolNames = (body: Body) => ((body.tools ?? []) as { function?: { name: string }; functionDeclarations?: { name: string }[] }[])
  .flatMap((t) => (t.function ? [t.function.name] : (t.functionDeclarations ?? []).map((f) => f.name))).sort();
const oa = (message: Record<string, unknown>) => ({ json: { id: "x", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", ...message } }] } });
const call = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

async function run(runner: "legacy" | "ai-sdk", env: Record<string, string>, script: Script, question: string) {
  useTempDb();
  for (const k of ["GROQ_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "LLM_PROVIDER", "AGENT_PROVIDER"]) delete process.env[k];
  Object.assign(process.env, env, { AGENT_RUNNER: runner === "ai-sdk" ? "ai-sdk" : "" });
  const bodies: Body[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    bodies.push(body);
    const r = script(bodies.length, body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json", "retry-after": "1" } });
  }));
  expect(agentRunner()).toBe(runner);
  const { company } = await getSnapshot("co_kmerlog");
  const reply = await runAgent(company, [{ role: "user", content: question }]);
  const snap = await getSnapshot("co_kmerlog");
  vi.unstubAllGlobals();
  return { reply, bodies, snap };
}

const scenarios: { name: string; env: Record<string, string>; q: string; script: Script }[] = [
  { name: "Groq : outil puis réponse", env: { GROQ_API_KEY: "k", LLM_PROVIDER: "groq" }, q: "Rappelle-moi d'appeler la banque",
    script: (n) => (n === 1 ? oa({ content: null, tool_calls: [call("c1", "creer_tache", { titre: "Appeler la banque", echeance: null })] }) : oa({ content: "C'est noté, tâche créée." })) },
  { name: "Groq : email externe → file d'approbation, jamais envoyé", env: { GROQ_API_KEY: "k", LLM_PROVIDER: "groq" }, q: "Écris un email à la banque pour un rendez-vous",
    script: (n) => (n === 1 ? oa({ content: null, tool_calls: [call("c1", "rediger_email", { destinataires: ["banque@example.com"], objet: "Rendez-vous", corps: "Bonjour, … Cordialement" })] }) : oa({ content: "L'email attend votre validation dans Approbations." })) },
  { name: "Groq : charger_outils étend les outils", env: { GROQ_API_KEY: "k" }, q: "Bonjour",
    script: (n) => (n === 1 ? oa({ content: "", tool_calls: [call("c1", "charger_outils", { module: "etat" })] }) : oa({ content: "Base juridique : non couvert par le corpus officiel. Voici la suite." })) },
  { name: "Groq 413 → démo + quota", env: { GROQ_API_KEY: "k" }, q: "Liste mes tâches",
    script: () => ({ status: 413, json: { error: { code: "rate_limit_exceeded", message: "Request too large" } } }) },
  { name: "Groq 400 tool_use_failed retenté une fois", env: { GROQ_API_KEY: "k" }, q: "Mon score ?",
    script: (n) => (n === 1 ? { status: 400, json: { error: { code: "tool_use_failed", message: "bad" } } } : oa({ content: "Votre score est prêt." })) },
  { name: "Gemini : functionCall → texte", env: { GEMINI_API_KEY: "k", LLM_PROVIDER: "gemini" }, q: "Mon score ?",
    script: (n) => ({ json: n === 1 ? { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "score_conformite", args: {} } }] }, finishReason: "STOP" }] } : { candidates: [{ content: { role: "model", parts: [{ text: "Votre score est de 41/100." }] }, finishReason: "STOP" }] } }) },
  { name: "Démo sans clé", env: {}, q: "Quel est mon score de conformité ?", script: () => ({ json: {} }) },
];

describe("parité runner maison ↔ runner AI SDK (LLM simulé)", () => {
  beforeEach(useTempDb);
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.AGENT_RUNNER; });
  for (const s of scenarios) {
    it(s.name, async () => {
      const a = await run("legacy", s.env, s.script, s.q);
      const b = await run("ai-sdk", s.env, s.script, s.q);
      expect(b.reply.mode).toBe(a.reply.mode);
      expect(b.reply.answer).toBe(a.reply.answer);
      expect(b.reply.toolTrace.map((t) => [t.tool, t.ok, t.input])).toEqual(a.reply.toolTrace.map((t) => [t.tool, t.ok, t.input]));
      expect(b.reply.citations.length).toBe(a.reply.citations.length);
      expect(Boolean(b.reply.notice)).toBe(Boolean(a.reply.notice));
      if (a.reply.notice) expect(b.reply.notice?.replace(/\(.*\)/, "")).toBe(a.reply.notice.replace(/\(.*\)/, ""));
      expect(b.reply.provider).toBe(a.reply.provider);
      expect(b.bodies.length).toBe(a.bodies.length);
      expect(b.snap.approvals.length).toBe(a.snap.approvals.length);
      expect(b.snap.tasks.length).toBe(a.snap.tasks.length);
      for (let i = 0; i < a.bodies.length; i += 1) {
        const ta = toolNames(a.bodies[i]);
        const tb = toolNames(b.bodies[i]);
        expect(tb).toEqual(ta);
        if (!b.bodies[i].contents && b.bodies[i].tools) expect(estimateTokens(b.bodies[i].messages) + estimateTokens(b.bodies[i].tools)).toBeLessThan(MAX_INPUT_TOKENS);
      }
      if (s.name.includes("email")) {
        expect(b.snap.approvals.at(-1)?.status ?? "").not.toMatch(/sent|envoy/i);
        const sch = JSON.stringify(b.bodies[0].tools?.find((t) => t.function.name === "creer_tache")?.function.parameters ?? {});
        if (sch !== "{}") expect(sch).toContain("null");
      }
    }, 60000);
  }
});
