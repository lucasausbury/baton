import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import type { Store } from "../core/store.ts";
import type { Message, Session } from "../core/types.ts";
import { NotFound } from "../core/types.ts";
import { escapeHtml, sameSecret } from "../core/web.ts";

/**
 * A read-only page for one session, at /s/<id>.
 *
 * This exists because a push notification needs somewhere to go. MCP is
 * pull-only, so the interrupt arrives over ntfy -- and tapping it should show
 * the session rather than drop you into an app and a conversation you then have
 * to steer. Answering still happens through MCP; nothing here writes.
 */

const COOKIE = "baton_page";
const COOKIE_PATH = "/s";
const SESSION_TTL_S = 7 * 24 * 60 * 60;

/** Newest messages win, within both caps, so one runaway log cannot blow up the page. */
const MAX_MESSAGES = 400;
const MAX_BODY_CHARS = 400_000;

const STATE_CLASS: Record<string, string> = {
  queued: "wait",
  running: "live",
  blocked: "ask",
  finished: "good",
  failed: "bad",
  cancelled: "muted",
};

const STYLE = `
  :root { color-scheme: light dark; --fg:#111; --bg:#fff; --muted:#666; --line:#d8d8d8;
          --accent:#1a6ae0; --bad:#b4232c; --good:#1a7f37; --warn:#9a6700; --soft:#f6f6f6; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#eee; --bg:#141414; --muted:#9a9a9a; --line:#333;
            --accent:#5c9cff; --bad:#ff7b84; --good:#4ac26b; --warn:#d4a72c; --soft:#1d1d1d; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px; font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
         color:var(--fg); background:var(--bg); display:flex; justify-content:center; }
  main { width:100%; max-width:46rem; }
  h1 { font-size:1.25rem; margin:0 0 .25rem; overflow-wrap:anywhere; }
  p { color:var(--muted); margin:.5rem 0; }
  code { overflow-wrap:anywhere; }
  .meta { font-size:.875rem; display:flex; flex-wrap:wrap; gap:.4rem .8rem;
          margin:.5rem 0 1.5rem; align-items:center; color:var(--muted); }
  .badge { display:inline-block; padding:.1rem .5rem; border-radius:999px; font-size:.8125rem;
           font-weight:600; border:1px solid var(--line); }
  .badge.live { color:var(--accent); border-color:var(--accent); }
  .badge.ask  { color:var(--warn); border-color:var(--warn); }
  .badge.good { color:var(--good); border-color:var(--good); }
  .badge.bad  { color:var(--bad);  border-color:var(--bad); }
  .ask-box { border:1px solid var(--warn); border-radius:8px; padding:12px; margin:0 0 1.5rem; }
  .ask-box h2 { font-size:1rem; margin:0 0 .5rem; color:var(--warn); }
  .log { list-style:none; margin:0; padding:0; }
  .log li { border-top:1px solid var(--line); padding:.75rem 0; }
  .log header { font-size:.75rem; text-transform:uppercase; letter-spacing:.04em;
                color:var(--muted); margin-bottom:.35rem; }
  .log li.in header { color:var(--accent); }
  .log li.error header { color:var(--bad); }
  pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--soft);
        padding:.6rem .7rem; border-radius:6px;
        font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  label { display:block; margin:16px 0 6px; font-weight:600; color:var(--fg); }
  input { width:100%; padding:12px; font-size:16px; border:1px solid var(--line);
          border-radius:8px; background:var(--bg); color:var(--fg); }
  button { width:100%; margin-top:16px; padding:12px; font-size:16px; font-weight:600;
           border:0; border-radius:8px; background:var(--accent); color:#fff; }
  .err { color:var(--bad); font-weight:600; }
  .note { font-size:.875rem; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head><body><main>
${body}
</main></body></html>`;
}

/**
 * The cookie is self-contained: an expiry, and an HMAC of it under the login
 * password. Nothing is stored, so there is no table to sweep -- and changing
 * the password invalidates every outstanding cookie for free.
 */
function mint(password: string): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  return `${exp}.${createHmac("sha256", password).update(String(exp)).digest("hex")}`;
}

function valid(cookie: string, password: string): boolean {
  const dot = cookie.indexOf(".");
  if (dot < 1) return false;
  const exp = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  if (!/^\d+$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Number(exp) * 1000 <= Date.now()) return false;
  const want = createHmac("sha256", password).update(exp).digest("hex");
  return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(want, "hex"));
}

function cookieFrom(header: string | undefined): string {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    if (part.slice(0, eq).trim() === COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

const when = (value: string | null): string =>
  value === null ? "--" : new Date(value).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");

/** Express types the param loosely; the route only ever matches one segment. */
const idOf = (value: unknown): string => (typeof value === "string" ? value : "");

function loginPage(action: string, error: string | null): string {
  return shell(
    "Sign in to baton",
    `  <h1>Sign in</h1>
  <p>This page shows one baton session. It is read-only.</p>
  ${error === null ? "" : `<p class="err">${escapeHtml(error)}</p>`}
  <form method="post" action="${escapeHtml(action)}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password"
           autofocus required>
    <button type="submit">Sign in</button>
  </form>`,
  );
}

/** Drops the oldest messages until both caps are satisfied. */
function trim(messages: Message[]): { kept: Message[]; dropped: number } {
  let kept = messages.slice(-MAX_MESSAGES);
  let chars = kept.reduce((n, m) => n + m.body.length, 0);
  while (kept.length > 1 && chars > MAX_BODY_CHARS) {
    const [oldest, ...rest] = kept;
    chars -= oldest === undefined ? 0 : oldest.body.length;
    kept = rest;
  }
  return { kept, dropped: messages.length - kept.length };
}

function sessionPage(store: Store, session: Session): string {
  const project = store.getProject(session.projectId);
  const profile = store.getProfile(session.profileId);
  const ask = store.openAsk(session.id);
  const { kept, dropped } = trim(store.messages(session.id));

  const heading = session.title ?? project.name;
  const facts = [
    `<span class="badge ${STATE_CLASS[session.state] ?? "muted"}">${escapeHtml(session.state)}</span>`,
    `<span>${escapeHtml(project.name)}</span>`,
    `<span>${escapeHtml(session.workerId)} &middot; ${escapeHtml(profile.label)}</span>`,
    session.exitCode === null ? null : `<span>exit ${session.exitCode}</span>`,
    session.runCount > 1 ? `<span>run ${session.runCount}</span>` : null,
    `<span>started ${escapeHtml(when(session.startedAt))}</span>`,
    session.endedAt === null ? null : `<span>ended ${escapeHtml(when(session.endedAt))}</span>`,
  ].filter((s) => s !== null);

  const askBox =
    ask === null
      ? ""
      : `<div class="ask-box">
    <h2>Waiting on you</h2>
    <pre>${escapeHtml(ask.body)}</pre>
    <p class="note">Answer in the Claude app -- this page cannot reply.</p>
  </div>`;

  const omitted =
    dropped === 0
      ? ""
      : `<p class="note">${dropped} earlier message${dropped === 1 ? "" : "s"} omitted; this is the most recent output.</p>`;

  const empty = `    <li><header>nothing yet</header><pre>No output has arrived for this session.</pre></li>`;
  const items = kept
    .map(
      (m) =>
        `    <li class="${m.direction} ${escapeHtml(m.kind)}">
      <header>${m.direction === "in" ? "you" : "agent"} &middot; ${escapeHtml(m.kind)} &middot; ${escapeHtml(when(m.createdAt))}</header>
      <pre>${escapeHtml(m.body)}</pre>
    </li>`,
    )
    .join("\n");

  return shell(
    `${heading} - baton`,
    `  <h1>${escapeHtml(heading)}</h1>
  <div class="meta">${facts.join("")}</div>
  ${askBox}
  ${omitted}
  <ol class="log">
${items === "" ? empty : items}
  </ol>
  <p class="note">Read-only. Session <code>${escapeHtml(session.id)}</code>.</p>`,
  );
}

export interface SessionPage {
  app: Express;
  /** Paths this app owns, so the outer server knows what to hand over. */
  owns: (path: string) => boolean;
}

/**
 * Builds the session page. It needs the login password and nothing else: the
 * same password that gets you through the OAuth consent screen, because it
 * grants the same sight of your projects' work.
 */
export function createSessionPage(opts: { store: Store; password: string }): SessionPage {
  const { store, password } = opts;
  const app = express();
  // Only Caddy sits in front, so trust exactly one hop -- for the rate
  // limiter's client address, and for req.secure.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // The same one password guards every worker, so failed attempts are capped
  // exactly as they are on the consent screen.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many attempts. Wait a few minutes and try again.",
  });

  app.post(
    "/s/:id",
    limiter,
    express.urlencoded({ extended: false, limit: "16kb" }),
    (req, res) => {
      const body = req.body as Record<string, unknown>;
      const given = typeof body.password === "string" ? body.password : "";
      const target = `/s/${encodeURIComponent(idOf(req.params.id))}`;

      if (given === "" || !sameSecret(given, password)) {
        res.status(401).type("html").send(loginPage(target, "That password is not right."));
        return;
      }
      const attrs = [
        `${COOKIE}=${mint(password)}`,
        `Path=${COOKIE_PATH}`,
        `Max-Age=${SESSION_TTL_S}`,
        "HttpOnly",
        "SameSite=Lax",
      ];
      if (req.secure) attrs.push("Secure");
      res.setHeader("set-cookie", attrs.join("; "));
      res.redirect(303, target);
    },
  );

  app.get("/s/:id", (req, res) => {
    const id = idOf(req.params.id);
    if (!valid(cookieFrom(req.headers.cookie), password)) {
      res.status(401).type("html").send(loginPage(`/s/${encodeURIComponent(id)}`, null));
      return;
    }
    // Only once the caller is known do we say whether the session exists.
    // Answering that first would make the login page an oracle for guessing ids.
    try {
      const session = store.getSession(id);
      res.type("html").send(sessionPage(store, session));
    } catch (err) {
      if (err instanceof NotFound) {
        res.status(404).type("html").send(shell("Not found", "  <h1>No such session</h1>"));
        return;
      }
      throw err;
    }
  });

  return {
    app,
    owns: (path: string) => path === "/s" || path.startsWith("/s/"),
  };
}
