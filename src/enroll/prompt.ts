import { createInterface, type Interface } from "node:readline/promises";
import { completeDir } from "../core/paths.ts";

/**
 * The wizard's prompting layer.
 *
 * It exists as its own thing because the first version got this wrong in a way
 * that made the whole wizard feel broken. It wrote prompts with
 * process.stdout.write and read answers from readline's async iterator, so
 * readline did not know what the prompt was -- and every redraw it does,
 * including the one after a backspace, wiped the prompt off the line. Text
 * appeared to vanish as you typed.
 *
 * readline's own question() handles all of that, and brings tab completion with
 * it. The iterator is still used, but only when input is piped: question()
 * drops lines that arrived before it was called, so a scripted run loses every
 * answer after the first and then hangs.
 */

export type Completion = "none" | "dir";

export interface AskOptions {
  /** Returned when the answer is blank. */
  fallback?: string;
  /** What Tab completes, while this question is on screen. */
  completion?: Completion;
  /** Shown once, above the prompt. */
  help?: string;
}

export class Prompter {
  #rl: Interface;
  #lines: AsyncIterator<string> | null = null;
  #completion: Completion = "none";

  /** True only when a person is typing, as opposed to a script or a heredoc. */
  readonly interactive: boolean;

  constructor() {
    this.interactive = process.stdin.isTTY === true;
    this.#rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: this.interactive,
      completer: (line: string): [string[], string] =>
        this.#completion === "dir" ? completeDir(line) : [[], line],
    });
    if (!this.interactive) this.#lines = this.#rl[Symbol.asyncIterator]();
  }

  async #nextPipedLine(): Promise<string> {
    if (!this.#lines) throw new Error("input is not open");
    const { value, done } = await this.#lines.next();
    return done === true ? "" : String(value);
  }

  /**
   * Asks one question.
   *
   * Help text is written before the prompt rather than inside it, so a redraw
   * cannot eat it and a long explanation does not push the cursor off the line.
   */
  async ask(question: string, opts: AskOptions = {}): Promise<string> {
    if (opts.help) console.log(`  ${opts.help}`);
    const text = opts.fallback ? `${question} [${opts.fallback}] ` : `${question} `;
    this.#completion = opts.completion ?? "none";
    try {
      const answer = this.interactive
        ? (await this.#rl.question(text)).trim()
        : await (async () => {
            process.stdout.write(text);
            return (await this.#nextPipedLine()).trim();
          })();
      return answer === "" ? (opts.fallback ?? "") : answer;
    } finally {
      this.#completion = "none";
    }
  }

  /** Asks until the answer passes, showing the reason each time it does not. */
  async askUntil(
    question: string,
    check: (answer: string) => string | null,
    opts: AskOptions = {},
  ): Promise<string> {
    for (;;) {
      const answer = await this.ask(question, opts);
      const problem = check(answer);
      if (problem === null) return answer;
      console.log(`  ${problem}`);
      // A script cannot be asked again -- it would be handed the next scripted
      // answer and everything after it would land in the wrong question.
      if (!this.interactive) return answer;
      opts = { ...opts, help: undefined };
    }
  }

  async yes(question: string, fallback = true): Promise<boolean> {
    const answer = await this.ask(`${question} (y/n)`, { fallback: fallback ? "y" : "n" });
    return answer.toLowerCase().startsWith("y");
  }

  /**
   * Offers a numbered list and returns the chosen index.
   *
   * Out-of-range and non-numeric answers ask again rather than silently
   * selecting the default, which is how the old version lost a posture choice.
   */
  async choose(question: string, labels: string[], fallbackIndex = 0): Promise<number> {
    labels.forEach((label, i) => console.log(`    ${i + 1}. ${label}`));
    const answer = await this.askUntil(
      question,
      (given) => {
        const n = Number(given);
        if (!Number.isInteger(n) || n < 1 || n > labels.length) {
          return `Enter a number from 1 to ${labels.length}.`;
        }
        return null;
      },
      { fallback: String(fallbackIndex + 1) },
    );
    const n = Number(answer);
    return Number.isInteger(n) && n >= 1 && n <= labels.length ? n - 1 : fallbackIndex;
  }

  /** Reads a line without echoing it, where there is a terminal to hide from. */
  async secret(question: string): Promise<string> {
    process.stdout.write(question);
    if (!this.interactive) return (await this.#nextPipedLine()).trim();

    // readline has no supported way to suppress echo, so silence its writer for
    // the duration. If a future version drops the internal, the password is
    // merely visible -- annoying, not broken -- so this never throws.
    const internals = this.#rl as unknown as { _writeToOutput?: (s: string) => void };
    const original = internals._writeToOutput;
    internals._writeToOutput = () => {};
    try {
      return (await this.#rl.question("")).trim();
    } finally {
      internals._writeToOutput = original;
      process.stdout.write("\n");
    }
  }

  /**
   * Gives stdin back.
   *
   * The old version called process.exit() from inside a live question, which on
   * Windows aborted with an assertion out of libuv's async.c -- the handle was
   * already closing. Closing properly and letting the process end on its own
   * avoids that entirely.
   */
  close(): void {
    this.#rl.close();
    process.stdin.pause();
  }
}
