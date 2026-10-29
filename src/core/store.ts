import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/index.ts";
import { nowIso } from "../db/index.ts";
import {
  canTransition,
  NotFound,
  POSTURES,
  StateError,
  type Message,
  type MessageKind,
  type Posture,
  type Profile,
  type Project,
  type Session,
  type SessionState,
  type Worker,
  type WorkerInventory,
  type WorkItem,
} from "./types.ts";
import { slug } from "./slug.ts";

export { slug };

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

function mapWorker(r: Row): Worker {
  return {
    id: str(r.id),
    name: str(r.name),
    platform: strOrNull(r.platform),
    lastSeenAt: strOrNull(r.last_seen_at),
    inventory: parseInventory(strOrNull(r.inventory_json)),
    inventoryAt: strOrNull(r.inventory_at),
    createdAt: str(r.created_at),
  };
}

/**
 * Worker-reported inventory, parsed defensively.
 *
 * It is display data written by another machine, so a shape we do not
 * recognise becomes "nothing reported" rather than an exception on a list call.
 */
function parseInventory(raw: string | null): WorkerInventory | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    return {
      projects: Array.isArray(o.projects) ? (o.projects as WorkerInventory["projects"]) : [],
      profiles: Array.isArray(o.profiles) ? (o.profiles as WorkerInventory["profiles"]) : [],
    };
  } catch {
    return null;
  }
}

function mapProfile(r: Row): Profile {
  return {
    id: str(r.id),
    workerId: str(r.worker_id),
    label: str(r.label),
    createdAt: str(r.created_at),
  };
}

function mapProject(r: Row): Project {
  return {
    id: str(r.id),
    name: str(r.name),
    workerId: str(r.worker_id),
    defaultProfileId: strOrNull(r.default_profile_id),
    context: strOrNull(r.context),
    requestedPosture: strOrNull(r.requested_posture) as Posture | null,
    createdAt: str(r.created_at),
    archivedAt: strOrNull(r.archived_at),
  };
}

function mapSession(r: Row): Session {
  return {
    id: str(r.id),
    projectId: str(r.project_id),
    profileId: str(r.profile_id),
    workerId: str(r.worker_id),
    title: strOrNull(r.title),
    state: str(r.state) as SessionState,
    exitCode: numOrNull(r.exit_code),
    runCount: Number(r.run_count),
    claimedAt: strOrNull(r.claimed_at),
    startedAt: strOrNull(r.started_at),
    endedAt: strOrNull(r.ended_at),
    seenAt: strOrNull(r.seen_at),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function mapMessage(r: Row): Message {
  const raw = strOrNull(r.payload_json);
  return {
    id: Number(r.id),
    sessionId: str(r.session_id),
    direction: str(r.direction) as Message["direction"],
    kind: str(r.kind) as MessageKind,
    body: str(r.body),
    payload: raw === null ? null : JSON.parse(raw),
    answeredBy: numOrNull(r.answered_by),
    deliveredAt: strOrNull(r.delivered_at),
    createdAt: str(r.created_at),
  };
}

const hashToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/** Fired after any change worth telling the operator about. */
export interface StoreEvent {
  type: "blocked" | "finished" | "failed" | "queued" | "answered";
  session: Session;
  project: Project;
  message?: Message;
}

export class Store {
  #db: Db;
  #listeners = new Set<(e: StoreEvent) => void>();

  constructor(db: Db) {
    this.#db = db;
  }

  onEvent(fn: (e: StoreEvent) => void): void {
    this.#listeners.add(fn);
  }

  #emit(e: StoreEvent): void {
    for (const fn of this.#listeners) {
      try {
        fn(e);
      } catch (err) {
        console.error("[store] listener failed:", err);
      }
    }
  }

  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---------------------------------------------------------------- workers

  /** Returns the worker and its token. The token is not recoverable later. */
  createWorker(name: string, platform?: string): { worker: Worker; token: string } {
    const id = slug(name);
    const token = `baton_${randomUUID().replaceAll("-", "")}`;
    this.#db
      .prepare(
        `INSERT INTO workers (id, name, platform, token_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, name, platform ?? null, hashToken(token), nowIso());
    return { worker: this.getWorker(id), token };
  }

  getWorker(id: string): Worker {
    const row = this.#db.prepare(`SELECT * FROM workers WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw new NotFound(`no worker ${id}`);
    return mapWorker(row);
  }

  listWorkers(): Worker[] {
    return (this.#db.prepare(`SELECT * FROM workers ORDER BY name`).all() as Row[]).map(mapWorker);
  }

  /** Looks a worker up by bearer token without leaking timing on the hash. */
  authWorker(token: string): Worker | null {
    const want = Buffer.from(hashToken(token), "hex");
    let found: Row | null = null;
    for (const row of this.#db.prepare(`SELECT * FROM workers`).all() as Row[]) {
      const got = Buffer.from(str(row.token_hash), "hex");
      if (got.length === want.length && timingSafeEqual(got, want)) found = row;
    }
    return found ? mapWorker(found) : null;
  }

  /**
   * Records what a worker says it has: project paths, profile labels, the
   * posture each project allows. Display only -- nothing here is ever read back
   * to launch a session, because the machine is the authority on all of it.
   */
  setInventory(workerId: string, inventory: WorkerInventory): void {
    this.getWorker(workerId);
    this.#db
      .prepare(`UPDATE workers SET inventory_json = ?, inventory_at = ? WHERE id = ?`)
      .run(JSON.stringify(inventory), nowIso(), workerId);
  }

  heartbeat(workerId: string, platform?: string): void {
    this.#db
      .prepare(`UPDATE workers SET last_seen_at = ?, platform = COALESCE(?, platform) WHERE id = ?`)
      .run(nowIso(), platform ?? null, workerId);
  }

  // --------------------------------------------------------------- profiles

/**
   * Declares that a worker has an account under this label.
   *
   * There is nothing else to store. The machine's runner config says what the
   * label runs and with which credential, and this call cannot reach that --
   * which is the whole point of it being this short.
   */
  createProfile(input: { workerId: string; label: string }): Profile {
    const id = `${input.workerId}:${slug(input.label)}`;
    this.#db
      .prepare(
        `INSERT INTO profiles (id, worker_id, label, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label`,
      )
      .run(id, input.workerId, input.label, nowIso());
    return this.getProfile(id);
  }

  getProfile(id: string): Profile {
    const row = this.#db.prepare(`SELECT * FROM profiles WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw new NotFound(`no profile ${id}`);
    return mapProfile(row);
  }

  listProfiles(workerId?: string): Profile[] {
    const rows = workerId
      ? (this.#db
          .prepare(`SELECT * FROM profiles WHERE worker_id = ? ORDER BY label`)
          .all(workerId) as Row[])
      : (this.#db.prepare(`SELECT * FROM profiles ORDER BY worker_id, label`).all() as Row[]);
    return rows.map(mapProfile);
  }

  /**
   * Removes a profile, but never one still in use.
   *
   * Sessions record the profile they ran under, and a project can name one as
   * its default; both are real foreign keys, so SQLite would refuse anyway.
   * Doing the check here means the answer says which rows are in the way
   * instead of surfacing a constraint error. A profile that cannot be removed
   * can still be corrected, because createProfile replaces in place.
   */
  deleteProfile(id: string): void {
    this.getProfile(id); // throws NotFound if it never existed
    const sessions = (
      this.#db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE profile_id = ?`).get(id) as {
        n: number;
      }
    ).n;
    const projects = (
      this.#db
        .prepare(`SELECT name FROM projects WHERE default_profile_id = ? ORDER BY name`)
        .all(id) as { name: string }[]
    ).map((r) => r.name);

    if (sessions > 0 || projects.length > 0) {
      const blockers = [
        sessions > 0 ? `${sessions} session${sessions === 1 ? "" : "s"} ran under it` : null,
        projects.length > 0 ? `it is the default for ${projects.join(", ")}` : null,
      ].filter((s) => s !== null);
      throw new StateError(
        `cannot delete profile ${id}: ${blockers.join(", and ")}. ` +
          `Re-add it with the same label to correct it instead, or point those ` +
          `projects at another profile first.`,
      );
    }
    this.#db.prepare(`DELETE FROM profiles WHERE id = ?`).run(id);
  }

  /**
   * Sets up a whole machine in one transaction: the worker, its profiles, and
   * the projects that live on it.
   *
   * It is one call because the alternative is a wizard that asks a dozen
   * questions and then fails halfway, leaving a worker with no profile and a
   * token already spent. Either the machine is enrolled or nothing happened.
   */
  enroll(input: {
    name: string;
    platform?: string;
    replace?: boolean;
    profiles?: { label: string }[];
    projects?: {
      name: string;
      profileLabel?: string | null;
      context?: string | null;
      posture?: Posture | null;
    }[];
  }): { worker: Worker; token: string; profileIds: string[]; projectNames: string[] } {
    return this.#tx(() => {
      const id = slug(input.name);
      const already = this.#db.prepare(`SELECT id FROM workers WHERE id = ?`).get(id);
      if (already && !input.replace) {
        throw new StateError(
          `worker ${id} is already registered. Re-run with replace to issue it a new ` +
            `token -- which stops the old one working, so only do that for a machine ` +
            `you are setting up again.`,
        );
      }
      if (already) {
        // Rotating rather than deleting: sessions and projects reference this
        // worker, and the point of re-enrolling is to keep them.
        const token = `baton_${randomUUID().replaceAll("-", "")}`;
        this.#db
          .prepare(`UPDATE workers SET name = ?, platform = ?, token_hash = ? WHERE id = ?`)
          .run(input.name, input.platform ?? null, hashToken(token), id);
        return this.#enrollRest(id, token, input);
      }
      const { worker, token } = this.createWorker(input.name, input.platform);
      return this.#enrollRest(worker.id, token, input);
    });
  }

  #enrollRest(
    workerId: string,
    token: string,
    input: Parameters<Store["enroll"]>[0],
  ): { worker: Worker; token: string; profileIds: string[]; projectNames: string[] } {
    // Two names in the same batch that reduce to one id. Checked up front
    // because the whole batch is one transaction: without this the first of the
    // pair is attempted, the second fails, and the error names the row the
    // caller just created rather than the two answers that disagree.
    const byId = new Map<string, string>();
    for (const project of input.projects ?? []) {
      const id = this.#projectId(project.name);
      const first = byId.get(id);
      if (first !== undefined && first !== project.name) {
        throw new StateError(
          `projects "${first}" and "${project.name}" both reduce to the id "${id}", so they ` +
            `cannot both be registered. Rename one of them.`,
        );
      }
      byId.set(id, project.name);
    }

    const byLabel = new Map<string, string>();
    for (const p of input.profiles ?? []) {
      const profile = this.createProfile({ ...p, workerId });
      byLabel.set(p.label, profile.id);
    }
    for (const project of input.projects ?? []) {
      const profileId =
        project.profileLabel == null ? null : (byLabel.get(project.profileLabel) ?? null);
      if (project.profileLabel != null && profileId === null) {
        throw new StateError(
          `project ${project.name} names profile "${project.profileLabel}", which is not one of the profiles being enrolled`,
        );
      }
      this.registerProject({
        name: project.name,
        workerId,
        defaultProfileId: profileId,
        context: project.context ?? null,
        requestedPosture: project.posture ?? null,
      });
    }
    return {
      worker: this.getWorker(workerId),
      token,
      profileIds: [...byLabel.values()],
      projectNames: (input.projects ?? []).map((p) => p.name),
    };
  }

  // --------------------------------------------------------------- projects

  /**
   * Adds or updates a project.
   *
   * worker and path always overwrite -- they identify the checkout, and a
   * half-updated project pointing at the wrong machine is worse than a verbose
   * call. Everything else keeps its current value when omitted, so changing one
   * setting does not silently clear the rest.
   */
  /**
   * The id a project name becomes, with a message worth reading when it cannot
   * become one. slug() alone says "cannot derive an id from", which tells the
   * operator nothing about which of a dozen answers was the problem.
   */
  #projectId(name: string): string {
    try {
      return slug(name);
    } catch {
      throw new StateError(
        `project name ${JSON.stringify(name)} has no letters or digits, so there is no id ` +
          `to give it. Give it a name like "alexandria".`,
      );
    }
  }

  registerProject(input: {
    name: string;
    workerId: string;
    defaultProfileId?: string | null;
    context?: string | null;
    requestedPosture?: Posture | null;
  }): Project {
    if (input.requestedPosture != null && !POSTURES.includes(input.requestedPosture)) {
      throw new StateError(
        `unknown posture ${JSON.stringify(input.requestedPosture)}; use one of ${POSTURES.join(", ")}`,
      );
    }
    const id = this.#projectId(input.name);

    // A project's id is slug(name), so two different names can want the same
    // id -- "My App" and "my-app" do. The upsert below used to key on name, so
    // that pair hit the primary key instead and came back as a bare SQLite
    // constraint error: not a StateError, so the enrolment endpoint reported
    // only "enrollment failed", at the end, after every question was answered.
    // Merging two projects under one id silently would be worse, so say so.
    const clash = this.#db.prepare(`SELECT name FROM projects WHERE id = ?`).get(id) as
      | { name: string }
      | undefined;
    if (clash && clash.name !== input.name) {
      throw new StateError(
        `project "${input.name}" and the existing project "${clash.name}" both reduce to ` +
          `the id "${id}", so they cannot both exist. Rename one of them.`,
      );
    }

    this.#db
      .prepare(
        `INSERT INTO projects
           (id, name, worker_id, default_profile_id, context, requested_posture, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           worker_id = excluded.worker_id,
           default_profile_id = COALESCE(excluded.default_profile_id, projects.default_profile_id),
           context = COALESCE(excluded.context, projects.context),
           requested_posture = COALESCE(excluded.requested_posture, projects.requested_posture),
           archived_at = NULL`,
      )
      .run(
        id,
        input.name,
        input.workerId,
        input.defaultProfileId ?? null,
        input.context ?? null,
        input.requestedPosture ?? null,
        nowIso(),
      );
    return this.getProject(input.name);
  }

  /** Accepts an id or a name, so the MCP tools can take whichever is to hand. */
  getProject(idOrName: string): Project {
    const row = this.#db
      .prepare(`SELECT * FROM projects WHERE id = ? OR name = ?`)
      .get(idOrName, idOrName) as Row | undefined;
    if (!row) throw new NotFound(`no project ${idOrName}`);
    return mapProject(row);
  }

  listProjects(includeArchived = false): Project[] {
    const sql = includeArchived
      ? `SELECT * FROM projects ORDER BY name`
      : `SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name`;
    return (this.#db.prepare(sql).all() as Row[]).map(mapProject);
  }

  archiveProject(idOrName: string): Project {
    const project = this.getProject(idOrName);
    this.#db.prepare(`UPDATE projects SET archived_at = ? WHERE id = ?`).run(nowIso(), project.id);
    return this.getProject(project.id);
  }

  // --------------------------------------------------------------- sessions

  getSession(id: string): Session {
    const row = this.#db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw new NotFound(`no session ${id}`);
    return mapSession(row);
  }

  #setState(
    id: string,
    to: SessionState,
    extra: Record<string, string | number | null> = {},
  ): Session {
    const current = this.getSession(id);
    if (current.state === to) return current;
    if (!canTransition(current.state, to)) {
      throw new StateError(`session ${id} cannot go ${current.state} -> ${to}`);
    }
    const cols = Object.keys(extra);
    const sets = ["state = ?", "updated_at = ?", ...cols.map((c) => `${c} = ?`)];
    this.#db
      .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`)
      .run(to, nowIso(), ...cols.map((c) => extra[c] ?? null), id);
    return this.getSession(id);
  }

  createSession(input: {
    project: string;
    prompt: string;
    profileId?: string;
    title?: string;
  }): Session {
    const project = this.getProject(input.project);
    const profileId = input.profileId ?? project.defaultProfileId;
    if (!profileId) {
      throw new StateError(
        `project ${project.name} has no default profile; pass profileId explicitly`,
      );
    }
    const profile = this.getProfile(profileId);
    if (profile.workerId !== project.workerId) {
      throw new StateError(
        `profile ${profile.id} is on worker ${profile.workerId}, but project ${project.name} lives on ${project.workerId}`,
      );
    }
    const id = randomUUID();
    const now = nowIso();
    const session = this.#tx(() => {
      this.#db
        .prepare(
          `INSERT INTO sessions
             (id, project_id, profile_id, worker_id, title, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(id, project.id, profile.id, project.workerId, input.title ?? null, now, now);
      this.#appendMessage(id, "in", "prompt", input.prompt);
      return this.getSession(id);
    });
    this.#emit({ type: "queued", session, project });
    return session;
  }

  /** Re-queues an ended session so the agent resumes with further instructions. */
  resumeSession(id: string, prompt: string): Session {
    const before = this.getSession(id);
    if (before.state === "running" || before.state === "blocked") {
      throw new StateError(`session ${id} is ${before.state}; use reply instead`);
    }
    const session = this.#tx(() => {
      this.#appendMessage(id, "in", "prompt", prompt);
      return this.#setState(id, "queued", {
        claimed_at: null,
        started_at: null,
        ended_at: null,
        exit_code: null,
      });
    });
    this.#emit({ type: "queued", session, project: this.getProject(session.projectId) });
    return session;
  }

  /**
   * Atomically hands this worker every session queued for it. A claim moves the
   * session to running; the runner confirms with markStarted once the process is
   * actually up, and requeueStaleClaims recovers a claim that never started.
   */
  claimWork(workerId: string, limit = 5): WorkItem[] {
    return this.#tx(() => {
      const rows = this.#db
        .prepare(
          `SELECT * FROM sessions
            WHERE worker_id = ? AND state = 'queued'
            ORDER BY created_at LIMIT ?`,
        )
        .all(workerId, limit) as Row[];
      const items: WorkItem[] = [];
      for (const row of rows) {
        const session = mapSession(row);
        const prompt = this.#db
          .prepare(
            `SELECT * FROM messages
              WHERE session_id = ? AND kind = 'prompt' AND delivered_at IS NULL
              ORDER BY id LIMIT 1`,
          )
          .get(session.id) as Row | undefined;
        if (!prompt) continue;
        this.#db
          .prepare(`UPDATE messages SET delivered_at = ? WHERE id = ?`)
          .run(nowIso(), Number(prompt.id));
        // started_at is per-run, so clearing it here keeps "claimed but never
        // started" detectable even on a session that has run before.
        const claimed = this.#setState(session.id, "running", {
          claimed_at: nowIso(),
          started_at: null,
        });
        items.push({
          session: claimed,
          project: this.getProject(claimed.projectId),
          profile: this.getProfile(claimed.profileId),
          prompt: str(prompt.body),
          resume: claimed.runCount > 0,
        });
      }
      return items;
    });
  }

  markStarted(id: string): Session {
    const now = nowIso();
    this.#db
      .prepare(
        `UPDATE sessions SET started_at = ?, run_count = run_count + 1, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, id);
    return this.getSession(id);
  }

  /** Puts a claim that never started back on the queue. */
  requeueStaleClaims(olderThanMs: number): string[] {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = this.#db
      .prepare(
        `SELECT id FROM sessions
          WHERE state = 'running' AND started_at IS NULL AND claimed_at < ?`,
      )
      .all(cutoff) as Row[];
    const ids: string[] = [];
    for (const row of rows) {
      const id = str(row.id);
      this.#tx(() => {
        this.#db
          .prepare(
            `UPDATE messages SET delivered_at = NULL
              WHERE id = (SELECT MAX(id) FROM messages
                           WHERE session_id = ? AND kind = 'prompt')`,
          )
          .run(id);
        this.#setState(id, "queued", { claimed_at: null });
      });
      ids.push(id);
    }
    return ids;
  }

  appendOutput(id: string, body: string, kind: MessageKind = "output"): Message {
    const session = this.getSession(id);
    if (session.state === "finished" || session.state === "cancelled") {
      throw new StateError(`session ${id} is ${session.state}; it accepts no more output`);
    }
    return this.#appendMessage(id, "out", kind, body);
  }

  /**
   * The agent wants something from the operator -- an approval or a
   * clarification. The session parks until answered. Returns the message so the
   * caller can poll for its answer.
   */
  ask(input: {
    sessionId: string;
    kind: "approval_request" | "question";
    body: string;
    payload?: unknown;
  }): Message {
    const result = this.#tx(() => {
      const message = this.#appendMessage(
        input.sessionId,
        "out",
        input.kind,
        input.body,
        input.payload,
      );
      return { message, session: this.#setState(input.sessionId, "blocked") };
    });
    this.#emit({
      type: "blocked",
      session: result.session,
      project: this.getProject(result.session.projectId),
      message: result.message,
    });
    return result.message;
  }

  /** The operator's answer. Resolves the open ask and unparks the session. */
  reply(input: {
    sessionId: string;
    body: string;
    kind?: "answer" | "decision";
    payload?: unknown;
  }): Message {
    const result = this.#tx(() => {
      const open = this.#openAsk(input.sessionId);
      const answer = this.#appendMessage(
        input.sessionId,
        "in",
        input.kind ?? (open?.kind === "approval_request" ? "decision" : "answer"),
        input.body,
        input.payload,
      );
      if (open) {
        this.#db
          .prepare(`UPDATE messages SET answered_by = ? WHERE id = ?`)
          .run(answer.id, open.id);
      }
      if (this.getSession(input.sessionId).state === "blocked") {
        this.#setState(input.sessionId, "running");
      }
      return { answer, session: this.getSession(input.sessionId) };
    });
    this.#emit({
      type: "answered",
      session: result.session,
      project: this.getProject(result.session.projectId),
      message: result.answer,
    });
    return result.answer;
  }

  #openAsk(sessionId: string): Message | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM messages
          WHERE session_id = ? AND direction = 'out' AND answered_by IS NULL
            AND kind IN ('approval_request','question')
          ORDER BY id LIMIT 1`,
      )
      .get(sessionId) as Row | undefined;
    return row ? mapMessage(row) : null;
  }

  /** The oldest unanswered ask on a session, if any. */
  openAsk(sessionId: string): Message | null {
    return this.#openAsk(sessionId);
  }

  /** The answer to a specific ask, once it exists. Used by the approval shim. */
  answerTo(messageId: number): Message | null {
    const ask = this.#db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId) as
      | Row
      | undefined;
    if (!ask) throw new NotFound(`no message ${messageId}`);
    const answeredBy = numOrNull(ask.answered_by);
    if (answeredBy === null) return null;
    const row = this.#db.prepare(`SELECT * FROM messages WHERE id = ?`).get(answeredBy) as
      | Row
      | undefined;
    return row ? mapMessage(row) : null;
  }

  /** Undelivered operator messages, for a runner that can feed them to stdin. */
  takeInbound(sessionId: string): Message[] {
    return this.#tx(() => {
      const rows = this.#db
        .prepare(
          `SELECT * FROM messages
            WHERE session_id = ? AND direction = 'in' AND delivered_at IS NULL
            ORDER BY id`,
        )
        .all(sessionId) as Row[];
      const now = nowIso();
      for (const row of rows) {
        this.#db
          .prepare(`UPDATE messages SET delivered_at = ? WHERE id = ?`)
          .run(now, Number(row.id));
      }
      return rows.map(mapMessage);
    });
  }

  /** The agent process is gone. The exit code decides finished or failed. */
  finishSession(id: string, exitCode: number): Session {
    const session = this.#setState(id, exitCode === 0 ? "finished" : "failed", {
      exit_code: exitCode,
      ended_at: nowIso(),
    });
    this.#emit({
      type: exitCode === 0 ? "finished" : "failed",
      session,
      project: this.getProject(session.projectId),
    });
    return session;
  }

  cancelSession(id: string): Session {
    return this.#setState(id, "cancelled", { ended_at: nowIso() });
  }

  listSessions(
    filter: {
      state?: SessionState;
      project?: string;
      unseen?: boolean;
      limit?: number;
    } = {},
  ): Session[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.state) {
      where.push("state = ?");
      args.push(filter.state);
    }
    if (filter.project) {
      where.push("project_id = ?");
      args.push(this.getProject(filter.project).id);
    }
    if (filter.unseen) where.push("seen_at IS NULL");
    args.push(filter.limit ?? 50);
    const sql = `SELECT * FROM sessions
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY updated_at DESC LIMIT ?`;
    return (this.#db.prepare(sql).all(...args) as Row[]).map(mapSession);
  }

  messages(sessionId: string, sinceId = 0): Message[] {
    const rows = this.#db
      .prepare(`SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY id`)
      .all(sessionId, sinceId) as Row[];
    return rows.map(mapMessage);
  }

  /** Marks sessions read. Purely the operator's inbox; no effect on any worker. */
  acknowledge(ids: string[]): number {
    const now = nowIso();
    let n = 0;
    for (const id of ids) {
      const res = this.#db
        .prepare(`UPDATE sessions SET seen_at = ? WHERE id = ? AND seen_at IS NULL`)
        .run(now, id);
      n += Number(res.changes);
    }
    return n;
  }

  /**
   * Sessions this worker was told to stop. The runner intersects these with
   * what it actually has live, so the server needs no idea what is running
   * where.
   */
  cancelledFor(workerId: string, withinMs = 3_600_000): string[] {
    const cutoff = new Date(Date.now() - withinMs).toISOString();
    const rows = this.#db
      .prepare(
        `SELECT id FROM sessions
          WHERE worker_id = ? AND state = 'cancelled' AND updated_at > ?`,
      )
      .all(workerId, cutoff) as Row[];
    return rows.map((r) => str(r.id));
  }

  /** Sessions still blocked, for the reminder sweep. */
  blockedSince(olderThanMs: number): Session[] {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = this.#db
      .prepare(`SELECT * FROM sessions WHERE state = 'blocked' AND updated_at < ?`)
      .all(cutoff) as Row[];
    return rows.map(mapSession);
  }

  #appendMessage(
    sessionId: string,
    direction: "out" | "in",
    kind: MessageKind,
    body: string,
    payload?: unknown,
  ): Message {
    const res = this.#db
      .prepare(
        `INSERT INTO messages (session_id, direction, kind, body, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        direction,
        kind,
        body,
        payload === undefined ? null : JSON.stringify(payload),
        nowIso(),
      );
    const row = this.#db
      .prepare(`SELECT * FROM messages WHERE id = ?`)
      .get(Number(res.lastInsertRowid)) as Row;
    return mapMessage(row);
  }
}
