import { timingSafeEqual } from "node:crypto";
import type { AppFetch } from "./startup-gate.js";

/** Prewarm modules without opening business stores or recovering native turns. */
export function createDeploymentGate(options: { standby: boolean; slot?: string; sha?: string; token?: string }) {
  let phase = options.standby ? "warming" : "starting";
  let activate: () => void = () => {};
  const activation = options.standby ? new Promise<void>(resolve => { activate = resolve; }) : Promise.resolve();
  return {
    activation,
    prepared() { if (options.standby) phase = "prepared"; },
    ready() { phase = "ready"; },
    wrap(fetch: AppFetch): AppFetch {
      return async (request, env) => {
        const url = new URL(request.url);
        if (url.pathname === "/__deployment") {
          if (!["127.0.0.1", "localhost"].includes(url.hostname)) return new Response(null, { status: 404 });
          if (request.method === "POST") {
            const token = request.headers.get("x-pi-boot-token") ?? "";
            const expected = options.token ?? "";
            const actualBytes = Buffer.from(token), expectedBytes = Buffer.from(expected);
            if (!expected || actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return new Response(null, { status: 403 });
            // Flush the acknowledgement before initialization resumes: resolving
            // activation in this microtask lets synchronous store opening block
            // the HTTP response and trip the supervisor's short request timeout.
            if (phase === "prepared") { phase = "starting"; setImmediate(activate); }
            else if (phase !== "starting" && phase !== "ready") return new Response(null, { status: 409 });
          } else if (request.method !== "GET") return new Response(null, { status: 405 });
          return Response.json({ phase, slot: options.slot, sha: options.sha, pid: process.pid }, { headers: { "cache-control": "no-store" } });
        }
        return fetch(request, env);
      };
    }
  };
}
