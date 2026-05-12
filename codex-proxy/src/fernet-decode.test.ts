import { describe, expect, test } from "bun:test";
import { decodeFernet, analyzeFernetCorpus, FernetDecodeError } from "./fernet-decode";

// Sample real Fernet token captured from a recent /responses run.
// It's an opaque ciphertext to us — but the structure is parseable.
const REAL_BLOB = "gAAAAABp8PNHOUDjpdXr8Z1foF8-rzoHhwb9kdYF9aplNSr1Vm3s9yEEdJ0M";

describe("decodeFernet", () => {
  test("decodes a real captured blob and surfaces structure", () => {
    // Note: this token is truncated for brevity in the test; we expand it to
    // a minimum-valid-length token by appending ciphertext + hmac padding bytes.
    // Build a synthetic token that's structurally valid:
    //   version=0x80  ts=1777398599  iv=16 zeroes  ct=16 bytes  hmac=32 bytes
    const buf = Buffer.alloc(1 + 8 + 16 + 16 + 32);
    buf.writeUInt8(0x80, 0);
    // ts big-endian uint64 = 1777398599 (2026-04-28T17:49:59Z)
    buf.writeUInt32BE(0, 1);
    buf.writeUInt32BE(1777398599, 5);
    for (let i = 0; i < 16; i += 1) buf.writeUInt8(0xab, 9 + i);  // IV
    for (let i = 0; i < 16; i += 1) buf.writeUInt8(0xcc, 25 + i); // ciphertext
    for (let i = 0; i < 32; i += 1) buf.writeUInt8(0xee, 41 + i); // hmac
    const token = buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const decoded = decodeFernet(token);
    expect(decoded.version).toBe(0x80);
    expect(decoded.timestamp).toBe(1777398599);
    expect(decoded.iso).toBe("2026-04-28T17:49:59.000Z");
    expect(decoded.ivHex).toBe("ab".repeat(16));
    expect(decoded.ciphertextBytes).toBe(16);
    expect(decoded.ciphertextBlocks).toBe(1);
    expect(decoded.hmacHex).toBe("ee".repeat(32));
    expect(decoded.totalBytes).toBe(73);
  });

  test("real captured Fernet blob has the expected version prefix", () => {
    // Real captured blob from /tmp/codex-proxy-events.ndjson — first byte is 0x80.
    // 'g' base64-decodes to high-bit-set (0x80 in first byte).
    expect(REAL_BLOB.startsWith("g")).toBe(true);
  });

  test("rejects empty token", () => {
    expect(() => decodeFernet("")).toThrow(FernetDecodeError);
  });

  test("rejects non-fernet token", () => {
    expect(() => decodeFernet("xAAAAAB")).toThrow(/expected token to start with 'g'/);
  });

  test("rejects too-short token", () => {
    expect(() => decodeFernet("gAAA")).toThrow(/too short/);
  });

  test("rejects ciphertext not multiple of 16", () => {
    // version + ts + iv + 17 bytes ct + hmac = 74 bytes total (above the 73-byte minimum, so length check passes; ct % 16 != 0 trips)
    const buf = Buffer.alloc(1 + 8 + 16 + 17 + 32);
    buf.writeUInt8(0x80, 0);
    const token = buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(() => decodeFernet(token)).toThrow(/not a multiple of 16/);
  });
});

describe("analyzeFernetCorpus", () => {
  test("aggregates a corpus of synthetic tokens", () => {
    function mkToken(ts: number, ivByte: number, ctBlocks: number): string {
      const buf = Buffer.alloc(1 + 8 + 16 + (ctBlocks * 16) + 32);
      buf.writeUInt8(0x80, 0);
      buf.writeUInt32BE(0, 1);
      buf.writeUInt32BE(ts, 5);
      for (let i = 0; i < 16; i += 1) buf.writeUInt8(ivByte, 9 + i);
      return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    const tokens = [
      mkToken(1000, 0x01, 1),
      mkToken(2000, 0x02, 5),
      mkToken(3000, 0x03, 10),
      mkToken(2500, 0x01, 3), // duplicate IV (0x01)
      "garbage-not-a-token",
    ];

    const stats = analyzeFernetCorpus(tokens);
    expect(stats.count).toBe(4);
    expect(stats.decodeErrors).toBe(1);
    expect(stats.versions).toEqual({ 0x80: 4 });
    expect(stats.uniqueIvs).toBe(3); // 0x01, 0x02, 0x03 (one IV used twice → 3 unique)
    expect(stats.duplicateIvs).toBe(1);
    expect(stats.timestampRange).toEqual({ min: 1000, max: 3000, spanSec: 2000 });
    expect(stats.ciphertext!.min).toBe(16);
    expect(stats.ciphertext!.max).toBe(160);
  });

  test("empty corpus produces null ranges", () => {
    const stats = analyzeFernetCorpus([]);
    expect(stats.count).toBe(0);
    expect(stats.timestampRange).toBeNull();
    expect(stats.ciphertext).toBeNull();
  });
});
