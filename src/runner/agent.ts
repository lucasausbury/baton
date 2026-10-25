import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { WorkItem } from "../core/types.ts";
import { ServerError, type ServerClient } from "./client.ts";
import type { RunnerConfig } from "./config.ts";

const SHIM = join(dirname(fileURLToPath(import.meta.url)), "shim.ts");

const FLUSH_BYTES = 4096;
const FLUSH_MS = 2000;

/**
 * Every credential source Claude Code consults.
 *
 * These are cleared before a profile's own environment is applied, because the
 * precedence order is not in our favour: ANTHROPIC_API_KEY outranks a
 * subscription login, and under -p it is used without asking. A stray export in
 * the shell that started the runner would otherwise silently redirect every
 * subscription profile onto the wrong account -- the exact thing this tool
 * exists to control. CLAUDE_CONFIG_DIR is cleared for the same reason, so a
 * profile that names no config dir gets the default account rather than
 * whichever one the runner happened to inherit.
 */
const CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CONFIG_DIR",
];

function agentEnv(
  profileEnv: Record<string, string>,
  credentialEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of CREDENTIAL_VARS) delete env[key];
  return { ...env, ...profileEnv, ...credentialEnv };
}

/** Error categories in a stream-json api_retry event that mean "fix the account". */
const CREDENTIAL_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
  "cloud_credential_error",
]);

const CREDENTIAL_TEXT =
  /login expired|run \/login|not logged in|invalid api key|authentication_error|credit balance|oauth token has expired|invalid bearer token/i;

/** True when this message means the profile's credential is the problem. */
function looksLikeCredentialFailure(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.type === "system" && m.subtype === "api_retry") {
    return CREDENTIAL_ERRORS.has(String(m.error));
  }
  if (m.type === "result") {
    return typeof m.result === "string" && CREDENTIAL_TEXT.test(m.result);
  }
  return false;
}

/**
 * What to actually do about a broken credential, which depends on how the
 * profile authenticates. A subscription login expires and cannot refresh
 * itself, and the docs warn that unattended sessions are where that bites --
 * so say which command to run, on which machine, for which account.
 */
function credentialAdvice(
  profileId: string,
  workerId: string,
  env: Record<string, string>,
): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (configDir) {
    return (
      `[credential problem on profile ${profileId}. Its subscription login has expired or ` +
      `was revoked. On ${workerId}, run: CLAUDE_CONFIG_DIR=${configDir} claude /login. ` +
      `Every session on this profile will keep failing until you do.]`
    );
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return (
      `[credential problem on profile ${profileId}. Its long-lived OAuth token has expired ` +
      `or been revoked; these last a year. Run claude setup-token and update this runner's ` +
      `credentials entry on ${workerId}.]`
    );
  }
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
    return (
      `[credential problem on profile ${profileId}. Its API key was rejected -- check whether ` +
      `it was revoked, or whether the organization is out of credit.]`
    );
  }
  return (
    `[credential problem on profile ${profileId}. It uses the default account on ${workerId}, ` +
    `whose login has expired. Run claude /login there.]`
  );
}

function systemPrompt(workerId: string): string {
  return [
    `You are running unattended on ${workerId}, started from a task queue.`,
    "Nobody is watching your output as it appears.",
    "",
    "If you are blocked on a decision only the person who queued this task can make,",
    "call the ask_operator tool. The task pauses until they reply, which may take hours,",
    "so use it only for things you genuinely cannot settle yourself. Permission requests",
    "are routed to them automatically; you do not need to ask separately for those.",
    "",
    "When you finish, state plainly what you changed, what you verified, and anything you",
    "left undone. That summary is what they will read.",
  ].join("\n");
}

/** Batches output so a chatty agent does not become a request per token. */
class OutputBuffer {
  #client: ServerClient;
  #sessionId: string;
  #parts: string[] = [];
  #bytes = 0;
  #timer: NodeJS.Timeout | undefined;
  #chain: Promise<void> = Promise.resolve();

  constructor(client: ServerClient, sessionId: string) {
    this.#client = client;
    this.#sessionId = sessionId;
  }

  add(text: string): void {
    if (!text) return;
    this.#parts.push(text);
    this.#bytes += Buffer.byteLength(text);
    if (this.#bytes >= FLUSH_BYTES) {
      this.flush();
    } else if (!this.#timer) {
      this.#timer = setTimeout(() => this.flush(), FLUSH_MS);
      this.#timer.unref();
    }
  }

  flush(kind: "output" | "result" | "error" = "output"): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#parts.length === 0) return;
    const body = this.#parts.join("\n");
    this.#parts = [];
    this.#bytes = 0;
    // Serialise sends so the log keeps its order even under backpressure.
    this.#chain = this.#chain.then(async () => {
      try {
        await this.#client.sendOutput(this.#sessionId, body, kind);
      } catch (err) {
        // A 409 here is ordinary: the session was cancelled or settled while
        // the agent was still talking. Do not dress it up as a failure, or the
        // real failures stop standing out.
        if (err instanceof ServerError && err.status === 409) {
          console.log(`[runner] ${this.#sessionId} is closed; discarding late output`);
        } else {
          console.error(`[runner] dropping output for ${this.#sessionId}:`, err);
        }
      }
    });
  }

  /** Flushes anything buffered and waits for every send to land. */
  async drain(kind: "output" | "result" | "error" = "output"): Promise<void> {
    this.flush(kind);
    await this.#chain;
  }
}

/**
 * Turns one stream-json message into a line worth keeping, or null to drop it.
 * The goal is a log a person can read on a phone, not a transcript.
 */
function summarize(msg: unknown): { text: string; isResult: boolean } | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;

  if (m.type === "system" && m.subtype === "init") {
    return { text: `[started on ${String(m.model ?? "?")}]`, isResult: false };
  }
  if (m.type === "system" && m.subtype === "api_retry") {
    return { text: `[api retry ${String(m.attempt ?? "?")}: ${String(m.error ?? "")}]`, isResult: false };
  }
  if (m.type === "result") {
    const cost = typeof m.total_cost_usd === "number" ? ` ($${m.total_cost_usd.toFixed(3)})` : "";
    const text = typeof m.result === "string" ? m.result : `[${String(m.subtype ?? "done")}]`;
    return { text: `${text}${cost}`, isResult: true };
  }
  if (m.type === "assistant") {
    const message = m.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const lines: string[] = [];
    for (const raw of blocks) {
      const b = raw as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        lines.push(b.text.trim());
      } else if (b.type === "tool_use") {
        const input = JSON.stringify(b.input ?? {});
        const short = input.length > 200 ? `${input.slice(0, 200)}...` : input;
        lines.push(`[tool: ${String(b.name ?? "?")}] ${short}`);
      }
    }
    return lines.length ? { text: lines.join("\n"), isResult: false } : null;
  }
  if (m.type === "user") {
    // Tool results are mostly noise, but a failure is not.
    const message = m.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const errors = blocks
      .map((raw) => raw as Record<string, unknown>)
      .filter((b) => b.type === "tool_result" && b.is_error === true)
      .map((b) => `[tool failed] ${JSON.stringify(b.content ?? "").slice(0, 400)}`);
    return errors.length ? { text: errors.join("\n"), isResult: false } : null;
  }
  return null;
}

export interface RunningAgent {
  sessionId: string;
  /** Absent when the profile was rejected before anything was spawned. */
  child: ChildProcess | undefined;
  done: Promise<void>;
  kill: () => void;
}

/**
 * Spawns one agent for one work item and streams it back to the server.
 *
 * The runner owns only the process: approvals and questions travel from the
 * agent to the server through the shim, not through here.
 */
export function runAgent(
  item: WorkItem,
  client: ServerClient,
  config: RunnerConfig,
): RunningAgent {
  const { session, project, profile } = item;
  const credentialEnv = profile.credentialRef
    ? config.credentials[profile.credentialRef]
    : undefined;
  if (profile.credentialRef && !credentialEnv) {
    console.error(
      `[runner] profile ${profile.id} wants credential "${profile.credentialRef}", ` +
        `which is not in this runner's config`,
    );
  }

  // Node refuses to spawn a .cmd or .bat without a shell, and running one
  // through cmd.exe would put the prompt, the system prompt and a JSON blob
  // through shell parsing. Rather than do that, say what to use instead: npm's
  // `claude` on Windows is a .cmd wrapper, so point the profile at claude.exe
  // or at node with the CLI entry point in launchArgs.
  if (process.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(profile.command)) {
    const message =
      `[profile ${profile.id} names ${profile.command}. Windows cannot launch a ` +
      `.cmd/.bat safely without a shell, and this runner will not put your prompt ` +
      `through one. Point command at claude.exe, or at node with the CLI's .js ` +
      `entry point as the profile's launch args.]`;
    console.error(`[runner] ${message}`);
    const done = (async () => {
      try {
        await client.sendOutput(session.id, message, "error");
        await client.reportExit(session.id, 126);
      } catch (err) {
        console.error(`[runner] could not report the bad profile for ${session.id}:`, err);
      }
    })();
    return {
      sessionId: session.id,
      child: undefined,
      done,
      kill: () => undefined,
    };
  }

  const mcpConfig = {
    mcpServers: {
      awm: {
        command: process.execPath,
        args: ["--no-warnings=ExperimentalWarning", SHIM],
        env: {
          AWM_SESSION: session.id,
          AWM_URL: config.serverUrl,
          AWM_TOKEN: config.token,
        },
      },
    },
  };

  const args = [
    // A profile may need arguments before ours, e.g. command "node" with
    // launchArgs ["<path>/cli.js"].
    ...profile.launchArgs,
    "-p",
    item.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    JSON.stringify(mcpConfig),
    "--permission-prompt-tool",
    "mcp__awm__approve",
    "--append-system-prompt",
    systemPrompt(config.workerId),
    // The session row's id is the agent's own session id, so resuming needs no
    // extra bookkeeping.
    ...(item.resume ? ["--resume", session.id] : ["--session-id", session.id]),
    ...profile.args,
  ];

  const resolvedEnv = agentEnv(profile.env, credentialEnv);
  const child = spawn(profile.command, args, {
    cwd: project.path,
    env: resolvedEnv,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  const out = new OutputBuffer(client, session.id);
  let killed = false;
  let credentialFailure = false;

  // Every listener is attached synchronously, before anything is awaited. A
  // spawn failure emits 'error' on the next tick, and an unhandled 'error' on a
  // ChildProcess throws -- which would take down the whole runner because one
  // profile named a binary that is not there.
  let pending = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Not stream-json: pass it through rather than losing it.
        out.add(line.trim());
        continue;
      }
      if (looksLikeCredentialFailure(parsed)) credentialFailure = true;
      const summary = summarize(parsed);
      if (!summary) continue;
      if (summary.isResult) {
        out.flush();
        out.add(summary.text);
        out.flush("result");
      } else {
        out.add(summary.text);
      }
    }
  });

  // The shim logs here too, so keep it but do not treat it as failure.
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
  });

  const exited = new Promise<number>((resolve) => {
    child.once("error", (err) => {
      out.add(`[runner could not start ${profile.command}: ${err.message}]`);
      resolve(127);
    });
    child.once("close", (code, signal) => {
      if (pending.trim()) out.add(pending.trim());
      resolve(code ?? (signal ? 143 : 1));
    });
  });

  const done = (async () => {
    try {
      await client.markStarted(session.id);
    } catch (err) {
      console.error(`[runner] could not mark ${session.id} started:`, err);
    }

    const exitCode = await exited;

    if (exitCode !== 0 && stderr.trim()) {
      out.add(`[stderr]\n${stderr.trim().slice(-4000)}`);
    }
    // An expired login looks like an ordinary failure in the transcript, but it
    // will break every future session on this profile until someone logs in. Say
    // so, and say where.
    if (credentialFailure) {
      out.add(
        credentialAdvice(profile.id, config.workerId, {
          ...profile.env,
          ...credentialEnv,
        }),
      );
    }
    await out.drain(exitCode === 0 ? "output" : "error");

    if (killed) return; // cancelled: the server already moved it on
    try {
      await client.reportExit(session.id, exitCode);
    } catch (err) {
      console.error(`[runner] could not report exit for ${session.id}:`, err);
    }
  })();

  return {
    sessionId: session.id,
    child,
    done,
    kill: () => {
      killed = true;
      // SIGTERM lets Claude Code run its SessionEnd hooks and tear down its own
      // child processes; SIGKILL would orphan them.
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 10_000).unref();
    },
  };
}
