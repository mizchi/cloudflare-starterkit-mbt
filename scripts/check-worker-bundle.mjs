// Post-build sanity check for the bundled Worker core.
//
// `moon build --target js --release` followed by `prepare-worker.mjs`
// can produce a file with subtle corruption: missing rewrite targets
// (silent String#replace no-op), stray \x1f control bytes from the
// wasm host, or the wrong package name if moon.mod.json was renamed
// without updating prepare-worker.mjs. None of these surface as a
// crash at deploy time — they surface as a hung worker on first
// request, which is hard to debug after the fact.
//
// This script enforces a minimum set of invariants. Extend it when
// you add new rewrite steps in prepare-worker.mjs.

import { readFile, stat } from "node:fs/promises";

const target = process.argv[2];
if (!target) {
  console.error("usage: check-worker-bundle.mjs <path-to-bundle.js>");
  process.exit(2);
}

let info;
try {
  info = await stat(target);
} catch (error) {
  console.error(`worker bundle check: cannot stat ${target}: ${error.message}`);
  process.exit(1);
}
if (!info.isFile()) {
  console.error(`worker bundle check: ${target} is not a file`);
  process.exit(1);
}
if (info.size < 1024) {
  console.error(
    `worker bundle check: ${target} is only ${info.size} bytes — moon build likely produced an empty / stub file`,
  );
  process.exit(1);
}

const content = await readFile(target, "utf8");

// Reject stray \x1f (Unit Separator). The MoonBit toolchain has been
// observed to leak this into emitted JS during wasm-host translation.
const usPositions = [];
for (let i = 0; i < content.length; i += 1) {
  if (content.charCodeAt(i) === 0x1f) {
    usPositions.push(i);
    if (usPositions.length >= 5) break;
  }
}
if (usPositions.length > 0) {
  console.error(
    `worker bundle check: ${usPositions.length}+ occurrence(s) of \\x1f in ${target} ` +
      `(first at offset ${usPositions[0]}). The bundle is corrupted — rebuild from a clean _build/.`,
  );
  process.exit(1);
}

// Each MoonBit codegen path that prepare-worker.mjs rewrites should
// leave a distinctive marker behind so a silently-skipped rewrite is
// caught here. The starter ships without rewrites; add an entry per
// rewrite as you introduce them. Pattern:
//   const REQUIRED_MARKERS = [
//     { needle: "globalThis.__appCronTick", reason: "scheduled cron forwarder" },
//   ];
const REQUIRED_MARKERS = [];
for (const marker of REQUIRED_MARKERS) {
  if (!content.includes(marker.needle)) {
    console.error(
      `worker bundle check: missing marker "${marker.needle}" (${marker.reason}) in ${target}. ` +
        `Either prepare-worker.mjs's rewrite step failed silently, or the upstream moon ` +
        `output changed shape. Update prepare-worker.mjs and this checklist together.`,
    );
    process.exit(1);
  }
}

console.log(`worker bundle check: ok (${target})`);
