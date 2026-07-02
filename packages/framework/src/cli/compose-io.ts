// The readline-backed ComposeIo adapter — the terminal half of `fugue
// compose`, extracted from the bin so the close/rejection semantics are
// testable with a fake readline (no TTY). The bin keeps only
// `createInterface`, SIGINT registration, and env-key wiring.
//
// Semantics this adapter owns:
//   * Ctrl-D / piped-stdin exhaustion closes the interface — a pending `ask`
//     must settle as `{ kind: "closed" }` rather than hang the process
//     forever. One shared close promise, registered up front, races every ask.
//   * If the interface closes mid-question, `rl.question` either never
//     settles or rejects (runtime-dependent) — a rejection is folded to
//     `closed` ONLY when the interface actually closed. Any other rejection
//     is a genuine readline failure and must propagate (the bin's top-level
//     catch prints it), never be misreported as a user abort.

import type { ComposeAnswer, ComposeIo } from "./compose.js";

/**
 * The minimal structural slice of `node:readline/promises`' `Interface` this
 * adapter needs — narrow so tests substitute a plain fake object.
 */
export interface ReadlineLike {
  question(query: string): Promise<string>;
  once(event: "close", listener: () => void): unknown;
}

/**
 * Build a `ComposeIo` over a readline interface. `say` writes to stdout —
 * compose is interactive prose until its final JSON outcome line.
 */
export const readlineComposeIo = (rl: ReadlineLike): ComposeIo => {
  const closed: ComposeAnswer = { kind: "closed" };
  // Whether the interface ACTUALLY closed — the fact that licenses folding a
  // question rejection into the closed sentinel. Registered once, up front,
  // so every subsequent ask shares the same close promise.
  let isClosed = false;
  const closedToAbort: Promise<ComposeAnswer> = new Promise((resolveClosed) => {
    rl.once("close", () => {
      isClosed = true;
      resolveClosed(closed);
    });
  });
  return {
    ask: (q) =>
      Promise.race([
        rl.question(`${q}\n> `).then(
          (text): ComposeAnswer => ({ kind: "answer", text }),
          (e: unknown): ComposeAnswer => {
            // A rejection from a CLOSED interface is the close manifesting —
            // fold it. Anything else is a real readline failure: rethrow so
            // it surfaces instead of masquerading as a user abort.
            if (isClosed) return closed;
            throw e;
          },
        ),
        closedToAbort,
      ]),
    say: (m) => process.stdout.write(`${m}\n`),
  };
};
