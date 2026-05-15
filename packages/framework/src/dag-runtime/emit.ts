// Shared emit helper — dispatches an ObserverEvent through the NodeContext's
// observer (if present). Eliminates the 4-file duplication of the same
// null-check + dispatchEvent pattern.

import type { NodeContext } from "../types/node.js";
import type { ObserverEvent } from "../types/events.js";
import type { Observer } from "../types/observer.js";
import { dispatchEvent } from "../observer/buffered.js";

export const emit = (ctx: NodeContext, event: ObserverEvent): void => {
  if (ctx.observer) {
    dispatchEvent(ctx.observer as Observer, event);
  }
};
