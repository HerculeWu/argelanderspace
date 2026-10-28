/**
 * The page's side of the external requests queue (release-0.2 ticket 04; contracts `external-requests.ts`):
 *
 * - `GET  /api/external-requests` -> `{ requests }`, the queue in arrival order;
 * - `POST /api/external-requests/:id/decision` `{ decision: "approve" | "deny" }` -> `200 { state: "approved", result }`
 *   (after the operation finished; `result` is its own result object) or `200 { state: "denied" }`; `404 gone`; `409
 *   withdrawn` (the CLI left: it can never be approved) or `409 not_first` (only the first of the queue is decided);
 * - `POST /api/external-requests/:id/dismiss` -> the user closes a withdrawn card.
 *
 * Only a browser page decides: the CLI holds a token for the operation route but a decision must come from a page, so a
 * decision without an `Origin` header (curl, a script) is refused. That is not a defence against a process that forges
 * the header on the same machine - the same account can read the user's files and kill the workbench - it keeps an
 * agent that simply has the token and a shell from approving its own card by accident of a shortcut.
 */
import {
  EXTERNAL_REQUESTS_PATH,
  ExternalRequestDecisionSchema,
  type ExternalRequestList,
} from "@argelanderspace/contracts";
import type { ExternalRequestQueue } from "./external-requests.js";
import type { ProtectedRoutes } from "./protected-app.js";

export function mountExternalRequestRoutes(
  app: ProtectedRoutes,
  queue: ExternalRequestQueue
): void {
  const browserOnly = (headers: { header(name: string): string | undefined }) =>
    (headers.header("origin") ?? "") !== "";
  const refuse = (c: { json: (body: object, status: 403) => Response }) =>
    c.json({ code: "browser_only", detail: "a decision comes from the workbench page" }, 403);

  app.get(EXTERNAL_REQUESTS_PATH, { noStore: true }, (c) =>
    c.json({ requests: queue.list() } satisfies ExternalRequestList)
  );

  app.post(`${EXTERNAL_REQUESTS_PATH}/:id/decision`, { noStore: true }, async (c) => {
    if (!browserOnly(c.req)) return refuse(c);
    const body = ExternalRequestDecisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ code: "invalid_input" }, 400);
    const outcome = await queue.decide(c.req.param("id"), body.data.decision);
    switch (outcome.kind) {
      case "gone":
        return c.json({ code: "gone", detail: "no such request" }, 404);
      case "withdrawn":
        return c.json(
          { code: "withdrawn", detail: "the command line left; nothing was done" },
          409
        );
      case "not_first":
        return c.json({ code: "not_first", detail: "an earlier request is decided first" }, 409);
      case "decided":
        return c.json(
          outcome.decision === "approve"
            ? { state: "approved", result: outcome.result }
            : { state: "denied" }
        );
    }
  });

  app.post(`${EXTERNAL_REQUESTS_PATH}/:id/dismiss`, { noStore: true }, (c) => {
    if (!browserOnly(c.req)) return refuse(c);
    return queue.dismiss(c.req.param("id"))
      ? c.json({ ok: true })
      : c.json({ code: "gone", detail: "no such withdrawn request" }, 404);
  });
}
