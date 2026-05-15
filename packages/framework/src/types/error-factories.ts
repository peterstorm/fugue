// Ergonomic factory functions for constructing FrameworkError values.
//
// These accept plain strings for nodeId/runId and brand internally,
// providing the parse-don't-validate boundary for consumer code that
// constructs errors outside the framework's node factories.

import { nodeId as brandNodeId } from "./ids.js";
import type { NodeId, RunId } from "./ids.js";
import type { FrameworkError } from "./errors.js";
import type { Capability } from "./node.js";

const toNodeId = (nid: string | NodeId): NodeId =>
  typeof nid === "object" ? nid : brandNodeId(nid);

/** Ergonomic factories for constructing FrameworkError values with string node IDs. */
export const frameworkError = {
  validation: (nid: string | NodeId, message: string, path?: string): FrameworkError =>
    ({ kind: "validation", nodeId: toNodeId(nid), message, ...(path !== undefined ? { path } : {}) }),

  nodeCrash: (nid: string | NodeId, message: string, opts?: {
    retriability?: "retriable" | "non-retriable";
    stack?: string;
  }): FrameworkError => ({
    kind: "node-crash",
    nodeId: toNodeId(nid),
    message,
    retriability: opts?.retriability ?? "retriable",
    ...(opts?.stack !== undefined ? { stack: opts.stack } : {}),
  }),

  transient: (nid: string | NodeId, message: string): FrameworkError =>
    ({ kind: "transient", nodeId: toNodeId(nid), message }),

  rejected: (nid: string | NodeId, reason: string): FrameworkError =>
    ({ kind: "rejected", nodeId: toNodeId(nid), reason }),

  invalidReroute: (targetNodeId: string | NodeId, message: string): FrameworkError =>
    ({ kind: "invalid-reroute", targetNodeId: toNodeId(targetNodeId), message }),
} as const;
