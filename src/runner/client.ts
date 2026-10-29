import type { WorkerInventory, WorkItem } from "../core/types.ts";

export interface AskResult {
  askId: number;
  answered: boolean;
  answer?: { body: string; payload: unknown };
}

/**
 * Thin client for the server's runner API. Everything is outbound: this machine
 * has no stable address and may change networks mid-session, so there is no
 * listener here and no state the server has to keep about where we are.
 */
export class ServerClient {
  #base: string;
  #token: string;
  #platform: string;

  constructor(base: string, token: string, platform = process.platform) {
    this.#base = base.replace(/\/$/, "");
    this.#token = token;
    this.#platform = platform;
  }

  async #call(path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<unknown> {
    const res = await fetch(`${this.#base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
        "x-platform": this.#platform,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const body: unknown = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const message =
        typeof body === "object" && body !== null && "error" in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new ServerError(res.status, message);
    }
    return body;
  }

  /**
   * Long-polls for work. `limit` is how many sessions we can take right now;
   * pass 0 when at capacity to hear about cancellations without claiming
   * anything we cannot start.
   */
  async getWork(waitMs: number, limit: number): Promise<{ work: WorkItem[]; cancelled: string[] }> {
    const body = (await this.#call(
      `/v1/work?wait=${waitMs}&limit=${limit}`,
      {},
      waitMs + 20_000,
    )) as { work?: WorkItem[]; cancelled?: string[] };
    return { work: body.work ?? [], cancelled: body.cancelled ?? [] };
  }

  /**
   * Tells the server what this machine has, for the lists in the Claude apps.
   *
   * Display only. The server stores it and never reads it back to launch
   * anything, because the whole point of the config being here is that this
   * machine is the authority on its own paths and postures.
   */
  async reportInventory(inventory: WorkerInventory): Promise<void> {
    await this.#call(`/v1/inventory`, {
      method: "POST",
      body: JSON.stringify(inventory),
    });
  }

  async markStarted(sessionId: string): Promise<void> {
    await this.#call(`/v1/sessions/${sessionId}/started`, { method: "POST" });
  }

  async sendOutput(
    sessionId: string,
    body: string,
    kind: "output" | "result" | "error" = "output",
  ): Promise<void> {
    await this.#call(`/v1/sessions/${sessionId}/output`, {
      method: "POST",
      body: JSON.stringify({ body, kind }),
    });
  }

  async reportExit(sessionId: string, exitCode: number): Promise<void> {
    await this.#call(`/v1/sessions/${sessionId}/exit`, {
      method: "POST",
      body: JSON.stringify({ exitCode }),
    });
  }

  /**
   * Asks the operator something and waits. The server holds the response open,
   * so this request can legitimately stay pending for hours -- a parked agent
   * costs nothing, and the point is that the answer can wait for a human.
   */
  async ask(
    sessionId: string,
    kind: "approval_request" | "question",
    body: string,
    payload: unknown,
    waitMs: number,
  ): Promise<AskResult> {
    return (await this.#call(
      `/v1/sessions/${sessionId}/ask?wait=${waitMs}`,
      { method: "POST", body: JSON.stringify({ kind, body, payload }) },
      waitMs + 20_000,
    )) as AskResult;
  }

  /** Re-attaches to an ask whose request was cut off mid-flight. */
  async waitForOpenAsk(sessionId: string, waitMs: number): Promise<AskResult> {
    return (await this.#call(
      `/v1/sessions/${sessionId}/ask?wait=${waitMs}`,
      {},
      waitMs + 20_000,
    )) as AskResult;
  }
}

export class ServerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
