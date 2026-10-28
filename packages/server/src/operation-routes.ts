/**
 * The workbench's operation route (ADR 0015 "single writer"; release-0.2 ticket 02; `docs/operation-catalog.md`
 * "Running workbench"): one HTTP entrance through which a CLI process hands a cataloged operation to the running
 * server, which runs it with the server's own runtime - the same `runCatalogOperation` and the same `LibraryOpDeps`
 * (library lock, `library.changed` broadcast) the Copilot tool uses.
 *
 * Access: a request must carry the run's token (`Authorization: Bearer`, compared in constant time) and come from this
 * machine's loopback. Nothing else is answered - no token, a wrong token, or a non-loopback peer is `401` with the
 * same body, and nothing is run. The token is never logged: requests are recorded by route pattern only.
 *
 * Protocol (the CLI side is `runOnWorkbench`):
 * - `GET /api/operations/handshake` -> `200 { ok: true, pid }`. Proves the token and the process behind the port.
 * - `POST /api/operations/run` with `{ id, params, client? }` ->
 *     `200` the operation's own result object, verbatim (including `ok: false` answers - those are answers);
 *     `400 { ok: false, status: "unsupported", detail }` unknown id, malformed body or invalid params (not run);
 *     `401 { ok: false, status: "unauthorized" }`;
 *     `500 { ok: false, status: "error", detail }` the handler threw (the operation may or may not have run).
 *   The response is held until the operation finishes. A confirmation operation (ticket 04) does not answer until its
 *   card is decided: the request's `signal` aborts when the CLI leaves, which withdraws the card, and the workbench
 *   closing drops the connection, which the CLI reports as interrupted. `client` ({ pid, commandLine }) is what the
 *   card's source line shows. A navigation operation (05) is handed to the most recently active window by the route,
 *   without a protocol change.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  type ExternalRequestClient,
  ExternalRequestClientSchema,
} from "@argelanderspace/contracts";
import type { Context } from "hono";
import {
  findCatalogOperation,
  type OperationRuntime,
  parseOperationParams,
  runCatalogOperation,
} from "./operation-catalog.js";
import type { ProtectedRoutes } from "./protected-app.js";
import { WORKBENCH_HANDSHAKE_PATH, WORKBENCH_RUN_PATH } from "./workbench-instance.js";

export interface OperationRouteDeps {
  /** The run's one-time token; the route answers nothing to a request without it. */
  token: string;
  runtime: OperationRuntime;
  /** Default `process.pid`; tests pin it. */
  pid?: number;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The `client` the CLI reports, as far as it is well formed; a long command line is cut, a malformed one is dropped. */
function clientOf(raw: unknown): ExternalRequestClient | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { pid, commandLine } = raw as { pid?: unknown; commandLine?: unknown };
  const parsed = ExternalRequestClientSchema.safeParse({
    pid,
    commandLine: typeof commandLine === "string" ? commandLine.slice(0, 4000) : commandLine,
  });
  return parsed.success ? parsed.data : undefined;
}

const digest = (text: string): Buffer => createHash("sha256").update(text).digest();

export function mountOperationRoutes(app: ProtectedRoutes, deps: OperationRouteDeps): void {
  const expected = digest(deps.token);
  const pid = deps.pid ?? process.pid;

  const authorized = (c: Context): boolean => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (match === null || !timingSafeEqual(digest(match[1] as string), expected)) return false;
    // The peer address, when the server can tell (under `app.request` in tests it cannot).
    const peer = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
      ?.incoming?.socket?.remoteAddress;
    return peer === undefined || LOOPBACK.has(peer);
  };
  const unauthorized = (c: Context) => c.json({ ok: false, status: "unauthorized" }, 401, NO_STORE);
  const unsupported = (c: Context, detail: string) =>
    c.json({ ok: false, status: "unsupported", detail }, 400, NO_STORE);

  app.get(WORKBENCH_HANDSHAKE_PATH, { guard: true, noStore: true }, (c) =>
    authorized(c) ? c.json({ ok: true, pid }, 200, NO_STORE) : unauthorized(c)
  );

  app.post(WORKBENCH_RUN_PATH, { noStore: true }, async (c) => {
    if (!authorized(c)) return unauthorized(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return unsupported(c, "the request body is not valid JSON");
    }
    const request = body as { id?: unknown; params?: unknown; client?: unknown } | null;
    if (typeof request !== "object" || request === null || typeof request.id !== "string")
      return unsupported(c, "the request needs an operation id");
    const op = findCatalogOperation(request.id);
    if (op === undefined) return unsupported(c, `unknown operation: ${request.id}`);
    const parsed = parseOperationParams(op, request.params ?? {});
    if (!parsed.ok) return unsupported(c, parsed.detail);
    try {
      const result = await runCatalogOperation(
        deps.runtime,
        op.id as Parameters<typeof runCatalogOperation>[1],
        parsed.params,
        // The request's signal aborts when the CLI leaves; a confirmation operation withdraws its card then.
        { client: clientOf(request.client), signal: c.req.raw.signal }
      );
      return c.json(result as object, 200, NO_STORE);
    } catch (e) {
      return c.json(
        { ok: false, status: "error", detail: e instanceof Error ? e.message : String(e) },
        500,
        NO_STORE
      );
    }
  });
}
