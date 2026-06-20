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
export type ReapFn = () => void;

/**
 * Try to bind a reaper to libc's `waitpid` via ONE candidate shared object.
 * Returns the reaper closure, or `null` if this candidate can't provide `waitpid`
 * (wrong libc for the image / dlopen failure). Injectable into `resolveReaper` so
 * the candidate-resolution loop and its fail-fast are unit-testable.
 */
export const loadWaitpidReaper = (candidate: string): ReapFn | null => {
  try {
    const lib = dlopen(candidate, {
      waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });
    if (typeof lib.symbols.waitpid !== "function") return null;
    // `status` MUST stay alive for the process lifetime (the kernel writes the
    // child's exit status into it); `ptr(status)` is recomputed each call so the
    // closure keeps `status` (and `lib`) referenced — never GC'd out from under a
    // live native pointer.
    const status = new Int32Array(1);
    return () => {
      for (;;) {
        // -1 = wait for ANY child (incl. re-parented orphans). r > 0 → reaped a
        // pid; 0 → children exist but none exited; -1 → ECHILD (no children).
        const r = lib.symbols.waitpid(-1, ptr(status), WNOHANG);
        if (r <= 0) break;
      }
    };
  } catch {
    return null;
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
  load: (candidate: string) => ReapFn | null = loadWaitpidReaper,
): ReapFn => {
  for (const candidate of candidates) {
    const reaper = load(candidate);
    if (reaper) return reaper;
  }
  throw new Error(
    `[thin-init] could not load a libc exporting waitpid (PID 1 cannot reap zombies). Tried: ${candidates.join(", ")}`,
  );
};

// ── Adapter ─────────────────────────────────────────────────────────────────────

export interface BunInitAdapterConfig {
  /** Absolute path to the supervisor binary (`main-supervisor.ts`) to spawn. */
  readonly supervisorEntry: string;
  /** Env handed to the spawned supervisor. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Safety-net reap interval (ms) backing SIGCHLD. Default 30_000. */
  readonly reapIntervalMs?: number;
}

/**
 * The concrete adapter the thin-init binary holds: the `InitProcessPort` the pure
 * `runThinInit` loop codes against, PLUS a `beginTermination` control seam the
 * binary's SIGTERM handler uses to forward shutdown to the current supervisor and
 * stop respawning (the loop is otherwise infinite).
 */
export interface BunInitProcessAdapter extends InitProcessPort {
  /**
   * Pod shutdown: forward `sig` to the CURRENT supervisor child AND (when we are
   * actually PID 1) to every per-tenant WORKER in the pod so they drain gracefully
   * (FR-017/FR-060) — the supervisor deliberately does NOT propagate shutdown to
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
export const createBunInitProcessAdapter = (
  cfg: BunInitAdapterConfig,
  logger?: LogPort,
): BunInitProcessAdapter => {
  const reap = resolveReaper(libcCandidates(process.platform, process.arch));
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
      const proc = Bun.spawn(["bun", "run", cfg.supervisorEntry], {
        env: buildEnv(),
        stdout: "inherit",
        stderr: "inherit",
        // No custom process group: workers inherit PID 1's group and re-parent to
        // PID 1 (this process) on supervisor exit — they are NOT killed (AD-2).
      });
      currentPid = typeof proc.pid === "number" ? proc.pid : undefined;
      logger?.info?.("[thin-init] supervisor spawned", { pid: currentPid });
      return { exited: proc.exited };
    },

    reapZombies: reap,

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
      // Signal the current supervisor (its handler drains its own state + exits).
      if (currentPid !== undefined) {
        try {
          process.kill(currentPid, sig);
        } catch {
          // Already gone — the supervisor exited on its own; nothing to forward.
        }
      }
      // POD SHUTDOWN: broadcast to the per-tenant WORKERS so they drain too. GUARDED
      // on pid===1 — only when we are genuinely the pod's PID 1 (its own PID
      // namespace) is enumerating + signalling every process safe; running as a
      // normal child (tests/dev) it would signal UNRELATED host processes, so we
      // never broadcast there (the supervisor signal above still works).
      if (process.pid === 1) {
        let pids: string[];
        try {
          pids = readdirSync("/proc");
        } catch {
          return; // no /proc — cannot enumerate; supervisor was already signalled.
        }
        for (const entry of pids) {
          if (!/^\d+$/.test(entry)) continue;
          const pid = Number(entry);
          if (pid === 1) continue; // never signal ourselves (PID 1 has no default disposition)
          try {
            process.kill(pid, sig);
          } catch {
            // gone / not permitted — best-effort drain broadcast.
          }
        }
      }
    },
  };
};
