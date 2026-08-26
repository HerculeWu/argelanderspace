/** Offline stub `fetch` for the infra tests: routes URL → Response, records calls. */

export interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyText?: string;
}

export type StubHandler = (call: StubCall) => Response | Promise<Response>;

/** Build a `fetch`-shaped stub. No call ever leaves the process. */
export function stubFetch(handler: StubHandler): {
  fetchImpl: typeof fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : ((input as { url?: string })?.url ?? String(input));
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h) {
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
      else for (const [k, v] of Object.entries(h)) headers[k] = v as string;
    }
    let bodyText: string | undefined;
    if (typeof init?.body === "string") bodyText = init.body;
    else if (init?.body instanceof Uint8Array) bodyText = `<${init.body.length} bytes>`;
    const call: StubCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      bodyText,
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** 200 JSON response. */
export function jsonResponse(
  data: unknown,
  init: { status?: number; url?: string } = {}
): Response {
  const res = new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
  if (init.url) Object.defineProperty(res, "url", { value: init.url });
  return res;
}

/** 200 binary response with an explicit (possibly lying) content-length. */
export function bytesResponse(
  bytes: Uint8Array,
  init: { status?: number; contentType?: string; contentLength?: number; url?: string } = {}
): Response {
  const headers = new Headers();
  headers.set("content-type", init.contentType ?? "application/octet-stream");
  if (init.contentLength !== undefined) headers.set("content-length", String(init.contentLength));
  const res = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    { status: init.status ?? 200, headers }
  );
  if (init.url) Object.defineProperty(res, "url", { value: init.url });
  return res;
}

/** 200 HTML/text response. */
export function textResponse(
  text: string,
  init: { status?: number; contentType?: string; url?: string } = {}
): Response {
  const res = new Response(text, {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "text/html; charset=UTF-8" },
  });
  if (init.url) Object.defineProperty(res, "url", { value: init.url });
  return res;
}
