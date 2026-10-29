import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
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
 *
 * The streams are injectable so that the interactive path can be tested. It
 * could not be before, and that is exactly where both display bugs lived.
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

export interface PrompterOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Overrides the isTTY check. Tests drive the interactive path with this. */
  interactive?: boolean;
}

export class Prompter {
  #rl: Interface;
  #out: NodeJS.WritableStream;
  #lines: AsyncIterator<string> | null = null;
  #muted = false;
  #completion: Completion = "none";

  /** True only when a person is typing, as opposed to a script or a heredoc. */
  readonly interactive: boolean;

  constructor(opts: PrompterOptions = {}) {
    const input = opts.input ?? process.stdin;
    const real = opts.output ?? process.stdout;
    this.#out = real;
    this.interactive = opts.interactive ?? process.stdin.isTTY === true;

    // readline draws through this rather than straight at the terminal, so a
    // password can be read without being echoed. The previous attempt stubbed
    // readline's internal _writeToOutput, which does not exist on current Node
    // -- so it silenced nothing and the password went to the screen in clear
    // while the prompt promised otherwise. Owning the stream needs no
    // internals and cannot rot the same way.
    const sink = new Writable({
      write: (chunk: unknown, _enc: unknown, cb: (err?: Error | null) => void) => {
        if (!this.#muted) real.write(chunk as Buffer);
        cb();
      },
    });
    // readline reads these off its output for line wrapping and cursor maths.
    const source = real as unknown as { isTTY?: boolean; columns?: number; rows?: number };
    Object.defineProperties(sink, {
      isTTY: { get: () => source.isTTY === true },
      columns: { get: () => source.columns },
      rows: { get: () => source.rows },
    });

    this.#rl = createInterface({
      input,
      output: sink,
      terminal: this.interactive,
      completer: (line: string): [string[], string] =>
        this.#completion === "dir" ? completeDir(line) : [[], line],
    });
    if (!this.interactive) this.#lines = this.#rl[Symbol.asyncIterator]();
  }

  #say(text: string): void {
    this.#out.write(`${text}\n`);
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
    if (opts.help) this.#say(`  ${opts.help}`);
    const text = opts.fallback ? `${question} [${opts.fallback}] ` : `${question} `;
    this.#completion = opts.completion ?? "none";
    try {
      let answer: string;
      if (this.interactive) {
        answer = (await this.#rl.question(text)).trim();
      } else {
        this.#out.write(text);
        answer = (await this.#nextPipedLine()).trim();
      }
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
      this.#say(`  ${problem}`);
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
    labels.forEach((label, i) => this.#say(`    ${i + 1}. ${label}`));
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

  /**
   * Reads a line without echoing it, where there is a terminal to hide from.
   *
   * The prompt is printed on its own line and the answer typed on the line
   * below. That is not cosmetic. readline redraws by putting the cursor at
   * column 0 and clearing from there down, and those writes go straight to the
   * output stream rather than through the writer muted below -- so a prompt
   * sharing the line with the answer is erased the instant readline draws
   * anything, leaving a blank line and no sign of what is being asked. A line
   * above the cursor is out of its reach.
   */
  async secret(question: string): Promise<string> {
    if (!this.interactive) {
      this.#out.write(question);
      return (await this.#nextPipedLine()).trim();
    }
    this.#say(question);

    // Everything readline would draw while the answer is being typed is
    // dropped: the echo, and the cursor moves and line clears that go with it.
    // Line editing is unaffected, since that is internal state rather than
    // anything on screen -- backspace still works, it just shows nothing.
    this.#muted = true;
    try {
      return (await this.#rl.question("")).trim();
    } finally {
      this.#muted = false;
      // The newline readline writes on submit was dropped with the rest, so
      // move the cursor down here or the next output lands on this line.
      this.#out.write("\n");
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
    if (this.#out === process.stdout) process.stdin.pause();
  }
}
