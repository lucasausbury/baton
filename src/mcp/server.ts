import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "../config.ts";
import { NotFound, StateError, type Session } from "../core/types.ts";
import type { Store } from "../core/store.ts";

/**
 * claude.ai and Desktop cap a tool result at roughly 150,000 characters, and a
 * long session's log will pass that. These leave room for the metadata and the
 * open ask, which matter more than old output.
 */
const LOG_BUDGET_CHARS = 90_000;
const MAX_MESSAGE_CHARS = 8_000;

function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

export function createMcpHandler(store: Store) {
  function line(s: Session): string {
    const project = store.getProject(s.projectId);
    const unread = s.state !== "running" && s.state !== "queued" && !s.seenAt ? " *" : "";
    const name = s.title ? `${project.name} / ${s.title}` : project.name;
    return `[${s.state}]${unread} ${name} - ${ago(s.updatedAt)}  (${s.id})`;
  }

  function describe(s: Session): string {
    const project = store.getProject(s.projectId);
    const profile = store.getProfile(s.profileId);
    const parts = [
      `${s.title ?? "(untitled)"} - ${s.state}`,
      `project:  ${project.name} on ${s.workerId} (${project.path})`,
      `profile:  ${profile.label} [${[profile.command, ...profile.launchArgs, ...profile.args].join(" ")}]`,
      `session:  ${s.id}`,
      `runs:     ${s.runCount}, created ${ago(s.createdAt)}, updated ${ago(s.updatedAt)}`,
    ];
    if (s.exitCode !== null) parts.push(`exit:     ${s.exitCode}`);
    if (project.context) parts.push(`context:  ${project.context}`);

    const open = store.openAsk(s.id);
    if (open) {
      parts.push(
        "",
        `>>> WAITING ON YOU (${open.kind}, asked ${ago(open.createdAt)}):`,
        open.body,
        open.payload ? `payload: ${JSON.stringify(open.payload)}` : "",
        ">>> answer with the reply tool",
      );
    }

    // A tool result is capped at roughly 150,000 characters on claude.ai and
    // Desktop, and a long session's log will pass that. Keep the newest
    // messages and say what was dropped: the metadata and the open ask above
    // are the parts you cannot do without.
    const log = store.messages(s.id);
    const kept: string[] = [];
    let used = 0;
    let omitted = 0;
    for (let i = log.length - 1; i >= 0; i--) {
      const m = log[i]!;
      const who = m.direction === "in" ? "you" : "agent";
      const body = m.body.length > MAX_MESSAGE_CHARS
        ? `${m.body.slice(0, MAX_MESSAGE_CHARS)}\n[... ${m.body.length - MAX_MESSAGE_CHARS} more characters]`
        : m.body;
      const line = `[${who}/${m.kind}] ${body}`;
      if (used + line.length > LOG_BUDGET_CHARS) {
        omitted = i + 1;
        break;
      }
      kept.push(line);
      used += line.length;
    }
    kept.reverse();

    parts.push(
      "",
      `--- log (${log.length} messages${omitted ? `, ${omitted} older ones omitted` : ""}) ---`,
    );
    if (omitted) {
      parts.push(`[${omitted} earlier message(s) omitted; this shows the most recent]`);
    }
    parts.push(...kept);
    return parts.filter((p) => p !== "").join("\n");
  }

  function build(): McpServer {
    const server = new McpServer(
      { name: "ai-worker-manager", version: "0.1.0" },
      {
        instructions:
          "Central queue for AI coding agents on remote dev machines. Creating a session " +
          "queues real work on a real machine, so confirm the prompt with the user before " +
          "calling create_session. Sessions marked [blocked] are agents parked waiting for " +
          "an answer; they stay stopped until you call reply.",
      },
    );

    server.registerTool(
      "list_workers",
      {
        title: "List workers",
        description: "Dev machines and the execution profiles available on each.",
        annotations: { readOnlyHint: true },
      },
      () => {
        const workers = store.listWorkers();
        if (workers.length === 0) return text("No workers registered.");
        const out = workers.map((w) => {
          const stale =
            !w.lastSeenAt || Date.now() - new Date(w.lastSeenAt).getTime() > config.workerStaleMs;
          const profiles = store.listProfiles(w.id);
          const rows = profiles.length
            ? profiles.map(
                (p) =>
                  `    ${p.label} -> ${[p.command, ...p.launchArgs, ...p.args].join(" ")}`.trimEnd(),
              )
            : ["    (no profiles)"];
          return [
            `${w.id} (${w.platform ?? "?"}) - ${stale ? "OFFLINE" : "online"}, seen ${ago(w.lastSeenAt)}`,
            ...rows,
          ].join("\n");
        });
        return text(out.join("\n\n"));
      },
    );

    server.registerTool(
      "list_projects",
      {
        title: "List projects",
        description: "Registered projects, which machine each lives on, and its default profile.",
        annotations: { readOnlyHint: true },
      },
      () => {
        const projects = store.listProjects();
        if (projects.length === 0) return text("No projects registered.");
        return text(
          projects
            .map((p) => {
              const prof = p.defaultProfileId ? store.getProfile(p.defaultProfileId).label : "none";
              const ctx = p.context ? `\n    ${p.context}` : "";
              return `${p.name} - ${p.workerId}:${p.path}\n    default profile: ${prof}${ctx}`;
            })
            .join("\n\n"),
        );
      },
    );

    server.registerTool(
      "register_project",
      {
        title: "Register a project",
        description:
          "Add or update a project. Re-registering an existing name updates it in place; " +
          "omitted fields keep their current values.",
        inputSchema: {
          name: z.string().describe("Short unique name, e.g. alexandria"),
          worker: z.string().describe("Worker id from list_workers"),
          path: z.string().describe("Absolute path to the checkout on that machine"),
          defaultProfile: z.string().optional().describe("Profile id to run by default"),
          context: z
            .string()
            .optional()
            .describe("Standing notes about the project, shown whenever it is opened"),
        },
      },
      (args) => {
        const project = store.registerProject({
          name: args.name,
          workerId: args.worker,
          path: args.path,
          defaultProfileId: args.defaultProfile ?? null,
          context: args.context ?? null,
        });
        return text(`Registered ${project.name} on ${project.workerId} at ${project.path}.`);
      },
    );

    server.registerTool(
      "create_session",
      {
        title: "Create a session",
        description:
          "Queue work on a project's machine. The prompt is the agent's whole brief, so it " +
          "should be complete and specific. Agree it with the user first -- this runs on a " +
          "real machine as soon as that worker picks it up.",
        inputSchema: {
          project: z.string().describe("Project name or id"),
          prompt: z.string().describe("The full brief for the agent"),
          title: z.string().optional().describe("Short label for your own lists"),
          profile: z
            .string()
            .optional()
            .describe("Profile id, to pin a specific model or account. Defaults to the project's"),
        },
      },
      (args) => {
        const project = store.getProject(args.project);
        const session = store.createSession({
          project: args.project,
          prompt: args.prompt,
          title: args.title,
          profileId: args.profile,
        });
        const worker = store.getWorker(session.workerId);
        const notes: string[] = [];

        // A client's conventions -- brand voice, a design framework -- usually
        // live in skills and rules attached to their account, so the profile is
        // how those reach the agent. Overriding it is allowed, but it must not
        // be silent: the work would come back ignoring their framework and that
        // only shows up in review, after the run is spent.
        if (project.defaultProfileId && session.profileId !== project.defaultProfileId) {
          notes.push(
            `Running under ${store.getProfile(session.profileId).label}, not ` +
              `${project.name}'s usual ${store.getProfile(project.defaultProfileId).label}. ` +
              `Account-level skills and rules for that project will not apply.`,
          );
        }

        const stale =
          !worker.lastSeenAt ||
          Date.now() - new Date(worker.lastSeenAt).getTime() > config.workerStaleMs;
        if (stale) {
          notes.push(
            `${worker.id} was last seen ${ago(worker.lastSeenAt)}, so it looks offline. ` +
              `The session will sit queued until its runner checks in.`,
          );
        }

        return text(
          `Queued ${session.id} on ${worker.id}.` +
            (notes.length ? `\n\n${notes.map((n) => `Note: ${n}`).join("\n\n")}` : ""),
        );
      },
    );

    server.registerTool(
      "list_sessions",
      {
        title: "List sessions",
        description:
          "Recent sessions, newest first. A '*' marks one that has ended and not been read. " +
          "Use state 'blocked' to find agents parked waiting on you.",
        inputSchema: {
          state: z
            .enum(["queued", "running", "blocked", "finished", "failed", "cancelled"])
            .optional(),
          project: z.string().optional(),
          unreadOnly: z.boolean().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      (args) => {
        const sessions = store.listSessions({
          state: args.state,
          project: args.project,
          unseen: args.unreadOnly,
          limit: args.limit,
        });
        if (sessions.length === 0) return text("No sessions match.");
        const blocked = sessions.filter((s) => s.state === "blocked").length;
        const header = blocked > 0 ? `${blocked} session(s) waiting on you.\n\n` : "";
        return text(header + sessions.map(line).join("\n"));
      },
    );

    server.registerTool(
      "get_session",
      {
        title: "Read a session",
        description:
          "The full message log for one session, plus anything it is waiting on. Reading " +
          "marks it as seen.",
        inputSchema: { sessionId: z.string() },
      },
      (args) => {
        const session = store.getSession(args.sessionId);
        store.acknowledge([session.id]);
        return text(describe(session));
      },
    );

    server.registerTool(
      "reply",
      {
        title: "Reply to a waiting agent",
        description:
          "Answer whatever a blocked session is waiting on and let it continue. For an " +
          "approval, say 'allow' or 'deny' plus any reasoning. The agent resumes immediately.",
        inputSchema: {
          sessionId: z.string(),
          body: z.string().describe("Your answer, or allow/deny for an approval"),
        },
      },
      (args) => {
        const before = store.getSession(args.sessionId);
        const open = store.openAsk(args.sessionId);
        if (!open && before.state !== "blocked") {
          return fail(
            `Session ${before.id} is ${before.state} and is not waiting on anything. ` +
              (before.state === "finished" || before.state === "failed"
                ? "Use resume_session to give it more work."
                : "Nothing to reply to."),
          );
        }
        store.reply({ sessionId: args.sessionId, body: args.body });
        return text(`Replied. Session is now ${store.getSession(args.sessionId).state}.`);
      },
    );

    server.registerTool(
      "resume_session",
      {
        title: "Resume a finished session",
        description:
          "Give an ended session more work. The agent resumes with its full prior context " +
          "rather than starting cold.",
        inputSchema: {
          sessionId: z.string(),
          prompt: z.string().describe("What to do next"),
        },
      },
      (args) => {
        const session = store.resumeSession(args.sessionId, args.prompt);
        return text(`Re-queued ${session.id} on ${session.workerId}; it will resume in place.`);
      },
    );

    server.registerTool(
      "cancel_session",
      {
        title: "Cancel a session",
        description:
          "Stop a session. A queued one never starts; a running one is killed by its runner " +
          "at the next check-in.",
        inputSchema: { sessionId: z.string() },
        annotations: { destructiveHint: true },
      },
      (args) => text(`Cancelled ${store.cancelSession(args.sessionId).id}.`),
    );

    server.registerTool(
      "acknowledge",
      {
        title: "Mark sessions read",
        description: "Clear sessions from your unread list without opening each one.",
        inputSchema: { sessionIds: z.array(z.string()).min(1) },
      },
      (args) => text(`Marked ${store.acknowledge(args.sessionIds)} session(s) read.`),
    );

    return server;
  }

  /**
   * One transport and server per request. Stateless keeps this simple: there is
   * no session affinity to maintain, so a phone that reconnects on a new network
   * just works.
   */
  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (err instanceof NotFound || err instanceof StateError) throw err;
      console.error("[mcp] request failed:", err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  };
}
