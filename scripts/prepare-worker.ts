// Bundle the MoonBit worker output into `dist/` together with the
// telemetry runtime, and emit `dist/worker.mjs` as the Cloudflare
// Worker entrypoint that imports the core and applies the telemetry +
// utels wrappers.
//
// Why this exists:
//   - `moon build --target js --release` only emits the MoonBit core
//     code as `_build/js/release/build/<package>.js`. The Worker
//     runtime needs a thin JS entrypoint that resolves env / ctx and
//     calls the `globalThis.__appServerFetch` the core registers (see
//     src/main.mbt).
//   - Telemetry + error tracking live as JS-side wrappers around the
//     core handler. The source is TypeScript under `src/`, transpiled
//     by `tsc` into `dist/telemetry-runtime.js` + `dist/telemetry/*.js`
//     before this script runs. We do NOT copy the .ts sources directly
//     — workerd cannot strip types at runtime.
//
// Adjust the moon-output path and the worker.mjs body if you rename
// the moon package or want to add more wrappers.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(root, "..");
const distDir = join(projectRoot, "dist");

const moonOutput = join(
  projectRoot,
  "_build/js/release/build/cloudflare-starterkit-mbt.js",
);

await mkdir(distDir, { recursive: true });
const moonCore = await readFile(moonOutput, "utf8");
await writeFile(join(distDir, "app-core.js"), moonCore);

// Sanity check: tsc should have produced dist/telemetry-runtime.js +
// dist/telemetry/d1-wrap.js by the time we get here. Fail loudly if
// not, because the worker entrypoint below will import them.
for (const required of ["telemetry-runtime.js", "telemetry/d1-wrap.js"]) {
  try {
    const info = await stat(join(distDir, required));
    if (!info.isFile()) throw new Error("not a file");
  } catch (error) {
    console.error(
      `prepare-worker: missing dist/${required} — did you run \`pnpm run build:ts\` first? ` +
        `(error: ${(error as Error).message})`,
    );
    process.exit(1);
  }
}

// Worker entrypoint. `wrangler.jsonc` has `"main": "dist/worker.mjs"`.
// The MoonBit core registers `globalThis.__appServerFetch` at module-
// load time (see src/main.mbt). If your core needs scheduled cron
// handlers, expose them on globalThis too and forward from here.
await writeFile(
  join(distDir, "worker.mjs"),
  `import "./app-core.js";
import { withTelemetry, withUtelsErrorTracking } from "./telemetry-runtime.js";

const coreHandler = {
  fetch(request, env, ctx) {
    if (typeof globalThis.__appServerFetch !== "function") {
      return new Response("app fetch handler not registered", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return globalThis.__appServerFetch(request, env, ctx);
  },
};

const fetchHandler = withUtelsErrorTracking(withTelemetry(coreHandler));

export default {
  fetch: fetchHandler.fetch,
};
`,
);
