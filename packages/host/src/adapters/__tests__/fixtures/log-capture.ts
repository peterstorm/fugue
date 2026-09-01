import type { LogPort } from "../../../ports.js";

export interface CapturedLog {
  readonly level: "info" | "warn" | "error";
  readonly msg: string;
  readonly data?: Record<string, unknown>;
}

/** Plain LogPort fake that retains typed records for behavioral assertions. */
export const collectLogs = (): {
  readonly logger: LogPort;
  readonly logs: CapturedLog[];
} => {
  const logs: CapturedLog[] = [];
  const logger: LogPort = {
    info: (msg, data) => logs.push({ level: "info", msg, data }),
    warn: (msg, data) => logs.push({ level: "warn", msg, data }),
    error: (msg, data) => logs.push({ level: "error", msg, data }),
  };
  return { logger, logs };
};
