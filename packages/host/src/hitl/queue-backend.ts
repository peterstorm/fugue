import type { QueueBackend } from "@fuguejs/framework";
import type { LogPort } from "../ports.js";

export interface HitlQueueConfig {
  readonly REDIS_URL: string;
  readonly TEAMS_WEBHOOK_URL?: string;
  readonly BOT_APP_ID?: string;
}

type BullMqFactory = (redisUrl: string) => QueueBackend;
type LoadBullMqFactory = () => Promise<BullMqFactory>;

const loadBullMqFactory: LoadBullMqFactory = async () => {
  const { createBullMQBackend } = await import("@fuguejs/framework/bullmq");
  return createBullMQBackend;
};

/** Build the optional HITL queue without loading BullMQ when HITL is disabled. */
export const createHitlQueueBackend = async (
  config: HitlQueueConfig,
  logger: Pick<LogPort, "info">,
  load: LoadBullMqFactory = loadBullMqFactory,
): Promise<QueueBackend | undefined> => {
  const configured =
    config.TEAMS_WEBHOOK_URL !== undefined || config.BOT_APP_ID !== undefined;
  if (!configured) return undefined;

  const createBackend = await load();
  const backend = createBackend(config.REDIS_URL);
  logger.info("HITL queue backend (BullMQ) constructed");
  return backend;
};

/** Close the optional backend without allowing cleanup failure to mask shutdown. */
export const closeHitlQueueBackend = async (
  backend: Pick<QueueBackend, "close"> | undefined,
  logger: Pick<LogPort, "error">,
): Promise<void> => {
  if (backend === undefined) return;
  try {
    await backend.close();
  } catch (error) {
    logger.error("Failed to close HITL queue backend", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
