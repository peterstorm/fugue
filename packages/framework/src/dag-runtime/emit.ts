// Shared emit helper — dispatches an ObserverEvent through the NodeContext's
// observer. The observer field always has a value (defaults to NoopObserver
// via makeNodeContext), so no null-check is needed.

import type { NodeContext } from "../types/node.js";
import type { ObserverEvent } from "../types/events.js";
import { dispatchEvent } from "../observer/buffered.js";

export const emit = (ctx: NodeContext, event: ObserverEvent): void => {
  dispatchEvent(ctx.observer, event);
};
