import { createInterface, type Interface } from "node:readline/promises";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { parseArgs } from "node:util";
import { PERMISSION_PRESETS } from "./core/permissions.ts";
import { cleanPath } from "./core/paths.ts";
import { floorJson, floorTarget } from "./core/managed.ts";
import { slug } from "./core/slug.ts";
import type { Posture } from "./core/types.ts";
import { DEFAULT_CONFIG_PATH } from "./runner/config.ts";

/**
 * The enrolment wizard. Run on a worker machine:
 *
 *   npm run enroll -- --server https://baton.example.com
 *
 * It asks what this machine is, which Claude accounts it has, which projects
 * live here and what each may do unattended. Then it tells the server the
 * names -- and only the names -- and writes everything else into this machine's
 * own config.
 *
 * That split is the point. The server learns that a project called "alexandria"
 * lives on this machine under the "Client A" account at the "edits" posture. It
 * does not learn, and cannot set, which binary runs, with what environment, in
 * which directory, or how much that posture is allowed to mean. So a server
 * that is taken over cannot run anything here that you had not already allowed.
 */

const { values } = parseArgs({
  allowPositionals: false,
  options: {
    server: { type: "string" },
    config: { type: "string" },
    replace: { type: "boolean" },
    "floor-only": { type: "boolean" },
  },
});

function die(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

/**
 * True only when a person is typing. Piped input (a script, or ssh with a
 * heredoc) must not get readline's terminal handling: it swallows the whole
 * stream on the first question and the run hangs.
 */
const interactive = process.stdin.isTTY === true;

/**
 * Lines are pulled from an iterator rather than asked for one at a time.
 * readline's own question() drops anything that arrived before it was called,
 * so with piped input -- a script, or ssh with a heredoc -- every answer after
 * the first is lost and the run hangs. The iterator queues them properly.
 */
let lines: AsyncIterator<string> | null = null;

async function nextLine(): Promise<string> {
  if (!lines) throw new Error("input is not open");
  const { value, done } = await lines.next();
  return done === true ? "" : String(value);
}

/** Reads a line without echoing it, where there is a terminal to hide from. */
async function secret(rl: Interface, prompt: string): Promise<string> {
  process.stdout.write(prompt);
  if (!interactive) return (await nextLine()).trim();

  // readline has no supported way to suppress echo, so override the internal
  // writer for the duration. If a future version drops it the password is
  // simply visible -- annoying, not broken -- so this never throws.
  const internals = rl as unknown as {
    output?: NodeJS.WritableStream;
    _writeToOutput?: (s: string) => void;
  };
  const original = internals._writeToOutput;
  let muted = true;
  internals._writeToOutput = (s: string) => {
    if (!muted) internals.output?.write(s);
  };
  try {
    return (await nextLine()).trim();
  } finally {
    muted = false;
    internals._writeToOutput = original;
    process.stdout.write("\n");
  }
}

const ask = async (_rl: Interface, prompt: string, fallback = ""): Promise<string> => {
  process.stdout.write(fallback ? `${prompt} [${fallback}] ` : `${prompt} `);
  const answer = (await nextLine()).trim();
  return answer === "" ? fallback : answer;
};

const yes = async (rl: Interface, prompt: string, fallback = true): Promise<boolean> => {
  const answer = (await ask(rl, `${prompt} (y/n)`, fallback ? "y" : "n")).toLowerCase();
  return answer.startsWith("y");
};

/**
 * Asks for a directory until it gets one that is absolute and really there.
 *
 * It used to skip the project on a bad answer, which meant a typo cost you the
 * project silently. Returns null only when the answer is blank, which is how
 * you back out.
 */
async function askExistingDir(rl: Interface, prompt: string): Promise<string | null> {
  for (;;) {
    const given = cleanPath(await ask(rl, prompt));
    if (given === "") return null;
    if (!isAbsolute(given)) {
      console.log(`  "${given}" is not an absolute path, and guessing where it starts`);
      console.log("  would be worse than asking again. Paste the full path.");
      if (!interactive) return null;
      continue;
    }
    if (!existsSync(given)) {
      console.log(`  ${given} does not exist on this machine.`);
      if (!interactive) return null;
      continue;
    }
    return resolve(given);
  }
}

interface EnrollReply {
  error?: string;
  workerId?: string;
  token?: string;
}

const postEnroll = async (
  serverUrl: string,
  body: unknown,
): Promise<{ status: number; payload: EnrollReply }> => {
  const res = await fetch(`${serverUrl}/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, payload: (await res.json().catch(() => ({}))) as EnrollReply };
};

/**
 * Checks the password before asking everything else.
 *
 * One round trip, against getting to the end of the wizard, having named a
 * machine and several accounts and projects, and then losing the lot to a typo
 * made minutes earlier. The submit path can retry too, but failing here is
 * cheaper than failing there.
 */
async function verifyPassword(rl: Interface, serverUrl: string, given: string): Promise<string> {
  let password = given;
  for (let attempt = 0; ; attempt++) {
    const { status, payload } = await postEnroll(serverUrl, { password, check: true });
    if (status === 200) return password;
    if (status === 503) {
      die(
        `That server cannot enrol a machine: ${payload.error ?? "it has no login password set"}`,
      );
    }
    if (status === 429) die("Too many attempts. Wait a few minutes and run this again.");
    if (status !== 401) {
      // A server from before the check existed answers something else -- and
      // such a server also predates profiles and projects moving onto the
      // worker, so it would accept what this wizard sends and store a profile
      // with no command and a project with no path. It cannot tell that it has
      // been handed the wrong shape, so refuse here instead.
      die(
        `That server does not understand this version of enrolment (HTTP ${status}` +
          `${payload.error ? `: ${payload.error}` : ""}).\n\n` +
          `It is running a build from before a machine held its own config. Deploy the ` +
          `server first, then run this again -- an older server would accept these ` +
          `answers and store a profile with no command and a project with no path.`,
      );
    }
    if (!interactive || attempt >= 4) die("That password was not accepted.");
    console.log("That password was not accepted by the server.");
    password = await secret(rl, "Login password (not shown): ");
    if (password === "") die("Stopped.");
  }
}

/** Where Claude Code lives on this machine, and how it has to be launched. */
function findClaude(): { command: string; launchArgs: string[] } | null {
  const win = process.platform === "win32";
  const direct = [
    join(homedir(), ".local", "bin", win ? "claude.exe" : "claude"),
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .flatMap((d) => (win ? ["claude.exe", "claude.cmd"] : ["claude"]).map((n) => join(d, n))),
  ];

  for (const candidate of direct) {
    if (!existsSync(candidate)) continue;
    if (!/\.(cmd|bat|ps1)$/i.test(candidate)) return { command: candidate, launchArgs: [] };

    // A .cmd shim cannot be spawned without a shell, and the runner refuses to
    // put a prompt through cmd.exe. Point at the entry point it wraps instead.
    const cli = join(dirname(candidate), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (existsSync(cli)) return { command: process.execPath, launchArgs: [cli] };
  }
  return null;
}

const readable = (path: string): boolean => {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

/** The sandbox exists on macOS, Linux and WSL2, but not on native Windows. */
const CAN_CONTAIN = process.platform !== "win32";

interface LocalProfileSpec {
  label: string;
  command: string;
  launchArgs: string[];
  args: string[];
  env: Record<string, string>;
  credentialRef: string | null;
}

interface LocalProjectSpec {
  name: string;
  path: string;
  profileLabel: string;
  posture: Posture;
  contained: boolean;
  allowedDomains: string[];
}

/**
 * Writes the machine's floor next to its config and says how to install it.
 *
 * It is not installed here because it has to go somewhere only an administrator
 * can write -- which is exactly why it is worth having. An agent runs as you,
 * so a file you can write is a file it can rewrite.
 */
function stageFloor(configPath: string): void {
  const target = floorTarget();
  const staged = join(dirname(configPath), "managed-settings.json");
  writeFileSync(staged, floorJson(), { mode: 0o644 });

  console.log("\n--- One more step, and it needs administrator rights ---\n");
  console.log("This machine's floor: the refusals no session on it can get under, whatever");
  console.log("baton asks for. It has to live where only an administrator can write, so");
  console.log(`it is staged at:\n\n  ${staged}\n`);
  console.log(`Install it with:\n\n  ${target.install(staged)}\n`);
  console.log(`Then check it took effect: run "claude" and type /status. The`);
  console.log(`"Setting sources" line should mention managed settings.`);

  if (process.platform === "linux" && existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) {
    console.log("\nThis looks like WSL, where /etc/claude-code is writable by you -- which");
    console.log("would let an agent rewrite its own floor. Put the policy in the Windows");
    console.log("chain instead (C:\\Program Files\\ClaudeCode or HKLM) and set");
    console.log("wslInheritsWindowsSettings there.");
  }
}

async function main(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
  });
  lines = rl[Symbol.asyncIterator]();
  try {
    const configPath = resolve(values.config ?? DEFAULT_CONFIG_PATH);

    if (values["floor-only"] === true) {
      mkdirSync(dirname(configPath), { recursive: true });
      stageFloor(configPath);
      return;
    }

    console.log("\nbaton -- enrolling this machine\n");

    const serverUrl = (await ask(rl, "Server URL", values.server ?? "")).replace(/\/+$/, "");
    if (!/^https?:\/\//.test(serverUrl)) {
      die("A server URL like https://baton.example.com is required.");
    }
    if (serverUrl.startsWith("http://") && !/\/\/(localhost|127\.0\.0\.1)/.test(serverUrl)) {
      const ok = await yes(
        rl,
        "That is plain http, so the password and token travel in the clear. Continue?",
        false,
      );
      if (!ok) die("Stopped.");
    }

    let password = await secret(rl, "Login password (not shown): ");
    if (password === "") die("The login password is required.");
    password = await verifyPassword(rl, serverUrl, password);

    const name = await ask(rl, "A name for this machine", hostname());

    // -- the agent -----------------------------------------------------------

    const found = findClaude();
    if (found) {
      console.log(`\nFound Claude Code: ${[found.command, ...found.launchArgs].join(" ")}`);
    } else {
      console.log("\nI could not find Claude Code on this machine.");
    }
    const command = cleanPath(await ask(rl, "Command to run the agent", found?.command ?? ""));
    if (command === "") die("Nothing to run the agent with; install Claude Code first.");
    const launchArgs = found && command === found.command ? found.launchArgs : [];

    // -- accounts ------------------------------------------------------------

    console.log("\nAccounts. Each one gets its own config directory, so client");
    console.log("conventions never leak between them. None of this reaches the server.\n");

    const profiles: LocalProfileSpec[] = [];
    const credentials: Record<string, Record<string, string>> = {};

    if (await yes(rl, "Use the account already signed in on this machine?")) {
      profiles.push({
        label: await ask(rl, "  Label for it", "Claude Code"),
        command,
        launchArgs,
        args: [],
        env: {},
        credentialRef: null,
      });
    }

    while (
      await yes(
        rl,
        profiles.length === 0 ? "Add an account?" : "Add another account?",
        profiles.length === 0,
      )
    ) {
      const label = await ask(rl, "  Label (e.g. Client A)");
      if (label === "") break;
      const ref = await ask(rl, "  Credential name", slug(label));
      const dir = cleanPath(
        await ask(rl, "  Config directory", join(homedir(), `.claude-${ref}`)),
      );
      mkdirSync(dir, { recursive: true });
      credentials[ref] = { CLAUDE_CONFIG_DIR: dir };
      profiles.push({ label, command, launchArgs, args: [], env: {}, credentialRef: ref });
    }

    if (profiles.length === 0) {
      die("At least one account is needed, or this machine can run nothing.");
    }

    // -- projects ------------------------------------------------------------

    console.log("\nProjects on this machine. For each one you set the ceiling: the most");
    console.log("its agents may ever do here. The server can ask for less and never more.\n");

    const projects: LocalProjectSpec[] = [];
    while (
      await yes(
        rl,
        projects.length === 0 ? "Add a project?" : "Add another project?",
        projects.length === 0,
      )
    ) {
      const path = await askExistingDir(rl, "  Absolute path to the checkout");
      if (path === null) {
        console.log("  Nothing entered; not adding a project.");
        continue;
      }
      const projectName = await ask(rl, "  Short name", slug(basename(path)));

      let profileLabel = profiles[0]!.label;
      if (profiles.length > 1) {
        console.log("  Which account runs it?");
        profiles.forEach((p, i) => console.log(`    ${i + 1}. ${p.label}`));
        const pick = Number(await ask(rl, "  Number", "1"));
        profileLabel = profiles[pick - 1]?.label ?? profiles[0]!.label;
      }

      console.log("\n  Ceiling -- the most its agents may do without asking you:");
      PERMISSION_PRESETS.forEach((preset, i) => {
        console.log(`    ${i + 1}. ${preset.label}`);
        console.log(`       ${preset.detail}`);
      });
      const chosen =
        PERMISSION_PRESETS[Number(await ask(rl, "  Number", "2")) - 1] ?? PERMISSION_PRESETS[1]!;
      console.log(`  -> ${chosen.label}`);

      // Containment is the only thing here the operating system enforces.
      // Everything else is policy inside Claude Code, which a shell command can
      // step around -- a script that opens files itself is not covered by any
      // deny rule. So it is offered wherever it exists, and explained where it
      // does not.
      let contained = false;
      let allowedDomains: string[] = [];
      if (CAN_CONTAIN) {
        console.log("");
        contained = await yes(
          rl,
          "  Sandbox its shell commands? (writes confined to the checkout,\n" +
            "    network blocked unless you allow hosts below)",
          true,
        );
        if (contained) {
          const hosts = await ask(
            rl,
            "  Hosts its commands may reach, comma-separated (blank for none)",
          );
          allowedDomains = hosts
            .split(",")
            .map((h) => h.trim())
            .filter(Boolean);
        }
      } else {
        console.log("\n  Claude Code's sandbox is not available on native Windows, so this");
        console.log("  project's shell commands are limited by policy rather than by the");
        console.log("  operating system. A deny rule covers Claude's own file tools and the");
        console.log("  file commands it recognises, but not a script that opens files itself.");
        console.log("  To contain it properly, run this machine's worker under WSL2.");
      }
      console.log("");

      projects.push({
        name: projectName,
        path,
        profileLabel,
        posture: chosen.key,
        contained,
        allowedDomains,
      });
    }

    // -- confirm -------------------------------------------------------------

    console.log("\nAbout to register:");
    console.log(`  machine   ${name} (${process.platform})`);
    for (const p of profiles) {
      console.log(
        `  account   ${p.label}${p.credentialRef ? ` -> ${p.credentialRef}` : " (signed-in)"}`,
      );
    }
    for (const p of projects) {
      console.log(
        `  project   ${p.name} at ${p.path} -- ${p.posture}${p.contained ? ", sandboxed" : ""}`,
      );
    }
    console.log("\nThe server is told the names and the postures. The paths, the command,");
    console.log(`the environment and the credentials stay in ${configPath}.`);
    if (!(await yes(rl, "\nSend this to the server?"))) die("Stopped. Nothing was registered.");

    // -- enroll --------------------------------------------------------------

    // Everything gathered is still in memory, so a refusal that can be fixed by
    // answering one more question is asked rather than fatal. Sending someone
    // back through the whole wizard to correct a typo is not a real option.
    let replace = values.replace === true;
    let workerId = "";
    let token = "";
    for (let attempt = 0; ; attempt++) {
      const { status, payload } = await postEnroll(serverUrl, {
        password,
        replace,
        worker: { name, platform: process.platform },
        profiles: profiles.map((p) => ({ label: p.label })),
        projects: projects.map((p) => ({
          name: p.name,
          profileLabel: p.profileLabel,
          posture: p.posture,
        })),
      });

      if (status === 201 && payload.workerId && payload.token) {
        workerId = payload.workerId;
        token = payload.token;
        break;
      }

      if (status === 401 && interactive && attempt < 4) {
        console.log("\nThe server did not accept that password.");
        password = await secret(rl, "Login password (not shown): ");
        if (password === "") die("Stopped. Nothing was registered.");
        continue;
      }

      if (
        status === 409 &&
        !replace &&
        interactive &&
        /already registered/i.test(payload.error ?? "")
      ) {
        console.log(`\n${payload.error}`);
        if (await yes(rl, "Issue it a new token and keep its projects?", false)) {
          replace = true;
          continue;
        }
        die("Stopped. Nothing was registered.");
      }

      die(`The server refused: ${payload.error ?? `HTTP ${status}`}`);
    }

    // -- write the config ----------------------------------------------------

    if (existsSync(configPath) && readable(configPath)) {
      const existing = readFileSync(configPath, "utf8");
      if (
        existing.trim() !== "" &&
        !(await yes(rl, `${configPath} already exists. Overwrite it?`, false))
      ) {
        console.log(`\nLeaving it alone. The machine is registered as ${workerId};`);
        console.log("re-run this with --config pointing somewhere else to write its config.");
        die("Nothing written.");
      }
    }

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          serverUrl,
          workerId,
          token,
          maxConcurrent: 2,
          credentials,
          profiles: Object.fromEntries(
            profiles.map((p) => [
              slug(p.label),
              {
                command: p.command,
                launchArgs: p.launchArgs,
                args: p.args,
                env: p.env,
                credentialRef: p.credentialRef,
              },
            ]),
          ),
          projects: Object.fromEntries(
            projects.map((p) => [
              slug(p.name),
              {
                path: p.path,
                profile: slug(p.profileLabel),
                posture: p.posture,
                contained: p.contained,
                allowedDomains: p.allowedDomains,
              },
            ]),
          ),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    console.log(`\nRegistered ${workerId}. Wrote ${configPath}.`);

    const needLogin = Object.entries(credentials);
    if (needLogin.length > 0) {
      console.log("\nSign each account in once, so its config directory has credentials:\n");
      for (const [ref, env] of needLogin) {
        const dir = env.CLAUDE_CONFIG_DIR ?? "";
        console.log(
          process.platform === "win32"
            ? `  $env:CLAUDE_CONFIG_DIR = '${dir}'; ${command}      # ${ref}, then /login`
            : `  CLAUDE_CONFIG_DIR=${dir} ${command}      # ${ref}, then /login`,
        );
      }
    }

    stageFloor(configPath);
    console.log("\nThen start the runner:\n\n  npm run runner\n");
  } finally {
    rl.close();
  }
}

await main();
