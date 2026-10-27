import { parseArgs } from "node:util";
import { openDb } from "./db/index.ts";
import { Store } from "./core/store.ts";
import { config } from "./config.ts";

const USAGE = `baton admin CLI  (db: ${config.dbPath})

  worker add <name> [--platform darwin|win32|linux]
  worker ls

  profile add --worker <id> --label <l> --command <cmd>
              [--launch-args=<path>/cli.js] [--args="--model opus"]
              [--env K=V]... [--credential <ref>]
              launch-args go before our flags; use them when command is node,
              which is how to run Claude Code on Windows. args go after, for
              things like --model.
              Re-adding an existing label REPLACES that profile outright, so
              state it in full -- flags you leave off go back to their defaults.
  profile ls [--worker <id>]
  profile rm <id>
              Refused while a session or a project's default still points at it.

  project add --name <n> --worker <id> --path <abs> [--profile <id>] [--context "..."]
  project ls

  session ls [--state blocked]

Everything else is driven from the Claude apps over MCP.`;

// parseArgs refuses a value that begins with a dash unless it is joined with an
// equals sign -- and nearly every useful --args value begins with one. Left
// alone that surfaces as an unhandled TypeError and a stack trace, so catch it
// and say what to type instead.
function parseCommandLine() {
  try {
    return parseArgs(PARSE_OPTIONS);
  } catch (err) {
    const code = err instanceof Error ? (err as { code?: string }).code : undefined;
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      console.error(
        `${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n\n` +
          `Join the value to the flag with "=" when it starts with a dash:\n` +
          `  --args="--model opus"      not  --args "--model opus"`,
      );
      process.exit(1);
    }
    throw err;
  }
}

const PARSE_OPTIONS = {
  allowPositionals: true,
  options: {
    platform: { type: "string" },
    worker: { type: "string" },
    label: { type: "string" },
    command: { type: "string" },
    args: { type: "string" },
    "launch-args": { type: "string" },
    env: { type: "string", multiple: true },
    credential: { type: "string" },
    name: { type: "string" },
    path: { type: "string" },
    profile: { type: "string" },
    context: { type: "string" },
    state: { type: "string" },
  },
} as const;

const { positionals, values } = parseCommandLine();

function need(value: string | undefined, flag: string): string {
  if (!value) {
    console.error(`missing --${flag}`);
    process.exit(1);
  }
  return value;
}

const db = openDb();
const store = new Store(db);
const [group, action, ...rest] = positionals;

try {
  if (group === "worker" && action === "add") {
    const name = rest[0];
    if (!name) {
      console.error("usage: worker add <name>");
      process.exit(1);
    }
    const { worker, token } = store.createWorker(name, values.platform);
    console.log(`worker:  ${worker.id}`);
    console.log(`token:   ${token}`);
    console.log("\nPut that token in the runner's config. It is not recoverable -- if you");
    console.log("lose it, delete the worker and add it again.");
  } else if (group === "worker" && action === "ls") {
    for (const w of store.listWorkers()) {
      console.log(`${w.id}\t${w.platform ?? "?"}\tlast seen ${w.lastSeenAt ?? "never"}`);
    }
  } else if (group === "profile" && action === "add") {
    const env: Record<string, string> = {};
    for (const pair of values.env ?? []) {
      const eq = pair.indexOf("=");
      if (eq < 1) {
        console.error(`--env expects K=V, got ${pair}`);
        process.exit(1);
      }
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const profile = store.createProfile({
      workerId: need(values.worker, "worker"),
      label: need(values.label, "label"),
      command: need(values.command, "command"),
      launchArgs: values["launch-args"]
        ? values["launch-args"].split(/\s+/).filter(Boolean)
        : [],
      args: values.args ? values.args.split(/\s+/).filter(Boolean) : [],
      env,
      credentialRef: values.credential ?? null,
    });
    console.log(`profile: ${profile.id}`);
  } else if (group === "profile" && action === "ls") {
    for (const p of store.listProfiles(values.worker)) {
      const invocation = [p.command, ...p.launchArgs, ...p.args].join(" ");
      console.log(`${p.id}\t${invocation}\tcred=${p.credentialRef ?? "-"}`);
    }
  } else if (group === "profile" && action === "rm") {
    const id = rest[0];
    if (!id) {
      console.error("usage: profile rm <id>   (see `profile ls` for ids)");
      process.exit(1);
    }
    store.deleteProfile(id);
    console.log(`deleted ${id}`);
  } else if (group === "project" && action === "add") {
    const project = store.registerProject({
      name: need(values.name, "name"),
      workerId: need(values.worker, "worker"),
      path: need(values.path, "path"),
      defaultProfileId: values.profile ?? null,
      context: values.context ?? null,
    });
    console.log(`project: ${project.name} -> ${project.workerId}:${project.path}`);
  } else if (group === "project" && action === "ls") {
    for (const p of store.listProjects()) {
      console.log(`${p.name}\t${p.workerId}:${p.path}\tprofile=${p.defaultProfileId ?? "-"}`);
    }
  } else if (group === "session" && action === "ls") {
    const sessions = store.listSessions({
      state: values.state as never,
      limit: 30,
    });
    for (const s of sessions) {
      console.log(`${s.state}\t${store.getProject(s.projectId).name}\t${s.title ?? ""}\t${s.id}`);
    }
  } else {
    console.log(USAGE);
    process.exit(group ? 1 : 0);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  db.close();
}
