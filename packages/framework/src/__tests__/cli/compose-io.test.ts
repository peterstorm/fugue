// readlineComposeIo — the terminal adapter's close/rejection semantics over a
// fake readline (no TTY). The load-bearing distinctions: a CLOSED interface
// settles every ask as { kind: "closed" } (whether the close lands before or
// mid-question, and whether it manifests as a hang or a rejection), while a
// rejection from a live interface is a genuine readline failure that must
// PROPAGATE — never be folded into the closed sentinel and misreported as a
// user abort.

import { describe, expect, it } from "bun:test";
import { readlineComposeIo, type ReadlineLike } from "../../cli/compose-io.js";

/**
 * A scriptable readline fake: `question` returns a promise the test settles
 * (or leaves pending), `close()` fires the registered close listener the way
 * the real interface's "close" event does.
 *
 * `questionBehavior` scripts Bun's divergence from Node: under Bun,
 * `rl.question` on a closed interface throws SYNCHRONOUSLY instead of
 * returning a never-settling promise.
 *   - "pending"                    — Node semantics (default): always return
 *                                    a promise the test settles.
 *   - "sync-throw"                 — the interface is broken: every question
 *                                    call throws synchronously (close never
 *                                    fired — a LIVE failure).
 *   - "sync-close-then-throw"      — Bun's closed-interface shape: question
 *                                    fires the close listeners, THEN throws
 *                                    synchronously.
 */
const fakeRl = (
  questionBehavior: "pending" | "sync-throw" | "sync-close-then-throw" = "pending",
): {
  rl: ReadlineLike;
  close: () => void;
  resolveQuestion: (text: string) => void;
  rejectQuestion: (e: unknown) => void;
  asked: string[];
} => {
  const closeListeners: (() => void)[] = [];
  const asked: string[] = [];
  let settle: { resolve: (text: string) => void; reject: (e: unknown) => void } | undefined;
  const close = (): void => {
    for (const l of closeListeners) l();
  };
  return {
    rl: {
      question: (query: string) => {
        asked.push(query);
        if (questionBehavior === "sync-throw") {
          throw new Error("readline exploded synchronously");
        }
        if (questionBehavior === "sync-close-then-throw") {
          close();
          throw new Error("question on closed interface");
        }
        return new Promise<string>((resolve, reject) => {
          settle = { resolve, reject };
        });
      },
      once: (_event, listener) => {
        closeListeners.push(listener);
        return undefined;
      },
    },
    close,
    resolveQuestion: (text) => settle?.resolve(text),
    rejectQuestion: (e) => settle?.reject(e),
    asked,
  };
};

describe("readlineComposeIo", () => {
  it("a typed answer resolves as { kind: 'answer' } with the prompt rendered", async () => {
    const { rl, resolveQuestion, asked } = fakeRl();
    const io = readlineComposeIo(rl);
    const pending = io.ask("Which sources?");
    resolveQuestion("weather");
    expect(await pending).toEqual({ kind: "answer", text: "weather" });
    expect(asked[0]).toBe("Which sources?\n> ");
  });

  it("closing mid-question settles the pending ask as closed (question hangs)", async () => {
    const { rl, close } = fakeRl();
    const io = readlineComposeIo(rl);
    const pending = io.ask("Which sources?");
    close(); // the question promise never settles — the close race must win
    expect(await pending).toEqual({ kind: "closed" });
  });

  it("closing BEFORE any question makes every subsequent ask settle as closed", async () => {
    const { rl, close } = fakeRl();
    const io = readlineComposeIo(rl);
    close();
    expect(await io.ask("first?")).toEqual({ kind: "closed" });
    expect(await io.ask("second?")).toEqual({ kind: "closed" });
  });

  it("a question rejection AFTER close folds into closed (the close manifesting)", async () => {
    const { rl, close, rejectQuestion } = fakeRl();
    const io = readlineComposeIo(rl);
    const pending = io.ask("Which sources?");
    close();
    rejectQuestion(new Error("aborted by close"));
    expect(await pending).toEqual({ kind: "closed" });
  });

  it("a rejection from a LIVE interface propagates — a real failure is not a user abort", async () => {
    const { rl, rejectQuestion } = fakeRl();
    const io = readlineComposeIo(rl);
    const pending = io.ask("Which sources?");
    rejectQuestion(new Error("EIO: readline exploded"));
    await expect(pending).rejects.toThrow("EIO: readline exploded");
  });

  // --- Bun's sync-throw divergence: `rl.question` on a closed interface
  // throws SYNCHRONOUSLY (Node returns a never-settling promise). The abort
  // path must survive it — no raw stack trace instead of the JSON outcome.

  it("ask after a known close never calls question at all (Bun sync-throw cannot fire)", async () => {
    // question would throw synchronously if called — the isClosed
    // short-circuit must answer `closed` without touching the interface.
    const { rl, close, asked } = fakeRl("sync-close-then-throw");
    const io = readlineComposeIo(rl);
    close();
    expect(await io.ask("first?")).toEqual({ kind: "closed" });
    expect(await io.ask("second?")).toEqual({ kind: "closed" });
    expect(asked).toEqual([]);
  });

  it("a sync throw whose question also delivered the close folds to closed (Bun mid-race)", async () => {
    // Bun's closed-interface question: the close manifests as a SYNC throw.
    // The fake fires the close listeners from inside question() and then
    // throws — isClosed is true by the time the catch runs, so the throw
    // folds to the closed sentinel exactly like a post-close rejection.
    const { rl } = fakeRl("sync-close-then-throw");
    const io = readlineComposeIo(rl);
    expect(await io.ask("Which sources?")).toEqual({ kind: "closed" });
  });

  it("a sync throw from a LIVE interface propagates — not misreported as a user abort", () => {
    const { rl } = fakeRl("sync-throw");
    const io = readlineComposeIo(rl);
    expect(() => io.ask("Which sources?")).toThrow("readline exploded synchronously");
  });
});
