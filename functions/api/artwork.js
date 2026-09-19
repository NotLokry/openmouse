// Artwork submission relay with strict image screening.
//
// The artwork dialog POSTs a multipart form (payload_json + files[0]) to this
// endpoint. What can reach Discord is deliberately narrow:
//   1. structurally validates the image (magic bytes + sane dimensions),
//   2. inspects file metadata (embedded camera EXIF is immediate proof the
//      file is a converted photograph — rejected without an AI call),
//   3. screens the content twice with a Workers AI vision model when the
//      `AI` binding is configured, and only forwards to the same Discord
//      webhook as feedback when BOTH independent passes fully satisfy the
//      artwork guidelines.
//
// Interpretation is unbiased and covers most of the pixels, so it can catch
// more edge cases than a brute-force heuristic — the strict workflow:
//   - The artwork guidelines are absolute: a clean top-down render/cutout of
//     the device alone, on a transparent or pure white background, and never
//     a clicked photograph.
//   - Auto-approval requires TWO independent model passes that both agree on
//     every criterion. Any doubt, disagreement, unsupported metadata, or
//     failed call rejects — nothing ambiguous ever reaches Discord, and the
//     uploader is shown why.
//   - Hard content categories (nsfw / hate / gore) are scored 0..1; any
//     signal at or above the flag threshold rejects outright.
//   - If AI screening is unavailable (no binding, budget exhausted), the
//     submission is rejected rather than forwarded unscreened.
//
// Env:
//   DISCORD_FEEDBACK_WEBHOOK — webhook for the review channel (required)
//   AI                        — Workers AI binding (required for screening)
//   SCREENING_BUDGET          — max AI screenings per day (default 400;
//                                counts every model pass, and strict screening
//                                runs two passes per submission; uses
//                                SECURITY_KV to count; 0 disables; screening
//                                being off rejects the upload)
// The screening model (@cf/meta/llama-3.2-11b-vision-instruct) requires
// accepting the Meta license once per account before first use.

import { parseArtworkImage, probeArtworkMetadata } from "./_lib/images.js";

const MAX_ART_SIZE = 5 * 1024 * 1024;
const SCREENING_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
// Keeps the account comfortably inside Workers AI's daily free allocation
// (~10,000 neurons; the 11B vision model costs roughly 20-60 neurons per
// call), so a well-meaning spike or a spam run can never turn into a bill.
// Strict screening always runs two passes per submission, so the cap is sized
// for around 200 fully double-checked submissions a day.
// Overridable per project with the SCREENING_BUDGET env var.
const DEFAULT_SCREENING_BUDGET = 400;

const HARD_CATEGORIES = ["nsfw", "hate", "gore"];

// Any hard-category signal at or above this rejects the submission outright.
const HARD_FLAG_THRESHOLD = 0.3;
// Above this the image is treated as not device imagery at all.
const UNRELATED_FLAG_THRESHOLD = 0.5;

// How many content rejections from one IP within 24h permanently ban it. The
// client already pauses after 3 failures; this server-side counter survives
// incognito windows and cleared localStorage, so a determined spammer gets
// IP-banned entirely instead of just chilled.
const ART_REJECTIONS_TO_BAN = 6;
// Rejection counts roll off after a day so a misfit not a spammer is never
// permanently punished by their art taste.
const REJECTION_TTL = 24 * 3600;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function budgetDate() {
  return new Date().toISOString().slice(0, 10);
}

/** Best-effort client IP, mirroring the site-wide guard in _middleware.js. */
function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/** Counts one content rejection from this IP today. Past the threshold the IP
    is permanently banned (`ban:<ip>` = "artwork"), which the site-wide guard
    enforces with a red ban screen. Storage failures fail OPEN — a KV hiccup
    must never be what trips a ban. */
export async function recordArtworkRejection(kv, ip) {
  if (!kv) return 0;
  try {
    const key = `artscreen:${ip}:${budgetDate()}`;
    const count = Number((await kv.get(key)) ?? "0") + 1;
    await kv.put(key, String(count), { expirationTtl: REJECTION_TTL });
    if (count >= ART_REJECTIONS_TO_BAN) {
      await kv.put(`ban:${ip}`, "artwork");
    }
    return count;
  } catch {
    return 0;
  }
}

/** Claims one AI screening slot for today's budget. Returns true when a slot
    exists (consuming it), false when the daily budget is exhausted or AI is
    disabled via SCREENING_BUDGET=0. Storage failures fail OPEN — screening is
    attempted anyway and the strict gate still decides. */
export async function claimScreeningSlot(env) {
  const budget = Number(env.SCREENING_BUDGET ?? DEFAULT_SCREENING_BUDGET);
  if (!Number.isFinite(budget) || budget <= 0) return false;
  const kv = env.SECURITY_KV;
  if (!kv) return true;
  try {
    const key = `ai-screen:${budgetDate()}`;
    const used = Number((await kv.get(key)) ?? "0");
    if (used >= budget) return false;
    await kv.put(key, String(used + 1), { expirationTtl: 3 * 24 * 3600 });
    return true;
  } catch {
    return true;
  }
}

const SCREENING_SYSTEM_PROMPT = `
You are the artwork gatekeeper for an open-source app whose catalog shows
top-down product artwork (cutouts) of computer mice and peripherals. A user
submitted the attached image as the product artwork for a device listing.

Only the following submissions are acceptable — everything else is rejected:
- The image must be a clean, top-down digital render or vector-style cutout of
  the device alone: nothing else in the frame (no desk, props, hands, food,
  people, stickers, captions, text, watermarks, or borders).
- The background must be fully transparent OR pure solid white: no gradients,
  shadows, scenes, colored backdrops, or desk surface.
- It must be a digital render/diagram/cutout — NOT a clicked photograph of the
  device. Photographs are always rejected, even if cropped onto white.

Be strict. When in doubt, mark it clearly rather than giving it the benefit.
Only score these when actually present:
- "nsfw": nudity, sexually explicit, or sexualized content
- "hate": hate symbols, slurs, or targeted abuse (including text drawn on the image)
- "gore": gore, graphic violence, or injury

Respond with ONLY a JSON object and no commentary, using this exact schema:
{"device": true, "render": true, "background": "transparent", "issues": {"nsfw": 0.0, "hate": 0.0, "gore": 0.0}, "unrelated": 0.0}

- "device" is true only when the image plausibly depicts the submitted device
  or similar hardware.
- "render" is true only when the image is a digital render/diagram/cutout and
  NOT a photograph. false when it is a photo.
- "background" must be exactly "transparent", "white", or "other".
Every score is a confidence 0..1 that the issue is present; use 0.0 when
absent, and always prefer lower scores when unsure.
- "unrelated" is the confidence that the image is not device imagery at all.
`.trim();

/** Pulls the verdict JSON out of a model response that may carry fences or
    surrounding prose. Returns null when no usable object is present. */
export function parseVerdict(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const data = JSON.parse(text.slice(start, end + 1));
    const issuesRaw = data.issues && typeof data.issues === "object" ? data.issues : {};
    const background = data.background === "transparent" || data.background === "white" ? data.background : "other";
    return {
      device: typeof data.device === "boolean" ? data.device : null,
      render: typeof data.render === "boolean" ? data.render : null,
      background,
      issues: {
        nsfw: clamp01(issuesRaw.nsfw),
        hate: clamp01(issuesRaw.hate),
        gore: clamp01(issuesRaw.gore),
      },
      unrelated: clamp01(data.unrelated),
    };
  } catch {
    return null;
  }
}

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** First guideline violation found in a single verdict, or null when the
    verdict fully complies. Reasons are user-facing: nsfw/hate/gore (content),
    notArtwork, photo, background, unconfirmed (model unsure or silent). */
export function strictViolation(verdict) {
  if (!verdict) return "unconfirmed";
  const top = HARD_CATEGORIES.map((category) => ({ category, score: verdict.issues?.[category] ?? 0 }))
    .sort((a, b) => b.score - a.score)[0];
  if (top.score >= HARD_FLAG_THRESHOLD) return top.category;
  if (verdict.device === false || verdict.unrelated >= UNRELATED_FLAG_THRESHOLD) return "notArtwork";
  if (verdict.device !== true) return "unconfirmed";
  if (verdict.render === false) return "photo";
  if (verdict.render !== true) return "unconfirmed";
  if (verdict.background !== "transparent" && verdict.background !== "white") return "background";
  return null;
}

/**
 * Strict two-pass gate. `first` and `second` are the two independent model
 * verdicts. Auto-approve only when BOTH passes fully comply with the artwork
 * guidelines; any violation, disagreement, or missing pass rejects.
 *
 * Returns one of:
 *   { action: "approve" }
 *   { action: "reject", reason }
 *   { action: "reject", reason: "unconfirmed" }
 */
export function screeningDecision(first, second = null) {
  if (!first) return { action: "reject", reason: "unconfirmed" };
  const firstReason = strictViolation(first);
  if (firstReason) return { action: "reject", reason: firstReason };
  if (!second) return { action: "reject", reason: "unconfirmed" };
  const secondReason = strictViolation(second);
  if (secondReason) return { action: "reject", reason: secondReason };
  return { action: "approve", reasons: [] };
}

/** Discord embed label describing how the image was handled. */
export function aiScreeningLabel(envAiAvailable, decision) {
  if (!envAiAvailable) return "Not screened (AI unavailable)";
  if (!decision) return "Unclear — manual review requested";
  if (decision.action === "skip") return "Not screened (daily AI budget reached)";
  if (decision.action === "approve") return "Auto-approved by AI";
  if (decision.action === "flag") {
    return `Flagged for review — ${(decision.reasons ?? []).join(", ")}`;
  }
  return "Unclear — manual review requested";
}

function toBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function dataUrl(bytes, format) {
  return `data:image/${format};base64,${toBase64(bytes)}`;
}

async function runVision(env, bytes, format, systemPrompt, userPrompt) {
  const response = await env.AI.run(SCREENING_MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    image: dataUrl(bytes, format),
  });
  // Workers AI sometimes returns `response` as a string (needing our own JSON
  // extraction below) and sometimes as an already-parsed object when the
  // model's output happened to be clean JSON — handle both.
  const inner = response && typeof response === "object" ? response.response : response;
  if (typeof inner === "string") return inner;
  if (inner && typeof inner === "object") return JSON.stringify(inner);
  return String(inner ?? "");
}

/** One full scored classification pass, broken open on model failure. */
async function screenImage(env, bytes, format, userPrompt) {
  const raw = await runVision(env, bytes, format, SCREENING_SYSTEM_PROMPT, userPrompt);
  return parseVerdict(raw);
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") return json({ message: "Method not allowed." }, 405);

  const webhook = env.DISCORD_FEEDBACK_WEBHOOK;
  if (!webhook || !webhook.startsWith("https://discord")) {
    return json({ message: "Artwork submissions are not configured." }, 503);
  }

  // Content rejections are counted per IP; enough of them permanently bans the
  // IP. Storage failures and shortage of SECURITY_KV must not break the flow.
  const contentReject = (reason) => {
    if (env.SECURITY_KV) void recordArtworkRejection(env.SECURITY_KV, clientIp(request));
    return json({ ok: false, reason }, 422);
  };

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, reason: "invalid" }, 400);
  }

  const file = form.get("files[0]");
  if (!(file instanceof File)) return json({ ok: false, reason: "invalid" }, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_ART_SIZE) {
    return json({ ok: false, reason: "invalid" }, 400);
  }

  const info = parseArtworkImage(bytes);
  if (!info) return json({ ok: false, reason: "invalid" }, 422);

  // Camera EXIF anywhere in the file means the submission is a converted
  // photograph, never device-render artwork — reject before spending a call.
  const meta = probeArtworkMetadata(bytes);
  if (meta.exif) return contentReject("photo");

  // No AI, no screening — and nothing unscreened ever reaches Discord.
  if (!env.AI) return json({ ok: false, reason: "unscreened" }, 503);
  if (!(await claimScreeningSlot(env))) return json({ ok: false, reason: "unscreened" }, 503);

  const userPrompt = meta.alpha
    ? "Review this image and output the requested JSON only. The file carries an alpha channel (transparency)."
    : "Review this image and output the requested JSON only.";

  const first = await screenImage(env, bytes, info.format, userPrompt).catch(() => null);
  const firstReason = strictViolation(first);
  if (firstReason) return contentReject(firstReason);

  const second = (await claimScreeningSlot(env))
    ? await screenImage(env, bytes, info.format, userPrompt).catch(() => null)
    : null;
  const decision = screeningDecision(first, second);
  if (decision.action !== "approve") return contentReject(decision.reason);

  let payload = { embeds: [] };
  const rawPayload = form.get("payload_json");
  if (typeof rawPayload === "string") {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      /* fall back to an empty embed list */
    }
  }

  const embed = Array.isArray(payload.embeds) ? payload.embeds[0] : undefined;
  if (embed && typeof embed === "object") {
    const fields = Array.isArray(embed.fields) ? [...embed.fields] : [];
    fields.push({ name: "AI Screening", value: aiScreeningLabel(true, decision), inline: false });
    embed.fields = fields;
  }

  const outForm = new FormData();
  outForm.append("payload_json", JSON.stringify(payload));
  outForm.append("files[0]", file, file.name);

  try {
    const response = await fetch(webhook, { method: "POST", body: outForm });
    if (!response.ok) return json({ message: "Discord rejected the submission." }, response.status);
    return json({ ok: true });
  } catch {
    return json({ message: "Discord unreachable." }, 502);
  }
}