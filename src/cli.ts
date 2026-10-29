import { parseArgs } from "node:util";
import { openDb } from "./db/index.ts";
import { Store } from "./core/store.ts";
import { config } from "./config.ts";
import { POSTURES, type Posture, type Project, type Worker } from "./core/types.ts";

const USAGE = `baton admin CLI  (db: ${config.dbPath})

  worker add <name> [--platform darwin|win32|linux]
  worker ls
              Prints what each machine has reported about itself.

  profile add --worker <id> --label <l>
              Declares that a machine has an account under this label. What the
              label actually runs -- the binary, its arguments, its environment,
              which credential -- is in that machine's runner.config.json, and
              cannot be set from here or from the Claude apps.
  profile ls [--worker <id>]
  profile rm <id>
              Refused while a session or a project's default still points at it.

  project add --name <n> --worker <id> [--profile <id>] [--context "..."]
              [--posture ask|edits|trusted]
              posture is a request, not a grant: the machine holds the ceiling
              and takes the stricter of the two, so you can ask for less
              autonomy and never for more. The checkout's path lives on that
              machine too.
              worker always overwrites; everything else is kept when you leave
              it off, so you can change one setting at a time.
  project ls

  session ls [--state blocked]

Machines are set up from the machine itself:
  npm run enroll -- --server ${config.publicUrl || "https://baton.example.com"}

Everything else is driven from the Claude apps over MCP.`;

// parseArgs refuses a value that begins with a dash unless it is joined with an
// equals sign. Left alone that surfaces as an unhandled TypeError and a stack
// trace, so catch it and say what to type instead.
function parseCommandLine() {
  try {
    return parseArgs(PARSE_OPTIONS);
  } catch (err) {
    const code = err instanceof Error ? (err as { code?: string }).code : undefined;
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      console.error(
        `${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n\n` +
          `Join the value to the flag with "=" when it starts with a dash:\n` +
          `  --context="-- see the wiki"      not  --context "-- see the wiki"`,
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
    name: { type: "string" },
    profile: { type: "string" },
    context: { type: "string" },
    state: { type: "string" },
    posture: { type: "string" },
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

function asPosture(value: string | undefined): Posture | null {
  if (value === undefined) return null;
  if (!POSTURES.includes(value as Posture)) {
    console.error(`--posture must be one of ${POSTURES.join(", ")}, got ${value}`);
    process.exit(1);
  }
  return value as Posture;
}

const db = openDb();
const store = new Store(db);

/** What the worker said about a project, or undefined if it has not reported. */
const reportedFor = (project: Project) =>
  store.getWorker(project.workerId).inventory?.projects.find((p) => p.id === project.id);

function describeProject(p: Project): string {
  const reported = reportedFor(p);
  const where = reported ? `${p.workerId}:${reported.path}` : `${p.workerId} (not reported)`;
  const asked = p.requestedPosture ?? "machine default";
  const ceiling = reported ? `machine allows ${reported.posture}` : "ceiling unknown";
  const sandbox = reported?.contained === true ? ", sandboxed" : "";
  return `${where}\tasked=${asked}\t${ceiling}${sandbox}`;
}

function describeWorker(w: Worker): string {
  const lines = [`${w.id}\t${w.platform ?? "?"}\tlast seen ${w.lastSeenAt ?? "never"}`];
  if (!w.inventory) {
    lines.push("  (has not reported its projects yet)");
    return lines.join("\n");
  }
  for (const p of w.inventory.profiles) {
    lines.push(`  account ${p.label}${p.credential ? ` -> ${p.credential}` : " (signed-in)"}`);
  }
  for (const p of w.inventory.projects) {
    lines.push(
      `  project ${p.id} at ${p.path} (${p.profile}, ${p.posture}${p.contained ? ", sandboxed" : ""})`,
    );
  }
  return lines.join("\n");
}

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
    console.log("lose it, delete the worker and add it again. Running the enrolment wizard");
    console.log("on the machine itself avoids carrying it across by hand.");
  } else if (group === "worker" && action === "ls") {
    for (const w of store.listWorkers()) console.log(describeWorker(w));
  } else if (group === "profile" && action === "add") {
    const profile = store.createProfile({
      workerId: need(values.worker, "worker"),
      label: need(values.label, "label"),
    });
    console.log(`profile: ${profile.id}`);
    console.log(`  What it runs is set in runner.config.json on ${profile.workerId}.`);
  } else if (group === "profile" && action === "ls") {
    for (const p of store.listProfiles(values.worker)) {
      console.log(`${p.id}\t${p.label}`);
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
      defaultProfileId: values.profile ?? null,
      context: values.context ?? null,
      requestedPosture: asPosture(values.posture),
    });
    console.log(`project: ${project.name}`);
    console.log(`  ${describeProject(project)}`);
  } else if (group === "project" && action === "ls") {
    for (const p of store.listProjects()) {
      console.log(`${p.name}\t${describeProject(p)}\tprofile=${p.defaultProfileId ?? "-"}`);
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
