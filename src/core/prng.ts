/**
 * FR-INV-002: Deterministic profile engine.
 *
 * seed = HMAC-SHA256(profile_secret, profile_version || ":" || session_id)
 * Then expand seed via HKDF-like byte stream to drive deterministic selections.
 * FIX: 32-bit counter to prevent wrap (FR-038).
 * FIX: Handle 32-bit mask edge case in nextInt (FR-039).
 */

const enc = new TextEncoder();

export async function deriveSeed(
  secret: string,
  version: number,
  sessionId: string
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const data = enc.encode(`${version}:${sessionId}`);
  return crypto.subtle.sign("HMAC", key, data);
}

/** Deterministic byte stream from seed — HKDF-expand style generator. */
export class SeedStream {
  private counter = 0;
  private buffer: Uint8Array = new Uint8Array(0);
  private bufPos = 0;

  constructor(private readonly seed: ArrayBuffer) {}

  private async fill(): Promise<void> {
    // FIX: Use 4-byte big-endian counter to prevent wrap at 256
    const info = new Uint8Array(4);
    new DataView(info.buffer).setUint32(0, this.counter++, false);
    const seedBytes = new Uint8Array(this.seed);
    const key = await crypto.subtle.importKey(
      "raw",
      this.seed,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const buf = new Uint8Array(info.byteLength + seedBytes.byteLength);
    buf.set(info, 0);
    buf.set(seedBytes, info.byteLength);
    const sig = await crypto.subtle.sign("HMAC", key, buf);
    this.buffer = new Uint8Array(sig);
    this.bufPos = 0;
  }

  async nextByte(): Promise<number> {
    if (this.bufPos >= this.buffer.byteLength) await this.fill();
    return this.buffer[this.bufPos++];
  }

  async nextBytes(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = await this.nextByte();
    return out;
  }

  /** Uniform integer in [0, n). Rejection sampling avoids modulo bias. */
  async nextInt(n: number): Promise<number> {
    if (n <= 0 || n > 0x100000000) throw new Error(`invalid range: ${n}`);
    const bits = 32 - Math.clz32(n - 1);
    const bytesNeeded = Math.ceil(bits / 8);
    for (;;) {
      const b = await this.nextBytes(bytesNeeded);
      // FIX FR-R6-045: accumulate with unsigned arithmetic, not bitwise
      // shifts — `val << 8` is signed 32-bit, so a 4-byte value with the high
      // bit set went negative and `val < n` could return a negative integer.
      // Max value here is 0xFFFFFFFF (well under 2^53), so Number math is exact.
      let val = 0;
      for (let i = 0; i < bytesNeeded; i++) val = val * 256 + b[i];
      if (val < n) return val;
    }
  }
}

const NONCE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export async function generateNonce(stream: SeedStream, length = 6): Promise<string> {
  let s = "";
  for (let i = 0; i < length; i++) {
    const idx = await stream.nextInt(NONCE_CHARS.length);
    s += NONCE_CHARS[idx];
  }
  return s;
}

export async function generateToken(stream: SeedStream, length = 12): Promise<string> {
  const bytes = await stream.nextBytes(length);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sampling without replacement — returns `count` unique indices into `items`. */
export async function sampleWithoutReplacement<T>(
  stream: SeedStream,
  items: readonly T[],
  count: number
): Promise<T[]> {
  if (count > items.length) throw new Error("sample count exceeds population");
  const indices = Array.from({ length: items.length }, (_, i) => i);
  const result: T[] = [];
  for (let i = 0; i < count; i++) {
    const j = await stream.nextInt(indices.length);
    result.push(items[indices[j]]);
    indices.splice(j, 1);
  }
  return result;
}
