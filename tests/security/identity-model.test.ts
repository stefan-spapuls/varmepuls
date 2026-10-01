import test from "node:test";
import assert from "node:assert/strict";
import { OfflineIdentityModel, type DevicePrincipal } from "../../src/security/identity-model.ts";

const t0 = "2026-10-01T12:00:00.000Z";
const t1 = "2026-10-01T12:01:00.000Z";
const t2 = "2026-10-01T12:06:00.000Z";
const expiry = "2026-10-01T12:05:00.000Z";
const proofFor = (verifier: string) => `synthetic-proof:${verifier}`;

function setup() {
  let id = 0;
  const model = new OfflineIdentityModel((kind, proof, verifier) =>
    kind === "enrollment" ? proof === verifier : proof === proofFor(verifier),
  () => `opaque_id_${++id}`);
  assert.equal(model.addInstallation("installation_A", { rev: 1 }, { plan: "A-only" }), true);
  assert.equal(model.addInstallation("installation_B", { rev: 9 }, { plan: "B-only" }), true);
  return model;
}

function enroll(model: OfflineIdentityModel, installationId: string, enrollmentId: string, code: string, key: string, now = t0) {
  const expiresAt = now < expiry ? expiry : "2026-10-01T12:10:00.000Z";
  assert.equal(model.createEnrollment({ id: enrollmentId, installationId, verifier: code, expiresAt }), true);
  const result = model.consumeEnrollment({ enrollmentId, proof: code, now, publicKeyVerifier: key });
  assert.equal(result.status, "enrolled");
  if (result.status !== "enrolled") throw new Error("test setup enrollment failed");
  return { ...result, auth: model.authenticate(result.credentialId, proofFor(key), now) };
}

function principal(result: ReturnType<OfflineIdentityModel["authenticate"]>): DevicePrincipal {
  assert.equal(result.status, "authenticated");
  if (result.status !== "authenticated") throw new Error("expected synthetic device authentication");
  return result.principal;
}

test("each successful enrollment receives a unique opaque device and credential identity", () => {
  const model = setup();
  const a = enroll(model, "installation_A", "enrollment_A", "synthetic-code-A", "synthetic-public-key-A");
  const b = enroll(model, "installation_A", "enrollment_B", "synthetic-code-B", "synthetic-public-key-B");
  assert.notEqual(a.deviceId, b.deviceId);
  assert.notEqual(a.credentialId, b.credentialId);
  assert.equal(a.auth.status, "authenticated");
  assert.equal(b.auth.status, "authenticated");
});

test("a device is bound to exactly the installation attached to its enrollment", () => {
  const model = setup();
  const result = enroll(model, "installation_A", "enrollment_A", "code-A", "key-A");
  assert.equal(principal(result.auth).installationId, "installation_A");
});

test("valid Device A proof authenticates Device A", () => {
  const model = setup();
  const a = enroll(model, "installation_A", "enrollment_A", "code-A", "key-A");
  assert.equal(model.authenticate(a.credentialId, proofFor("key-A"), t0).status, "authenticated");
});

test("invalid device credential proof is rejected", () => {
  const model = setup();
  const a = enroll(model, "installation_A", "enrollment_A", "code-A", "key-A");
  assert.deepEqual(model.authenticate(a.credentialId, "wrong-proof", t0), { status: "unauthorized" });
});

test("Device A cannot authenticate as Device B", () => {
  const model = setup();
  const a = enroll(model, "installation_A", "enrollment_A", "code-A", "key-A");
  const b = enroll(model, "installation_B", "enrollment_B", "code-B", "key-B");
  assert.deepEqual(model.authenticate(b.credentialId, proofFor("key-A"), t0), { status: "unauthorized" });
  assert.equal(model.authenticate(a.credentialId, proofFor("key-A"), t0).status, "authenticated");
});

test("Device A cannot read or mutate Installation B", () => {
  const model = setup();
  const a = enroll(model, "installation_A", "enrollment_A", "code-A", "key-A");
  const p = principal(a.auth);
  assert.deepEqual(model.readConfig(p, t0, "installation_B"), { status: "forbidden" });
  assert.deepEqual(model.readPlan(p, t0, "installation_B"), { status: "forbidden" });
  assert.equal(model.writeConfig(p, "installation_B", { rev: 100 }, t0), "forbidden");
  assert.deepEqual(model.readConfig(p, t0), { status: "ok", value: { rev: 1 } });
});

test("revoking one device immediately rejects its credential without revoking another device", () => {
  const model = setup();
  const a = enroll(model, "installation_A", "enrollment_A", "code-A", "key-A");
  const b = enroll(model, "installation_A", "enrollment_B", "code-B", "key-B");
  assert.equal(model.revokeDevice("installation_A", a.deviceId), true);
  assert.equal(model.authenticate(a.credentialId, proofFor("key-A"), t0).status, "unauthorized");
  assert.equal(model.authenticate(b.credentialId, proofFor("key-B"), t0).status, "authenticated");
  assert.equal(model.revokeDevice("installation_B", b.deviceId), false);
});

test("expired enrollment creates no trusted device", () => {
  const model = setup();
  assert.equal(model.createEnrollment({ id: "enrollment_A", installationId: "installation_A", verifier: "code-A", expiresAt: expiry }), true);
  assert.deepEqual(model.consumeEnrollment({ enrollmentId: "enrollment_A", proof: "code-A", now: expiry, publicKeyVerifier: "key-A" }), { status: "expired" });
  assert.equal(model.authenticate("opaque_id_2", proofFor("key-A"), expiry).status, "unauthorized");
});

test("enrollment capability succeeds once and replay is rejected", () => {
  const model = setup();
  assert.equal(model.createEnrollment({ id: "enrollment_A", installationId: "installation_A", verifier: "code-A", expiresAt: expiry }), true);
  const first = model.consumeEnrollment({ enrollmentId: "enrollment_A", proof: "code-A", now: t0, publicKeyVerifier: "key-A" });
  assert.equal(first.status, "enrolled");
  assert.deepEqual(model.consumeEnrollment({ enrollmentId: "enrollment_A", proof: "code-A", now: t1, publicKeyVerifier: "key-replay" }), { status: "used" });
});

test("failed enrollment proof creates no trusted device and does not consume the invitation", () => {
  const model = setup();
  assert.equal(model.createEnrollment({ id: "enrollment_A", installationId: "installation_A", verifier: "code-A", expiresAt: expiry }), true);
  assert.deepEqual(model.consumeEnrollment({ enrollmentId: "enrollment_A", proof: "wrong", now: t0, publicKeyVerifier: "key-A" }), { status: "invalid" });
  const valid = model.consumeEnrollment({ enrollmentId: "enrollment_A", proof: "code-A", now: t0, publicKeyVerifier: "key-A" });
  assert.equal(valid.status, "enrolled");
});

test("enrollment binds to the installation in the invitation, not a caller-supplied target", () => {
  const model = setup();
  const result = enroll(model, "installation_A", "enrollment_A", "code-A", "key-A");
  assert.equal(principal(result.auth).installationId, "installation_A");
  assert.deepEqual(model.readConfig(principal(result.auth), t0, "installation_B"), { status: "forbidden" });
});

test("confirmed credential rotation immediately invalidates the old credential", () => {
  const model = setup();
  const a = enroll(model, "installation_A", "enrollment_A", "code-A", "key-A");
  const oldPrincipal = principal(a.auth);
  assert.equal(model.beginRotation(oldPrincipal, "new_credential_A", "key-A2", expiry, t0), true);
  assert.equal(model.authenticate("new_credential_A", proofFor("key-A2"), t1).status, "authenticated");
  assert.equal(model.confirmRotation("new_credential_A", proofFor("key-A2"), t1), true);
  assert.equal(model.authenticate(a.credentialId, proofFor("key-A"), t1).status, "unauthorized");
  assert.equal(model.authenticate("new_credential_A", proofFor("key-A2"), t1).status, "authenticated");
});

test("interrupted rotation expires only the pending key and permits deterministic retry", () => {
  const model = setup();
  const a = enroll(model, "installation_A", "enrollment_A", "code-A", "key-A");
  assert.equal(model.beginRotation(principal(a.auth), "new_credential_A", "key-A2", expiry, t0), true);
  assert.equal(model.authenticate(a.credentialId, proofFor("key-A"), expiry).status, "authenticated");
  assert.equal(model.authenticate("new_credential_A", proofFor("key-A2"), t2).status, "unauthorized");
  const oldPrincipal = principal(model.authenticate(a.credentialId, proofFor("key-A"), t2));
  assert.equal(model.beginRotation(oldPrincipal, "retry_credential_A", "key-A3", "2026-10-01T12:10:00.000Z", t2), true);
  assert.equal(model.confirmRotation("retry_credential_A", proofFor("key-A3"), "2026-10-01T12:07:00.000Z"), true);
  assert.equal(model.authenticate(a.credentialId, proofFor("key-A"), "2026-10-01T12:07:00.000Z").status, "unauthorized");
  assert.equal(model.authenticate("retry_credential_A", proofFor("key-A3"), "2026-10-01T12:07:00.000Z").status, "authenticated");
});

test("malformed authentication inputs are rejected", () => {
  const model = setup();
  assert.deepEqual(model.authenticate("bad id", "proof", t0), { status: "unauthorized" });
  assert.deepEqual(model.authenticate("credential_123", "", t0), { status: "unauthorized" });
  assert.deepEqual(model.authenticate("credential_123", "proof", "not-a-time"), { status: "unauthorized" });
  assert.deepEqual(model.authenticate("credential_123", "x".repeat(2049), t0), { status: "unauthorized" });
});

test("plan lookup derives installation scope from authenticated identity", () => {
  const model = setup();
  const a = enroll(model, "installation_A", "enrollment_A", "code-A", "key-A");
  const p = principal(a.auth);
  assert.deepEqual(model.readPlan(p, t0), { status: "ok", value: { plan: "A-only" } });
  assert.deepEqual(model.readPlan(p, t0, "installation_B"), { status: "forbidden" });
});

test("revocation invalidates an already-authenticated request context", () => {
  const model = setup();
  const a = enroll(model, "installation_A", "enrollment_A", "code-A", "key-A");
  const p = principal(a.auth);
  assert.equal(model.revokeDevice("installation_A", a.deviceId), true);
  assert.deepEqual(model.readPlan(p, t0), { status: "unauthorized" });
});
