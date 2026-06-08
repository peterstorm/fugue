/**
 * The /contract subpath is the public surface DAG repos build against — a
 * removed export breaks every dags repo's pre-merge validation. Pin it here.
 */

import { describe, it, expect } from "bun:test";
import {
  DagRegistrationSchema,
  validateDagRegistration,
  resolveDefaults,
  FugueYamlSchema,
  parseFugueYaml,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT,
} from "../contract.js";

describe("@fuguejs/host/contract surface", () => {
  it("exports the DagRegistration validation pieces", () => {
    expect(DagRegistrationSchema).toBeDefined();
    expect(typeof validateDagRegistration).toBe("function");
    expect(typeof resolveDefaults).toBe("function");
    expect(typeof DEFAULT_TIMEOUT_MS).toBe("number");
    expect(typeof DEFAULT_MAX_CONCURRENT).toBe("number");
  });

  it("exports fugue.yaml validation for DAG-repo CI", () => {
    const valid = FugueYamlSchema.safeParse({ team: "leads", owner: "peter.hansen" });
    expect(valid.success).toBe(true);

    const result = parseFugueYaml({ team: "" }, "dags/x/y/fugue.yaml");
    expect(result.ok).toBe(false);
  });
});
