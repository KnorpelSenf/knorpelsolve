# knorpelsolve

fast integer linear programming solver for typescript

```sh
deno add jsr:@knorpelsenf/knorpelsolve
```

```ts
import { load } from "@knorpelsenf/knorpelsolve";

using lib = await load();

const p = lib.problem();
const a = p.variable("a", { max: 1 });
const b = p.variable("b", { min: 2, max: 4 });
p.constraint`${a} + 2 <= ${b}`;
p.constraint`1 + ${a} >= 4 - ${b}`;
const solution = p.maximize`10 * (${a} - ${b} / 5) - ${b}`;
console.log(solution.status, solution.values);
```

Check out the API reference on JSR for more information, especially the
[`Problem` interface](https://jsr.io/@knorpelsenf/knorpelsolve/doc/~/Problem).

The library downloads and caches a [HiGHS](https://highs.dev/) binary which
performs the solving at native speed. This happens automatically the first time
you use it.

You can perform the download upfront to make your program start faster. Run the
package directly to cache the binary and print its path.

```sh
$ deno -Ar jsr:@knorpelsenf/knorpelsolve
/home/vscode/.cache/libknorpelsolve/1.0.0/libknorpelsolve.so
```

```ts
using lib = loadCached(
  "/home/vscode/.cache/libknorpelsolve/1.0.0/libknorpelsolve.so",
);
```
