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
//   * Under Bun, `rl.question` on an ALREADY-closed interface throws
//     synchronously instead — `ask` short-circuits a known close and folds a
//     sync throw by the same rule (closed ⇒ fold, live ⇒ propagate).

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
    ask: (q) => {
      // Under Bun, `rl.question` on an already-closed interface throws
      // SYNCHRONOUSLY (Node returns a promise that never settles) — the throw
      // would escape before the race / rejection-fold below ever attaches and
      // crash the abort path with a raw stack trace. Short-circuit a known
      // close first; then fold a sync throw exactly like the rejection: the
      // close licenses the fold, a throw from a LIVE interface is a genuine
      // readline failure and must propagate.
      if (isClosed) return Promise.resolve(closed);
      let question: Promise<string>;
      try {
        question = rl.question(`${q}\n> `);
      } catch (e) {
        if (isClosed) return Promise.resolve(closed);
        throw e;
      }
      return Promise.race([
        question.then(
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
      ]);
    },
    say: (m) => process.stdout.write(`${m}\n`),
  };
};
