/** Stable proof-of-concept encoding. Not wired into the deployed Worker. */
export interface CanonicalDeviceRequest {
  protocolVersion: string;
  deviceId: string;
  credentialId: string;
  challengeId: string;
  nonceBase64Url: string;
  method: string;
  normalizedPath: string;
  bodySha256Hex: string;
}

const identifier = (value: string) => /^[A-Za-z0-9_-]{8,80}$/.test(value);
const path = (value: string) => {
  if (!value.startsWith("/") || value.includes("%") || value.includes("\\") || value.includes("?") ||
      value.includes("#") || value.includes("//") || !/^[A-Za-z0-9._~/-]+$/.test(value)) return false;
  return value.split("/").every((segment, index) => index === 0 || (segment !== "" && segment !== "." && segment !== ".."));
};

/**
 * Encodes fields in fixed order as VPDA magic, a uint16 field count, then for
 * each UTF-8 field a uint32 big-endian byte length followed by the bytes.
 */
export function canonicalDeviceRequest(fields: CanonicalDeviceRequest): Uint8Array {
  if (!fields || !/^[a-z0-9][a-z0-9.-]{0,39}$/.test(fields.protocolVersion) ||
      !identifier(fields.deviceId) || !identifier(fields.credentialId) || !identifier(fields.challengeId) ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(fields.nonceBase64Url) ||
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(fields.method) ||
      !path(fields.normalizedPath) || !/^[a-f0-9]{64}$/.test(fields.bodySha256Hex)) {
    throw new TypeError("Invalid canonical device request fields.");
  }
  const encoder = new TextEncoder();
  const parts = [fields.protocolVersion, fields.deviceId, fields.credentialId, fields.challengeId,
    fields.nonceBase64Url, fields.method, fields.normalizedPath, fields.bodySha256Hex].map(value => encoder.encode(value));
  const byteLength = 4 + 2 + parts.reduce((sum, part) => sum + 4 + part.byteLength, 0);
  const result = new Uint8Array(byteLength);
  result.set([0x56, 0x50, 0x44, 0x41], 0); // "VPDA"
  const view = new DataView(result.buffer);
  view.setUint16(4, parts.length, false);
  let offset = 6;
  for (const part of parts) {
    view.setUint32(offset, part.byteLength, false);
    offset += 4;
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
