/**
 * Bun.spawn-backed `InitProcessPort` — the IMPERATIVE SHELL for the PID-1
 * thin-init (AD-2). The supervise POLICY (crash-loop budget) is the PURE
 * `decideSupervisorRestart` in thin-init.ts; this adapter only does OS I/O:
 *
 *   - spawnSupervisor — `Bun.spawn(["bun","run", <main-supervisor.ts>])`; its
 *     `proc.exited` is what the supervise loop awaits.
 *   - reapZombies     — `waitpid(-1, …, WNOHANG)` loop (via `bun:ffi` → libc) that
 *     reaps the per-tenant WORKERS re-parented to PID 1 when a supervisor exits.
 *     Bun reaps its OWN children (the supervisor) via `proc.exited`; it does NOT
 *     reap re-parented orphans, so PID 1 must — otherwise the pod leaks zombies
 *     AND the supervisor's `process.kill(pid, 0)` liveness probe reads a dead
 *     worker as ALIVE (a zombie still answers signal 0), wedging the tenant.
 *   - onSigchld       — installs a SIGCHLD handler driving `reapZombies`, plus a
 *     low-frequency interval as a delivery-quirk safety net.
 *
 * VALIDATED on real PID-namespace semantics (glibc box + `oven/bun` alpine/musl):
 *   - `waitpid(-1, WNOHANG)` reaps re-parented orphan workers → zero zombies.
 *   - It does NOT steal the supervisor's exit status: Bun resolves `proc.exited`
 *     independently of who `waitpid()`s (pidfd), so the supervise loop never hangs
 *     even when the reaper races Bun for the same child.
 *   - `dlopen("libc.so.6")` resolves on BOTH glibc and the alpine Bun image; the
 *     musl/darwin candidate list covers other images/arches/dev machines.
 *
 * WHY FFI, not tini/dumb-init: keeps thin-init a single self-contained Bun binary
 * (AD-2: "thin-init IS PID 1") with no extra image dependency; the reap is a dozen
 * lines and is unit + integration tested. A real init would also work as a fallback
 * if a future base image ever lacks an FFI-loadable libc — in which case
 * construction FAILS FAST (see `resolveReaper`) rather than running a silent
 * non-reaping PID 1.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { readdirSync } from "node:fs";
import type { LogPort } from "../../ports.js";
import type { InitProcessPort } from "./thin-init.js";

// ── Pure: libc resolution candidates (testable without dlopen) ──────────────────

/** Map a Node `process.arch` to the musl shared-object arch token. */
export const muslArchName = (arch: string): string =>
  arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;

/**
 * PURE: the ordered list of libc shared objects to try for the `waitpid` symbol,
 * for a given `process.platform` / `process.arch`. `libc.so.6` (glibc) is first
 * because it resolves on Debian/Ubuntu AND the alpine Bun image; the musl names
 * cover bare-musl images, and the darwin names keep local `bun test` working on
 * macOS dev machines.
 */
export const libcCandidates = (platform: string, arch: string): readonly string[] => {
  if (platform === "darwin") {
    return ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib", "libc.dylib"];
  }
  const m = muslArchName(arch);
  return ["libc.so.6", `libc.musl-${m}.so.1`, `/lib/libc.musl-${m}.so.1`, `/lib/ld-musl-${m}.so.1`, "libc.so"];
};

// ── Reaper (impure: bun:ffi → libc waitpid) ─────────────────────────────────────

/** `waitpid` option: return immediately if no child has exited (non-blocking). */
const WNOHANG = 1;

/** A non-blocking zombie reaper: drains every currently-reapable child. */
type ReapFn = () => void;

/** Closed result of probing one libc candidate for a callable `waitpid`. */
export type ReaperLoadResult =
  | { readonly kind: "loaded"; readonly reaper: ReapFn }
  | { readonly kind: "failed"; readonly diagnostic: string };

const nativeLoadDiagnostic = (error: unknown): string => {
  let raw: string;
  try {
    raw = error instanceof Error ? error.message : String(error);
  } catch {
    raw = "<unprintable native-loader failure>";
  }
  return raw.replace(/\s+/g, " ").slice(0, 500);
};

/**
 * PURE drain loop for the reaper: invoke `reapOne` (one non-blocking `waitpid`)
 * until it reports nothing left to reap. `reapOne` returns the waitpid result:
 * r > 0 reaped a pid (keep draining a burst of coalesced exits); r === 0 children
 * exist but none have exited; r < 0 ECHILD / no children. Stops on r <= 0.
 *
 * NEVER THROWS: a throw from the underlying FFI call is caught and ends THIS drain
 * cycle, signaling the fault through `onFault` exactly once (the wiring counts
 * consecutive faults and escalates a persistent broken seam to an error log —
 * see `createBunInitProcessAdapter`). The reaper runs inside a SIGCHLD handler
 * AND an unref'd safety-net interval — an uncaught throw there would escape into
 * PID 1 (worst case: a bad reap takes out PID 1 from a signal handler). On a
 * fault we stop the cycle; the next SIGCHLD / the interval retries.
 *
 * EINTR: a `waitpid(-1, WNOHANG)` that returns -1 on EINTR (extremely rare —
 * WNOHANG does not block, so the interrupt window is tiny) is indistinguishable
 * from ECHILD here and breaks early. That defers the rest of that burst's reaps
 * to the next cycle, bounded by the safety-net interval — never a persistent
 * zombie leak.
 *
 * Exported so the multi-reap drain + the throw-safety are unit-testable without a
 * real PID namespace.
 */
export const drainReap = (reapOne: () => number, onFault?: () => void): void => {
  for (;;) {
    let r: number;
    try {
      r = reapOne();
    } catch {
      // FFI call-time fault — stop this cycle; SIGCHLD / the interval retries.
      // A transient fault is still invisible at the caller unless signaled:
      // `onFault` fires exactly once per broken cycle so the wiring can count
      // and escalate a PERSISTENTLY broken waitpid seam (a broken native seam
      // fails identically every cycle — without a signal, PID 1 leaks zombies
      // indefinitely with zero log line, defeating the "dead-worker-reads-as-alive"
      // invariant this module's header warns about).
      onFault?.();
      break;
    }
    if (r <= 0) break;
  }
};

/**
 * Try to bind a reaper to libc's `waitpid` via ONE candidate shared object.
 * Failure retains a bounded one-line diagnostic so startup can explain why
 * every candidate was rejected. Injectable into `resolveReaper` so the pure
 * candidate-resolution loop and its fail-fast are unit-testable.
 */
const loadWaitpidReaper = (candidate: string, onFault?: () => void): ReaperLoadResult => {
  try {
    const lib = dlopen(candidate, {
      waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });
    if (typeof lib.symbols.waitpid !== "function") {
      return { kind: "failed", diagnostic: "loaded library did not expose a callable waitpid symbol" };
    }
    // `status` MUST stay alive for the process lifetime (the kernel writes the
    // child's exit status into it); `ptr(status)` is recomputed each call so the
    // closure keeps `status` (and `lib`) referenced — never GC'd out from under a
    // live native pointer.
    const status = new Int32Array(1);
    // -1 = wait for ANY child (incl. re-parented orphans). Drained (and made
    // throw-safe) by `drainReap`.
    return {
      kind: "loaded",
      reaper: () =>
        drainReap(() => lib.symbols.waitpid(-1, ptr(status), WNOHANG) as number, onFault),
    };
  } catch (error) {
    return { kind: "failed", diagnostic: nativeLoadDiagnostic(error) };
  }
};

/**
 * Resolve a non-blocking zombie-reaper by trying each candidate libc until one
 * provides `waitpid`. FAILS FAST (throws) if none does — a PID 1 that cannot reap
 * is more dangerous than one that refuses to start (zombie leak +
 * dead-worker-reads-as-alive). `load` is injectable so tests can drive the loop to
 * exhaustion and assert the throw without an unloadable real libc.
 */
export const resolveReaper = (
  candidates: readonly string[],
  load: (candidate: string) => ReaperLoadResult = loadWaitpidReaper,
): ReapFn => {
  const failures: string[] = [];
  for (const candidate of candidates) {
    const result = load(candidate);
    if (result.kind === "loaded") return result.reaper;
    failures.push(`${candidate}: ${result.diagnostic}`);
  }
  throw new Error(
    `[thin-init] could not load a libc exporting waitpid (PID 1 cannot reap zombies). Candidate failures: ${failures.join("; ")}`,
  );
};

// ── Pod-shutdown worker broadcast (PID-1 only; injected OS seams) ────────────────

/** OS seams for the worker-drain broadcast — injected so the PID-1-only path is testable. */
interface WorkerBroadcastSeams {
  /** This process's PID. The broadcast is a NO-OP unless this is 1 (genuine pod PID 1). */
  readonly selfPid: number;
  /** Enumerate `/proc` entries (pid dir names). MAY throw (no `/proc` / EACCES). */
  readonly enumerate: () => readonly string[];
  /** Send `sig` to `pid`. MAY throw (ESRCH gone / EPERM not permitted). */
  readonly kill: (pid: number, sig: "SIGTERM" | "SIGINT") => void;
  readonly logger?: LogPort;
}

/**
 * POD SHUTDOWN: broadcast `sig` to every per-tenant WORKER in the pod's PID
 * namespace so they drain gracefully (multi-tenant spec FR-017) — the supervisor deliberately does
 * NOT propagate shutdown to workers (AD-2), so PID 1 must, else they are
 * hard-SIGKILLed by namespace teardown. GUARDED on `selfPid === 1`: only as the
 * pod's genuine PID 1 (its own PID namespace) is enumerating + signalling every
 * process safe; as a normal child (tests/dev) it would signal UNRELATED host
 * processes.
 *
 * FULLY OBSERVABLE (this is the single most load-bearing action PID 1 takes on
 * shutdown):
 *   - a `/proc` enumeration failure is LOGGED at `error`, not swallowed — without
 *     the broadcast the caller's grace-timer `exit(0)` SIGKILLs the workers
 *     mid-drain, so a dropped broadcast MUST be diagnosable.
 *   - a summary (`enumerated`/`signalled`) is logged so a systematic EPERM that
 *     signals ZERO workers is distinguishable from a clean broadcast. Each per-pid
 *     `kill` failure is swallowed (the pid is gone / not ours) but counted.
 *
 * Exported with injected seams so this PID-1-only path is unit-testable without a
 * real PID namespace (production passes `readdirSync("/proc")` + `process.kill`).
 */
export const broadcastSignalToWorkers = (sig: "SIGTERM" | "SIGINT", seams: WorkerBroadcastSeams): void => {
  if (seams.selfPid !== 1) return; // only safe as the pod's genuine PID 1
  let entries: readonly string[];
  try {
    entries = seams.enumerate();
  } catch (e) {
    seams.logger?.error?.(
      "[thin-init] pod shutdown: cannot enumerate /proc — workers will NOT receive the drain signal; the grace-timer exit will SIGKILL them mid-drain",
      { sig, error: e instanceof Error ? e.message : String(e) },
    );
    return;
  }
  let enumerated = 0;
  let signalled = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === 1) continue; // never signal ourselves (PID 1 has no default disposition)
    enumerated++;
    try {
      seams.kill(pid, sig);
      signalled++;
    } catch {
      // gone (ESRCH) / not permitted (EPERM) — best-effort drain broadcast.
    }
  }
  seams.logger?.info?.("[thin-init] pod shutdown: broadcast drain signal to workers", {
    sig,
    enumerated,
    signalled,
  });
};

// ── Adapter ─────────────────────────────────────────────────────────────────────

/** What the adapter needs from a spawned supervisor: its pid + a promise of its exit code. */
interface SpawnedSupervisorProcess {
  readonly pid?: number;
  readonly exited: Promise<number | null>;
}

/**
 * Spawn seam: start the supervisor process. Injected so the SYNCHRONOUS fork-failure
 * path (`Bun.spawn` throwing on EAGAIN/ENOMEM/EMFILE/ENOENT) is unit-testable without
 * a real resource-exhaustion fork. Production defaults to `Bun.spawn`.
 */
type SpawnSupervisorFn = (
  command: readonly string[],
  options: { readonly env: Record<string, string>; readonly stdout: "inherit"; readonly stderr: "inherit" },
) => SpawnedSupervisorProcess;

interface BunInitAdapterConfig {
  /** Absolute path to the supervisor binary (`main-supervisor.ts`) to spawn. */
  readonly supervisorEntry: string;
  /** Env handed to the spawned supervisor. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Safety-net reap interval (ms) backing SIGCHLD. Default 30_000. */
  readonly reapIntervalMs?: number;
  /**
   * Spawn seam (injected for tests; production defaults to `Bun.spawn`). Lets the
   * fork-failure branch be exercised without a real resource-exhaustion fork.
   */
  readonly spawn?: SpawnSupervisorFn;
}

/**
 * The concrete adapter the thin-init binary holds: the `InitProcessPort` the pure
 * `runThinInit` loop codes against, PLUS a `beginTermination` control seam the
 * binary's SIGTERM handler uses to forward shutdown to the current supervisor and
 * stop respawning (the loop is otherwise infinite).
 */
interface BunInitProcessAdapter extends InitProcessPort {
  /**
   * Pod shutdown: forward `sig` to the CURRENT supervisor child AND (when we are
   * actually PID 1) to every per-tenant WORKER in the pod so they drain gracefully
   * (multi-tenant spec FR-017) — the supervisor deliberately does NOT propagate shutdown to
   * workers (AD-2), so without this they would be hard-SIGKILLed by namespace
   * teardown. Latches a flag so the supervise loop PARKS instead of respawning;
   * the binary then `process.exit`s after a bounded grace.
   */
  readonly beginTermination: (sig: "SIGTERM" | "SIGINT") => void;
}

/**
 * Build the Bun.spawn-backed PID-1 adapter. Resolves the libc reaper eagerly so a
 * libc-resolution failure surfaces at startup (fail-fast), not on the first
 * orphaned worker.
 */
/**
 * Escalation policy for FFI reap faults, separated from the adapter so it is
 * unit-testable without a real FFI fault. A broken `waitpid` seam fails
 * identically on every cycle, so the first fault logs at error level, then every
 * 10th consecutive fault (SIGCHLD bursts can fire the reaper many times per
 * second — unthrottled per-fault logging would be spam). A fault-free cycle
 * resets the counter, so a transient fault followed by healthy reaping never
 * leaves the counter elevated. A persistently broken reaper must not leak
 * zombies with ZERO signal (a dead worker reads as alive — the invariant this
 * module's header warns about).
 */
export const createReapFaultEscalation = (
  logger?: LogPort,
): {
  readonly onFault: () => void;
  readonly runCycle: (cycle: () => void) => void;
} => {
  let consecutiveFaults = 0;
  return {
    onFault: (): void => {
      consecutiveFaults += 1;
      if (consecutiveFaults === 1 || consecutiveFaults % 10 === 0) {
        logger?.error?.(
          "[thin-init] waitpid FFI fault — reap cycle stopped; zombies will accumulate until the next SIGCHLD/interval",
          { faultCount: consecutiveFaults },
        );
      }
    },
    runCycle: (cycle: () => void): void => {
      const before = consecutiveFaults;
      cycle();
      if (consecutiveFaults === before) consecutiveFaults = 0;
    },
  };
};

export const createBunInitProcessAdapter = (
  cfg: BunInitAdapterConfig,
  logger?: LogPort,
): BunInitProcessAdapter => {
  const reapFaults = createReapFaultEscalation(logger);
  const rawReap = resolveReaper(libcCandidates(process.platform, process.arch), (candidate) =>
    loadWaitpidReaper(candidate, reapFaults.onFault),
  );
  const reapZombies: ReapFn = () => reapFaults.runCycle(rawReap);
  const spawn: SpawnSupervisorFn = cfg.spawn ?? ((command, options) => Bun.spawn([...command], options));
  let terminating = false;
  let currentPid: number | undefined;

  const buildEnv = (): Record<string, string> => {
    const src = cfg.env ?? process.env;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(src)) if (v !== undefined) out[k] = v;
    return out;
  };

  return {
    spawnSupervisor: () => {
      if (terminating) {
        // Pod is shutting down — do NOT respawn. Park the loop on a promise that
        // never resolves; the binary's grace-timeout `process.exit` ends it (and
        // PID-namespace teardown SIGKILLs anything still running).
        return { exited: new Promise<number | null>(() => {}) };
      }
      try {
        // No custom process group: workers inherit PID 1's group and re-parent to
        // PID 1 (this process) on supervisor exit — they are NOT killed (AD-2).
        const proc = spawn(["bun", "run", cfg.supervisorEntry], {
          env: buildEnv(),
          stdout: "inherit",
          stderr: "inherit",
        });
        currentPid = typeof proc.pid === "number" ? proc.pid : undefined;
        logger?.info?.("[thin-init] supervisor spawned", { pid: currentPid });
        return { exited: proc.exited };
      } catch (e) {
        // A SYNCHRONOUS fork failure (EAGAIN/ENOMEM under memory pressure, EMFILE on
        // fd exhaustion, ENOENT if the entry vanished) is a supervisor NON-START, not
        // a PID-1 crash. Hand the supervise loop a synthetic failed exit (-1, the
        // signal/abnormal-exit convention) so `decideSupervisorRestart` applies the
        // crash-loop budget + the pod's give-up/grace-drain path — exactly as it does
        // for a supervisor that starts then crashes. Letting it THROW would escape the
        // loop to `main().catch` → `process.exit(1)`, tearing down the PID namespace and
        // SIGKILLing every live worker mid-flight with NO drain (AD-2/multi-tenant spec FR-019/FR-021
        // violated) — the worst outcome at precisely the moment (memory pressure) a
        // fork failure is most likely AND most likely to be transient/self-healing.
        // Clear `currentPid` so a subsequent `beginTermination` never signals a stale
        // pid. Logged at `error` (not swallowed): a non-start that burns restart budget
        // must be diagnosable.
        currentPid = undefined;
        logger?.error?.("[thin-init] supervisor spawn failed; treating as a crash for the restart budget", {
          supervisorEntry: cfg.supervisorEntry,
          error: e instanceof Error ? e.message : String(e),
        });
        return { exited: Promise.resolve(-1) };
      }
    },

    reapZombies,

    onSigchld: (handler) => {
      const onChld = (): void => handler();
      process.on("SIGCHLD", onChld);
      // SIGCHLD delivery to a JS runtime can be coalesced under bursts; a
      // low-frequency timer guarantees re-parented orphans are reaped within the
      // interval even if a SIGCHLD is dropped. `waitpid(-1, WNOHANG)` is a cheap
      // no-op when nothing is reapable. `unref` so it never holds the loop open.
      const timer = setInterval(handler, cfg.reapIntervalMs ?? 30_000);
      if (typeof timer.unref === "function") timer.unref();
      return () => {
        process.off("SIGCHLD", onChld);
        clearInterval(timer);
      };
    },

    beginTermination: (sig) => {
      terminating = true;
      // Signal the current supervisor explicitly. This is the ONLY drain signal it
      // gets on the non-PID-1 dev/test path (the broadcast below is skipped there);
      // when we ARE pid 1 the broadcast also re-signals it — benign, the
      // supervisor's drain handler is idempotent.
      if (currentPid !== undefined) {
        try {
          process.kill(currentPid, sig);
        } catch {
          // Already gone — the supervisor exited on its own; nothing to forward.
        }
      }
      // POD SHUTDOWN: broadcast to the per-tenant WORKERS so they drain too (PID-1
      // only; a /proc-read failure and the signalled count are logged, never
      // swallowed — a dropped broadcast means the grace-timer exit SIGKILLs them).
      broadcastSignalToWorkers(sig, {
        selfPid: process.pid,
        enumerate: () => readdirSync("/proc"),
        kill: (pid, s) => process.kill(pid, s),
        logger,
      });
    },
  };
};
