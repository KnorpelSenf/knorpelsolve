import { join } from "@std/path/join";
import { exists } from "@std/fs/exists";

/** options for creating a variable */
export interface VariableOptions {
  /** optional min constraint */
  min?: number;
  /** optional max constraint */
  max?: number;
  /** whether or not the variable must be an integer */
  integer?: boolean;
  /** optional initial value for hot starts */
  initial?: number;
}
/** variable in a MILP */
export interface Variable extends VariableOptions {
  /** name of the variable */
  name: string;
}
/** a single (in)equality in the MILP */
export interface Constraint {
  /** expression that is constrained to be zero or negative */
  expression: Expression;
  /** if isEquality, represents expression == 0, otherwise, expression <= 0 */
  isEquality: boolean;
}

/** affine linear expression */
export interface Expression {
  /** linear part of the expression */
  linear: LinearExpression;
  /** constant offset */
  constant: number;
}
/** a * x + b * y + c * z */
export interface LinearExpression {
  /** name -> { a, x } */
  coeff: Map<string, { /** a */ factor: number; /** x */ variable: Variable }>;
}

/** constructs an expression from a template string */
export function exp(
  expression: TemplateStringsArray,
  ...vars: Array<number | Variable | Expression>
): Expression;
/** converts a number or an expression to an expression */
export function exp(constant: number | Variable | Expression): Expression;
export function exp(
  constant: number | Variable | Expression | TemplateStringsArray,
  ...vars: Array<number | Variable | Expression>
): Expression {
  if (typeof constant === "number") {
    return { linear: { coeff: new Map() }, constant };
  }
  if ("name" in constant) {
    const coeff = new Map([[constant.name, { factor: 1, variable: constant }]]);
    return { linear: { coeff }, constant: 0 };
  }
  if ("linear" in constant) {
    return constant;
  }
  return parse(constant, vars);
}
/** a + b */
export function add(
  left: number | Variable | Expression,
  right: number | Variable | Expression,
): Expression {
  return addMul(left, 1, right);
}
/** a - b */
export function sub(
  left: number | Variable | Expression,
  right: number | Variable | Expression,
): Expression {
  return addMul(left, -1, right);
}
/** -a */
export function neg(
  expression: number | Variable | Expression,
): Expression {
  return addMul(0, -1, expression);
}
/** const * a */
export function mul(
  factor: number,
  expression: number | Variable | Expression,
): Expression {
  return addMul(0, factor, expression);
}
/** a / const */
export function div(
  expression: number | Variable | Expression,
  factor: number,
): Expression {
  return addMul(0, 1.0 / factor, expression);
}
/** a + (const * b) */
export function addMul(
  expression: number | Variable | Expression,
  coefficient: number,
  other: number | Variable | Expression,
): Expression {
  expression = exp(expression);
  other = exp(other);

  const res = structuredClone(expression);
  for (const { variable, factor } of other.linear.coeff.values()) {
    let existing = res.linear.coeff.get(variable.name);
    if (existing === undefined) {
      existing = { variable, factor: 0 };
      res.linear.coeff.set(variable.name, existing);
    }
    existing.factor += coefficient * factor;
  }
  res.constant += coefficient * other.constant;
  return res;
}

function parse(
  strings: TemplateStringsArray,
  vars: Array<number | Variable | Expression>,
): Expression {
  if (vars.length + 1 !== strings.length) throw new Error("bad parse");

  type Tok =
    | { kind: "op"; value: "+" | "-" | "*" | "/" }
    | { kind: "brac"; value: "(" | ")" }
    | { kind: "lit"; value: number }
    | { kind: "exp"; value: Expression };
  function* tokenize(): Generator<Tok> {
    yield { kind: "brac", value: "(" };
    let needsOp = false;
    for (let i = 0; i < strings.length; i++) {
      const piece = strings[i];
      const tokenizer =
        /\s*((?:[+-]?\d+(?:\.\d+)?)|[+\-*/()]|(?:[\s\S]+$))\s*/y;
      let token: RegExpExecArray | null;
      while ((token = tokenizer.exec(piece)) != null) {
        const value = token[1];
        switch (value) {
          case "+":
          case "-":
          case "*":
          case "/":
            needsOp = false;
            yield { kind: "op", value };
            break;
          case "(":
            needsOp = false;
            yield { kind: "brac", value };
            break;
          case ")":
            needsOp = true;
            yield { kind: "brac", value };
            break;
          default: {
            const num = parseFloat(value);
            if (!Number.isNaN(num)) {
              if (needsOp) yield { kind: "op", value: "+" };
              yield { kind: "lit", value: num };
              needsOp = true;
              break;
            }
            // bad input, throw error
            const char = value[0];
            const input = strings.raw.map((str, idx) => {
              if (idx >= vars.length) return str;
              const exp = vars[idx];
              if (typeof exp === "number") return str + exp;
              if ("name" in exp) return str + exp.name;
              return "<exp>";
            }).join("");
            let msg =
              `unexpected character '${char}'\n  at index ${token.index}`;
            if (input !== piece) msg += `\n  in the part '${piece}'`;
            msg += `\n  in the expression '${input}'`;
            throw new Error(msg);
          }
        }
      }
      if (i < vars.length) {
        const value = vars[i];
        needsOp = true;
        yield typeof value === "number"
          ? { kind: "lit", value }
          : { kind: "exp", value: exp(value) };
      }
    }
    yield { kind: "brac", value: ")" };
  }

  type AstNode =
    | { kind: "lit"; value: number }
    | { kind: "exp"; value: Variable | Expression }
    | { kind: "bin"; op: "+" | "-" | "*" | "/"; left: AstNode; right: AstNode };
  function generateAst(): AstNode {
    const tokens = Array.from(tokenize());
    let pos = 0;
    function peek(): Tok | undefined {
      return tokens[pos];
    }
    function next(): Tok {
      return tokens[pos++];
    }

    function primary(): AstNode {
      const token = next();
      if (!token) throw new Error("Unexpected end of expression");

      if (token.kind === "lit" || token.kind === "exp") {
        return token;
      }
      if (token.kind === "brac" && token.value === "(") {
        const node = expression();
        const closing = next();
        if (!closing || closing.kind !== "brac" || closing.value !== ")") {
          throw new Error("Expected ')'");
        }
        return node;
      }
      throw new Error(`Unexpected token: ${Deno.inspect(token)}`);
    }
    function product(): AstNode {
      let node = primary();
      while (
        peek()?.kind === "op" &&
        (peek()?.value === "*" || peek()?.value === "/")
      ) {
        const opToken = next() as { kind: "op"; value: "*" | "/" };
        const right = primary();
        node = { kind: "bin", op: opToken.value, left: node, right };
      }
      return node;
    }
    function sum(): AstNode {
      let node = product();
      while (
        peek()?.kind === "op" &&
        (peek()?.value === "+" || peek()?.value === "-")
      ) {
        const opToken = next() as { kind: "op"; value: "+" | "-" };
        const right = product();
        node = { kind: "bin", op: opToken.value, left: node, right: right };
      }
      return node;
    }
    function expression(): AstNode {
      return sum();
    }

    const ast = expression();
    if (pos < tokens.length) {
      throw new Error(
        `Unexpected token at end of expression: ${Deno.inspect(peek())}`,
      );
    }
    return ast;
  }

  function evaluate(ast: AstNode): number | Expression {
    switch (ast.kind) {
      case "lit":
        return ast.value;
      case "exp":
        return exp(ast.value);
      case "bin": {
        const left = evaluate(ast.left);
        const right = evaluate(ast.right);
        switch (ast.op) {
          case "+":
            return typeof left === "number" && typeof right === "number"
              ? left + right
              : add(left, right);
          case "-":
            return typeof left === "number" && typeof right === "number"
              ? left - right
              : sub(left, right);
          case "*": {
            if (typeof left === "number" && typeof right === "number") {
              return left * right;
            }
            if (typeof left === "number") {
              return mul(left, right);
            }
            if (typeof right === "number") {
              return mul(right, left);
            }
            throw new Error(
              "Multiplication is only supported between an expression and a number.",
            );
          }
          case "/": {
            if (typeof right === "number") {
              return typeof left === "number" ? left / right : div(left, right);
            }
            throw new Error("Division is only supported by a number.");
          }
        }
      }
    }
  }

  const ast = generateAst();
  return exp(evaluate(ast));
}

/** MILP solution as map from variable name to value */
export interface Solution {
  /** solution status */
  status: "optimal" | "unbounded" | "infeasible";
  /** solution values */
  values: Map<string, number>;
}

/** MILP problem definition */
export interface Problem {
  /** adds a variable and returns it */
  variable(name: string, options?: VariableOptions): Variable;
  /** adds a constraint and returns it */
  constraint(
    left: number | Variable | Expression,
    operator: "<=" | "==" | ">=",
    right: number | Variable | Expression,
  ): Constraint;
  /** solves the MILP by finding a minimum */
  minimize(objective: Variable | Expression, options?: SolveOptions): Solution;
  /** solves the MILP by finding a maximum */
  maximize(objective: Variable | Expression, options?: SolveOptions): Solution;
}

/** options for the solution process */
export interface SolveOptions {
  /** whether to log output while solving the problem */
  verbose?: boolean;
}

function problem(ffi: Ffi): () => Problem {
  return () => {
    const vars: Map<string, Variable> = new Map();
    const conss: Constraint[] = [];
    return {
      variable(name, options) {
        if (vars.has(name)) throw new Error(`variable '${name}' exists`);
        const v = Object.freeze({ name, ...options });
        vars.set(name, v);
        return v;
      },
      constraint(left, operator, right) {
        const expression = operator === ">="
          ? sub(right, left)
          : sub(left, right);
        const isEquality = operator === "==";
        const cons = { expression, isEquality };
        conss.push(cons);
        return cons;
      },
      minimize(objective, options) {
        return solve(ffi, "min", vars, exp(objective), conss, {
          verbose: options?.verbose ?? false,
        });
      },
      maximize(objective, options) {
        return solve(ffi, "max", vars, exp(objective), conss, {
          verbose: options?.verbose ?? false,
        });
      },
    };
  };
}

interface CoeffVar {
  name: string;
  factor: number;
}
interface MessageProblem {
  direction: "min" | "max";
  variables: Array<
    {
      name: string;
      min: number | null;
      max: number | null;
      initial: number | null;
      integer: boolean;
    }
  >;
  objective: CoeffVar[];
  objective_offset: number;

  constraints: CoeffVar[][];
  constraint_offsets: number[];

  equalities: CoeffVar[][];
  equalities_offsets: number[];

  verbose: boolean;
}
interface MessageSolution {
  status: "optimal" | "unbounded" | "infeasible";
  values: number[];
}

function solve(
  ffi: Ffi,
  direction: "min" | "max",
  vars: Map<string, Variable>,
  obj: Expression,
  conss: Constraint[],
  options: { verbose: boolean },
): Solution {
  const variables = vars.values()
    .map((v) => ({
      name: v.name,
      min: v.min ?? null,
      max: v.max ?? null,
      initial: v.initial ?? null,
      integer: v.integer ?? false,
    }))
    .toArray();

  const objective = obj.linear.coeff.values()
    .map((v) => ({ name: v.variable.name, factor: v.factor }))
    .toArray();
  const objective_offset = obj.constant;

  const constraints = conss.filter((c) => !c.isEquality)
    .map((c) =>
      c.expression.linear.coeff.values()
        .map((v) => ({ name: v.variable.name, factor: v.factor }))
        .toArray()
    );
  const constraint_offsets = conss.filter((c) => !c.isEquality)
    .map((c) => c.expression.constant);

  const equalities = conss.filter((c) => c.isEquality)
    .map((c) =>
      c.expression.linear.coeff.values()
        .map((v) => ({ name: v.variable.name, factor: v.factor }))
        .toArray()
    );
  const equalities_offsets = conss.filter((c) => c.isEquality)
    .map((c) => c.expression.constant);

  const msg: MessageProblem = {
    direction,
    variables,
    objective,
    objective_offset,
    constraints,
    constraint_offsets,
    equalities,
    equalities_offsets,
    verbose: options.verbose,
  };
  const solution = io(ffi, msg);
  return {
    status: solution.status,
    values: new Map(variables.map((v, i) => [v.name, solution.values[i]])),
  };
}

const ffi = {
  solve: { parameters: ["buffer", "usize"], result: "pointer" },
  free: { parameters: ["pointer"], result: "void" },
} as const;
type Ffi = ReturnType<typeof Deno.dlopen<typeof ffi>>["symbols"];

function io(ffi: Ffi, msg: MessageProblem): MessageSolution {
  const buf = new TextEncoder().encode(JSON.stringify(msg));
  const ptr = ffi.solve(buf, BigInt(buf.length));
  if (ptr === null) throw new Error("rcv bad buffer");
  try {
    const str = Deno.UnsafePointerView.getCString(ptr);
    const res: MessageSolution = JSON.parse(str);
    return res;
  } finally {
    ffi.free(ptr);
  }
}

/** options for loading the library */
export interface LoadOptions {
  /** custom cache directory for binary files */
  cacheDir?: string;
}
/** library which lets you create and solve MILPs */
export interface Library {
  /** creates a new MILP defintion */
  problem(): Problem;

  /** location of loaded binary on disk */
  binaryPath: string;
  /** purges temporary files */
  [Symbol.dispose](): void;
}
/** loads the library */
export async function load(options?: LoadOptions): Promise<Library> {
  const file = await cache(options);
  return loadCached(file);
}
/** loads the library from a known cache location */
export function loadCached(binaryPath: string): Library {
  const lib = Deno.dlopen(binaryPath, ffi);
  return {
    problem: problem(lib.symbols),

    binaryPath: binaryPath,
    [Symbol.dispose]: () => lib.close(),
  };
}

async function cache(options?: { cacheDir?: string }) {
  const { default: manifest } = await import("./deno.json", {
    with: { type: "json" },
  });
  if (!("name" in manifest) || typeof manifest.name !== "string") {
    throw new Error("Could not determine version");
  }
  if (!("version" in manifest) || typeof manifest.version !== "string") {
    throw new Error("Could not determine version");
  }
  const name = manifest.name;
  const version = manifest.version;
  const source =
    `https://jsr.io/${name}/${version}/target/release/libknorpelsolve.so`;

  const cacheDir = options?.cacheDir ?? join(
    (await import("node:os")).homedir(),
    ".cache",
    "libknorpelsolve",
    version,
  );
  await Deno.mkdir(cacheDir, { recursive: true });
  const dest = join(cacheDir, "libknorpelsolve.so");

  await cacheFile(cacheDir, source, dest);

  return dest;
}
async function cacheFile(dir: string, source: string, dest: string) {
  if (await exists(dest, { isFile: true })) {
    return;
  }

  const tempDest = await Deno.makeTempFile({ dir });
  {
    await using tempFile = await Deno.open(tempDest, { write: true });
    const response = await fetch(source);
    if (response.body === null) throw new Error("Could not fetch library");
    await response.body.pipeTo(tempFile.writable);
  }
  await Deno.rename(tempDest, dest);
}

if (import.meta.main) {
  console.log(await cache());
}
