import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeDir } from "../src/core/paths.ts";
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

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
