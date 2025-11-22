import { join } from "@std/path/join";
import { exists } from "@std/fs/exists";
import { arch, homedir } from "node:os";

/** options for creating a {@link Variable} */
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
  /** sets min and max */
  bounds(min: number, max: number): this;
  /** sets integer = true */
  int(): this;
  /** sets min = 0 and max = 1 and integer = true */
  binary(): this;
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

/**
 * Constructs an {@link Expression} from a template string.
 *
 * ```ts
 * const a = problem.variable("a");
 * const b = problem.variable("b");
 * const expression = exp`${a} + 3 - (${b} / (-5.5 / 2))`;
 * const other = exp`7 * ${expression} - 2`;
 * ```
 */
export function exp(
  expression: TemplateStringsArray,
  ...vars: Array<number | Variable | Expression>
): Expression;
/**
 * Converts a number, a {@link Variable}, or an {@link Expression} to an
 * {@link Expression}.
 *
 * ```ts
 * const a = problem.variable("a");
 *
 * const expressions: Expression[] = [
 *   exp(0),
 *   exp(a),
 *   exp(exp(exp(42))),
 * ];
 * ```
 */
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
  return parse(constant, vars, { type: "expression" });
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

  // clone all factors, but share all variables
  const coeff = new Map(
    expression.linear.coeff.entries()
      .map(([name, { factor, variable }]) => [name, { factor, variable }]),
  );
  const res: Expression = { constant: expression.constant, linear: { coeff } };
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
  options: { type: "expression" },
): Expression;
function parse(
  strings: TemplateStringsArray,
  vars: Array<number | Variable | Expression>,
  options: { type: "constraint" },
): [Expression, "<=" | "==" | ">=", Expression];
function parse(
  strings: TemplateStringsArray,
  vars: Array<number | Variable | Expression>,
  options: { type: "expression" | "constraint" },
): Expression | [Expression, "<=" | "==" | ">=", Expression] {
  if (vars.length + 1 !== strings.length) throw new Error("bad parse");

  // === SCANNING ===
  type Tok =
    | { kind: "op"; value: "+" | "-" | "*" | "/" }
    | { kind: "brac"; value: "(" | ")" }
    | { kind: "lit"; value: number }
    | { kind: "exp"; value: Expression }
    | { kind: "cmp"; value: "<=" | "==" | ">=" };
  function* scan(): Generator<Tok> {
    let needsOp = false;
    for (let i = 0; i < strings.length; i++) {
      const piece = strings[i];
      const scanner =
        /\s*((?:[+-]?\d+(?:\.\d+)?)|[+\-*/()]|(?:<=|==|>=)|(?:[\s\S]+$))\s*/y;
      let token: RegExpExecArray | null;
      while ((token = scanner.exec(piece)) != null) {
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
          case "<=":
          case "==":
          case ">=":
            needsOp = false;
            yield { kind: "cmp", value };
            break;
          default: {
            const num = parseFloat(value);
            if (!Number.isNaN(num)) {
              if (needsOp && (value.startsWith("-") || value.startsWith("+"))) {
                yield { kind: "op", value: "+" };
              }
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
  }

  // === PARSING ===
  type AstNode =
    | { kind: "lit"; value: number }
    | { kind: "exp"; value: Variable | Expression }
    | { kind: "bin"; op: "+" | "-" | "*" | "/"; left: AstNode; right: AstNode }
    | { kind: "cmp"; op: "<=" | "==" | ">=" };
  const tokens = scan();
  let head = tokens.next().value;
  function peek(): Tok | undefined {
    return head;
  }
  function next(): Tok {
    const token = head;
    head = tokens.next().value;
    return token;
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
  function constraint(): [AstNode, "<=" | "==" | ">=", AstNode] {
    const left = expression();
    const cmp = next();
    if (cmp.kind !== "cmp") {
      throw new Error(
        `Expected one of '<=', '==', '>=' but got unexpected token: ${
          Deno.inspect(left)
        }`,
      );
    }
    const right = expression();
    return [left, cmp.value, right];
  }

  // === EVALUATING ===
  function evaluate(ast: AstNode): number | Expression {
    switch (ast.kind) {
      case "lit":
        return ast.value;
      case "exp":
        return exp(ast.value);
      case "cmp":
        throw new Error("Cannot evaluate constraint");
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

  // === EXECUTING ===
  if (options.type === "expression") {
    const e = expression();
    if (peek() !== undefined) {
      throw new Error(
        `Unexpected token at end of expression: ${Deno.inspect(peek())}`,
      );
    }
    return exp(evaluate(e));
  } else {
    const [l, cmp, r] = constraint();
    if (peek() !== undefined) {
      throw new Error(
        `Unexpected token at end of constraint: ${Deno.inspect(peek())}`,
      );
    }
    return [exp(evaluate(l)), cmp, exp(evaluate(r))];
  }
}

/** MILP solution as a map from each {@link Variable.name} to its value */
export interface Solution {
  /** solution status */
  status: "optimal" | "unbounded" | "infeasible";
  /** solution values, may be empty if no solution was found */
  values: Map<string, number>;
}

/**
 * MILP problem definition. Can be created after loading the library.
 *
 * ```ts
 * import { load } from "@knorpelsenf/knorpelsolve";
 *
 * const lib = await load();
 * // alternatively, load from a known path:
 * // const lib = loadCached("/path/to/libknorpelsolve.so")
 *
 * // create a new MILP problem
 * const problem: Problem = lib.problem();
 *
 * // define and solve problem
 * const a = p.variable("a", { max: 1 });
 * const solution = p.maximize(a);
 * console.log(solution.values);
 * ```
 */
export interface Problem {
  /**
   * Adds a variable and returns it.
   *
   * ```ts
   * // unbounded, continuous
   * const a = problem.variable("a");
   * // unbounded, integer
   * const b = problem.variable("b", { integer: true });
   * const c = problem.variable("c").int();
   * // bounded, continuous
   * const d = problem.variable("d", { min: 0 });
   * const e = problem.variable("e", { max: 10 });
   * const f = problem.variable("f").bounds(-5, 5);
   * // bounded, integer
   * const g = problem.variable("g").bounds(0, 1).int();
   * // binary
   * const h = problem.variable("h").binary();
   * ```
   */
  variable(name: string, options?: VariableOptions): Variable;

  /**
   * Adds a constraint based on a string expression and returns it.
   *
   * ```ts
   * const a = problem.variable("a");
   * const b = problem.variable("b");
   * problem.constraint`${a} + 4 >= (${b} - 1) / 2.0`;
   * ```
   */
  constraint(
    constraint: TemplateStringsArray,
    ...vars: Array<number | Variable | Expression>
  ): Constraint;
  /**
   * Adds a constraint and returns it.
   *
   * ```ts
   * const a = problem.variable("a");
   * const b = problem.variable("b");
   * problem.constraint(add(a, 4), ">=", exp`(${b} - 1) / 2.0`);
   * ```
   */
  constraint(
    left: number | Variable | Expression,
    operator: "<=" | "==" | ">=",
    right: number | Variable | Expression,
  ): Constraint;

  /**
   * Solves the MILP by finding a minimum defined as a template string.
   *
   * ```ts
   * const a = problem.variable("a");
   * const b = problem.variable("b");
   * const solution = problem.minimize`10 * (${a} - ${b} / 5) - ${b}`;
   * ```
   */
  minimize(
    objective: TemplateStringsArray,
    ...vars: Array<number | Variable | Expression>
  ): Solution;
  /**
   * Solves the MILP by finding a minimum of an expression.
   *
   * ```ts
   * const a = problem.variable("a").bounds(-5, 5);
   * const solution = problem.minimize(a, { verbose: true });
   * ```
   */
  minimize(objective: Variable | Expression, options?: SolveOptions): Solution;

  /**
   * Solves the MILP by finding a maximum defined as a template string.
   *
   * ```ts
   * const a = problem.variable("a");
   * const b = problem.variable("b");
   * const solution = problem.maximize`10 * (${a} - ${b} / 5) - ${b}`;
   * ```
   */
  maximize(
    objective: TemplateStringsArray,
    ...vars: Array<number | Variable | Expression>
  ): Solution;
  /**
   * Solves the MILP by finding a maximum of an expression.
   *
   * ```ts
   * const a = problem.variable("a").bounds(-5, 5);
   * const solution = problem.maximize(a, { verbose: true });
   * ```
   */
  maximize(objective: Variable | Expression, options?: SolveOptions): Solution;
}

/** options for the solution process */
export interface SolveOptions {
  /** whether to log output while solving the problem */
  verbose?: boolean;
}

function problem(ffi: Ffi): () => Problem {
  return () => {
    const variables: Map<string, Variable> = new Map();
    const constraints: Constraint[] = [];
    return {
      variable(name, options) {
        if (variables.has(name)) throw new Error(`variable '${name}' exists`);
        const v: Variable = {
          name,
          ...options,
          bounds(min, max) {
            v.min = min;
            v.max = max;
            return v;
          },
          int() {
            v.integer = true;
            return v;
          },
          binary() {
            return v.bounds(0, 1).int();
          },
        };
        variables.set(name, v);
        return v;
      },
      constraint(constraint, ...vars) {
        let left: number | Variable | Expression;
        let cmp: "<=" | "==" | ">=";
        let right: number | Variable | Expression;
        if (typeof vars[0] === "string" && vars.length === 2) {
          left = constraint as Expression;
          cmp = vars[0];
          right = vars[1];
        } else {
          [left, cmp, right] = parse(
            constraint as TemplateStringsArray,
            vars as Variable[],
            { type: "constraint" },
          );
        }
        const expression = cmp === ">=" ? sub(right, left) : sub(left, right);
        const isEquality = cmp === "==";
        const cons = { expression, isEquality };
        constraints.push(cons);
        return cons;
      },
      minimize(objective, ...vars) {
        if (!("name" in objective) && !("linear" in objective)) {
          objective = exp(objective, ...vars as Variable[]);
        }
        const opts = {
          verbose: typeof vars[0] === "object" && "verbose" in vars[0] &&
            (vars[0].verbose ?? false),
        };
        return solve(ffi, "min", variables, exp(objective), constraints, opts);
      },
      maximize(objective, ...vars) {
        if (!("name" in objective) && !("linear" in objective)) {
          objective = exp(objective, ...vars as Variable[]);
        }
        const opts = {
          verbose: typeof vars[0] === "object" && "verbose" in vars[0] &&
            (vars[0].verbose ?? false),
        };
        return solve(ffi, "max", variables, exp(objective), constraints, opts);
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
  /** target CPU architecture to use instead of detecting it */
  arch?: "x64" | "arm64";
}
/** library which lets you create and solve MILPs */
export interface Library {
  /** creates a new MILP defintion */
  problem(): Problem;

  /** location of loaded binary on disk */
  binaryPath: string;
  /** closes the loaded native library */
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

    binaryPath,
    [Symbol.dispose]: () => lib.close(),
  };
}

async function cache(options?: LoadOptions) {
  const { default: manifest } = await import("./deno.json", {
    with: { type: "json" },
  });
  if (!("version" in manifest) || typeof manifest.version !== "string") {
    throw new Error("Could not determine version");
  }
  const cpu = options?.arch ?? arch();
  let target: string;
  switch (cpu) {
    case "x64":
      target = "x86_64-unknown-linux-gnu";
      break;
    case "arm64":
      target = "aarch64-unknown-linux-gnu";
      break;
    default:
      throw new Error(`unsupported architecture '${cpu}'`);
  }
  const version = manifest.version;
  const source = new URL(
    `./target/${target}/release/libknorpelsolve.so`,
    import.meta.url,
  );

  const cacheDir = options?.cacheDir ??
    join(homedir(), ".cache", "libknorpelsolve", version, target);
  const libPath = await cacheFile(cacheDir, source, "libknorpelsolve.so");
  return libPath;
}
async function cacheFile(dir: string, source: URL, filename: string) {
  const dest = join(dir, filename);
  if (await exists(dest, { isFile: true })) {
    return dest;
  }

  await Deno.mkdir(dir, { recursive: true });
  const tempDest = await Deno.makeTempFile({ dir });
  {
    await using tempFile = await Deno.open(tempDest, { write: true });
    const response = await fetch(source);
    if (response.body === null) throw new Error("Could not fetch library");
    await response.body.pipeTo(tempFile.writable);
  }
  await Deno.rename(tempDest, dest);
  return dest;
}

if (import.meta.main) {
  console.log(await cache());
}
