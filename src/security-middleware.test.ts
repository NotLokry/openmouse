import assert from "node:assert/strict";
import test from "node:test";
import { onRequest } from "../functions/_middleware.js";

class FakeKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

async function guarded(request: Request, kv = new FakeKV(), extraEnv: Record<string, unknown> = {}) {
  return onRequest({
    request,
    env: { SECURITY_KV: kv, ...extraEnv },
    next: async () => new Response("passed-through", { status: 200 }),
  });
}

test("the guard passes requests through when no SECURITY_KV binding is set", async () => {
  const response = await onRequest({
    request: new Request("https://openmouse.app/api/presence"),
    env: {},
    next: async () => new Response("passed-through", { status: 200 }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "passed-through");
});

test("the guard serves a red ban screen to a permanently banned IP", async () => {
  const kv = new FakeKV();
  await kv.put("ban:1.2.3.4", "1");
  const response = await guarded(
    new Request("https://openmouse.app/", { headers: { "CF-Connecting-IP": "1.2.3.4" } }),
    kv,
  );
  assert.equal(response.status, 403);
  const body = await response.text();
  assert.match(body, /<h1>You have been banned<\/h1>/);
  assert.match(body, /Repeated automated abuse or exploit attempts/);
  assert.match(body, /discordapp\.com\/channels\/1531814042421952644\/1545272715072639117/);
});

test("the guard says so when an IP was banned for artwork spam", async () => {
  const kv = new FakeKV();
  await kv.put("ban:203.0.113.9", "artwork");
  const response = await guarded(
    new Request("https://openmouse.app/", { headers: { "CF-Connecting-IP": "203.0.113.9" } }),
    kv,
  );
  const body = await response.text();
  assert.equal(response.status, 403);
  assert.match(body, /Repeated artwork submissions were rejected/);
});

test("a banned IP can still reach the unban endpoint with the admin token", async () => {
  const kv = new FakeKV();
  await kv.put("ban:1.2.3.4", "artwork");
  const response = await guarded(
    new Request("https://openmouse.app/api/admin/unban", {
      method: "POST",
      headers: { "CF-Connecting-IP": "1.2.3.4", Authorization: "Bearer s3cret" },
    }),
    kv,
    { ADMIN_TOKEN: "s3cret" },
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "passed-through");
});

test("the admin token does not unlock the rest of the site for a banned IP", async () => {
  const kv = new FakeKV();
  await kv.put("ban:1.2.3.4", "artwork");
  const response = await guarded(
    new Request("https://openmouse.app/", {
      headers: { "CF-Connecting-IP": "1.2.3.4", Authorization: "Bearer s3cret" },
    }),
    kv,
    { ADMIN_TOKEN: "s3cret" },
  );
  assert.equal(response.status, 403);
});

test("a banned IP needs a valid and configured token to reach the unban endpoint", async () => {
  const kv = new FakeKV();
  await kv.put("ban:1.2.3.4", "artwork");
  const post = (authorization: string | null) =>
    new Request("https://openmouse.app/api/admin/unban", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "1.2.3.4",
        ...(authorization ? { Authorization: authorization } : {}),
      },
    });

  const wrongToken = await guarded(post("Bearer nope"), kv, { ADMIN_TOKEN: "s3cret" });
  assert.equal(wrongToken.status, 403);

  const noToken = await guarded(post(null), kv, { ADMIN_TOKEN: "s3cret" });
  assert.equal(noToken.status, 403);

  const unconfigured = await guarded(post("Bearer s3cret"), kv);
  assert.equal(unconfigured.status, 403);
});

test("the guard blocks exploit URLs and counts a strike", async () => {
  const kv = new FakeKV();
  const response = await guarded(
    new Request("https://openmouse.app/api/admin/login%2e%2e%2f%2e%2e%2f.env"),
    kv,
  );
  assert.equal(response.status, 403);
  assert.ok(await kv.get("strikes:unknown"));
});

test("the guard blocks cross-site POSTs", async () => {
  const response = await guarded(
    new Request("https://openmouse.app/api/feedback", {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    }),
  );
  assert.equal(response.status, 403);
});

test("the guard allows same-origin POSTs", async () => {
  const response = await guarded(
    new Request("https://openmouse.app/api/feedback", {
      method: "POST",
      headers: { Origin: "https://openmouse.app" },
    }),
  );
  assert.equal(response.status, 200);
});

test("the guard rejects oversized POST bodies", async () => {
  const response = await guarded(
    new Request("https://openmouse.app/api/feedback", {
      method: "POST",
      headers: { "Content-Length": String(9 * 1024 * 1024) },
    }),
  );
  assert.equal(response.status, 413);
});

test("the guard rate-limits aggressive GET traffic with a strike", async () => {
  const kv = new FakeKV();
  let lastStatus = 200;
  for (let i = 0; i < 241; i++) {
    const response = await guarded(new Request("https://openmouse.app/assets/app.js"), kv);
    lastStatus = response.status;
  }
  assert.equal(lastStatus, 429);
  assert.ok(await kv.get("strikes:unknown"));
});

test("repeated abuse permanently bans the IP", async () => {
  const kv = new FakeKV();
  let lastStatus = 200;
  for (let i = 0; i < 26; i++) {
    const response = await guarded(
      new Request("https://openmouse.app/api/admin%2e%2e%2f%2e%2e%2f.env"),
      kv,
    );
    lastStatus = response.status;
  }
  assert.equal(lastStatus, 403);
  assert.equal(await kv.get("ban:unknown"), "security");
});