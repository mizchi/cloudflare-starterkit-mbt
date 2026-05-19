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
//     core handler. Keeping them in `src/telemetry-runtime.mjs` lets
//     them stay readable and unit-testable from Node.
//
// Adjust the moon-output path and the worker.mjs body if you rename
// the moon package or want to add more wrappers.

import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(root, "..");
const distDir = join(projectRoot, "dist");

// `moon build --target js --release` puts the bundled JS here. The
// filename matches the package name in moon.mod.json. Rename if you
// change the moon package name.
const moonOutput = join(
  projectRoot,
  "_build/js/release/build/cloudflare-starterkit-mbt.js",
);

const telemetryRuntime = join(projectRoot, "src/telemetry-runtime.mjs");
const telemetryDir = join(projectRoot, "src/telemetry");

await mkdir(distDir, { recursive: true });
const moonCore = await readFile(moonOutput, "utf8");

// Output filename for the bundled core. `wrangler` does not import it
// directly — the worker entrypoint below does.
await writeFile(join(distDir, "app-core.js"), moonCore);

// Copy the JS-side telemetry runtime (server-side error tracking +
// OTLP push + D1 query wrap).
await copyFile(telemetryRuntime, join(distDir, "telemetry-runtime.mjs"));
await mkdir(join(distDir, "telemetry"), { recursive: true });
for (const name of await readdir(telemetryDir)) {
  if (!name.endsWith(".mjs")) continue;
  await copyFile(join(telemetryDir, name), join(distDir, "telemetry", name));
}

// Worker entrypoint. `wrangler.jsonc` has `"main": "dist/worker.mjs"`.
// The MoonBit core registers `globalThis.__appServerFetch` at module-
// load time (see src/main.mbt). If your core needs scheduled cron
// handlers, expose them on globalThis too and forward from here.
await writeFile(
  join(distDir, "worker.mjs"),
  `import "./app-core.js";
import { withTelemetry, withUtelsErrorTracking } from "./telemetry-runtime.mjs";

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
