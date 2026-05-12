import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, err, type Result, type FrameworkError } from "@ai-summary/framework";
import { CrmRecordSchema, type CrmRecord } from "../schemas/crm.js";
import type { ConversationSource } from "./conversation-source.js";

export class JsonFixtureSource implements ConversationSource {
  constructor(private readonly fixturesDir: string) {}

  async fetchCustomer(customerId: string): Promise<Result<CrmRecord | null, FrameworkError>> {
    // Sanitize customerId to prevent path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(customerId)) {
      return err({
        kind: "validation",
        nodeId: "json-fixture-source",
        message: `Invalid customer ID format: ${customerId}`,
      });
    }
    const filePath = join(this.fixturesDir, `${customerId}.json`);
    try {
      const raw = await readFile(filePath, "utf-8");
      const json = JSON.parse(raw);
      const parsed = CrmRecordSchema.safeParse(json);
      if (!parsed.success) {
        return err({
          kind: "validation",
          nodeId: "json-fixture-source",
          message: `Invalid CRM record for ${customerId}: ${parsed.error.message}`,
        });
      }
      return ok(parsed.data);
    } catch (e: unknown) {
      if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
        return ok(null);
      }
      return err({
        kind: "node-crash",
        nodeId: "json-fixture-source",
        retriability: "retriable",
        message: `Failed to read fixture for ${customerId}: ${String(e)}`,
      });
    }
  }
}
