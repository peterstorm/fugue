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
 */
const fakeRl = (): {
  rl: ReadlineLike;
  close: () => void;
  resolveQuestion: (text: string) => void;
  rejectQuestion: (e: unknown) => void;
  asked: string[];
} => {
  const closeListeners: (() => void)[] = [];
  const asked: string[] = [];
  let settle: { resolve: (text: string) => void; reject: (e: unknown) => void } | undefined;
  return {
    rl: {
      question: (query: string) => {
        asked.push(query);
        return new Promise<string>((resolve, reject) => {
          settle = { resolve, reject };
        });
      },
      once: (_event, listener) => {
        closeListeners.push(listener);
        return undefined;
      },
    },
    close: () => {
      for (const l of closeListeners) l();
    },
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
});
