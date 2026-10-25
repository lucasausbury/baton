import { config } from "../config.ts";
import type { Store, StoreEvent } from "./store.ts";

interface Push {
  title: string;
  body: string;
  priority: "min" | "low" | "default" | "high" | "urgent";
  tags: string[];
  sessionId: string;
}

/**
 * Notification policy. MCP is pull-only -- the Claude app calls tools only
 * while someone is in a conversation -- so anything that needs a human has to
 * reach out of band. The response comes back through MCP; only the interrupt
 * comes through here.
 */
function pushFor(e: StoreEvent): Push | null {
  const where = `${e.project.name}${e.session.title ? `: ${e.session.title}` : ""}`;
  switch (e.type) {
    case "blocked":
      return {
        title: `Needs you - ${where}`,
        body: e.message?.body ?? "The agent is waiting on an answer.",
        priority: "high",
        tags: ["question"],
        sessionId: e.session.id,
      };
    case "failed":
      return {
        title: `Failed - ${where}`,
        body: `Exit code ${e.session.exitCode ?? "?"}.`,
        priority: "default",
        tags: ["x"],
        sessionId: e.session.id,
      };
    case "finished":
      return {
        title: `Done - ${where}`,
        body: "Finished cleanly.",
        priority: "low",
        tags: ["white_check_mark"],
        sessionId: e.session.id,
      };
    // Queueing and answering are things the operator just did. Telling them
    // about their own action is noise.
    case "queued":
    case "answered":
      return null;
  }
}

async function send(push: Push): Promise<void> {
  if (!config.ntfyTopic) {
    console.log(`[notify] ${push.title} - ${push.body}`);
    return;
  }
  const headers: Record<string, string> = {
    Title: push.title,
    Priority: push.priority,
    Tags: push.tags.join(","),
  };
  if (config.publicUrl) {
    headers.Click = `${config.publicUrl.replace(/\/$/, "")}/s/${push.sessionId}`;
  }
  try {
    const res = await fetch(`${config.ntfyUrl.replace(/\/$/, "")}/${config.ntfyTopic}`, {
      method: "POST",
      headers,
      body: push.body.slice(0, 3800),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`[notify] ntfy returned ${res.status}`);
  } catch (err) {
    // A missed notification must never take down a session.
    console.error("[notify] push failed:", err);
  }
}

/**
 * Wires notifications to the store and starts the reminder sweep. A session
 * that is still blocked is the only thing actually costing a stalled worker, so
 * it is the only thing that nags.
 */
export function attachNotifications(store: Store): () => void {
  const reminded = new Map<string, number>();

  store.onEvent((e) => {
    const push = pushFor(e);
    if (push) void send(push);
    if (e.type !== "blocked") reminded.delete(e.session.id);
  });

  const timer = setInterval(() => {
    for (const session of store.blockedSince(config.blockedReminderMs)) {
      const last = reminded.get(session.id) ?? 0;
      if (Date.now() - last < config.blockedReminderMs) continue;
      reminded.set(session.id, Date.now());
      const project = store.getProject(session.projectId);
      const ask = store.openAsk(session.id);
      void send({
        title: `Still waiting - ${project.name}`,
        body: ask?.body ?? "Blocked on an answer.",
        priority: "high",
        tags: ["hourglass"],
        sessionId: session.id,
      });
    }
  }, 60_000);
  timer.unref();

  return () => clearInterval(timer);
}
