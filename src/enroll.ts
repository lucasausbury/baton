import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir, hostname } from "node:os";
import { parseArgs } from "node:util";
import { PERMISSION_PRESETS } from "./core/permissions.ts";
import { floorJson, floorTarget } from "./core/managed.ts";
import { cleanPath } from "./core/paths.ts";
import { slug } from "./core/slug.ts";
import type { Posture } from "./core/types.ts";
import { DEFAULT_CONFIG_PATH } from "./runner/config.ts";
import { Prompter } from "./enroll/prompt.ts";
import {
  clearDraft,
  draftPathFor,
  emptyDraft,
  loadDraft,
  nameProblem,
  saveDraft,
  type Draft,
  type DraftProfile,
  type DraftProject,
} from "./enroll/draft.ts";

/**
 * The enrolment wizard. Run on a worker machine:
 *
 *   npm run enroll -- --server https://baton.example.com
 *
 * It asks what this machine is, which Claude accounts it has, which projects
 * live here and the most each may ever do. Then it tells the server the names
 * -- and only the names -- and writes everything else into this machine's own
 * config.
 *
 * That split is the point. The server learns that a project called
 * "alexandria" lives here under the "Client A" account at the "edits" posture.
 * It does not learn, and cannot set, which binary runs, with what environment,
 * in which directory, or how much that posture is allowed to mean. So a server
 * that is taken over cannot run anything here that was not already allowed.
 *
 * Every answer is written to a draft file as it is given. This is run once per
 * machine when it goes well, and several times in a row when it does not, so
 * losing a dozen answers to a failure at the last step is not acceptable.
 */

const { values } = parseArgs({
  allowPositionals: false,
  options: {
    server: { type: "string" },
    config: { type: "string" },
    replace: { type: "boolean" },
    "floor-only": { type: "boolean" },
    fresh: { type: "boolean" },
  },
});

/** Stops the wizard with a message, without tearing down a live stdin. */
class Stop extends Error {}
const stop = (message: string): never => {
  throw new Stop(message);
};

/** The sandbox exists on macOS, Linux and WSL2, but not on native Windows. */
const CAN_CONTAIN = process.platform !== "win32";

// --------------------------------------------------------------- the machine

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

// ---------------------------------------------------------------- the server

interface EnrollReply {
  error?: string;
  workerId?: string;
  token?: string;
}

const postEnroll = async (
  serverUrl: string,
  body: unknown,
): Promise<{ status: number; payload: EnrollReply }> => {
  let res: Response;
  try {
    res = await fetch(`${serverUrl}/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // A wrong URL, no DNS, a server that is down. Reported as a status of its
    // own so the caller can offer a retry rather than dying.
    return { status: 0, payload: { error: err instanceof Error ? err.message : String(err) } };
  }
  return { status: res.status, payload: (await res.json().catch(() => ({}))) as EnrollReply };
};

/**
 * Checks the password before asking anything else.
 *
 * One round trip, against answering a dozen questions and then losing them to a
 * typo made minutes earlier.
 */
async function verifyPassword(p: Prompter, serverUrl: string, given: string): Promise<string> {
  let password = given;
  for (let attempt = 0; ; attempt++) {
    const { status, payload } = await postEnroll(serverUrl, { password, check: true });
    if (status === 200) return password;
    if (status === 0) stop(`Cannot reach ${serverUrl}: ${payload.error ?? "no response"}`);
    if (status === 503) {
      stop(`That server cannot enrol a machine: ${payload.error ?? "it has no login password set"}`);
    }
    if (status === 429) stop("Too many attempts. Wait a few minutes and run this again.");
    if (status !== 401) {
      // A server from before the check existed answers something else -- and
      // such a server also predates profiles and projects moving onto the
      // worker, so it would accept what this wizard sends and store a profile
      // with no command and a project with no path.
      stop(
        `That server does not understand this version of enrolment (HTTP ${status}` +
          `${payload.error ? `: ${payload.error}` : ""}).\n\n` +
          `Deploy the server first, then run this again.`,
      );
    }
    if (!p.interactive || attempt >= 4) stop("That password was not accepted.");
    console.log("  That password was not accepted by the server.");
    password = await p.secret("Login password (not shown): ");
    if (password === "") stop("Stopped.");
  }
}

// ------------------------------------------------------------------- display

const describeProject = (project: DraftProject): string =>
  `${project.name} — ${project.path}\n      ${project.profileLabel}, ${project.posture}` +
  `${project.contained ? ", sandboxed" : ""}`;

function showPlan(draft: Draft): void {
  console.log(`\n  machine   ${draft.machine} (${process.platform})`);
  for (const profile of draft.profiles) {
    console.log(
      `  account   ${profile.label}${profile.credentialRef ? ` → ${profile.credentialRef}` : " (already signed in)"}`,
    );
  }
  if (draft.projects.length === 0) {
    console.log("  projects  none yet");
  }
  draft.projects.forEach((project, i) => {
    console.log(`  ${String(i + 1).padStart(2)}.       ${describeProject(project)}`);
  });
}

// --------------------------------------------------------------------- steps

async function askProject(
  p: Prompter,
  draft: Draft,
  draftPath: string,
): Promise<DraftProject | null> {
  const given = await p.askUntil(
    "  Path to the checkout",
    (answer) => {
      if (answer.trim() === "") return null; // blank backs out
      const path = cleanPath(answer);
      if (!isAbsolute(path)) return "That is not a full path. Tab completes directory names.";
      if (!existsSync(path)) return `${path} does not exist on this machine.`;
      return null;
    },
    {
      completion: "dir",
      help: "Tab completes. A path pasted from Explorer, quotes and all, is fine.",
    },
  );
  if (given.trim() === "") return null;
  const path = resolve(cleanPath(given));

  const taken = draft.projects.map((project) => project.name);
  // The folder's own name is usually right, but two checkouts called "api"
  // under different parents would collide -- so suggest the parent as well.
  const suggestion = (() => {
    const first = slugOrEmpty(basename(path));
    if (first !== "" && nameProblem(first, taken) === null) return first;
    const withParent = slugOrEmpty(`${basename(dirname(path))}-${basename(path)}`);
    return nameProblem(withParent, taken) === null ? withParent : "";
  })();

  const name = await p.askUntil("  Short name", (answer) => nameProblem(answer, taken), {
    fallback: suggestion,
    help: "How you will refer to it from the Claude app.",
  });
  if (nameProblem(name, taken) !== null) return null;

  let profileLabel = draft.profiles[0]!.label;
  if (draft.profiles.length > 1) {
    console.log("  Which account runs it?");
    const picked = await p.choose(
      "  Number",
      draft.profiles.map((profile) => profile.label),
    );
    profileLabel = draft.profiles[picked]!.label;
  }

  console.log("\n  The most its agents may do here without asking you:");
  const chosen = await p.choose(
    "  Number",
    PERMISSION_PRESETS.map((preset) => `${preset.label}\n       ${preset.detail}`),
    1,
  );
  const posture: Posture = PERMISSION_PRESETS[chosen]!.key;

  let contained = false;
  let allowedDomains: string[] = [];
  if (CAN_CONTAIN) {
    contained = await p.yes(
      "  Sandbox its shell commands? Writes stay in the checkout and the\n" +
        "    network is blocked unless you allow hosts",
      true,
    );
    if (contained) {
      const hosts = await p.ask("  Hosts its commands may reach, comma-separated", {
        help: "Leave blank for none. Add registry.npmjs.org if it installs packages.",
      });
      allowedDomains = hosts
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
    }
  }

  const project: DraftProject = {
    name,
    path,
    profileLabel,
    posture,
    contained,
    allowedDomains,
  };
  draft.projects.push(project);
  saveDraft(draftPath, draft);
  console.log(`  Added ${name}. (saved)\n`);
  return project;
}

const slugOrEmpty = (value: string): string => {
  try {
    return slug(value);
  } catch {
    return "";
  }
};

async function askAccounts(
  p: Prompter,
  draft: Draft,
  draftPath: string,
  command: string,
  launchArgs: string[],
): Promise<void> {
  if (draft.profiles.length === 0) {
    console.log("Accounts. Each gets its own config directory, so one client's");
    console.log("conventions never leak into another's work. None of this reaches");
    console.log("the server.\n");

    if (await p.yes("Use the account already signed in on this machine?")) {
      const label = await p.ask("  A label for it", { fallback: "Claude Code" });
      draft.profiles.push({
        label,
        command,
        launchArgs,
        args: [],
        env: {},
        credentialRef: null,
        configDir: null,
      });
      saveDraft(draftPath, draft);
    }
  }

  for (;;) {
    const first = draft.profiles.length === 0;
    if (!(await p.yes(first ? "Add an account?" : "Add another account?", first))) break;

    const taken = draft.profiles.map((profile) => profile.label);
    const label = await p.askUntil("  Label (e.g. Client A)", (answer) =>
      answer.trim() === "" ? null : nameProblem(answer, taken),
    );
    if (label.trim() === "") break;

    const ref = await p.ask("  Credential name", { fallback: slugOrEmpty(label) || "account" });
    const dir = cleanPath(
      await p.ask("  Its config directory", {
        fallback: join(homedir(), `.claude-${ref}`),
        completion: "dir",
      }),
    );
    mkdirSync(dir, { recursive: true });
    draft.profiles.push({
      label,
      command,
      launchArgs,
      args: [],
      env: {},
      credentialRef: ref,
      configDir: dir,
    });
    saveDraft(draftPath, draft);
    console.log(`  Added ${label}. (saved)\n`);
  }

  if (draft.profiles.length === 0) {
    stop("At least one account is needed, or this machine can run nothing.");
  }
}

/** The last stop before submitting: see everything, fix anything. */
async function review(p: Prompter, draft: Draft, draftPath: string): Promise<void> {
  for (;;) {
    console.log("\n─── About to register ───");
    showPlan(draft);
    console.log("\nThe server is told the names and the postures. The paths, the command,");
    console.log("the environment and the credentials stay on this machine.");

    const actions = ["Send this to the server", "Add another project"];
    if (draft.projects.length > 0) actions.push("Remove a project");
    const picked = await p.choose("\nWhat next?", actions);

    if (picked === 0) {
      if (draft.projects.length === 0 && !(await p.yes("No projects. Register anyway?", false))) {
        continue;
      }
      return;
    }
    if (picked === 1) {
      await askProject(p, draft, draftPath);
      continue;
    }
    const which = await p.choose(
      "  Which one?",
      draft.projects.map((project) => project.name),
    );
    const [removed] = draft.projects.splice(which, 1);
    saveDraft(draftPath, draft);
    console.log(`  Removed ${removed?.name ?? "it"}.`);
  }
}

// ----------------------------------------------------------------- the floor

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
  mkdirSync(dirname(staged), { recursive: true });
  writeFileSync(staged, floorJson(), { mode: 0o644 });

  console.log("\n─── One more step, and it needs administrator rights ───\n");
  console.log("This machine's floor: the refusals no session on it can get under,");
  console.log(`whatever baton asks for. Staged at:\n\n  ${staged}\n`);
  console.log(`Install it with:\n\n  ${target.install(staged)}\n`);
  console.log('Then run "claude", type /status, and check the "Setting sources" line');
  console.log("mentions managed settings.");

  if (process.platform === "linux" && existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) {
    console.log("\nThis looks like WSL, where /etc/claude-code is writable by you — which");
    console.log("would let an agent rewrite its own floor. Put the policy in the Windows");
    console.log("chain (C:\\Program Files\\ClaudeCode or HKLM) and set");
    console.log("wslInheritsWindowsSettings there.");
  }
}

// ------------------------------------------------------------------ the flow

async function run(p: Prompter): Promise<void> {
  const configPath = resolve(values.config ?? DEFAULT_CONFIG_PATH);
  const draftPath = draftPathFor(configPath);

  if (values["floor-only"] === true) {
    stageFloor(configPath);
    return;
  }

  console.log("\nbaton — enrolling this machine\n");

  // -- resume --------------------------------------------------------------

  let draft = emptyDraft();
  let resuming = false;
  const existing = values.fresh === true ? null : loadDraft(draftPath);
  if (existing) {
    console.log("There is an unfinished enrolment here:");
    showPlan(existing);
    console.log(`\n  saved ${existing.savedAt}`);
    if (await p.yes("\nCarry on with it?")) {
      draft = existing;
      resuming = true;
    } else {
      console.log("Starting again. (--fresh skips this question next time.)\n");
    }
  }

  // -- the server ----------------------------------------------------------

  if (!resuming) console.log("─── 1 of 4: the server ───\n");
  const serverUrl = (
    await p.askUntil(
      "Server URL",
      (answer) =>
        /^https?:\/\//.test(answer.trim())
          ? null
          : "Needs to start with http:// or https://, e.g. https://baton.example.com",
      { fallback: values.server ?? draft.serverUrl },
    )
  )
    .trim()
    .replace(/\/+$/, "");
  if (serverUrl.startsWith("http://") && !/\/\/(localhost|127\.0\.0\.1)/.test(serverUrl)) {
    if (!(await p.yes("That is plain http, so the password and token travel in the clear. Continue?", false))) {
      stop("Stopped.");
    }
  }
  draft.serverUrl = serverUrl;
  saveDraft(draftPath, draft);

  let password = await p.secret("Login password (not shown): ");
  if (password === "") stop("The login password is required.");
  password = await verifyPassword(p, serverUrl, password);
  console.log("  Password accepted.\n");

  // -- this machine --------------------------------------------------------

  const found = findClaude();
  let command = draft.profiles[0]?.command ?? "";
  let launchArgs = draft.profiles[0]?.launchArgs ?? [];

  if (draft.machine === "" || command === "") {
    console.log("─── 2 of 4: this machine ───\n");
    if (draft.machine === "") {
      draft.machine = await p.askUntil(
        "A name for this machine",
        (answer) => nameProblem(answer, []),
        { fallback: hostname() },
      );
      saveDraft(draftPath, draft);
    }
    if (command === "") {
      if (found) {
        console.log(`\nFound Claude Code: ${[found.command, ...found.launchArgs].join(" ")}`);
      } else {
        console.log("\nI could not find Claude Code on this machine.");
      }
      command = cleanPath(
        await p.ask("Command to run the agent", {
          fallback: found?.command ?? "",
          completion: "dir",
        }),
      );
      if (command === "") stop("Nothing to run the agent with; install Claude Code first.");
      launchArgs = found && command === found.command ? found.launchArgs : [];
    }
  }

  // -- accounts ------------------------------------------------------------

  if (draft.profiles.length === 0) console.log("\n─── 3 of 4: accounts ───\n");
  await askAccounts(p, draft, draftPath, command, launchArgs);

  // -- projects ------------------------------------------------------------

  if (draft.projects.length === 0) {
    console.log("\n─── 4 of 4: projects ───\n");
    console.log("Each project is a checkout on this machine. Add them one at a time;");
    console.log("everything is saved as you go, so nothing here has to be retyped.\n");
    while (await p.yes(draft.projects.length === 0 ? "Add a project?" : "Add another project?", draft.projects.length === 0)) {
      await askProject(p, draft, draftPath);
    }
  }

  await review(p, draft, draftPath);

  // -- submit --------------------------------------------------------------

  let replace = values.replace === true;
  let workerId = "";
  let token = "";
  for (let attempt = 0; ; attempt++) {
    const { status, payload } = await postEnroll(serverUrl, {
      password,
      replace,
      worker: { name: draft.machine, platform: process.platform },
      profiles: draft.profiles.map((profile) => ({ label: profile.label })),
      projects: draft.projects.map((project) => ({
        name: project.name,
        profileLabel: project.profileLabel,
        posture: project.posture,
      })),
    });

    if (status === 201 && payload.workerId && payload.token) {
      workerId = payload.workerId;
      token = payload.token;
      break;
    }

    // Nothing is lost by a failure here: the draft holds every answer, so a
    // refusal that one more question can fix is asked rather than fatal, and
    // anything else can be resumed by running the wizard again.
    const retryable =
      status === 0 || status === 401 || (status === 409 && !replace) || status >= 500;
    if (p.interactive && attempt < 4 && retryable) {
      console.log(`\n  The server refused: ${payload.error ?? `HTTP ${status}`}`);
      if (status === 401) {
        password = await p.secret("  Login password (not shown): ");
        if (password === "") stop("Stopped. Everything you entered is saved; run this again.");
        continue;
      }
      if (status === 409 && /already registered/i.test(payload.error ?? "") && !replace) {
        if (await p.yes("  Issue it a new token and keep its projects?", false)) {
          replace = true;
          continue;
        }
        stop("Stopped. Everything you entered is saved; run this again.");
      }
      if (await p.yes("  Try again?", true)) continue;
    }
    stop(
      `The server refused: ${payload.error ?? `HTTP ${status}`}\n\n` +
        `Everything you entered is saved in\n  ${draftPath}\n` +
        `so running the wizard again picks up where this left off.`,
    );
  }

  // -- write the config ----------------------------------------------------

  if (existsSync(configPath) && readFileSync(configPath, "utf8").trim() !== "") {
    if (!(await p.yes(`\n${configPath} already exists. Overwrite it?`, false))) {
      stop(
        `Leaving it alone. The machine is registered as ${workerId}, but without that\n` +
          `config it cannot run anything. Re-run with --config pointing elsewhere.`,
      );
    }
  }

  const credentials = Object.fromEntries(
    draft.profiles
      .filter((profile) => profile.credentialRef !== null && profile.configDir !== null)
      .map((profile) => [profile.credentialRef!, { CLAUDE_CONFIG_DIR: profile.configDir! }]),
  );

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
          draft.profiles.map((profile) => [
            slug(profile.label),
            {
              command: profile.command,
              launchArgs: profile.launchArgs,
              args: profile.args,
              env: profile.env,
              credentialRef: profile.credentialRef,
            },
          ]),
        ),
        projects: Object.fromEntries(
          draft.projects.map((project) => [
            slug(project.name),
            {
              path: project.path,
              profile: slug(project.profileLabel),
              posture: project.posture,
              contained: project.contained,
              allowedDomains: project.allowedDomains,
            },
          ]),
        ),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  // Only now, with the real config on disk, is the draft no longer needed.
  clearDraft(draftPath);

  console.log(`\n─── Registered ${workerId} ───\n`);
  console.log(`Config written to ${configPath}.`);
  console.log(`${draft.projects.length} project(s), ${draft.profiles.length} account(s).`);

  const needLogin = draft.profiles.filter((profile) => profile.configDir !== null);
  if (needLogin.length > 0) {
    console.log("\nSign each account in once, so its config directory has credentials:\n");
    for (const profile of needLogin) {
      console.log(
        process.platform === "win32"
          ? `  $env:CLAUDE_CONFIG_DIR = '${profile.configDir}'; ${profile.command}   # ${profile.label}, then /login`
          : `  CLAUDE_CONFIG_DIR=${profile.configDir} ${profile.command}   # ${profile.label}, then /login`,
      );
    }
  }

  stageFloor(configPath);
  console.log("\nThen start the runner:\n\n  npm run runner\n");
}

const prompter = new Prompter();
try {
  await run(prompter);
} catch (err) {
  if (err instanceof Stop) {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  } else {
    console.error(`\nSomething went wrong:\n${err instanceof Error ? err.stack : String(err)}`);
    process.exitCode = 1;
  }
} finally {
  prompter.close();
}
