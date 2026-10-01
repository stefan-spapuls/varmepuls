import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare } from "miniflare";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { canonicalDeviceRequest } from "../../src/security/canonical-request.ts";
import { enrollmentCapabilityVerifier } from "../../src/cloud/device-auth.ts";

const compatibilityDate = "2026-09-30";
const INSTALL_A = "installation_local_A";
const INSTALL_B = "installation_local_B";
let miniflare;
let db;
let scratch;
let keysA;
let keysB;
let deviceA;
let deviceB;

function b64url(bytes) { return Buffer.from(bytes).toString("base64url"); }
function makeKeyPair() {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ format: "der", type: "spki" });
  return { privateKey: pair.privateKey, publicKey: b64url(der.subarray(-32)) };
}
function nowUtc() { return new Date().toISOString(); }
function jsonRequest(path, body, method = "POST", headers = {}) {
  return miniflare.dispatchFetch(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function createInvitation(installationId, { expired = false } = {}) {
  const enrollmentId = `enroll_${crypto.randomUUID().replaceAll("-", "")}`;
  const capability = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const createdAt = new Date(Date.now() - (expired ? 6 * 60_000 : 0)).toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + 5 * 60_000).toISOString();
  const verifier = await enrollmentCapabilityVerifier(enrollmentId, capability);
  await db.prepare(`INSERT INTO enrollment_capabilities
    (enrollment_id,installation_id,verifier_sha256,created_at,expires_at)
    VALUES (?,?,?,?,?)`).bind(enrollmentId, installationId, verifier, createdAt, expiresAt).run();
  return { enrollmentId, capability };
}

async function enroll(installationId, keyPair, overrides = {}) {
  const invitation = await createInvitation(installationId, overrides);
  const response = await jsonRequest("/v1/enrollments/consume", {
    ...invitation, publicKey: keyPair.publicKey,
  });
  return { response, invitation };
}

async function challenge(deviceId, credentialId) {
  const response = await jsonRequest("/v1/device/challenges", { deviceId, credentialId });
  return { response, value: response.status === 201 ? await response.json() : null };
}

function signedHeaders(identity, keyPair, challengeValue, method, path, bodyBytes = Buffer.alloc(0)) {
  const fields = {
    protocolVersion: "varmepuls-device-auth-v1",
    deviceId: identity.deviceId,
    credentialId: identity.credentialId,
    challengeId: challengeValue.challengeId,
    nonceBase64Url: challengeValue.nonce,
    method,
    normalizedPath: path,
    bodySha256Hex: createHash("sha256").update(bodyBytes).digest("hex"),
  };
  const signature = sign(null, Buffer.from(canonicalDeviceRequest(fields)), keyPair.privateKey);
  return {
    "x-varmepuls-device-id": fields.deviceId,
    "x-varmepuls-credential-id": fields.credentialId,
    "x-varmepuls-challenge-id": fields.challengeId,
    "x-varmepuls-nonce": fields.nonceBase64Url,
    "x-varmepuls-signature": b64url(signature),
  };
}

async function protectedRequest(identity, keyPair, challengeValue, method, path, bodyText) {
  const bodyBytes = bodyText === undefined ? Buffer.alloc(0) : Buffer.from(bodyText);
  const headers = signedHeaders(identity, keyPair, challengeValue, method, path, bodyBytes);
  return miniflare.dispatchFetch(`http://localhost${path}`, {
    method, headers: { ...(bodyText === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(bodyText === undefined ? {} : { body: bodyText }),
  });
}

async function readConfig(identity, keyPair) {
  const { response: challengeResponse, value } = await challenge(identity.deviceId, identity.credentialId);
  assert.equal(challengeResponse.status, 201);
  return protectedRequest(identity, keyPair, value, "GET", "/v1/device/config");
}

before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "varmepuls-device-auth-local-"));
  process.env.TEMP = scratch;
  process.env.TMP = scratch;
  const moduleNames = [
    "src/cloud/worker.ts", "src/cloud/device-auth.ts",
    "src/security/canonical-request.ts", "src/security/challenge-consume.ts",
  ];
  const modules = Object.fromEntries(moduleNames.map(name => [name, {
    type: "esm",
    contents: transpileModule(readFileSync(resolve(name), "utf8"), {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    }).outputText,
  }]));
  miniflare = new Miniflare({
    workers: [{
      config: {
        name: "varmepuls-auth-local-qualification",
        compatibilityDate,
        manifest: { mainModule: "src/cloud/worker.ts", modules },
        env: {
          VARMEPULS_STATE_DB: { type: "d1", id: "local-device-auth-only" },
          LOCAL_AUTH_HTTP_TEST: { type: "text", value: "1" },
        },
      },
      dev: { rootPath: process.cwd() },
    }],
  });
  await miniflare.ready;
  db = await miniflare.getD1Database("VARMEPULS_STATE_DB");
  const applyMigration = async name => {
    const lines = readFileSync(resolve(name), "utf8").split(/\r?\n/);
    let statement = "";
    let trigger = false;
    for (const line of lines) {
      if (/^\s*--/.test(line) || !line.trim()) continue;
      statement += `${line}\n`;
      if (/^\s*CREATE TRIGGER\b/i.test(line)) trigger = true;
      const complete = trigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line);
      if (complete) {
        await db.prepare(statement).run();
        statement = "";
        trigger = false;
      }
    }
    assert.equal(statement.trim(), "", `incomplete migration statement in ${name}`);
  };
  await applyMigration("migrations/0001_initial.sql");
  await applyMigration("migrations/0002_device_auth.sql");
  const now = nowUtc();
  const expires = new Date(Date.parse(now) + 2 * 60 * 60_000).toISOString();
  for (const [id, zone, mode] of [[INSTALL_A, "SE4", "winter"], [INSTALL_B, "SE1", "summer"]]) {
    await db.prepare("INSERT INTO installations (id,created_at) VALUES (?,?)").bind(id, now).run();
    await db.prepare(`INSERT INTO installation_config (installation_id,revision,config_json,updated_at)
      VALUES (?,1,?,?)`).bind(id, JSON.stringify({ zone, mode, marker: id }), now).run();
    await db.prepare(`INSERT INTO plan_revisions
      (installation_id,revision,plan_id,config_revision,created_at,valid_from,expires_at,zone,
       coverage_start_utc,coverage_end_utc,actions_json)
      VALUES (?,1,?,1,?,?,?,?,?,?,?)`).bind(id, `plan-${id}`, now, now, expires, zone,
      now, expires, JSON.stringify([{ atUtc: now, target: "domestic-hot-water", enabled: true }])).run();
  }
  keysA = makeKeyPair();
  keysB = makeKeyPair();
});

after(async () => {
  if (miniflare) await miniflare.dispose();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("migration 0002 creates only bounded device-auth state and enforces constraints", async t => {
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('devices','enrollment_capabilities','auth_challenges') ORDER BY name").all();
  assert.deepEqual(tables.results.map(row => row.name), ["auth_challenges", "devices", "enrollment_capabilities"]);
  const columns = await db.prepare("PRAGMA table_info(devices)").all();
  assert.ok(columns.results.some(row => row.name === "public_key_b64url"));
  assert.equal(columns.results.some(row => row.name.toLowerCase().includes("private_key")), false);
  await t.test("rejects invalid lifecycle and key metadata", async () => {
    await assert.rejects(db.prepare(`INSERT INTO devices
      (device_id,installation_id,credential_id,public_key_b64url,credential_version,status,created_at)
      VALUES ('bad_device','${INSTALL_A}','bad_credential','short',1,'active','${nowUtc()}')`).run());
  });
});

test("local Worker routes implement enrollment, signed scoped reads, replay defense, revocation and rotation", async t => {
  await t.test("expired enrollment creates no trusted device", async () => {
    const key = makeKeyPair();
    const { response } = await enroll(INSTALL_A, key, { expired: true });
    assert.equal(response.status, 401);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM devices").first();
    assert.equal(count.n, 0);
  });

  await t.test("malformed key and caller-selected installation are rejected without consuming invitation", async () => {
    const invitation = await createInvitation(INSTALL_A);
    const malformed = await jsonRequest("/v1/enrollments/consume", { ...invitation, publicKey: "short" });
    assert.equal(malformed.status, 400);
    const crossInstall = await jsonRequest("/v1/enrollments/consume", {
      ...invitation, publicKey: keysA.publicKey, installationId: INSTALL_B,
    });
    assert.equal(crossInstall.status, 400);
    const row = await db.prepare("SELECT consumed_at FROM enrollment_capabilities WHERE enrollment_id=?")
      .bind(invitation.enrollmentId).first();
    assert.equal(row.consumed_at, null);
  });

  await t.test("enrollment creates a unique opaque device bound only to its invitation installation", async () => {
    const result = await enroll(INSTALL_A, keysA);
    assert.equal(result.response.status, 201);
    deviceA = await result.response.json();
    assert.equal(deviceA.installationId, INSTALL_A);
    assert.equal(deviceA.credentialVersion, 1);
    assert.notEqual(deviceA.deviceId, INSTALL_A);
    const row = await db.prepare("SELECT * FROM devices WHERE device_id=?").bind(deviceA.deviceId).first();
    assert.equal(row.public_key_b64url, keysA.publicKey);
    assert.equal(row.status, "active");
  });

  await t.test("enrollment is single-use and replay does not create a second device", async () => {
    const { response, invitation } = await enroll(INSTALL_A, makeKeyPair());
    assert.equal(response.status, 201);
    const replay = await jsonRequest("/v1/enrollments/consume", {
      ...invitation, publicKey: makeKeyPair().publicKey,
    });
    assert.equal(replay.status, 401);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM devices").first();
    assert.equal(count.n, 2);
  });

  await t.test("separate installation enrollment produces distinct device and credential identities", async () => {
    const result = await enroll(INSTALL_B, keysB);
    assert.equal(result.response.status, 201);
    deviceB = await result.response.json();
    assert.equal(deviceB.installationId, INSTALL_B);
    assert.notEqual(deviceA.deviceId, deviceB.deviceId);
    assert.notEqual(deviceA.credentialId, deviceB.credentialId);
  });

  await t.test("unknown and malformed challenge selectors have bounded generic failures", async () => {
    const unknown = await challenge("device_unknown_123", "credential_unknown_123");
    assert.equal(unknown.response.status, 401);
    assert.deepEqual(await unknown.response.json(), { error: "AUTHENTICATION_FAILED" });
    const malformed = await jsonRequest("/v1/device/challenges", { deviceId: "bad", credentialId: "bad" });
    assert.equal(malformed.status, 400);
  });

  await t.test("challenge issuance is server-timed and bounded to three outstanding keys", async () => {
    const issued = [];
    for (let index = 0; index < 3; index++) {
      const response = await challenge(deviceA.deviceId, deviceA.credentialId);
      assert.equal(response.response.status, 201);
      issued.push(response.value);
      assert.ok(Date.parse(response.value.expiresAt) - Date.now() <= 120_000);
      assert.ok(Date.parse(response.value.expiresAt) - Date.now() > 110_000);
    }
    const fourth = await challenge(deviceA.deviceId, deviceA.credentialId);
    assert.equal(fourth.response.status, 401);
    for (const value of issued) {
      const response = await protectedRequest(deviceA, keysA, value, "GET", "/v1/device/config");
      assert.equal(response.status, 200);
    }
  });

  await t.test("signed configuration read derives installation scope from device identity", async () => {
    const response = await readConfig(deviceA, keysA);
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.installationId, INSTALL_A);
    assert.deepEqual(value.configuration, { zone: "SE4", mode: "winter", marker: INSTALL_A });
    assert.equal(JSON.stringify(value).includes(INSTALL_B), false);
  });

  await t.test("signed plan read returns revision, validity, coverage and logical actions only for its installation", async () => {
    const { value } = await challenge(deviceA.deviceId, deviceA.credentialId);
    const response = await protectedRequest(deviceA, keysA, value, "GET", "/v1/device/plan");
    assert.equal(response.status, 200);
    const plan = await response.json();
    assert.equal(plan.installationId, INSTALL_A);
    assert.equal(plan.planId, `plan-${INSTALL_A}`);
    assert.equal(plan.planRevision, 1);
    assert.equal(plan.configurationRevision, 1);
    assert.ok(plan.expiresAt);
    assert.ok(plan.coverage.startUtc < plan.coverage.endUtc);
    assert.deepEqual(plan.actions, [{ atUtc: plan.actions[0].atUtc, target: "domestic-hot-water", enabled: true }]);
    assert.equal(JSON.stringify(plan).includes("relay"), false);
  });

  await t.test("a second device reads only its own installation configuration and plan", async () => {
    const configResponse = await readConfig(deviceB, keysB);
    assert.equal(configResponse.status, 200);
    assert.equal((await configResponse.json()).installationId, INSTALL_B);
    const { value } = await challenge(deviceB.deviceId, deviceB.credentialId);
    const planResponse = await protectedRequest(deviceB, keysB, value, "GET", "/v1/device/plan");
    assert.equal(planResponse.status, 200);
    assert.equal((await planResponse.json()).planId, `plan-${INSTALL_B}`);
  });

  await t.test("caller cannot choose another installation or authenticate as another device", async () => {
    const selected = await miniflare.dispatchFetch(`http://localhost/v1/device/config?installationId=${INSTALL_B}`, { method: "GET" });
    assert.equal(selected.status, 400);
    const { value } = await challenge(deviceB.deviceId, deviceB.credentialId);
    const mismatchedIdentity = { ...deviceB, deviceId: deviceA.deviceId };
    const response = await protectedRequest(mismatchedIdentity, keysB, value, "GET", "/v1/device/config");
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "AUTHENTICATION_FAILED" });
  });

  await t.test("challenge cannot be replayed and two competing consumers cannot both pass", async () => {
    const { value } = await challenge(deviceA.deviceId, deviceA.credentialId);
    const competing = await Promise.all([
      protectedRequest(deviceA, keysA, value, "GET", "/v1/device/config"),
      protectedRequest(deviceA, keysA, value, "GET", "/v1/device/config"),
    ]);
    assert.deepEqual(competing.map(item => item.status).sort(), [200, 401]);
    const replay = await protectedRequest(deviceA, keysA, value, "GET", "/v1/device/config");
    assert.equal(replay.status, 401);
  });

  await t.test("method and path are bound to the canonical signature", async () => {
    const methodChallenge = (await challenge(deviceA.deviceId, deviceA.credentialId)).value;
    const getHeaders = signedHeaders(deviceA, keysA, methodChallenge, "GET", "/v1/device/config");
    const changedMethod = await miniflare.dispatchFetch("http://localhost/v1/device/config", { method: "POST", headers: getHeaders });
    assert.equal(changedMethod.status, 401);
    assert.equal((await protectedRequest(deviceA, keysA, methodChallenge, "GET", "/v1/device/config")).status, 200);

    const pathChallenge = (await challenge(deviceA.deviceId, deviceA.credentialId)).value;
    const configHeaders = signedHeaders(deviceA, keysA, pathChallenge, "GET", "/v1/device/config");
    const changedPath = await miniflare.dispatchFetch("http://localhost/v1/device/plan", { method: "GET", headers: configHeaders });
    assert.equal(changedPath.status, 401);
    assert.equal((await protectedRequest(deviceA, keysA, pathChallenge, "GET", "/v1/device/config")).status, 200);
  });

  await t.test("tampered signature is rejected without consuming a valid challenge", async () => {
    const { value } = await challenge(deviceA.deviceId, deviceA.credentialId);
    const headers = signedHeaders(deviceA, keysA, value, "GET", "/v1/device/config");
    const changedSignature = Buffer.from(headers["x-varmepuls-signature"], "base64url");
    changedSignature[0] ^= 1;
    headers["x-varmepuls-signature"] = b64url(changedSignature);
    const rejected = await miniflare.dispatchFetch("http://localhost/v1/device/config", { method: "GET", headers });
    assert.equal(rejected.status, 401);
    assert.equal((await protectedRequest(deviceA, keysA, value, "GET", "/v1/device/config")).status, 200);
  });

  await t.test("malformed and expired challenge authentication fails, and wrong client clock is irrelevant", async () => {
    const challengeValue = (await challenge(deviceA.deviceId, deviceA.credentialId)).value;
    const clientClock = "1970-01-01T00:00:00.000Z";
    assert.ok(Date.parse(challengeValue.expiresAt) > Date.now());
    assert.equal(clientClock < challengeValue.expiresAt, true);
    assert.equal((await protectedRequest(deviceA, keysA, challengeValue, "GET", "/v1/device/config")).status, 200);

    const expiredId = `expired_${crypto.randomUUID().replaceAll("-", "")}`;
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const nonceHash = createHash("sha256").update(nonce).digest("hex");
    const createdPast = new Date(Date.now() - 2000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    await db.prepare(`INSERT INTO auth_challenges
      (challenge_id,device_id,credential_id,credential_version,nonce_sha256,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?)`).bind(expiredId, deviceA.deviceId, deviceA.credentialId, 1, nonceHash, createdPast, past).run();
    const expired = { challengeId: expiredId, nonce: b64url(nonce), expiresAt: past };
    assert.equal((await protectedRequest(deviceA, keysA, expired, "GET", "/v1/device/config")).status, 401);
    const missing = await miniflare.dispatchFetch("http://localhost/v1/device/config", { method: "GET" });
    assert.equal(missing.status, 401);
  });

  await t.test("signed body digest protects rotation payload", async () => {
    const nextKeys = makeKeyPair();
    const body = JSON.stringify({ publicKey: nextKeys.publicKey });
    const { value } = await challenge(deviceA.deviceId, deviceA.credentialId);
    const headers = signedHeaders(deviceA, keysA, value, "POST", "/v1/device/rotation", Buffer.from(body));
    const tampered = JSON.stringify({ publicKey: keysB.publicKey });
    const failed = await miniflare.dispatchFetch("http://localhost/v1/device/rotation", {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: tampered,
    });
    assert.equal(failed.status, 401);
    const started = await protectedRequest(deviceA, keysA, value, "POST", "/v1/device/rotation", body);
    assert.equal(started.status, 201);
    const rotation = await started.json();
    assert.equal(rotation.credentialVersion, 2);
    assert.ok(Date.parse(rotation.confirmationExpiresAt) - Date.now() <= 10 * 60_000);
    assert.ok(Date.parse(rotation.confirmationExpiresAt) - Date.now() > 9 * 60_000);

    assert.equal((await readConfig(deviceA, keysA)).status, 200);
    const pendingIdentity = { ...deviceA, credentialId: rotation.credentialId };
    const pendingAttempt = await challenge(pendingIdentity.deviceId, pendingIdentity.credentialId);
    assert.equal(pendingAttempt.response.status, 201);
    const pendingRead = await protectedRequest(pendingIdentity, nextKeys, pendingAttempt.value, "GET", "/v1/device/config");
    assert.equal(pendingRead.status, 401);

    const confirmation = await protectedRequest(pendingIdentity, nextKeys, pendingAttempt.value,
      "POST", "/v1/device/rotation/confirm", "{}");
    assert.equal(confirmation.status, 200);
    assert.equal((await confirmation.json()).status, "confirmed");
    assert.equal((await challenge(deviceA.deviceId, deviceA.credentialId)).response.status, 401);
    const newCredential = { ...deviceA, credentialId: rotation.credentialId };
    assert.equal((await readConfig(newCredential, nextKeys)).status, 200);
    keysA = nextKeys;
    deviceA = newCredential;
  });

  await t.test("expired pending rotation preserves confirmed key and permits retry", async () => {
    const pendingKeys = makeKeyPair();
    const body = JSON.stringify({ publicKey: pendingKeys.publicKey });
    const { value } = await challenge(deviceA.deviceId, deviceA.credentialId);
    const started = await protectedRequest(deviceA, keysA, value, "POST", "/v1/device/rotation", body);
    assert.equal(started.status, 201);
    const rotation = await started.json();
    await db.prepare("UPDATE devices SET pending_expires_at=? WHERE device_id=?")
      .bind(new Date(Date.now() - 1000).toISOString(), deviceA.deviceId).run();
    assert.equal((await readConfig(deviceA, keysA)).status, 200);
    assert.equal((await challenge(deviceA.deviceId, rotation.credentialId)).response.status, 401);
    const row = await db.prepare("SELECT credential_id,credential_version,pending_credential_id FROM devices WHERE device_id=?")
      .bind(deviceA.deviceId).first();
    assert.equal(row.credential_id, deviceA.credentialId);
    assert.equal(row.credential_version, 2);
    assert.equal(row.pending_credential_id, null);
  });

  await t.test("revocation rejects existing challenges and future challenge requests", async () => {
    const { value } = await challenge(deviceB.deviceId, deviceB.credentialId);
    await db.prepare("UPDATE devices SET status='revoked',revoked_at=? WHERE device_id=?")
      .bind(nowUtc(), deviceB.deviceId).run();
    const read = await protectedRequest(deviceB, keysB, value, "GET", "/v1/device/config");
    assert.equal(read.status, 401);
    assert.deepEqual(await read.json(), { error: "AUTHENTICATION_FAILED" });
    assert.equal((await challenge(deviceB.deviceId, deviceB.credentialId)).response.status, 401);
    assert.equal((await readConfig(deviceA, keysA)).status, 200);
  });

  await t.test("bounded cleanup removes only expired auth state, never device/config/plan identity", async () => {
    const expiredInvitation = await createInvitation(INSTALL_A, { expired: true });
    const expiredChallenge = `cleanup_${crypto.randomUUID().replaceAll("-", "")}`;
    const expiredCreated = new Date(Date.now() - 5000).toISOString();
    const past = new Date(Date.now() - 4000).toISOString();
    await db.prepare(`INSERT INTO auth_challenges
      (challenge_id,device_id,credential_id,credential_version,nonce_sha256,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?)`).bind(expiredChallenge, deviceA.deviceId, deviceA.credentialId, 2,
        "a".repeat(64), expiredCreated, past).run();
    assert.equal((await challenge(deviceA.deviceId, deviceA.credentialId)).response.status, 201);
    assert.equal(await db.prepare("SELECT enrollment_id FROM enrollment_capabilities WHERE enrollment_id=?")
      .bind(expiredInvitation.enrollmentId).first(), null);
    assert.equal(await db.prepare("SELECT challenge_id FROM auth_challenges WHERE challenge_id=?")
      .bind(expiredChallenge).first(), null);
    assert.ok(await db.prepare("SELECT device_id FROM devices WHERE device_id=? AND status='active'")
      .bind(deviceA.deviceId).first());
    assert.ok(await db.prepare("SELECT installation_id FROM installation_config WHERE installation_id=?")
      .bind(INSTALL_A).first());
    assert.ok(await db.prepare("SELECT installation_id FROM plan_revisions WHERE installation_id=?")
      .bind(INSTALL_A).first());
  });
});
