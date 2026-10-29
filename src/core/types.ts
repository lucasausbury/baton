export type SessionState =
  | "queued"
  | "running"
  | "blocked"
  | "finished"
  | "failed"
  | "cancelled";

export type MessageDirection = "out" | "in";

export type MessageKind =
  | "prompt"
  | "output"
  | "question"
  | "approval_request"
  | "answer"
  | "decision"
  | "result"
  | "error"
  | "note";

/**
 * Allowed state transitions. State is set from facts the runner reports about
 * the agent process, never inferred from message content -- a final "all done"
 * message is just output, and blocks nothing.
 */
export const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  queued: ["running", "cancelled"],
  // running -> queued is un-claiming: a runner took the session but never got
  // the process up. Only requeueStaleClaims does this, and only for a claim
  // with no started_at; the table cannot express that condition, so the guard
  // lives in that query.
  running: ["blocked", "finished", "failed", "cancelled", "queued"],
  blocked: ["running", "finished", "failed", "cancelled"],
  finished: ["queued"],
  failed: ["queued"],
  cancelled: ["queued"],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface Worker {
  id: string;
  name: string;
  platform: string | null;
  lastSeenAt: string | null;
  /** What this machine last said it has. Display only; never used to launch. */
  inventory: WorkerInventory | null;
  inventoryAt: string | null;
  createdAt: string;
}

/**
 * A profile names an account on a machine, and nothing more.
 *
 * What it actually runs -- the binary, its arguments, its environment, which
 * credential it uses -- lives in that machine's own runner config, keyed by
 * slug(label). The server deliberately cannot see or set any of it: a server
 * that could name an executable and its environment would be a server that
 * could run anything it liked on every machine enrolled with it.
 */
export interface Profile {
  id: string;
  workerId: string;
  label: string;
  createdAt: string;
}

/**
 * How much a project's agents may do without asking, least to most autonomous.
 *
 * The server stores a *request*; the worker holds the ceiling and takes the
 * stricter of the two. An enum rather than tool patterns, so there is nothing
 * for a compromised server to inject -- "--allowedTools Bash" would have been a
 * shell for the asking.
 */
export const POSTURES = ["ask", "edits", "trusted"] as const;

export type Posture = (typeof POSTURES)[number];

/**
 * Like a profile, a project is a name the worker resolves locally. Its path on
 * disk is in that machine's runner config, not here, so the server cannot
 * repoint a project at someone's home directory and ask for a summary of it.
 *
 * reportedPath and reportedPosture are what the worker last said about itself.
 * They exist to be displayed and are never used to launch anything.
 */
export interface Project {
  id: string;
  name: string;
  workerId: string;
  defaultProfileId: string | null;
  context: string | null;
  /** The most autonomy the operator asks for. The worker may grant less. */
  requestedPosture: Posture | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface Session {
  id: string;
  projectId: string;
  profileId: string;
  workerId: string;
  title: string | null;
  state: SessionState;
  exitCode: number | null;
  runCount: number;
  claimedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  seenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: number;
  sessionId: string;
  direction: MessageDirection;
  kind: MessageKind;
  body: string;
  payload: unknown;
  answeredBy: number | null;
  deliveredAt: string | null;
  createdAt: string;
}

/**
 * What the server can tell a runner about a session.
 *
 * Note what is absent: no command, no environment, no path, no tool patterns.
 * The runner resolves all of that from its own config by project id and
 * profile label, and refuses the session if it cannot.
 */
export interface WorkItem {
  session: Session;
  project: Project;
  profile: Profile;
  /** The prompt for this run: the newest undelivered prompt message. */
  prompt: string;
  /** False on the first run, true when the agent should be resumed. */
  resume: boolean;
}

/** What a worker reports about itself, for display only. */
export interface WorkerInventory {
  projects: { id: string; path: string; profile: string; posture: Posture; contained: boolean }[];
  profiles: { label: string; credential: string | null }[];
}

export class StateError extends Error {}
export class NotFound extends Error {}
