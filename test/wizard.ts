import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { completeDir } from "../src/core/paths.ts";
import { Prompter } from "../src/enroll/prompt.ts";
import {
  clearDraft,
  draftPathFor,
  emptyDraft,
  loadDraft,
  nameProblem,
  saveDraft,
} from "../src/enroll/draft.ts";

const dir = mkdtempSync(join(tmpdir(), "baton-wizard-"));

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// -- tab completion -----------------------------------------------------------

mkdirSync(join(dir, "src", "alexandria"), { recursive: true });
mkdirSync(join(dir, "src", "alexandria-www"), { recursive: true });
mkdirSync(join(dir, "src", "brochure"), { recursive: true });
writeFileSync(join(dir, "src", "notes.txt"), "not a directory");

check("completion offers the directories under a path", () => {
  const [hits] = completeDir(`${dir}/src/`);
  assert.deepEqual(
    hits.map((h) => h.slice(`${dir}/src/`.length)),
    ["alexandria/", "alexandria-www/", "brochure/"],
    "sorted, and each ends with a separator so tabbing again goes deeper",
  );
});

check("completion narrows by what has been typed", () => {
  const [hits] = completeDir(`${dir}/src/alex`);
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.includes("alexandria")));
});

check("completion leaves files out, since every path asked for is a directory", () => {
  const [hits] = completeDir(`${dir}/src/not`);
  assert.deepEqual(hits, []);
});

check("completion keeps the separator that was typed", () => {
  const [backslash] = completeDir(`${dir.replace(/\//g, "\\")}\\src\\bro`);
  assert.ok(backslash[0]?.endsWith("brochure\\"), `got ${backslash[0]}`);
  const [forward] = completeDir(`${dir}/src/bro`);
  assert.ok(forward[0]?.endsWith("brochure/"), `got ${forward[0]}`);
});

check("completion handles a path pasted with quotes", () => {
  const [hits] = completeDir(`"${dir}/src/bro`);
  assert.ok(hits[0]?.endsWith("brochure/"), "the quote is not treated as part of the name");
});

check("completion on a directory that is not there is quiet", () => {
  assert.deepEqual(completeDir(`${dir}/nope/deeper/`), [[], `${dir}/nope/deeper/`]);
  assert.deepEqual(completeDir(""), completeDir(""), "and an empty line does not throw");
});

// -- names --------------------------------------------------------------------

check("a name is refused when it would collide by slug, not just by spelling", () => {
  // The server's primary key is slug(name), so these are the same project.
  assert.match(nameProblem("My App", ["my-app"]) ?? "", /already uses/);
  assert.match(nameProblem("my_app", ["my-app"]) ?? "", /already uses/);
  assert.match(nameProblem("ALEXANDRIA", ["alexandria"]) ?? "", /already uses/);
});

check("the same name twice says so plainly", () => {
  assert.match(nameProblem("alpha", ["alpha"]) ?? "", /already added/i);
});

check("a name with nothing to slug is refused", () => {
  assert.match(nameProblem("!!!", []) ?? "", /no letters or digits/i);
  assert.match(nameProblem("   ", []) ?? "", /name is needed/i);
});

check("a distinct name passes", () => {
  assert.equal(nameProblem("brochure", ["alexandria", "my-app"]), null);
});

// -- the draft ----------------------------------------------------------------

const configPath = join(dir, "cfg", "runner.config.json");
const draftPath = draftPathFor(configPath);

check("the draft sits beside the config it will become", () => {
  assert.equal(draftPath, join(dir, "cfg", "runner.config.draft.json"));
});

check("a draft round-trips every answer", () => {
  const draft = emptyDraft();
  draft.serverUrl = "https://baton.example.com";
  draft.machine = "ODIN";
  draft.profiles.push({
    label: "Client A",
    command: "C:/Users/you/.local/bin/claude.exe",
    launchArgs: [],
    args: ["--model", "opus"],
    env: {},
    credentialRef: "client-a",
    configDir: "C:/Users/you/.claude-client-a",
  });
  draft.projects.push({
    name: "brochure",
    path: "C:/src/brochure",
    profileLabel: "Client A",
    posture: "edits",
    contained: false,
    allowedDomains: [],
  });
  saveDraft(draftPath, draft);

  const back = loadDraft(draftPath);
  assert.equal(back?.machine, "ODIN");
  assert.equal(back?.profiles[0]?.configDir, "C:/Users/you/.claude-client-a");
  assert.deepEqual(back?.profiles[0]?.args, ["--model", "opus"]);
  assert.equal(back?.projects[0]?.posture, "edits");
  assert.ok(back?.savedAt, "and when it was saved, so a resume can say");
});

check("the draft never holds the password", () => {
  // It is the one answer cheap to retype and unacceptable to leave on disk.
  const raw = readFileSync(draftPath, "utf8").toLowerCase();
  assert.ok(!raw.includes("password"), "no password field at all");
  assert.ok(!raw.includes("token"), "and no token either");
});

check("the draft is written only for its owner", () => {
  if (process.platform === "win32") return; // POSIX modes do not apply
  assert.equal(statSync(draftPath).mode & 0o777, 0o600);
});

check("a draft from another version is ignored rather than half-read", () => {
  const stale = join(dir, "stale.json");
  writeFileSync(stale, JSON.stringify({ version: 99, machine: "ODIN" }));
  assert.equal(loadDraft(stale), null);
});

check("an unreadable draft is not a reason to refuse to run", () => {
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ this is not json");
  assert.equal(loadDraft(broken), null, "a convenience must not become a blocker");
  assert.equal(loadDraft(join(dir, "absent.json")), null);
});

check("a draft drops entries it cannot trust and keeps the rest", () => {
  const mixed = join(dir, "mixed.json");
  writeFileSync(
    mixed,
    JSON.stringify({
      version: 1,
      machine: "ODIN",
      profiles: [{ label: "ok", command: "claude" }, { label: "no command" }],
      projects: [
        { name: "good", path: "/srv/good", posture: "edits" },
        { name: "bad posture", path: "/srv/bad", posture: "yolo" },
        { name: "no path", posture: "edits" },
      ],
    }),
  );
  const back = loadDraft(mixed);
  assert.equal(back?.profiles.length, 1, "a profile with no command cannot run anything");
  assert.equal(back?.projects.length, 1, "nor can a project with a bad posture or no path");
  assert.equal(back?.projects[0]?.name, "good");
});

check("clearing the draft removes it, and twice is not an error", () => {
  clearDraft(draftPath);
  assert.equal(loadDraft(draftPath), null);
  clearDraft(draftPath);
});

// -- what a terminal actually shows ------------------------------------------

/**
 * Applies the escape sequences readline emits to a screen, and returns its
 * lines.
 *
 * Asserting on the raw bytes would prove nothing here: both display bugs in
 * this wizard were writes that happened and were then erased, so the text was
 * present in the stream and absent from the screen. readline moves the cursor
 * to column 0 and clears from there down on every redraw, so the only honest
 * question is what is left afterwards.
 */
function render(raw: string): string {
  const lines: string[] = [""];
  let row = 0;
  let col = 0;
  const at = (r: number): string => {
    while (lines.length <= r) lines.push("");
    return lines[r]!;
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "\x1b" && raw[i + 1] === "[") {
      let j = i + 2;
      while (j < raw.length && /[0-9;?]/.test(raw[j]!)) j++;
      const n = Number(raw.slice(i + 2, j).split(";")[0] || "0");
      const final = raw[j];
      i = j + 1;
      if (final === "G") col = Math.max(0, n - 1);
      else if (final === "J") {
        // Clear from the cursor to the end of the screen.
        lines[row] = at(row).slice(0, col);
        lines.length = row + 1;
      } else if (final === "K") {
        lines[row] = n === 2 ? "" : at(row).slice(0, col);
      } else if (final === "A") row = Math.max(0, row - Math.max(n, 1));
      else if (final === "B") row += Math.max(n, 1);
      else if (final === "C") col += Math.max(n, 1);
      else if (final === "D") col = Math.max(0, col - Math.max(n, 1));
      continue;
    }
    i++;
    if (ch === "\n") {
      row++;
      col = 0;
      at(row);
    } else if (ch === "\r") {
      col = 0;
    } else {
      const line = at(row).padEnd(col, " ");
      lines[row] = line.slice(0, col) + ch + line.slice(col + 1);
      col++;
    }
  }
  return lines.join("\n");
}

/** A Prompter wired to streams a test can drive, on the interactive path. */
function onFakeTerminal(): {
  prompter: Prompter;
  type: (keys: string) => void;
  screen: () => string;
  raw: () => string;
} {
  const input = new PassThrough();
  const written: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      written.push(String(chunk));
      cb();
    },
  });
  Object.assign(output, { isTTY: true, columns: 100, rows: 30 });
  const prompter = new Prompter({ input, output, interactive: true });
  return {
    prompter,
    type: (keys: string) => input.write(keys),
    screen: () => render(written.join("")),
    raw: () => written.join(""),
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

async function acheck(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

check("the renderer notices text that was written and then erased", () => {
  // Guarding the guard: if this did not model erasure, the two checks below
  // would pass against the very bug they exist to catch.
  assert.equal(render("Password: \x1b[1G\x1b[0J"), "", "cleared from column 0 downwards");
  assert.equal(render("Password:\nsecret\x1b[1G\x1b[0J"), "Password:\n", "but not the line above");
});

await acheck("the password prompt survives readline's redrawing", async () => {
  const { prompter, type, screen, raw } = onFakeTerminal();
  const pending = prompter.secret("Login password (it is not shown as you type):");
  await settle();
  // A correction forces a full redraw, which is what erased the prompt before.
  type("hunterX");
  await settle();
  type("\x7f");
  await settle();
  type("2\r");

  const got = await pending;
  prompter.close();

  assert.equal(got, "hunter2", "and the backspace was applied to the answer");
  const shown = screen();
  assert.match(shown, /Login password/, "the prompt is still on screen afterwards");
  assert.ok(!shown.includes("hunter"), "and not one character of it was echoed");
  // Stronger than the screen: it must never reach the stream at all, or it
  // sits in the scrollback of every terminal this is ever run in.
  assert.ok(!raw().includes("hunter"), "nothing of it was written out, not even to be erased");
  assert.ok(!raw().includes("hunterX"), "including the mistyped attempt");
});

await acheck("an ordinary prompt survives a backspace too", async () => {
  const { prompter, type, screen } = onFakeTerminal();
  const pending = prompter.ask("A name for this machine", {
    fallback: "odin",
    help: "Tab completes.",
  });
  await settle();
  type("ODINX");
  await settle();
  type("\x7f");
  await settle();
  type("\r");

  assert.equal(await pending, "ODIN");
  prompter.close();

  const shown = screen();
  assert.match(shown, /A name for this machine/, "the prompt is intact after the redraw");
  assert.match(shown, /\[odin\]/, "including the default it offered");
  assert.match(shown, /Tab completes\./, "and the help text above it");
});

await acheck("a blank answer takes the default", async () => {
  const { prompter, type } = onFakeTerminal();
  const pending = prompter.ask("A name for this machine", { fallback: "odin" });
  await settle();
  type("\r");
  assert.equal(await pending, "odin");
  prompter.close();
});

await acheck("a bad numbered choice is asked again rather than defaulted", async () => {
  const { prompter, type, screen } = onFakeTerminal();
  const pending = prompter.choose("Number", ["first", "second", "third"], 1);
  await settle();
  type("9\r");
  await settle();
  type("3\r");

  assert.equal(await pending, 2, "the second answer is the one used");
  prompter.close();
  assert.match(screen(), /Enter a number from 1 to 3/, "and it said why the first was no good");
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
