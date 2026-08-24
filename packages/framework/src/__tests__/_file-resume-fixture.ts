import type { Machine } from "../state-machine/types.js";

export type S =
  | { kind: "pending"; count: number }
  | { kind: "succeeded"; count: number }
  | { kind: "failed"; count: number };

export type E = { type: "STEP" } | { type: "DONE" } | { type: "FAIL" };
export type C = { value: number };

/** Shared resume model: pending(n) advances by STEP and terminates by DONE/FAIL. */
export const machine: Machine<S, E, C> = {
  transition(state, event, context) {
    if (state.kind === "pending" && event.type === "STEP") {
      return {
        state: { kind: "pending", count: state.count + 1 },
        context: { value: context.value + 1 },
      };
    }
    if (state.kind === "pending" && event.type === "DONE") {
      return { state: { kind: "succeeded", count: state.count }, context };
    }
    if (state.kind === "pending" && event.type === "FAIL") {
      return { state: { kind: "failed", count: state.count }, context };
    }
    return { state, context };
  },
  isTerminal: (state) => state.kind === "succeeded" || state.kind === "failed",
  isFailed: (state) => state.kind === "failed",
  stateProgress: (state) => state.kind === "succeeded" ? 100 : state.kind === "failed" ? 0 : 50,
  stateKey: (state) => JSON.stringify(state),
};

export const genesis = (): { state: S; context: C } => ({
  state: { kind: "pending", count: 0 },
  context: { value: 0 },
});
