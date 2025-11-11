import { exp, load } from "./mod.ts";

using lib = await load();

const p = lib.problem();
const a = p.variable("a", { max: 1 });
const b = p.variable("b", { min: 2, max: 4 });
p.constraint(exp`${a} + 2`, "<=", b);
p.constraint(exp`1 + ${a}`, ">=", exp`4 - ${b}`);
const solution = p.maximize(exp`10 * (${a} - ${b} / 5) - ${b}`);
console.log(solution.status, solution.values);
