import { createHash } from "node:crypto";

export const computePromptHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);
