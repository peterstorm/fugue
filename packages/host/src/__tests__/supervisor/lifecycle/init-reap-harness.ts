/**
 * Standalone harness — NOT a `*.test.ts`, so the test glob never auto-runs it.
 * `bun-init-process-adapter.test.ts` invokes it under `unshare -rpf --mount-proc`
 * so it runs as PID 1 in a throwaway PID namespace, proving the REAL Bun adapter
 * end-to-end: the supervise loop restarts the (fake) supervisor within budget and
 * reaps the orphan workers each fake supervisor leaves re-parented to PID 1 —
 * zero zombies, and the loop never hangs (Bun's `proc.exited` resolves even though
 * the FFI reaper races it for the same children).
 *
 * Emits machine-readable `RESULT …` lines the test parses.
 */

import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runThinInit } from "../../../supervisor/lifecycle/thin-init.js";
import { createBunInitProcessAdapter } from "../../../supervisor/lifecycle/bun-init-process-adapter.js";

const dir = mkdtempSync(join(tmpdir(), "thininit-harness-"));
const fakeSupervisor = join(dir, "fake-supervisor.ts");
// Fake supervisor: spawn an orphan worker that OUTLIVES it, then crash (exit 7).
// When this exits, the `sleep` re-parents to PID 1 (the harness) and later exits —
// PID 1 must reap it or it becomes a zombie.
writeFileSync(fakeSupervisor, `Bun.spawn(["sleep", "0.5"]); process.exit(7);\n`);

// Budget 2 → spawn #1 (initial) + 2 restarts, then give up: 3 fake supervisors,
// 3 orphan workers to reap.
const adapter = createBunInitProcessAdapter({ supervisorEntry: fakeSupervisor });
const result = await runThinInit(adapter, { maxRestartsPerWindow: 2, windowMs: 60_000 }, () => Date.now());

console.info("RESULT pid=" + process.pid); // 1 inside the namespace
console.info("RESULT stoppedReason=" + result.stoppedReason);

// Let the final orphan exit, then reap + scan for any zombie still parented here.
await new Promise((r) => setTimeout(r, 1200));
adapter.reapZombies();

let zombies = 0;
for (const d of readdirSync("/proc")) {
  if (!/^\d+$/.test(d)) continue;
  try {
    const m = readFileSync(`/proc/${d}/stat`, "utf8").match(/^\d+ \(.*\) (\S)/);
    if (m && m[1] === "Z") zombies++;
  } catch {
    // pid vanished mid-scan — fine.
  }
}
console.info("RESULT zombies=" + zombies);
process.exit(0);
