import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Miniflare } from "miniflare";
import { canonicalDeviceRequest } from "../../src/security/canonical-request.ts";
import { consumeChallenge } from "../../src/security/challenge-consume.ts";

const compatibilityDate = "2026-09-30";
const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const publicKey = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const otherPublicKey = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c";
const signatureVector = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155\n" +
  "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed, "hex")]),
  format: "der",
  type: "pkcs8",
});

const workerScript = `
function decode(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
export default {
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/verify") return new Response("not found", { status: 404 });
    try {
      const input = await request.json();
      const key = await crypto.subtle.importKey("raw", decode(input.publicKey), { name: "Ed25519" }, false, ["verify"]);
      const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, decode(input.signature), decode(input.message));
      return Response.json({ valid });
    } catch {
      return Response.json({ valid: false });
    }
  }
};`;

let miniflare;
let d1;
let tempPath;

before(async () => {
  tempPath = mkdtempSync(join(tmpdir(), "varmepuls-auth-feasibility-"));
  process.env.TEMP = tempPath;
  process.env.TMP = tempPath;
  miniflare = new Miniflare({
    workers: [{
      config: {
        name: "varmepuls-auth-feasibility-local",
        compatibilityDate,
        manifest: { mainModule: "index.mjs", modules: { "index.mjs": { type: "esm", contents: workerScript } } },
        env: { AUTH_DB: { type: "d1", id: "local-only-feasibility-d1" } },
      },
      dev: { rootPath: process.cwd() },
    }],
  });
  await miniflare.ready;
  d1 = await miniflare.getD1Database("AUTH_DB");
  await d1.prepare(`CREATE TABLE auth_challenges (
    challenge_id TEXT PRIMARY KEY NOT NULL,
    nonce_sha256 TEXT NOT NULL,
    device_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  )`).run();
  await d1.prepare(`CREATE TRIGGER consumed_challenge_cannot_reopen
    BEFORE UPDATE OF consumed_at ON auth_challenges
    WHEN OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NULL
    BEGIN SELECT RAISE(ABORT, 'consumed challenge cannot be reopened'); END`).run();
});

after(async () => {
  if (miniflare) await miniflare.dispose();
  if (tempPath) rmSync(tempPath, { recursive: true, force: true });
});

const hexBytes = value => Buffer.from(value, "hex");
const base64 = value => Buffer.from(value).toString("base64");
const signOutsideWorker = message => sign(null, Buffer.from(message), privateKey);

async function verifyInWorkerd(key, signature, message) {
  const response = await miniflare.dispatchFetch("http://localhost/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: base64(hexBytes(key)), signature: base64(signature), message: base64(message) }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).valid;
}

test("the pinned local workerd runtime accepts RFC 8032 Ed25519 test vector 1", async () => {
  assert.equal(await verifyInWorkerd(publicKey, hexBytes(signatureVector.replaceAll("\n", "")), new Uint8Array()), true);
});

test("workerd rejects a modified Ed25519 message", async () => {
  const signature = hexBytes(signatureVector.replaceAll("\n", ""));
  assert.equal(await verifyInWorkerd(publicKey, signature, Uint8Array.of(0)), false);
});

test("workerd rejects a modified Ed25519 signature", async () => {
  const signature = hexBytes(signatureVector.replaceAll("\n", ""));
  signature[0] ^= 1;
  assert.equal(await verifyInWorkerd(publicKey, signature, new Uint8Array()), false);
});

test("workerd rejects the valid signature under a different valid public key", async () => {
  assert.equal(await verifyInWorkerd(otherPublicKey, hexBytes(signatureVector.replaceAll("\n", "")), new Uint8Array()), false);
});

const originalBody = Buffer.from('{"read":"plan"}');
const bodyDigest = value => createHash("sha256").update(value).digest("hex");
const canonicalFields = {
  protocolVersion: "varmepuls-device-auth-v1",
  deviceId: "device_A_opaque",
  credentialId: "credential_A_v1",
  challengeId: "challenge_opaque_1",
  nonceBase64Url: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  method: "POST",
  normalizedPath: "/v1/device/plan",
  bodySha256Hex: bodyDigest(originalBody),
};

test("canonical request signature verifies in workerd when signed outside it", async () => {
  const canonical = canonicalDeviceRequest(canonicalFields);
  assert.equal(await verifyInWorkerd(publicKey, signOutsideWorker(canonical), canonical), true);
});

for (const [field, change] of [
  ["protocolVersion", value => value.replace("v1", "v2")],
  ["deviceId", value => value.replace("A", "B")],
  ["credentialId", value => value.replace("v1", "v2")],
  ["challengeId", value => value.replace("1", "2")],
  ["nonceBase64Url", value => value.replace("AA", "AQ")],
  ["method", () => "GET"],
  ["normalizedPath", () => "/v1/device/config"],
  ["bodySha256Hex", () => bodyDigest(Buffer.from('{"read":"config"}'))],
]) {
  test(`canonical request signature rejects changed ${field}`, async () => {
    const signature = signOutsideWorker(canonicalDeviceRequest(canonicalFields));
    const altered = canonicalDeviceRequest({ ...canonicalFields, [field]: change(canonicalFields[field]) });
    assert.equal(await verifyInWorkerd(publicKey, signature, altered), false);
  });
}

test("length-prefixed canonical fields cannot collide at concatenation boundaries", () => {
  const left = canonicalDeviceRequest({ ...canonicalFields, deviceId: "aaaaaaaa", credentialId: "bbbbbbbbc" });
  const right = canonicalDeviceRequest({ ...canonicalFields, deviceId: "aaaaaaaab", credentialId: "bbbbbbbb" });
  assert.notDeepEqual(left, right);
  assert.deepEqual([...left.slice(0, 6)], [0x56, 0x50, 0x44, 0x41, 0, 8]);
});

const challenge = (overrides = {}) => ({
  challengeId: "challenge_opaque_1",
  nonceSha256: "a".repeat(64),
  deviceId: "device_A_opaque",
  credentialId: "credential_A_v1",
  credentialVersion: 1,
  serverNowUtc: "2026-10-01T12:00:00.000Z",
  ...overrides,
});

async function insertChallenge(value, expiresAt = "2026-10-01T12:01:00.000Z") {
  await d1.prepare(`INSERT INTO auth_challenges
    (challenge_id, nonce_sha256, device_id, credential_id, credential_version, expires_at, consumed_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)`)
    .bind(value.challengeId, value.nonceSha256, value.deviceId, value.credentialId, value.credentialVersion, expiresAt).run();
}

test("D1-compatible atomic compare-and-consume accepts the first valid attempt only", async () => {
  const input = challenge();
  await insertChallenge(input);
  assert.equal(await consumeChallenge(d1, input), "consumed");
  assert.equal(await consumeChallenge(d1, input), "rejected");
  const row = await d1.prepare("SELECT consumed_at FROM auth_challenges WHERE challenge_id = ?").bind(input.challengeId).first();
  assert.equal(row.consumed_at, input.serverNowUtc);
});

test("server time rejects an expired challenge at the exact expiry boundary", async () => {
  const input = challenge({ challengeId: "challenge_expired" });
  await insertChallenge(input, input.serverNowUtc);
  assert.equal(await consumeChallenge(d1, input), "rejected");
});

test("wrong device, credential, key version, nonce, and unknown challenge all affect zero rows", async () => {
  const input = challenge({ challengeId: "challenge_bound" });
  await insertChallenge(input);
  for (const altered of [
    { deviceId: "device_B_opaque" },
    { credentialId: "credential_B_v1" },
    { credentialVersion: 2 },
    { nonceSha256: "b".repeat(64) },
    { challengeId: "challenge_unknown" },
  ]) assert.equal(await consumeChallenge(d1, { ...input, ...altered }), "rejected");
  assert.equal(await consumeChallenge(d1, input), "consumed");
});

test("malformed challenge identifiers are rejected before SQL", async () => {
  assert.equal(await consumeChallenge(d1, challenge({ challengeId: "bad id" })), "invalid");
  assert.equal(await consumeChallenge(d1, challenge({ nonceSha256: "not-a-hash" })), "invalid");
});

test("a consumed challenge cannot return to unused", async () => {
  const input = challenge({ challengeId: "challenge_immutable" });
  await insertChallenge(input);
  assert.equal(await consumeChallenge(d1, input), "consumed");
  await assert.rejects(d1.prepare("UPDATE auth_challenges SET consumed_at = NULL WHERE challenge_id = ?").bind(input.challengeId).run(), /cannot be reopened/);
});

test("two competing local D1 consumers cannot both consume one challenge", async () => {
  const input = challenge({ challengeId: "challenge_competing" });
  await insertChallenge(input);
  const results = await Promise.all([consumeChallenge(d1, input), consumeChallenge(d1, input)]);
  assert.equal(results.filter(result => result === "consumed").length, 1);
  assert.equal(results.filter(result => result === "rejected").length, 1);
});
