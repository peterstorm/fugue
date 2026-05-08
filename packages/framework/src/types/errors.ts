// Discriminated union of all framework errors

export type FrameworkError =
  | { readonly kind: "validation"; readonly nodeId: string; readonly message: string; readonly path?: string }
  | { readonly kind: "retry-exhausted"; readonly nodeId: string; readonly attempts: number; readonly lastError: string }
  | { readonly kind: "checkpoint-missing"; readonly runId: string }
  | { readonly kind: "checkpoint-expired"; readonly runId: string; readonly expiredAt: Date }
  | { readonly kind: "prompt-not-found"; readonly promptName: string; readonly reason: string }
  | { readonly kind: "cache-error"; readonly operation: string; readonly message: string }
  | { readonly kind: "node-crash"; readonly nodeId: string; readonly message: string; readonly stack?: string }
  | { readonly kind: "cycle-detected"; readonly nodeIds: readonly string[] }
  | { readonly kind: "aborted"; readonly reason: string }
  | { readonly kind: "rejected"; readonly nodeId: string; readonly reason: string }
  | { readonly kind: "invalid-reroute"; readonly targetNodeId: string; readonly message: string };
