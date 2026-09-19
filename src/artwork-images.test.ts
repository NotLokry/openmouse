import assert from "node:assert/strict";
import test from "node:test";
import { parseArtworkImage, probeArtworkMetadata } from "../functions/api/_lib/images.js";
import {
  aiScreeningLabel,
  claimScreeningSlot,
  parseVerdict,
  recordArtworkRejection,
  screeningDecision,
  strictViolation,
} from "../functions/api/artwork.js";

class FakeKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

function verdictOf({ device = true, render = true, background = "white", nsfw = 0, hate = 0, gore = 0, unrelated = 0 } = {}) {
  return { device, render, background, issues: { nsfw, hate, gore }, unrelated };
}

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes[8] = 0;
  bytes[9] = 0;
  bytes[10] = 0;
  bytes[11] = 13;
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

function webpVp8lBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(25);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12); // VP8L
  bytes[20] = 0x2f;
  const bits = (width - 1) & 0x3fff | (((height - 1) & 0x3fff) << 14);
  bytes[21] = bits & 0xff;
  bytes[22] = (bits >>> 8) & 0xff;
  bytes[23] = (bits >>> 16) & 0xff;
  bytes[24] = (bits >>> 24) & 0xff;
  return bytes;
}

/** PNG with a valid IHDR (width 512, height 256) followed by extra chunks,
    each with its 4-byte CRC so the chunk walk finds them correctly. */
function pngWithChunks(extraTypes: string[], alpha = true): Uint8Array {
  const axes = alpha ? 6 : 2;
  const crc = [0, 0, 0, 0];
  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    new Uint8Array([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0, 0, 0, 1, 0, 8, axes, 0, 0, 0, ...crc]),
  ];
  for (const type of extraTypes) {
    parts.push(new Uint8Array([0, 0, 0, 5]));
    parts.push(new Uint8Array([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)]));
    parts.push(new Uint8Array([9, 9, 9, 9, 9]));
    parts.push(new Uint8Array(crc));
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** Minimal WebP container with an optional EXIF chunk appended after a
    zero-length VP8L chunk (so the riff chunk walk reaches the EXIF chunk). */
function webpWithExif(exif: boolean): Uint8Array {
  const parts = [
    new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    new Uint8Array([40, 0, 0, 0]),
    new Uint8Array([0x57, 0x45, 0x42, 0x50]),
    new Uint8Array([0x56, 0x50, 0x38, 0x4c]),
    new Uint8Array([0, 0, 0, 0]),
  ];
  if (exif) {
    parts.push(new Uint8Array([0x45, 0x58, 0x49, 0x46]));
    parts.push(new Uint8Array([20, 0, 0, 0]));
    parts.push(new Uint8Array(20));
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

test("parseArtworkImage reads PNG dimensions from the IHDR chunk", () => {
  const info = parseArtworkImage(pngBytes(512, 256));
  assert.deepEqual(info, { format: "png", width: 512, height: 256 });
});

test("parseArtworkImage reads WebP lossless dimensions", () => {
  const info = parseArtworkImage(webpVp8lBytes(40, 40));
  assert.deepEqual(info, { format: "webp", width: 40, height: 40 });
});

test("parseArtworkImage rejects non-image bytes", () => {
  assert.equal(parseArtworkImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);
  assert.equal(parseArtworkImage(new Uint8Array(0)), null);
});

test("parseArtworkImage rejects out-of-range dimensions", () => {
  assert.equal(parseArtworkImage(pngBytes(10, 10)), null);
  assert.equal(parseArtworkImage(pngBytes(90000, 100)), null);
  assert.equal(parseArtworkImage(pngBytes(9000, 9000)), null);
});

test("probeArtworkMetadata flags camera EXIF in a PNG", () => {
  assert.deepEqual(probeArtworkMetadata(pngWithChunks(["tEXt"], true)), { exif: false, alpha: true });
  assert.deepEqual(probeArtworkMetadata(pngWithChunks(["eXIf"], true)), { exif: true, alpha: true });
  assert.deepEqual(probeArtworkMetadata(pngWithChunks(["eXIf"], false)), { exif: true, alpha: false });
});

test("probeArtworkMetadata flags camera EXIF in a WebP and reads PNG alpha", () => {
  assert.deepEqual(probeArtworkMetadata(webpWithExif(false)), { exif: false, alpha: false });
  assert.deepEqual(probeArtworkMetadata(webpWithExif(true)), { exif: true, alpha: false });
  assert.deepEqual(probeArtworkMetadata(pngBytes(512, 256)), { exif: false, alpha: false });
  assert.deepEqual(probeArtworkMetadata(pngWithChunks([], true)), { exif: false, alpha: true });
});

test("parseVerdict extracts scores from a bare model response", () => {
  const text = '{"device": true, "render": true, "background": "transparent", "issues": {"nsfw": 0.0, "hate": 0.0, "gore": 0.0}, "unrelated": 0.0}';
  assert.deepEqual(parseVerdict(text), {
    device: true,
    render: true,
    background: "transparent",
    issues: { nsfw: 0, hate: 0, gore: 0 },
    unrelated: 0,
  });
});

test("parseVerdict strips code fences and clamps out-of-range scores", () => {
  const text = 'Here:\n```json\n{"device": false, "render": false, "background": "beige", "issues": {"nsfw": 1.4, "hate": -3, "gore": 0.2}, "unrelated": "0.9"}\n```\nDone.';
  assert.deepEqual(parseVerdict(text), {
    device: false,
    render: false,
    background: "other",
    issues: { nsfw: 1, hate: 0, gore: 0.2 },
    unrelated: 0.9,
  });
});

test("parseVerdict defaults an unstated background to other", () => {
  const text = '{"device": true, "render": true, "issues": {"nsfw": 0, "hate": 0, "gore": 0}, "unrelated": 0}';
  assert.equal(parseVerdict(text)?.background, "other");
});

test("parseVerdict returns null for non-JSON output", () => {
  assert.equal(parseVerdict("I cannot review this image."), null);
  assert.equal(parseVerdict(""), null);
});

test("strictViolation names the first broken guideline", () => {
  assert.equal(strictViolation(verdictOf()), null);
  assert.equal(strictViolation(verdictOf({ nsfw: 0.4 })), "nsfw");
  assert.equal(strictViolation(verdictOf({ device: false })), "notArtwork");
  assert.equal(strictViolation(verdictOf({ unrelated: 0.7 })), "notArtwork");
  assert.equal(strictViolation(verdictOf({ render: false })), "photo");
  assert.equal(strictViolation(verdictOf({ device: null })), "unconfirmed");
  assert.equal(strictViolation(verdictOf({ render: null })), "unconfirmed");
  assert.equal(strictViolation(verdictOf({ background: "other" })), "background");
  assert.equal(strictViolation(null), "unconfirmed");
});

test("screeningDecision approves only when both independent passes comply", () => {
  const clean = verdictOf();
  assert.deepEqual(screeningDecision(clean, clean), { action: "approve", reasons: [] });
  assert.deepEqual(screeningDecision(clean, null), { action: "reject", reason: "unconfirmed" });
  assert.deepEqual(screeningDecision(null, clean), { action: "reject", reason: "unconfirmed" });
});

test("screeningDecision rejects a hard category from either pass", () => {
  const verdict = verdictOf({ nsfw: 0.95 });
  assert.deepEqual(screeningDecision(verdict, verdictOf()), { action: "reject", reason: "nsfw" });
  assert.deepEqual(screeningDecision(verdictOf(), verdict), { action: "reject", reason: "nsfw" });
});

test("screeningDecision picks the top hard category by score", () => {
  const verdict = verdictOf({ nsfw: 0.3, hate: 0.97, gore: 0.9 });
  const decision = screeningDecision(verdict, verdict);
  assert.equal(decision.action, "reject");
  assert.equal(decision.reason, "hate");
});

test("screeningDecision rejects non-device imagery with no second chance", () => {
  const animeFace = verdictOf({ device: false, unrelated: 0.95 });
  assert.deepEqual(screeningDecision(animeFace, verdictOf()), { action: "reject", reason: "notArtwork" });
  assert.deepEqual(screeningDecision(verdictOf(), animeFace), { action: "reject", reason: "notArtwork" });
});

test("screeningDecision rejects photographs", () => {
  const photo = verdictOf({ render: false });
  assert.deepEqual(screeningDecision(photo, verdictOf()), { action: "reject", reason: "photo" });
  assert.deepEqual(screeningDecision(verdictOf(), photo), { action: "reject", reason: "photo" });
});

test("screeningDecision rejects non-conforming backgrounds", () => {
  const busyBackground = verdictOf({ background: "other" });
  assert.deepEqual(screeningDecision(busyBackground, verdictOf()), { action: "reject", reason: "background" });
  assert.deepEqual(screeningDecision(verdictOf(), busyBackground), { action: "reject", reason: "background" });
});

test("screeningDecision approves through a weak unrelated signal, flags a moderate one", () => {
  assert.equal(screeningDecision(verdictOf({ unrelated: 0.4 }), verdictOf()).action, "approve");
  assert.deepEqual(screeningDecision(verdictOf({ unrelated: 0.6 }), verdictOf()), {
    action: "reject",
    reason: "notArtwork",
  });
});

test("screeningDecision never approves an uncertain device or render read", () => {
  assert.deepEqual(screeningDecision(verdictOf({ device: null }), verdictOf()), {
    action: "reject",
    reason: "unconfirmed",
  });
  assert.deepEqual(screeningDecision(verdictOf({ render: null }), verdictOf()), {
    action: "reject",
    reason: "unconfirmed",
  });
});

test("screeningDecision rejects a missing verdict rather than dropping it", () => {
  assert.deepEqual(screeningDecision(null), { action: "reject", reason: "unconfirmed" });
  assert.deepEqual(screeningDecision(verdictOf(), verdictOf({ device: false })), {
    action: "reject",
    reason: "notArtwork",
  });
});

test("claimScreeningSlot consumes slots and stops at the configured budget", async () => {
  const env = { SECURITY_KV: new FakeKV(), SCREENING_BUDGET: "2" };
  assert.equal(await claimScreeningSlot(env), true);
  assert.equal(await claimScreeningSlot(env), true);
  assert.equal(await claimScreeningSlot(env), false);
});

test("claimScreeningSlot counts by day, not forever", async () => {
  const kv = new FakeKV();
  const env = { SECURITY_KV: kv, SCREENING_BUDGET: "1" };
  assert.equal(await claimScreeningSlot(env), true);
  assert.equal(await claimScreeningSlot(env), false);
  const [key] = [...kv.store.keys()];
  assert.match(key ?? "", /^ai-screen:\d{4}-\d{2}-\d{2}$/);
});

test("claimScreeningSlot disables screening when the budget is zero", async () => {
  const env = { SECURITY_KV: new FakeKV(), SCREENING_BUDGET: "0" };
  assert.equal(await claimScreeningSlot(env), false);
});

test("claimScreeningSlot fails open without KV storage", async () => {
  const env = { SCREENING_BUDGET: "5" };
  assert.equal(await claimScreeningSlot(env), true);
});

test("claimScreeningSlot fails open on storage errors", async () => {
  const kv = {
    get: async () => {
      throw new Error("kv down");
    },
    put: async () => {
      throw new Error("kv down");
    },
  };
  const env = { SECURITY_KV: kv, SCREENING_BUDGET: "5" };
  assert.equal(await claimScreeningSlot(env), true);
});

test("aiScreeningLabel describes every handling path", () => {
  assert.equal(aiScreeningLabel(false, null), "Not screened (AI unavailable)");
  assert.equal(aiScreeningLabel(true, null), "Unclear — manual review requested");
  assert.equal(aiScreeningLabel(true, { action: "skip" }), "Not screened (daily AI budget reached)");
  assert.equal(aiScreeningLabel(true, { action: "approve" }), "Auto-approved by AI");
  assert.equal(
    aiScreeningLabel(true, { action: "flag", reasons: ["nsfw", "unrelated"] }),
    "Flagged for review — nsfw, unrelated",
  );
});

test("recordArtworkRejection stays calm before the ban threshold", async () => {
  const kv = new FakeKV();
  const count = await recordArtworkRejection(kv, "203.0.113.7");
  assert.equal(count, 1);
  assert.equal(await kv.get("ban:203.0.113.7"), null);
});

test("six rejected submissions from one IP permanently ban it", async () => {
  const kv = new FakeKV();
  let last = 0;
  for (let i = 0; i < 6; i++) {
    last = await recordArtworkRejection(kv, "203.0.113.8");
  }
  assert.equal(last, 6);
  assert.equal(await kv.get("ban:203.0.113.8"), "artwork");
});

test("recordArtworkRejection is a no-op without KV and cannot throw", async () => {
  const broken = {
    get: async () => {
      throw new Error("kv down");
    },
    put: async () => {
      throw new Error("kv down");
    },
  };
  assert.equal(await recordArtworkRejection(null, "203.0.113.9"), 0);
  assert.equal(await recordArtworkRejection(broken, "203.0.113.9"), 0);
});