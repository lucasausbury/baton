import { createInterface, type Interface } from "node:readline/promises";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { parseArgs } from "node:util";
import { PERMISSION_PRESETS } from "./core/permissions.ts";

/**
 * The enrollment wizard. Run on a worker machine:
 *
 *   npm run enroll -- --server https://baton.example.com
 *
 * It asks what this machine is, which Claude accounts it has, which projects
 * live here and what each may do unattended; then registers the lot in one
 * call and writes runner.config.json itself. The worker token goes straight
 * from the server into the config file without ever being shown, which is the
 * whole point -- copying one by hand was the worst part of adding a machine.
 */

const CONFIG = "runner.config.json";

const { values } = parseArgs({
  allowPositionals: false,
  options: {
    server: { type: "string" },
    config: { type: "string" },
    replace: { type: "boolean" },
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
    const cli = join(
      dirname(candidate),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js",
    );
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

interface ProfileSpec {
  label: string;
  command: string;
  launchArgs: string[];
  args: string[];
  credentialRef: string | null;
}

interface ProjectSpec {
  name: string;
  path: string;
  profileLabel: string | null;
  permissionMode: string | null;
  allowedTools: string[];
  deniedTools: string[];
}

async function main(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: interactive,
  });
  lines = rl[Symbol.asyncIterator]();
  try {
    console.log("\nbaton -- enrolling this machine\n");

    const serverUrl = (await ask(rl, "Server URL", values.server ?? "")).replace(/\/+$/, "");
    if (!/^https?:\/\//.test(serverUrl)) die("A server URL like https://baton.example.com is required.");
    if (serverUrl.startsWith("http://") && !/\/\/(localhost|127\.0\.0\.1)/.test(serverUrl)) {
      const ok = await yes(rl, "That is plain http, so the password and token travel in the clear. Continue?", false);
      if (!ok) die("Stopped.");
    }

    const password = await secret(rl, "Login password (not shown): ");
    if (password === "") die("The login password is required.");

    const name = await ask(rl, "A name for this machine", hostname());

    // -- the agent -----------------------------------------------------------

    const found = findClaude();
    if (found) {
      console.log(`\nFound Claude Code: ${[found.command, ...found.launchArgs].join(" ")}`);
    } else {
      console.log("\nI could not find Claude Code on this machine.");
    }
    const command = await ask(rl, "Command to run the agent", found?.command ?? "");
    if (command === "") die("Nothing to run the agent with; install Claude Code first.");
    const launchArgs = found && command === found.command ? found.launchArgs : [];

    // -- accounts ------------------------------------------------------------

    console.log("\nAccounts. Each one gets its own config directory, so client");
    console.log("conventions never leak between them.\n");

    const profiles: ProfileSpec[] = [];
    const credentials: Record<string, Record<string, string>> = {};

    if (await yes(rl, "Use the account already signed in on this machine?")) {
      profiles.push({
        label: await ask(rl, "  Label for it", "Claude Code"),
        command,
        launchArgs,
        args: [],
        credentialRef: null,
      });
    }

    while (await yes(rl, profiles.length === 0 ? "Add an account?" : "Add another account?", profiles.length === 0)) {
      const label = await ask(rl, "  Label (e.g. Client A)");
      if (label === "") break;
      const ref = await ask(rl, "  Credential name", label.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
      const dir = await ask(rl, "  Config directory", join(homedir(), `.claude-${ref}`));
      mkdirSync(dir, { recursive: true });
      credentials[ref] = { CLAUDE_CONFIG_DIR: dir };
      profiles.push({ label, command, launchArgs, args: [], credentialRef: ref });
    }

    if (profiles.length === 0) die("At least one account is needed, or this machine can run nothing.");

    // -- projects ------------------------------------------------------------

    console.log("\nProjects on this machine. For each one you choose how much");
    console.log("its agents may do without asking you.\n");

    const projects: ProjectSpec[] = [];
    while (await yes(rl, projects.length === 0 ? "Add a project?" : "Add another project?", projects.length === 0)) {
      const path = resolve(await ask(rl, "  Absolute path to the checkout"));
      if (!isAbsolute(path) || !existsSync(path)) {
        console.log(`  ${path} does not exist here. Skipping it.`);
        continue;
      }
      const projectName = await ask(rl, "  Short name", basename(path).toLowerCase());

      let profileLabel: string | null = profiles[0]?.label ?? null;
      if (profiles.length > 1) {
        console.log("  Which account runs it?");
        profiles.forEach((p, i) => console.log(`    ${i + 1}. ${p.label}`));
        const pick = Number(await ask(rl, "  Number", "1"));
        profileLabel = profiles[pick - 1]?.label ?? profiles[0]?.label ?? null;
      }

      console.log("\n  What may it do without asking you?");
      PERMISSION_PRESETS.forEach((preset, i) => {
        console.log(`    ${i + 1}. ${preset.label}`);
        console.log(`       ${preset.detail}`);
      });
      const chosen =
        PERMISSION_PRESETS[Number(await ask(rl, "  Number", "2")) - 1] ?? PERMISSION_PRESETS[1];
      if (!chosen) die("No permission presets are defined.");
      console.log(`  -> ${chosen.label}\n`);

      projects.push({
        name: projectName,
        path,
        profileLabel,
        permissionMode: chosen.permissionMode,
        allowedTools: chosen.allowedTools,
        deniedTools: chosen.deniedTools,
      });
    }

    // -- confirm -------------------------------------------------------------

    console.log("\nAbout to register:");
    console.log(`  machine   ${name} (${process.platform})`);
    for (const p of profiles) {
      console.log(`  account   ${p.label}${p.credentialRef ? ` -> ${p.credentialRef}` : " (signed-in)"}`);
    }
    for (const p of projects) {
      console.log(`  project   ${p.name} at ${p.path} -- mode ${p.permissionMode}`);
    }
    if (!(await yes(rl, "\nSend this to the server?"))) die("Stopped. Nothing was registered.");

    // -- enroll --------------------------------------------------------------

    const res = await fetch(`${serverUrl}/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password,
        replace: values.replace === true,
        worker: { name, platform: process.platform },
        profiles,
        projects,
      }),
    });

    const payload = (await res.json().catch(() => ({}))) as { error?: string; workerId?: string; token?: string };
    if (!res.ok || !payload.workerId || !payload.token) {
      die(`The server refused: ${payload.error ?? `HTTP ${res.status}`}`);
    }

    // -- write the config ----------------------------------------------------

    const configPath = resolve(values.config ?? CONFIG);
    if (existsSync(configPath) && readable(configPath)) {
      const existing = readFileSync(configPath, "utf8");
      if (existing.trim() !== "" && !(await yes(rl, `${configPath} already exists. Overwrite it?`, false))) {
        console.log("\nLeaving it alone. The worker is registered; its config is:");
        console.log(JSON.stringify({ serverUrl, workerId: payload.workerId, token: "<above>" }, null, 2));
        die("Nothing written.");
      }
    }

    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          serverUrl,
          workerId: payload.workerId,
          token: payload.token,
          maxConcurrent: 2,
          credentials,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    console.log(`\nRegistered ${payload.workerId}. Wrote ${configPath}.`);

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
    console.log("\nThen start the runner:\n\n  npm run runner\n");
  } finally {
    rl.close();
  }
}

await main();
