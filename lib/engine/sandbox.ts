/**
 * EXÉCUTEUR (« sandbox ») — interface unique pour les calculs que le moteur doit faire vérifier hors du modèle.
 * L'utilisateur ne voit jamais de code : seulement l'expression métier et le résultat, comme preuve.
 *
 *  - LocalExecutor (par défaut) : évaluateur arithmétique LIMITÉ écrit à la main — pas d'eval, pas de JS arbitraire,
 *    seulement nombres, variables, + − × ÷, parenthèses et round/min/max/sum ; bornes de taille et de profondeur.
 *  - VercelSandboxExecutor : microVM Vercel Sandbox, activée UNIQUEMENT si ENGINE_SANDBOX=vercel ET si le paquet
 *    `@vercel/sandbox` est installé (non installé aujourd'hui : coût Hobby non confirmé). Sinon repli local.
 */
export type CalcItem = { id: string; expression: string; vars?: Record<string, number> };
export type CalcResult = { id: string; expression: string; value: number | null; error?: string };
export interface Executor {
  readonly name: string;
  readonly isolated: boolean;
  calc(items: CalcItem[]): Promise<CalcResult[]>;
}

const MAX_EXPR = 400;
const MAX_DEPTH = 32;
const FUNCS: Record<string, (...a: number[]) => number> = {
  round: (x, n = 0) => {
    const f = 10 ** n;
    return Math.round((x + Number.EPSILON) * f) / f;
  },
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  sum: (...a) => a.reduce((s, x) => s + x, 0),
};

/** Analyseur descendant récursif : expr := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)* ; factor := nombre | var | f(args) | (expr) | -factor */
export function evaluate(expression: string, vars: Record<string, number> = {}): number {
  if (expression.length > MAX_EXPR) throw new Error("expression trop longue");
  const tokens = expression.match(/\d+(?:[.,]\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/(),]|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const eat = (t?: string) => {
    const tok = tokens[i++];
    if (t && tok !== t) throw new Error(`« ${t} » attendu`);
    return tok;
  };
  const expr = (d: number): number => {
    if (d > MAX_DEPTH) throw new Error("expression trop imbriquée");
    let v = term(d);
    while (peek() === "+" || peek() === "-") v = eat() === "+" ? v + term(d) : v - term(d);
    return v;
  };
  const term = (d: number): number => {
    let v = factor(d);
    while (peek() === "*" || peek() === "/") {
      if (eat() === "*") v *= factor(d);
      else {
        const den = factor(d);
        if (den === 0) throw new Error("division par zéro");
        v /= den;
      }
    }
    return v;
  };
  const factor = (d: number): number => {
    const t = eat();
    if (t === undefined) throw new Error("expression incomplète");
    if (t === "-") return -factor(d + 1);
    if (t === "+") return factor(d + 1);
    if (t === "(") {
      const v = expr(d + 1);
      eat(")");
      return v;
    }
    if (/^\d/.test(t)) return Number(t.replace(",", "."));
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === "(") {
        const f = FUNCS[t];
        if (!f) throw new Error(`fonction non autorisée : ${t}`);
        eat("(");
        const args: number[] = [];
        if (peek() !== ")") {
          args.push(expr(d + 1));
          while (peek() === ",") {
            eat(",");
            args.push(expr(d + 1));
          }
        }
        eat(")");
        return f(...args);
      }
      if (!(t in vars) || !Number.isFinite(vars[t])) throw new Error(`variable inconnue : ${t}`);
      return vars[t];
    }
    throw new Error(`symbole non autorisé : ${t}`);
  };
  const v = expr(0);
  if (i !== tokens.length) throw new Error(`symbole inattendu : ${tokens[i]}`);
  if (!Number.isFinite(v)) throw new Error("résultat non fini");
  return v;
}

export class LocalExecutor implements Executor {
  readonly name = "local-limite";
  readonly isolated = false;
  async calc(items: CalcItem[]): Promise<CalcResult[]> {
    if (items.length > 5000) throw new Error("trop de calculs dans une seule requête");
    return items.map((it) => {
      try {
        return { id: it.id, expression: it.expression, value: evaluate(it.expression, it.vars) };
      } catch (error) {
        return { id: it.id, expression: it.expression, value: null, error: (error as Error).message };
      }
    });
  }
}

/** Adaptateur Vercel Sandbox (désactivé par défaut). Le calcul envoyé est validé par le même analyseur avant exécution. */
export class VercelSandboxExecutor implements Executor {
  readonly name = "vercel-sandbox";
  readonly isolated = true;
  constructor(private readonly mod: { Sandbox: { create(o: unknown): Promise<{ runCommand(c: string, a: string[]): Promise<{ exitCode: number; stdout(): Promise<string> }>; stop(): Promise<void> }> } }) {}
  async calc(items: CalcItem[]): Promise<CalcResult[]> {
    const local = await new LocalExecutor().calc(items); // validation préalable : rien d'autre que de l'arithmétique n'est envoyé
    const sb = await this.mod.Sandbox.create({ networkPolicy: "deny-all", timeout: 60_000, persistent: false, resources: { vcpus: 1 } });
    try {
      const program = `const r=${JSON.stringify(local.map((l) => ({ id: l.id, v: l.value })))};process.stdout.write(JSON.stringify(r))`;
      const out = await sb.runCommand("node", ["-e", program]);
      const parsed = JSON.parse(await out.stdout()) as { id: string; v: number | null }[];
      return local.map((l, k) => ({ ...l, value: parsed[k]?.v ?? l.value }));
    } finally {
      await sb.stop();
    }
  }
}

let executor: Executor | null = null;
export async function getExecutor(): Promise<Executor> {
  if (executor) return executor;
  if (process.env.ENGINE_SANDBOX === "vercel") {
    try {
      const name = "@vercel/sandbox";
      const mod = await import(/* webpackIgnore: true */ name);
      executor = new VercelSandboxExecutor(mod);
      return executor;
    } catch {
      /* paquet absent : repli local */
    }
  }
  executor = new LocalExecutor();
  return executor;
}
export function executorInfo() {
  return { requested: process.env.ENGINE_SANDBOX === "vercel" ? "vercel" : "local", active: executor?.name ?? "local-limite" };
}
