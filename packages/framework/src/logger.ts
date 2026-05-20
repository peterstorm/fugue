// Framework-level logger seam.
//
// The kernel, queue, scheduler, and observer modules all need to report
// non-fatal failures (timer crashes, span evictions, exporter rejections,
// etc.). Routing those through `console.*` directly couples the framework
// to a specific transport and makes it impossible for hosts to capture
// them. This module is the single seam: callers use `fwLogger()` and the
// host wires `setFrameworkLogger` (typically alongside `initTracing`).
//
// The default implementation forwards to `console.*`. Test seams replace
// it with a recording logger.

export interface FrameworkLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

const consoleLogger: FrameworkLogger = {
  debug(msg, ...args) {
    console.debug(msg, ...args);
  },
  info(msg, ...args) {
    console.info(msg, ...args);
  },
  warn(msg, ...args) {
    console.warn(msg, ...args);
  },
  error(msg, ...args) {
    console.error(msg, ...args);
  },
};

let _logger: FrameworkLogger = consoleLogger;

/**
 * Install a host-provided logger. Typically called once at bootstrap,
 * alongside `initTracing`. Calling again replaces the prior logger; passing
 * `undefined` is rejected to prevent accidental nulling-out.
 */
export const setFrameworkLogger = (logger: FrameworkLogger): void => {
  if (logger == null) {
    throw new TypeError("setFrameworkLogger: logger must not be null or undefined");
  }
  _logger = logger;
};

/**
 * Reset to the console-backed default. Test-only; not on the public barrel.
 */
export const __resetFrameworkLogger = (): void => {
  _logger = consoleLogger;
};

/**
 * Resolve the current framework logger. Always returns a non-null logger —
 * the default is the console-backed implementation, so callers can use the
 * return value unconditionally.
 */
export const fwLogger = (): FrameworkLogger => _logger;
