import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ServerClient } from "./client.ts";

/**
 * The permission shim.
 *
 * Claude Code spawns this over stdio and is told about it with
 * --permission-prompt-tool, so every approval it cannot resolve itself arrives
 * here as a tool call. We relay it to the server, which holds the response open
 * until the operator answers on their phone, then return the decision.
 *
 * It runs on the worker rather than pointing Claude Code at the remote server
 * directly for three reasons: session startup would otherwise wait on whatever
 * the network is doing, the blocking and retry behaviour stays under our
 * control, and the worker token never has to be written into a project's MCP
 * config.
 *
 * Nothing may be written to stdout: that is the MCP channel. Diagnostics go to
 * stderr, which the runner captures.
 */

const SESSION = process.env.AWM_SESSION ?? "";
const URL_ = process.env.AWM_URL ?? "";
const TOKEN = process.env.AWM_TOKEN ?? "";
/** Per-request wait. The tool call outlives these; we just re-attach. */
const LEG_MS = Number(process.env.AWM_ASK_LEG_MS ?? 10 * 60 * 1000);
/** Total time before we give up and deny rather than hang forever. */
const TOTAL_MS = Number(process.env.AWM_ASK_TOTAL_MS ?? 12 * 60 * 60 * 1000);

if (!SESSION || !URL_ || !TOKEN) {
  console.error("[shim] AWM_SESSION, AWM_URL and AWM_TOKEN are all required");
  process.exit(1);
}

const client = new ServerClient(URL_, TOKEN);

const log = (...args: unknown[]): void => console.error("[shim]", ...args);

/** Returns the operator's answer, or null if nobody answered in time. */
async function askOperator(
  kind: "approval_request" | "question",
  body: string,
  payload: unknown,
): Promise<string | null> {
  const deadline = Date.now() + TOTAL_MS;
  try {
    const first = await client.ask(SESSION, kind, body, payload, Math.min(LEG_MS, TOTAL_MS));
    if (first.answered && first.answer) return first.answer.body;
  } catch (err) {
    log("ask failed, will re-attach:", err instanceof Error ? err.message : err);
  }

  // The question is recorded server-side, so a dropped connection loses
  // nothing: re-attach to the same open ask until it is answered.
  while (Date.now() < deadline) {
    try {
      const again = await client.waitForOpenAsk(SESSION, Math.min(LEG_MS, deadline - Date.now()));
      if (again.answered && again.answer) return again.answer.body;
      if (again.askId === null) return null; // nothing open any more
    } catch (err) {
      log("re-attach failed, retrying:", err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return null;
}

const ALLOW = /^\s*(allow|approve|approved|yes|y|ok|okay|go ahead|do it|sure|lgtm)\b/i;
const DENY = /^\s*(deny|denied|no|n|reject|refuse|don'?t|stop|cancel)\b/i;

function describeToolCall(toolName: string, input: unknown): string {
  const lines = [`${toolName} wants to run.`];
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    // Put the fields a person actually decides on first.
    for (const key of ["command", "file_path", "url", "description", "pattern"]) {
      if (typeof o[key] === "string") lines.push(`${key}: ${o[key] as string}`);
    }
    const rest = JSON.stringify(input);
    if (rest.length <= 1500) lines.push(`full input: ${rest}`);
  }
  lines.push("", "Reply allow or deny. Anything else is treated as a denial with your text as the reason.");
  return lines.join("\n");
}

function describeQuestions(input: unknown): string {
  const o = (input ?? {}) as { questions?: unknown };
  if (!Array.isArray(o.questions)) return "The agent has a question but sent no question text.";
  const lines = ["The agent is asking:"];
  for (const raw of o.questions) {
    const q = raw as { question?: string; header?: string; options?: { label?: string; description?: string }[] };
    lines.push("", q.header ? `${q.header}: ${q.question ?? ""}` : (q.question ?? ""));
    for (const opt of q.options ?? []) {
      lines.push(`  - ${opt.label ?? ""}${opt.description ? ` (${opt.description})` : ""}`);
    }
  }
  lines.push("", "Answer in your own words; it is passed through verbatim.");
  return lines.join("\n");
}

const asJson = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

const server = new McpServer({ name: "awm", version: "0.1.0" });

server.registerTool(
  "approve",
  {
    title: "Ask the operator for a decision",
    description:
      "Relays a permission request to the operator and returns their decision. " +
      "Claude Code calls this automatically; it is not for the agent to call directly.",
    // Deliberately permissive. The field names Claude Code uses for a
    // permission prompt tool are not documented, so accept the plausible
    // spellings and log whatever arrives rather than rejecting the call.
    inputSchema: {
      tool_name: z.string().optional(),
      toolName: z.string().optional(),
      input: z.unknown().optional(),
      tool_input: z.unknown().optional(),
      tool_use_id: z.string().optional(),
    },
  },
  async (args) => {
    const toolName = args.tool_name ?? args.toolName ?? "unknown tool";
    const toolInput = args.input ?? args.tool_input ?? {};
    log(`approve: ${toolName}`, JSON.stringify(args).slice(0, 2000));

    // Clarifying questions arrive here too, as AskUserQuestion. Returning a
    // free-text `response` lets the operator answer in their own words instead
    // of us mapping their reply onto option labels.
    if (toolName === "AskUserQuestion") {
      const reply = await askOperator("question", describeQuestions(toolInput), toolInput);
      if (reply === null) {
        return asJson({
          behavior: "deny",
          message: "Nobody answered. Stop and report what you need to know.",
        });
      }
      const questions = (toolInput as { questions?: unknown }).questions ?? [];
      return asJson({
        behavior: "allow",
        updatedInput: { questions, response: reply },
      });
    }

    const reply = await askOperator(
      "approval_request",
      describeToolCall(toolName, toolInput),
      { tool_name: toolName, tool_input: toolInput },
    );
    if (reply === null) {
      return asJson({
        behavior: "deny",
        message:
          "No approval came back in time. Do not retry this action; stop and report what you were blocked on.",
      });
    }
    if (ALLOW.test(reply)) {
      // updatedInput must be present on an allow, so always echo the input back.
      return asJson({ behavior: "allow", updatedInput: toolInput });
    }
    if (DENY.test(reply)) {
      return asJson({ behavior: "deny", message: reply });
    }
    // An ambiguous reply is not consent. Pass it through as guidance so the
    // agent can adapt rather than silently proceeding.
    return asJson({ behavior: "deny", message: `The operator said: ${reply}` });
  },
);

server.registerTool(
  "ask_operator",
  {
    title: "Ask the operator a question",
    description:
      "Ask the person who queued this task a free-form question and wait for their reply. " +
      "Use it when you are genuinely blocked on a decision only they can make. The task " +
      "pauses until they answer, so do not use it for anything you can work out yourself.",
    inputSchema: {
      question: z.string().describe("What you need to know, with enough context to answer it"),
    },
  },
  async (args) => {
    log("ask_operator:", args.question.slice(0, 200));
    const reply = await askOperator("question", args.question, null);
    return {
      content: [
        {
          type: "text" as const,
          text:
            reply ??
            "No reply came back in time. Stop here and report that you are waiting on an answer.",
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());
log(`ready for session ${SESSION}`);
