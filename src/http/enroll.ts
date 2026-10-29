import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import type { Store } from "../core/store.ts";
import { StateError } from "../core/types.ts";
import { sameSecret } from "../core/web.ts";

/**
 * Machine enrollment, at POST /v1/enroll.
 *
 * Registering a worker used to mean running the CLI on the server, reading a
 * token off the screen and carrying it to the other machine by hand. This lets
 * the machine ask for itself: the wizard gathers everything locally, submits
 * once, and writes the token straight into its own config. The token never
 * appears on a screen or passes through a person.
 *
 * It is authenticated with the login password, which already grants full
 * control through MCP -- so this adds no authority that password did not
 * already carry. It is rate limited exactly as the consent screen is, because
 * it is the same password and the same stake.
 */

export interface EnrollApp {
  app: Express;
  owns: (path: string) => boolean;
}

const PATH = "/v1/enroll";

export function createEnrollApp(opts: { store: Store; password: string }): EnrollApp {
  const { store, password } = opts;
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Wait a few minutes and try again." },
  });

  app.post(PATH, limiter, express.json({ limit: "256kb" }), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const given = typeof body.password === "string" ? body.password : "";

    if (given === "" || !sameSecret(given, password)) {
      res.status(401).json({ error: "wrong password" });
      return;
    }

    // A password check and nothing else, so the wizard can fail in the first
    // ten seconds instead of after a dozen questions. It creates nothing, and
    // it is behind the same rate limiter as a real attempt.
    if (body.check === true) {
      res.status(200).json({ ok: true });
      return;
    }

    const worker = (body.worker ?? {}) as Record<string, unknown>;
    const name = typeof worker.name === "string" ? worker.name.trim() : "";
    if (name === "") {
      res.status(400).json({ error: "worker.name is required" });
      return;
    }

    try {
      const result = store.enroll({
        name,
        platform: typeof worker.platform === "string" ? worker.platform : undefined,
        replace: body.replace === true,
        // Only names and a posture. A command, an environment or a path sent
        // here would be ignored anyway -- the machine holds all of that -- but
        // there is no field to send it in, which is better than ignoring it.
        profiles: (Array.isArray(body.profiles) ? body.profiles : []).map((raw) => ({
          label: String(((raw ?? {}) as Record<string, unknown>).label ?? ""),
        })),
        projects: (Array.isArray(body.projects) ? body.projects : []).map((raw) => {
          const p = (raw ?? {}) as Record<string, unknown>;
          return {
            name: String(p.name ?? ""),
            profileLabel: typeof p.profileLabel === "string" ? p.profileLabel : null,
            context: typeof p.context === "string" ? p.context : null,
            posture: (typeof p.posture === "string" ? p.posture : null) as never,
          };
        }),
      });

      res.status(201).json({
        workerId: result.worker.id,
        token: result.token,
        platform: result.worker.platform,
        profileIds: result.profileIds,
        projects: result.projectNames,
      });
    } catch (err) {
      // A bad posture, a duplicate machine, a project naming a profile that is
      // not there: all of these are the caller's mistake and all of them have a
      // message worth reading, so send it rather than a bare 500.
      if (err instanceof StateError) {
        res.status(409).json({ error: err.message });
        return;
      }
      console.error("[enroll] failed:", err);
      res.status(500).json({ error: "enrollment failed" });
    }
  });

  return { app, owns: (path: string) => path === PATH };
}
