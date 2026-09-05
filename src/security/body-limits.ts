/**
 * FR-P1-02: TRUE bounded streaming body readers.
 *
 * The previous reader checked Content-Length, then read the WHOLE body via
 * `req.text()`, and only then compared the decoded size to the limit. It
 * claimed "rejects once the limit is crossed" — it did not. A request with
 * no trustworthy Content-Length was fully buffered before any enforcement,
 * so FireRaid's declared application cap was not enforced where its
 * documentation said it was.
 *
 * These readers stream the request body:
 *   1. Early-reject on a Content-Length that already exceeds the limit.
 *   2. Read via `req.body.getReader()`, counting bytes AS THEY ARRIVE;
 *      the instant the running total crosses the limit the reader is
 *      cancelled (stops draining the socket) and OVERSIZE is returned.
 *   3. Only the bounded buffer is decoded (and, for JSON, parsed) afterward.
 *
 * Both the JSON reader (telemetry / API submits) and the urlencoded FORM
 * reader (browser form submits) share the SAME streaming core — neither
 * buffers the whole request before enforcing the cap.
 *
 * Results are TYPED — OVERSIZE, BAD_JSON, MISSING — rather than collapsed to
 * a bare `null`, so callers can classify an over-limit payload (413-style)
 * separately from malformed content and from an absent body. A missing body
 * on an endpoint that demands one is not "invalid JSON".
 */

export type BoundedReadResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: "OVERSIZE" | "BAD_JSON" | "MISSING" };

const textDecoder = new TextDecoder();

/**
 * Stream a request body up to `maxBytes`, returning a typed result.
 * Both JSON and urlencoded readers derive from this single bounded core.
 */
export async function readBoundedBody(req: Request, maxBytes: number): Promise<BoundedReadResult> {
  // 1. Early reject: a Content-Length already over the cap is a byte-count
  //    the stream can only confirm — no need to open the body.
  const contentLengthStr = req.headers.get("content-length");
  if (contentLengthStr && Number(contentLengthStr) > maxBytes) {
    return { ok: false, reason: "OVERSIZE" };
  }

  if (!req.body) return { ok: false, reason: "MISSING" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let text: string;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // FR-P1-02: the limit is crossed AS bytes arrive. Cancel stops the
        // read — we already consumed over the cap and must not buffer more.
        await reader.cancel();
        return { ok: false, reason: "OVERSIZE" };
      }
      chunks.push(value);
    }
    text = textDecoder.decode(concat(chunks));
  } catch {
    return { ok: false, reason: "MISSING" };
  }

  if (text.length === 0) return { ok: false, reason: "MISSING" };
  return { ok: true, data: text };
}

/**
 * Read + JSON-parse a request body with a hard byte limit.
 * @returns OVERSIZE (streamed past the cap), BAD_JSON (malformed JSON),
 *   MISSING (no/empty body), or ok with the parsed object.
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<
  Exclude<BoundedReadResult, { ok: true; data: unknown }> | { ok: true; data: Record<string, unknown> }
> {
  const read = await readBoundedBody(req, maxBytes);
  if (!read.ok) return read;
  try {
    return { ok: true, data: JSON.parse(String(read.data)) as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "BAD_JSON" };
  }
}

/** Concatenate the accumulated (bounded) byte chunks in order. */
function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let len = 0;
  for (const c of chunks) len += c.byteLength;
  const out = new Uint8Array(len);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}