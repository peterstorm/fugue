/**
 * Standalone harness — NOT a `*.test.ts`, so the test glob never auto-runs it.
 * `bun-init-process-adapter.test.ts` invokes it under `unshare -rpf --mount-proc`
 * so it runs as PID 1 in a throwaway PID namespace, proving the pod-shutdown WORKER
 * BROADCAST: when running as PID 1, `beginTermination` SIGTERMs every OTHER process
 * in the pod's namespace, so the per-tenant workers drain gracefully (FR-017/FR-060)
 * instead of being hard-SIGKILLed by namespace teardown. The supervisor deliberately
 * does NOT propagate shutdown to workers (AD-2), so PID 1 must.
 *
 * Emits machine-readable `RESULT …` lines the test parses.
 */

import { createBunInitProcessAdapter } from "../../../supervisor/lifecycle/bun-init-process-adapter.js";

// Built only to drive beginTermination — the supervisorEntry is never spawned here.
const adapter = createBunInitProcessAdapter({ supervisorEntry: "/dev/null/unused" });

// Fake "workers" that TRAP SIGTERM and exit 0 (graceful drain) — like real
// createHost workers (host.ts registerSignalHandlers). `wait` makes SIGTERM
// interrupt immediately so the trap runs without delay.
const workers = [1, 2, 3].map(() =>
  Bun.spawn(["bash", "-c", "trap 'exit 0' TERM; sleep 30 & wait"], {
    stdout: "ignore",
    stderr: "ignore",
  }),
);

// Give the workers a moment to install their TERM traps.
await new Promise((r) => setTimeout(r, 300));

// POD SHUTDOWN: broadcast SIGTERM to all namespace processes (pid===1 guard active).
adapter.beginTermination("SIGTERM");

// Each worker should receive SIGTERM, run its trap, and exit 0 (graceful drain).
const codes = await Promise.all(workers.map((w) => w.exited));

console.info("RESULT pid=" + process.pid); // 1 inside the namespace
console.info("RESULT codes=" + JSON.stringify(codes));
process.exit(0);
