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
  createdAt: string;
}

export interface Profile {
  id: string;
  workerId: string;
  label: string;
  command: string;
  /** Inserted immediately after the command, before any of our own flags. */
  launchArgs: string[];
  args: string[];
  env: Record<string, string>;
  credentialRef: string | null;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  workerId: string;
  path: string;
  defaultProfileId: string | null;
  context: string | null;
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

/** What a runner needs in order to spawn an agent. */
export interface WorkItem {
  session: Session;
  project: Project;
  profile: Profile;
  /** The prompt for this run: the newest undelivered prompt message. */
  prompt: string;
  /** False on the first run, true when the agent should be resumed. */
  resume: boolean;
}

export class StateError extends Error {}
export class NotFound extends Error {}
