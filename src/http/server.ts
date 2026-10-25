import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config.ts";
import { NotFound, StateError, type Worker } from "../core/types.ts";
import type { Store } from "../core/store.ts";

const MAX_BODY = 1_000_000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, "body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "body is not valid JSON");
  }
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  }).end(text);
}

const asString = (v: unknown, field: string): string => {
  if (typeof v !== "string" || v.length === 0) throw new HttpError(400, `${field} is required`);
  return v;
};

/**
 * Holds the request open until `probe` returns something, or the wait expires.
 *
 * Workers roam between networks and have no stable address, so everything is
 * outbound polling. Holding the request gives push latency without needing a
 * listener on the worker. The probe must never hold a write transaction open.
 */
async function longPoll<T>(
  res: ServerResponse,
  probe: () => T | null,
  totalMs: number,
): Promise<T | null> {
  const deadline = Date.now() + totalMs;
  // Watch the *response*, not the request: a POST body that has been read to
  // completion closes the request stream, which says nothing about whether the
  // client is still there.
  let closed = res.destroyed;
  let wake: (() => void) | undefined;
  const onClose = (): void => {
    closed = true;
    wake?.();
  };
  res.once("close", onClose);
  try {
    for (;;) {
      const hit = probe();
      if (hit !== null) return hit;
      if (closed || Date.now() >= deadline) return null;
      const remaining = Math.max(Math.min(config.pollIntervalMs, deadline - Date.now()), 1);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, remaining);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    }
  } finally {
    res.removeListener("close", onClose);
  }
}

const waitMs = (url: URL, fallback: number, cap: number): number => {
  const raw = url.searchParams.get("wait");
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "wait must be a number of ms");
  return Math.min(n, cap);
};

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

export function createRunnerHandler(store: Store): RequestHandler {
  /** A worker may only ever see or touch its own sessions. */
  function ownSession(worker: Worker, id: string) {
    const session = store.getSession(id);
    if (session.workerId !== worker.id) throw new NotFound(`no session ${id}`);
    return session;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (method === "GET" && (path === "/healthz" || path === "/")) {
      send(res, 200, { ok: true, workers: store.listWorkers().length });
      return;
    }

    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const worker = token ? store.authWorker(token) : null;
    if (!worker) {
      res.setHeader("www-authenticate", "Bearer");
      throw new HttpError(401, "a worker bearer token is required");
    }
    store.heartbeat(worker.id, typeof req.headers["x-platform"] === "string" ? req.headers["x-platform"] : undefined);

    // Long-poll for work. Returns as soon as anything is queued for this
    // worker. `limit` is how many the runner can actually take right now;
    // limit=0 means it is at capacity and only wants to hear about
    // cancellations, so nothing is claimed and nothing is held open.
    if (method === "GET" && path === "/v1/work") {
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? 5 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 0 || limit > 20) {
        throw new HttpError(400, "limit must be an integer from 0 to 20");
      }
      const items =
        limit === 0
          ? []
          : ((await longPoll(
              res,
              () => {
                const batch = store.claimWork(worker.id, limit);
                return batch.length > 0 ? batch : null;
              },
              waitMs(url, config.longPollMs, 120_000),
            )) ?? []);
      send(res, 200, { work: items, cancelled: store.cancelledFor(worker.id) });
      return;
    }

    const session = /^\/v1\/sessions\/([^/]+)\/([a-z]+)$/.exec(path);
    if (session) {
      const id = session[1]!;
      const action = session[2]!;
      ownSession(worker, id);

      if (method === "POST" && action === "started") {
        send(res, 200, { session: store.markStarted(id) });
        return;
      }

      if (method === "POST" && action === "output") {
        const body = await readJson(req);
        const kind = body.kind === "error" || body.kind === "result" ? body.kind : "output";
        send(res, 201, { message: store.appendOutput(id, asString(body.body, "body"), kind) });
        return;
      }

      if (method === "POST" && action === "exit") {
        const body = await readJson(req);
        const code = Number(body.exitCode);
        if (!Number.isInteger(code)) throw new HttpError(400, "exitCode must be an integer");
        send(res, 200, { session: store.finishSession(id, code) });
        return;
      }

      // The agent wants something from the operator. The response is held until
      // it is answered -- a parked agent costs nothing, and the whole point is
      // that an approval can wait until someone picks up the phone.
      if (method === "POST" && action === "ask") {
        const body = await readJson(req);
        const kind = body.kind === "question" ? "question" : "approval_request";
        const ask = store.ask({
          sessionId: id,
          kind,
          body: asString(body.body, "body"),
          payload: body.payload,
        });
        const answer = await longPoll(
          res,
          () => store.answerTo(ask.id),
          waitMs(url, config.approvalWaitMs, config.approvalWaitMs),
        );
        if (!answer) {
          send(res, 200, { askId: ask.id, answered: false });
          return;
        }
        send(res, 200, {
          askId: ask.id,
          answered: true,
          answer: { body: answer.body, payload: answer.payload },
        });
        return;
      }

      // Resume waiting on an ask whose request was cut off mid-flight.
      if (method === "GET" && action === "ask") {
        const open = store.openAsk(id);
        if (!open) {
          send(res, 200, { askId: null, answered: true });
          return;
        }
        const answer = await longPoll(
          res,
          () => store.answerTo(open.id),
          waitMs(url, config.longPollMs, config.approvalWaitMs),
        );
        send(res, 200, {
          askId: open.id,
          answered: answer !== null,
          answer: answer ? { body: answer.body, payload: answer.payload } : undefined,
        });
        return;
      }

      // Operator messages the runner can feed to a live agent's stdin.
      if (method === "GET" && action === "inbound") {
        const messages = await longPoll(
          res,
          () => {
            const batch = store.takeInbound(id);
            return batch.length > 0 ? batch : null;
          },
          waitMs(url, 0, 120_000),
        );
        send(res, 200, { messages: messages ?? [] });
        return;
      }
    }

    throw new HttpError(404, `no route for ${method} ${path}`);
  }

  return (req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.message });
      } else if (err instanceof NotFound) {
        send(res, 404, { error: err.message });
      } else if (err instanceof StateError) {
        send(res, 409, { error: err.message });
      } else {
        console.error("[http] unhandled:", err);
        send(res, 500, { error: "internal error" });
      }
    });
  };
}

export { HttpError, readJson, send };
