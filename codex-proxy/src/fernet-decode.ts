// Fernet token structural decoder. Does NOT decrypt — that requires the 32-byte
// server-held key. But the version byte, timestamp, IV, ciphertext length, and
// HMAC tag are all readable from the public token bytes.
//
// Fernet v1 token layout (after urlsafe-b64 decode):
//   1 byte:  version (must be 0x80)
//   8 bytes: timestamp (big-endian uint64, seconds since Unix epoch)
//  16 bytes: IV (initialization vector)
//   N bytes: ciphertext (multiple of 16, AES-128-CBC)
//  32 bytes: HMAC-SHA256 tag

export interface FernetStructure {
  totalBytes: number;
  version: number;
  timestamp: number;       // unix seconds
  iso: string;             // ISO timestamp
  ivHex: string;           // 32 hex chars (16 bytes)
  ciphertextBytes: number;
  ciphertextBlocks: number;
  hmacHex: string;         // 64 hex chars (32 bytes)
}

export class FernetDecodeError extends Error {
  constructor(message: string) { super(message); }
}

const MIN_TOKEN_BYTES = 1 + 8 + 16 + 16 + 32; // version + ts + iv + at-least-1-block + hmac

function urlsafeB64Decode(s: string): Uint8Array {
  // Pad to multiple of 4
  const padded = s + "=".repeat((-s.length % 4 + 4) % 4);
  // Convert urlsafe to standard
  const standard = padded.replace(/-/g, "+").replace(/_/g, "/");
  const buf = Buffer.from(standard, "base64");
  return new Uint8Array(buf);
}

function readUint64BE(bytes: Uint8Array, offset: number): number {
  // Number is safe for ts up to 2^53 — Unix seconds fit until year 285,000+
  let n = 0;
  for (let i = 0; i < 8; i += 1) {
    n = n * 256 + bytes[offset + i];
  }
  return n;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function decodeFernet(token: string): FernetStructure {
  if (typeof token !== "string" || token.length === 0) {
    throw new FernetDecodeError("empty token");
  }
  if (!token.startsWith("g")) {
    throw new FernetDecodeError(`expected token to start with 'g' (Fernet v1), got '${token[0]}'`);
  }

  let raw: Uint8Array;
  try {
    raw = urlsafeB64Decode(token);
  } catch (e) {
    throw new FernetDecodeError(`base64 decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (raw.length < MIN_TOKEN_BYTES) {
    throw new FernetDecodeError(`token too short (${raw.length} bytes, minimum ${MIN_TOKEN_BYTES})`);
  }

  const version = raw[0];
  const timestamp = readUint64BE(raw, 1);
  const iv = raw.slice(9, 25);
  const hmac = raw.slice(raw.length - 32);
  const ct = raw.slice(25, raw.length - 32);

  if (ct.length === 0) {
    throw new FernetDecodeError("ciphertext is empty");
  }
  if (ct.length % 16 !== 0) {
    throw new FernetDecodeError(`ciphertext length ${ct.length} is not a multiple of 16 (AES block size)`);
  }

  return {
    totalBytes: raw.length,
    version,
    timestamp,
    iso: new Date(timestamp * 1000).toISOString(),
    ivHex: toHex(iv),
    ciphertextBytes: ct.length,
    ciphertextBlocks: ct.length / 16,
    hmacHex: toHex(hmac),
  };
}

export interface FernetCorpusStats {
  count: number;
  decodeErrors: number;
  versions: Record<number, number>;
  uniqueIvs: number;
  duplicateIvs: number;
  timestampRange: { min: number; max: number; spanSec: number } | null;
  ciphertext: { min: number; median: number; max: number } | null;
  decoded: FernetStructure[];
}

export function analyzeFernetCorpus(tokens: string[]): FernetCorpusStats {
  const decoded: FernetStructure[] = [];
  let decodeErrors = 0;
  for (const t of tokens) {
    try { decoded.push(decodeFernet(t)); }
    catch { decodeErrors += 1; }
  }

  const versions: Record<number, number> = {};
  const ivSet = new Set<string>();
  let dupIv = 0;
  for (const d of decoded) {
    versions[d.version] = (versions[d.version] || 0) + 1;
    if (ivSet.has(d.ivHex)) dupIv += 1;
    ivSet.add(d.ivHex);
  }

  const timestamps = decoded.map((d) => d.timestamp).filter((t) => t > 0);
  const ctLens = decoded.map((d) => d.ciphertextBytes).sort((a, b) => a - b);

  return {
    count: decoded.length,
    decodeErrors,
    versions,
    uniqueIvs: ivSet.size,
    duplicateIvs: dupIv,
    timestampRange: timestamps.length > 0
      ? { min: Math.min(...timestamps), max: Math.max(...timestamps), spanSec: Math.max(...timestamps) - Math.min(...timestamps) }
      : null,
    ciphertext: ctLens.length > 0
      ? { min: ctLens[0], median: ctLens[Math.floor(ctLens.length / 2)], max: ctLens[ctLens.length - 1] }
      : null,
    decoded,
  };
}
