// fugue capabilities — emit the framework's built-in capability catalogue as
// JSON, plus the mechanism for obtaining custom (adapter-provided) ones.
//
// This complements `fugue describe <dag>` (which reports what a *specific* DAG
// requires) by answering "what capability names are legal to put in a node's
// `requires`, and what does each inject into `ctx`?". The built-in set is
// sourced from `BUILTIN_CAPABILITY_KEYS` / `BUILTIN_CAPABILITY_INFO` so it can
// never drift from the registry.
//
// Pure and synchronous — never prints, never exits. The bin entry
// (`bin/fugue.ts`) handles I/O. All output is stable JSON.

import { BUILTIN_CAPABILITY_KEYS, BUILTIN_CAPABILITY_INFO } from "../types/node.js";
import type { CapabilitiesResult } from "./types.js";

/**
 * Build the capability catalogue. The built-in list is derived from the
 * registry's single source of truth; the `custom` block explains how to obtain
 * the rest (adapter packages + module augmentation + host wiring).
 */
export const runCapabilities = (): CapabilitiesResult => ({
  ok: true,
  builtin: BUILTIN_CAPABILITY_KEYS.map((name) => ({
    name,
    description: BUILTIN_CAPABILITY_INFO[name].description,
    clientType: BUILTIN_CAPABILITY_INFO[name].clientType,
    reference: BUILTIN_CAPABILITY_INFO[name].reference,
  })),
  custom: {
    mechanism:
      "Adapter packages (e.g. @fuguejs/fs and @fuguejs/ms-graph provide `documents`; @fuguejs/pg provides `db`) augment the `CapabilityRegistry` interface via TypeScript module augmentation and ship a `CapabilityHandle` that the host wires at boot.",
    howToDeclare:
      "Add the capability name to a node's `requires: [...] as const`. The matching `ctx.<name>` is then typed non-null inside `run`. Import the adapter (or its port package) so the augmented name is visible to the type checker.",
    discover:
      "The built-ins above are always part of the registry. Whether an adapter-provided capability is available is a property of the deployment — it exists only if the host registered its CapabilityHandle. Run `fugue describe <dag>` to see which capabilities a specific DAG requires.",
    seeAlso: [
      "docs/llm-document-source.md",
      "docs/adapter-authoring.md",
      "docs/adr/0051-extensible-capability-registry.md",
      "docs/adr/0052-document-source-capability.md",
    ],
  },
});
