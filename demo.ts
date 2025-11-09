import { add, div, load, mul, sub } from "./mod.ts";

using lib = await load();

const p = lib.problem();
const a = p.variable("a", { max: 1 });
const b = p.variable("b", { min: 2, max: 4 });
p.constraint(add(a, 2), "<=", b);
p.constraint(add(1, a), ">=", sub(4, b));
const solution = p.maximize(sub(mul(10, sub(a, div(b, 5))), b));
console.log(solution.status, solution.values);
