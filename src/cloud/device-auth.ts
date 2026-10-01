import { canonicalDeviceRequest } from "../security/canonical-request.ts";
import { consumeChallenge } from "../security/challenge-consume.ts";

const PROTOCOL_VERSION = "varmepuls-device-auth-v1";
const CHALLENGE_LIFETIME_MS = 120_000;
const ROTATION_LIFETIME_MS = 10 * 60_000;
const MAX_OUTSTANDING_CHALLENGES = 3;
const MAX_BODY_BYTES = 8192;
const CLEANUP_BATCH_SIZE = 100;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const AUTH_FAILURE = () => json({ error: "AUTHENTICATION_FAILED" }, 401);
const INVALID_REQUEST = () => json({ error: "INVALID_REQUEST" }, 400);

type AuthEnv = Env & { LOCAL_AUTH_HTTP_TEST?: string };
type AuthDatabase = D1Database;
type KeyKind = "current" | "pending";
interface DeviceRow {
  device_id: string;
  installation_id: string;
  credential_id: string;
  public_key_b64url: string;
  credential_version: number;
  status: "active" | "revoked";
  pending_credential_id: string | null;
  pending_public_key_b64url: string | null;
  pending_version: number | null;
  pending_expires_at: string | null;
}
interface AuthenticatedDevice {
  deviceId: string;
  installationId: string;
  credentialId: string;
  credentialVersion: number;
  keyKind: KeyKind;
  publicKey: string;
  body: Uint8Array;
}

const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value);
const validInstant = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: JSON_HEADERS });
const genericFailure = (): Response => json({ error: "REQUEST_FAILED" }, 401);
const serverNow = (): string => new Date().toISOString();
function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

const opaqueId = (): string => encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));

function decodeBase64Url(value: unknown, exactBytes?: number): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    const result = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index);
    if (encodeBase64Url(result) !== value || (exactBytes !== undefined && result.byteLength !== exactBytes)) return null;
    return result;
  } catch {
    return null;
  }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy)));
}

/** Exported for bounded local test/operator setup; this is not a public route. */
export async function enrollmentCapabilityVerifier(enrollmentId: string, capability: string): Promise<string> {
  return sha256Hex(encoder.encode(`varmepuls-enrollment-capability-v1\0${enrollmentId}\0${capability}`));
}

function isSecureTransport(request: Request, env: AuthEnv): boolean {
  const url = new URL(request.url);
  if (url.protocol === "https:") return true;
  return env.LOCAL_AUTH_HTTP_TEST === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

async function readBody(request: Request): Promise<Uint8Array | null> {
  try {
    const body = new Uint8Array(await request.arrayBuffer());
    return body.byteLength <= MAX_BODY_BYTES ? body : null;
  } catch {
    return null;
  }
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function jsonContentType(request: Request): boolean {
  return (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() === "application/json";
}

/** Bounded, opportunistic cleanup. It never touches installation, config, plan, or device rows. */
export async function cleanupDeviceAuthState(db: AuthDatabase, nowUtc: string): Promise<void> {
  if (!validInstant(nowUtc)) throw new TypeError("Invalid server time.");
  await db.batch([
    db.prepare(`DELETE FROM enrollment_capabilities
      WHERE enrollment_id IN (
        SELECT enrollment_id FROM enrollment_capabilities
        WHERE consumed_at IS NOT NULL OR expires_at <= ?
        ORDER BY expires_at LIMIT ?
      )`).bind(nowUtc, CLEANUP_BATCH_SIZE),
    db.prepare(`DELETE FROM auth_challenges
      WHERE challenge_id IN (
        SELECT challenge_id FROM auth_challenges
        WHERE consumed_at IS NOT NULL OR expires_at <= ?
        ORDER BY expires_at LIMIT ?
      )`).bind(nowUtc, CLEANUP_BATCH_SIZE),
    db.prepare(`UPDATE devices SET pending_credential_id = NULL, pending_public_key_b64url = NULL,
        pending_version = NULL, pending_expires_at = NULL
      WHERE device_id IN (
        SELECT device_id FROM devices
        WHERE pending_expires_at IS NOT NULL AND pending_expires_at <= ?
        ORDER BY pending_expires_at LIMIT ?
      )`).bind(nowUtc, CLEANUP_BATCH_SIZE),
  ]);
}

async function consumeEnrollment(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== "POST" || !isSecureTransport(request, env) || !jsonContentType(request)) return INVALID_REQUEST();
  const bytes = await readBody(request);
  if (!bytes) return INVALID_REQUEST();
  const body = parseJson(bytes);
  if (!exactKeys(body, ["enrollmentId", "capability", "publicKey"]) ||
      !validId(body.enrollmentId) || typeof body.capability !== "string" || typeof body.publicKey !== "string" ||
      decodeBase64Url(body.capability, 32) === null || decodeBase64Url(body.publicKey, 32) === null) return INVALID_REQUEST();

  const now = serverNow();
  const verifier = await enrollmentCapabilityVerifier(body.enrollmentId, body.capability);
  const enrollment = await env.VARMEPULS_STATE_DB.prepare(`SELECT verifier_sha256, expires_at, consumed_at
      FROM enrollment_capabilities WHERE enrollment_id = ?`)
    .bind(body.enrollmentId).first<{ verifier_sha256: string; expires_at: string; consumed_at: string | null }>();
  if (!enrollment || enrollment.consumed_at !== null || enrollment.expires_at <= now ||
      !constantTimeHexEqual(enrollment.verifier_sha256, verifier)) return genericFailure();

  const deviceId = opaqueId();
  const credentialId = opaqueId();
  const results = await env.VARMEPULS_STATE_DB.batch([
    env.VARMEPULS_STATE_DB.prepare(`UPDATE enrollment_capabilities
      SET consumed_at = ?, consumed_device_id = ?
      WHERE enrollment_id = ? AND verifier_sha256 = ? AND consumed_at IS NULL AND expires_at > ?`)
      .bind(now, deviceId, body.enrollmentId, verifier, now),
    env.VARMEPULS_STATE_DB.prepare(`INSERT INTO devices
      (device_id, installation_id, credential_id, public_key_b64url, credential_version, status, created_at)
      SELECT ?, installation_id, ?, ?, 1, 'active', ? FROM enrollment_capabilities
      WHERE enrollment_id = ? AND consumed_at = ? AND consumed_device_id = ? AND verifier_sha256 = ?`)
      .bind(deviceId, credentialId, body.publicKey, now, body.enrollmentId, now, deviceId, verifier),
  ]);
  if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) return genericFailure();
  const enrolled = await env.VARMEPULS_STATE_DB.prepare(`SELECT installation_id FROM devices WHERE device_id = ?`)
    .bind(deviceId).first<{ installation_id: string }>();
  if (!enrolled) return genericFailure();
  return json({ deviceId, installationId: enrolled.installation_id, credentialId, credentialVersion: 1 }, 201);
}

interface CredentialSelector extends DeviceRow {
  selectedVersion: number;
  selectedKey: string;
  keyKind: KeyKind;
}

async function selectChallengeCredential(db: AuthDatabase, deviceId: string, credentialId: string,
  now: string): Promise<CredentialSelector | null> {
  const row = await db.prepare(`SELECT * FROM devices WHERE device_id = ? AND status = 'active' AND
      (credential_id = ? OR (pending_credential_id = ? AND pending_expires_at > ?))`)
    .bind(deviceId, credentialId, credentialId, now).first<DeviceRow>();
  if (!row) return null;
  if (row.credential_id === credentialId) return { ...row, selectedVersion: row.credential_version,
    selectedKey: row.public_key_b64url, keyKind: "current" };
  if (row.pending_credential_id === credentialId && row.pending_version !== null && row.pending_public_key_b64url) {
    return { ...row, selectedVersion: row.pending_version, selectedKey: row.pending_public_key_b64url,
      keyKind: "pending" };
  }
  return null;
}

async function createChallenge(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== "POST" || !isSecureTransport(request, env) || !jsonContentType(request)) return INVALID_REQUEST();
  const bytes = await readBody(request);
  if (!bytes) return INVALID_REQUEST();
  const body = parseJson(bytes);
  if (!exactKeys(body, ["deviceId", "credentialId"]) || !validId(body.deviceId) || !validId(body.credentialId)) {
    return INVALID_REQUEST();
  }
  const now = serverNow();
  const selector = await selectChallengeCredential(env.VARMEPULS_STATE_DB, body.deviceId, body.credentialId, now);
  if (!selector) return AUTH_FAILURE();

  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const nonceBase64Url = encodeBase64Url(nonce);
  const nonceSha256 = await sha256Hex(nonce);
  const challengeId = opaqueId();
  const expiresAt = new Date(Date.parse(now) + CHALLENGE_LIFETIME_MS).toISOString();
  const inserted = await env.VARMEPULS_STATE_DB.prepare(`INSERT INTO auth_challenges
      (challenge_id, device_id, credential_id, credential_version, nonce_sha256, created_at, expires_at)
    SELECT ?, d.device_id, ?, ?, ?, ?, ? FROM devices d
    WHERE d.device_id = ? AND d.status = 'active' AND
      ((d.credential_id = ? AND d.credential_version = ?) OR
       (d.pending_credential_id = ? AND d.pending_version = ? AND d.pending_expires_at > ?))
      AND (SELECT COUNT(*) FROM auth_challenges c WHERE c.device_id = d.device_id
        AND c.credential_id = ? AND c.credential_version = ?
        AND c.consumed_at IS NULL AND c.expires_at > ?) < ?`)
    .bind(challengeId, body.credentialId, selector.selectedVersion, nonceSha256, now, expiresAt,
      body.deviceId, body.credentialId, selector.selectedVersion, body.credentialId,
      selector.selectedVersion, now, body.credentialId, selector.selectedVersion, now,
      MAX_OUTSTANDING_CHALLENGES).run();
  if (!inserted.success || inserted.meta?.changes !== 1) return AUTH_FAILURE();
  return json({ challengeId, nonce: nonceBase64Url, expiresAt }, 201);
}

async function authenticate(request: Request, env: AuthEnv, rawBody: Uint8Array): Promise<AuthenticatedDevice | null> {
  const url = new URL(request.url);
  if (url.search || url.hash || !isSecureTransport(request, env)) return null;
  const deviceId = request.headers.get("x-varmepuls-device-id");
  const credentialId = request.headers.get("x-varmepuls-credential-id");
  const challengeId = request.headers.get("x-varmepuls-challenge-id");
  const nonceBase64Url = request.headers.get("x-varmepuls-nonce");
  const signature = decodeBase64Url(request.headers.get("x-varmepuls-signature"), 64);
  const nonce = decodeBase64Url(nonceBase64Url, 32);
  if (!validId(deviceId) || !validId(credentialId) || !validId(challengeId) || !nonce || !signature) return null;

  const now = serverNow();
  const selector = await selectChallengeCredential(env.VARMEPULS_STATE_DB, deviceId, credentialId, now);
  if (!selector) return null;
  const isConfirmPath = url.pathname === "/v1/device/rotation/confirm";
  if ((selector.keyKind === "pending") !== isConfirmPath) return null;

  const challenge = await env.VARMEPULS_STATE_DB.prepare(`SELECT nonce_sha256 FROM auth_challenges
      WHERE challenge_id = ? AND device_id = ? AND credential_id = ? AND credential_version = ?
        AND consumed_at IS NULL AND expires_at > ?`)
    .bind(challengeId, deviceId, credentialId, selector.selectedVersion, now)
    .first<{ nonce_sha256: string }>();
  if (!challenge || !constantTimeHexEqual(challenge.nonce_sha256, await sha256Hex(nonce))) return null;

  let validSignature = false;
  try {
    const publicKeyBytes = decodeBase64Url(selector.selectedKey, 32);
    if (!publicKeyBytes) return null;
    const key = await crypto.subtle.importKey("raw", new Uint8Array(publicKeyBytes), { name: "Ed25519" }, false, ["verify"]);
    const bodySha256Hex = await sha256Hex(rawBody);
    const canonical = canonicalDeviceRequest({ protocolVersion: PROTOCOL_VERSION, deviceId, credentialId,
      challengeId, nonceBase64Url: nonceBase64Url!, method: request.method,
      normalizedPath: url.pathname, bodySha256Hex });
    validSignature = await crypto.subtle.verify({ name: "Ed25519" }, key,
      new Uint8Array(signature), new Uint8Array(canonical));
  } catch {
    return null;
  }
  if (!validSignature) return null;

  const consumed = await consumeChallenge(env.VARMEPULS_STATE_DB, {
    challengeId, nonceSha256: challenge.nonce_sha256, deviceId, credentialId,
    credentialVersion: selector.selectedVersion, serverNowUtc: serverNow(),
  });
  if (consumed !== "consumed") return null;
  return { deviceId, installationId: selector.installation_id, credentialId,
    credentialVersion: selector.selectedVersion, keyKind: selector.keyKind,
    publicKey: selector.selectedKey, body: rawBody };
}

function parseAuthenticatedJson(auth: AuthenticatedDevice): Record<string, unknown> | null {
  if (auth.body.byteLength === 0) return {};
  return parseJson(auth.body);
}

async function readConfig(request: Request, env: AuthEnv): Promise<Response> {
  const body = await readBody(request);
  if (!body) return INVALID_REQUEST();
  const auth = await authenticate(request, env, body);
  if (!auth) return AUTH_FAILURE();
  if (request.method !== "GET" || auth.keyKind !== "current" || body.byteLength !== 0) return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const row = await env.VARMEPULS_STATE_DB.prepare(`SELECT revision, config_json, updated_at
      FROM installation_config WHERE installation_id = ?`)
    .bind(auth.installationId).first<{ revision: number; config_json: string; updated_at: string }>();
  if (!row) return json({ error: "NOT_FOUND" }, 404);
  try {
    return json({ installationId: auth.installationId, revision: row.revision,
      updatedAt: row.updated_at, configuration: JSON.parse(row.config_json) });
  } catch {
    return json({ error: "STATE_UNAVAILABLE" }, 503);
  }
}

async function readPlan(request: Request, env: AuthEnv): Promise<Response> {
  const body = await readBody(request);
  if (!body) return INVALID_REQUEST();
  const auth = await authenticate(request, env, body);
  if (!auth) return AUTH_FAILURE();
  if (request.method !== "GET" || auth.keyKind !== "current" || body.byteLength !== 0) return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const now = serverNow();
  const row = await env.VARMEPULS_STATE_DB.prepare(`SELECT revision, plan_id, config_revision, created_at,
      valid_from, expires_at, zone, coverage_start_utc, coverage_end_utc, actions_json
    FROM plan_revisions WHERE installation_id = ? AND expires_at > ?
    ORDER BY revision DESC LIMIT 1`)
    .bind(auth.installationId, now).first<{
      revision: number; plan_id: string; config_revision: number; created_at: string; valid_from: string;
      expires_at: string; zone: string; coverage_start_utc: string; coverage_end_utc: string; actions_json: string;
    }>();
  if (!row) return json({ error: "NOT_FOUND" }, 404);
  try {
    return json({ installationId: auth.installationId, planId: row.plan_id, planRevision: row.revision,
      configurationRevision: row.config_revision, createdAt: row.created_at, validFrom: row.valid_from,
      expiresAt: row.expires_at, zone: row.zone, coverage: { startUtc: row.coverage_start_utc, endUtc: row.coverage_end_utc },
      actions: JSON.parse(row.actions_json) });
  } catch {
    return json({ error: "STATE_UNAVAILABLE" }, 503);
  }
}

async function startRotation(request: Request, env: AuthEnv): Promise<Response> {
  const body = await readBody(request);
  if (!body) return INVALID_REQUEST();
  const auth = await authenticate(request, env, body);
  if (!auth) return AUTH_FAILURE();
  if (request.method !== "POST" || auth.keyKind !== "current" || !jsonContentType(request)) return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const value = parseAuthenticatedJson(auth);
  if (!exactKeys(value, ["publicKey"]) || decodeBase64Url(value.publicKey, 32) === null) return INVALID_REQUEST();
  const now = serverNow();
  const expiresAt = new Date(Date.parse(now) + ROTATION_LIFETIME_MS).toISOString();
  const credentialId = opaqueId();
  const version = auth.credentialVersion + 1;
  const updated = await env.VARMEPULS_STATE_DB.prepare(`UPDATE devices SET pending_credential_id = ?,
      pending_public_key_b64url = ?, pending_version = ?, pending_expires_at = ?
    WHERE device_id = ? AND installation_id = ? AND status = 'active' AND credential_id = ?
      AND credential_version = ? AND pending_credential_id IS NULL`)
    .bind(credentialId, value.publicKey, version, expiresAt, auth.deviceId, auth.installationId,
      auth.credentialId, auth.credentialVersion).run();
  if (!updated.success || updated.meta?.changes !== 1) return json({ error: "ROTATION_UNAVAILABLE" }, 409);
  return json({ credentialId, credentialVersion: version, confirmationExpiresAt: expiresAt }, 201);
}

async function confirmRotation(request: Request, env: AuthEnv): Promise<Response> {
  const body = await readBody(request);
  if (!body) return INVALID_REQUEST();
  const auth = await authenticate(request, env, body);
  if (!auth) return AUTH_FAILURE();
  if (request.method !== "POST" || auth.keyKind !== "pending" || !jsonContentType(request)) return AUTH_FAILURE();
  const value = parseAuthenticatedJson(auth);
  if (!exactKeys(value, [])) return INVALID_REQUEST();
  const now = serverNow();
  const promoted = await env.VARMEPULS_STATE_DB.prepare(`UPDATE devices SET
      credential_id = pending_credential_id, public_key_b64url = pending_public_key_b64url,
      credential_version = pending_version, pending_credential_id = NULL,
      pending_public_key_b64url = NULL, pending_version = NULL, pending_expires_at = NULL
    WHERE device_id = ? AND installation_id = ? AND status = 'active'
      AND pending_credential_id = ? AND pending_version = ? AND pending_expires_at > ?`)
    .bind(auth.deviceId, auth.installationId, auth.credentialId, auth.credentialVersion, now).run();
  if (!promoted.success || promoted.meta?.changes !== 1) return AUTH_FAILURE();
  return json({ deviceId: auth.deviceId, credentialId: auth.credentialId,
    credentialVersion: auth.credentialVersion, status: "confirmed" });
}

export async function fetchDeviceAuth(request: Request, env: AuthEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const knownPath = path === "/v1/enrollments/consume" || path === "/v1/device/challenges" ||
    path === "/v1/device/config" || path === "/v1/device/plan" ||
    path === "/v1/device/rotation" || path === "/v1/device/rotation/confirm";
  if (!knownPath) return null;
  if (new URL(request.url).search || new URL(request.url).hash) return INVALID_REQUEST();
  try {
    await cleanupDeviceAuthState(env.VARMEPULS_STATE_DB, serverNow());
    if (path === "/v1/enrollments/consume") return await consumeEnrollment(request, env);
    if (path === "/v1/device/challenges") return await createChallenge(request, env);
    if (path === "/v1/device/config") return await readConfig(request, env);
    if (path === "/v1/device/plan") return await readPlan(request, env);
    if (path === "/v1/device/rotation") return await startRotation(request, env);
    if (path === "/v1/device/rotation/confirm") return await confirmRotation(request, env);
    return null;
  } catch {
    return json({ error: "AUTH_SERVICE_UNAVAILABLE" }, 503);
  }
}
