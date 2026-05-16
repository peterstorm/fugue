/**
 * Application-level logger interface. Richer than the framework's
 * `FrameworkLogger` (which carries only `warn`/`error`) — the app also
 * needs `info` for startup messages and operational logging.
 *
 * Threading through `AppDeps` makes the app testable (inject a recording
 * logger) and swappable to a structured JSON logger for production.
 */
export interface AppLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/** Default: routes to `console.*`. Replace with structured JSON logger in production. */
export const consoleAppLogger: AppLogger = {
  info: (msg, ...args) => console.log(msg, ...args),
  warn: (msg, ...args) => console.warn(msg, ...args),
  error: (msg, ...args) => console.error(msg, ...args),
};
