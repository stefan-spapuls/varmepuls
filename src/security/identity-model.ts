/**
 * Offline authorization policy model only. This is not production
 * authentication, credential storage, token generation, or cryptography.
 */
export type ProofKind = "enrollment" | "device";
export type ProofVerifier = (kind: ProofKind, proof: string, verifier: string) => boolean;
export type DeviceScope = "config:read" | "plan:read";

export interface DevicePrincipal {
  readonly deviceId: string;
  readonly installationId: string;
  readonly credentialId: string;
  readonly credentialVersion: number;
  readonly scopes: readonly DeviceScope[];
}

type Credential = { id: string; verifier: string; version: number };
type PendingRotation = { credential: Credential; expiresAt: string };
type Device = {
  id: string;
  installationId: string;
  status: "active" | "revoked" | "recovery_required";
  credential: Credential;
  pendingRotation?: PendingRotation;
};
type Enrollment = { id: string; installationId: string; verifier: string; expiresAt: string; consumed: boolean };
type InstallationState = { config: unknown; plan: unknown };

export type EnrollmentResult =
  | { status: "enrolled"; deviceId: string; credentialId: string }
  | { status: "invalid" | "expired" | "used" | "not_found" };
export type AuthResult = { status: "authenticated"; principal: DevicePrincipal } | { status: "unauthorized" };
export type AccessResult<T> = { status: "ok"; value: T } | { status: "unauthorized" | "forbidden" | "not_found" };

const instant = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const opaqueId = (value: string) => /^[A-Za-z0-9_-]{8,80}$/.test(value);

export class OfflineIdentityModel {
  private readonly installations = new Map<string, InstallationState>();
  private readonly enrollments = new Map<string, Enrollment>();
  private readonly devices = new Map<string, Device>();
  private readonly verify: ProofVerifier;
  private readonly nextOpaqueId: () => string;

  constructor(verify: ProofVerifier, nextOpaqueId: () => string) {
    this.verify = verify;
    this.nextOpaqueId = nextOpaqueId;
  }

  addInstallation(installationId: string, config: unknown, plan: unknown): boolean {
    if (!opaqueId(installationId) || this.installations.has(installationId)) return false;
    this.installations.set(installationId, { config, plan });
    return true;
  }

  /** Test fixture equivalent of an authorized owner creating a short-lived invitation. */
  createEnrollment(input: { id: string; installationId: string; verifier: string; expiresAt: string }): boolean {
    if (!opaqueId(input.id) || !this.installations.has(input.installationId) || !input.verifier ||
        !instant(input.expiresAt) || this.enrollments.has(input.id)) return false;
    this.enrollments.set(input.id, { ...input, consumed: false });
    return true;
  }

  consumeEnrollment(input: {
    enrollmentId: string; proof: string; now: string; publicKeyVerifier: string;
  }): EnrollmentResult {
    if (!opaqueId(input.enrollmentId) || !input.proof || !instant(input.now) || !input.publicKeyVerifier ||
        input.publicKeyVerifier.length > 256) return { status: "invalid" };
    const enrollment = this.enrollments.get(input.enrollmentId);
    if (!enrollment) return { status: "not_found" };
    if (enrollment.consumed) return { status: "used" };
    if (input.now >= enrollment.expiresAt) return { status: "expired" };
    if (!this.verify("enrollment", input.proof, enrollment.verifier)) return { status: "invalid" };

    const deviceId = this.nextOpaqueId();
    const credentialId = this.nextOpaqueId();
    if (!opaqueId(deviceId) || !opaqueId(credentialId) || this.devices.has(deviceId) ||
        [...this.devices.values()].some(device => device.credential.id === credentialId || device.pendingRotation?.credential.id === credentialId)) {
      return { status: "invalid" };
    }
    this.devices.set(deviceId, {
      id: deviceId,
      installationId: enrollment.installationId,
      status: "active",
      credential: { id: credentialId, verifier: input.publicKeyVerifier, version: 1 },
    });
    enrollment.consumed = true;
    return { status: "enrolled", deviceId, credentialId };
  }

  authenticate(credentialId: string, proof: string, now: string): AuthResult {
    if (!opaqueId(credentialId) || !proof || proof.length > 2048 || !instant(now)) return { status: "unauthorized" };
    const device = [...this.devices.values()].find(candidate =>
      candidate.credential.id === credentialId || candidate.pendingRotation?.credential.id === credentialId);
    if (!device) return { status: "unauthorized" };
    this.expireInterruptedRotation(device, now);
    if (device.status !== "active") return { status: "unauthorized" };
    const credential = device.credential.id === credentialId ? device.credential : device.pendingRotation?.credential;
    if (!credential || !this.verify("device", proof, credential.verifier)) return { status: "unauthorized" };
    return { status: "authenticated", principal: {
      deviceId: device.id,
      installationId: device.installationId,
      credentialId,
      credentialVersion: credential.version,
      scopes: ["config:read", "plan:read"],
    } };
  }

  readConfig(principal: DevicePrincipal, now: string, requestedInstallationId?: string): AccessResult<unknown> {
    const device = this.authorizePrincipal(principal, "config:read", now);
    if (!device) return { status: "unauthorized" };
    if (requestedInstallationId !== undefined && requestedInstallationId !== device.installationId) return { status: "forbidden" };
    const installation = this.installations.get(device.installationId);
    return installation ? { status: "ok", value: structuredClone(installation.config) } : { status: "not_found" };
  }

  readPlan(principal: DevicePrincipal, now: string, requestedInstallationId?: string): AccessResult<unknown> {
    const device = this.authorizePrincipal(principal, "plan:read", now);
    if (!device) return { status: "unauthorized" };
    if (requestedInstallationId !== undefined && requestedInstallationId !== device.installationId) return { status: "forbidden" };
    const installation = this.installations.get(device.installationId);
    return installation ? { status: "ok", value: structuredClone(installation.plan) } : { status: "not_found" };
  }

  /** Device principals have no configuration-write scope. */
  writeConfig(principal: DevicePrincipal, targetInstallationId: string, _config: unknown, now: string): "forbidden" | "unauthorized" {
    const device = this.authorizePrincipal(principal, "config:read", now);
    if (!device) return "unauthorized";
    if (targetInstallationId !== device.installationId) return "forbidden";
    // The device role has no config:write scope, even within its own installation.
    return "forbidden";
  }

  revokeDevice(installationId: string, deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    if (!device || device.installationId !== installationId) return false;
    device.status = "revoked";
    delete device.pendingRotation;
    return true;
  }

  beginRotation(principal: DevicePrincipal, newCredentialId: string, newVerifier: string, expiresAt: string, now: string): boolean {
    const device = this.authorizePrincipal(principal, "config:read", now);
    if (!device || device.pendingRotation || !opaqueId(newCredentialId) || !newVerifier || !instant(now) ||
        !instant(expiresAt) || expiresAt <= now || expiresAt > new Date(Date.parse(now) + 10 * 60_000).toISOString() ||
        this.findCredential(newCredentialId)) return false;
    device.pendingRotation = { credential: { id: newCredentialId, verifier: newVerifier, version: device.credential.version + 1 }, expiresAt };
    return true;
  }

  confirmRotation(credentialId: string, proof: string, now: string): boolean {
    const auth = this.authenticate(credentialId, proof, now);
    if (auth.status !== "authenticated") return false;
    const device = this.devices.get(auth.principal.deviceId);
    if (!device?.pendingRotation || device.pendingRotation.credential.id !== credentialId) return false;
    device.credential = device.pendingRotation.credential;
    delete device.pendingRotation;
    return true;
  }

  private authorizePrincipal(principal: DevicePrincipal, scope: DeviceScope, now: string): Device | undefined {
    if (!principal || !instant(now) || !principal.scopes.includes(scope)) return undefined;
    const device = this.devices.get(principal.deviceId);
    if (device) this.expireInterruptedRotation(device, now);
    if (!device || device.status !== "active" || device.installationId !== principal.installationId) return undefined;
    const credential = device.credential.id === principal.credentialId ? device.credential : device.pendingRotation?.credential;
    if (!credential || credential.version !== principal.credentialVersion) return undefined;
    return device;
  }

  private findCredential(credentialId: string): Device | undefined {
    return [...this.devices.values()].find(device => device.credential.id === credentialId || device.pendingRotation?.credential.id === credentialId);
  }

  private expireInterruptedRotation(device: Device, now: string): void {
    if (device.pendingRotation && now >= device.pendingRotation.expiresAt) {
      delete device.pendingRotation;
      // An unconfirmed replacement expires; the last confirmed key remains active.
    }
  }
}
