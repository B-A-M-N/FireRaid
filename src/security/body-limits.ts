/**
 * P1-8: bounded JSON body reader.
 *
 * A public endpoint must not deserialize an arbitrarily large attack payload
 * and only afterward decide the validated object is too large. This reader:
 *   1. Checks Content-Length when present (early reject).
 *   2. Reads the body and counts actual streamed bytes (Content-Length is not
 *      authoritative — an attacker can send a larger body).
 *   3. Rejects once the limit is crossed.
 *   4. Parses JSON only from the bounded buffer.
 *
 * Used on Worker telemetry, host telemetry, and host submit.
 */

export type BoundedReadResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: "OVERSIZE" | "BAD_JSON" | "MISSING" };

/**
 * Read + parse a JSON body with a hard byte limit.
 * @param req        the incoming Request
 * @param maxBytes   maximum allowed decoded byte length
 * @returns parsed object on null on rejection (check `reason`)
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > maxBytes) return null;

  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }

  const byteLength = new TextEncoder().encode(text).length;
  if (byteLength > maxBytes) return null;

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}
