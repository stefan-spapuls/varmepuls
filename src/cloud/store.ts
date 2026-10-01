import type { Zone } from "../core/models.ts";

export interface BoundStatement {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<{ success: boolean; results?: T[]; meta?: { changes?: number } }>;
}
export type SqlValue = string | number | null | Uint8Array;
export interface StateDatabase { prepare(sql: string): { bind(...values: SqlValue[]): BoundStatement } }
export type Config = { zone: Zone; mode: "summer" | "winter" };
export type ConfigWrite =
  | { status: "created" | "updated"; revision: number }
  | { status: "conflict"; currentRevision: number | null }
  | { status: "not_found" }
  | { status: "invalid"; reason: string };

export interface PlanInput {
  planId: string;
  configurationRevision: number;
  createdAt: string;
  validFrom: string;
  expiresAt: string;
  zone: Zone;
  coverageStartUtc: string;
  coverageEndUtc: string;
  actions: readonly { atUtc: string; target: "domestic-hot-water" | "house-heating"; enabled: boolean }[];
}
export type PlanWrite =
  | { status: "created"; revision: number }
  | { status: "conflict"; currentRevision: number }
  | { status: "not_found" }
  | { status: "configuration_conflict"; currentConfigurationRevision: number }
  | { status: "invalid"; reason: string };

const safeId = (value: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const instant = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export async function createInstallation(db: StateDatabase, installationId: string, createdAt: string): Promise<boolean> {
  if (!safeId(installationId) || !instant(createdAt)) return false;
  const result = await db.prepare("INSERT INTO installations (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING RETURNING id")
    .bind(installationId, createdAt).first<{ id: string }>();
  return result !== null;
}

export async function writeConfig(db: StateDatabase, installationId: string, expectedRevision: number,
  config: unknown, updatedAt: string): Promise<ConfigWrite> {
  if (!safeId(installationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      !instant(updatedAt) || !isConfig(config)) return { status: "invalid", reason: "Invalid installation, expected revision, configuration, or timestamp." };
  if (expectedRevision === 0) {
    const created = await db.prepare(`INSERT INTO installation_config (installation_id, revision, config_json, updated_at)
      SELECT id, 1, ?, ? FROM installations WHERE id = ?
      ON CONFLICT(installation_id) DO NOTHING RETURNING revision`)
      .bind(JSON.stringify(config), updatedAt, installationId).first<{ revision: number }>();
    if (created) return { status: "created", revision: created.revision };
  } else {
    const updated = await db.prepare(`UPDATE installation_config SET revision = revision + 1, config_json = ?, updated_at = ?
      WHERE installation_id = ? AND revision = ? RETURNING revision`)
      .bind(JSON.stringify(config), updatedAt, installationId, expectedRevision).first<{ revision: number }>();
    if (updated) return { status: "updated", revision: updated.revision };
  }
  const installation = await db.prepare("SELECT id FROM installations WHERE id = ?").bind(installationId).first<{ id: string }>();
  if (!installation) return { status: "not_found" };
  const current = await db.prepare("SELECT revision FROM installation_config WHERE installation_id = ?").bind(installationId).first<{ revision: number }>();
  return { status: "conflict", currentRevision: current?.revision ?? null };
}

export async function appendPlan(db: StateDatabase, installationId: string, expectedPlanRevision: number,
  plan: PlanInput, observedAtUtc: string): Promise<PlanWrite> {
  if (!safeId(installationId) || !Number.isSafeInteger(expectedPlanRevision) || expectedPlanRevision < 0) {
    return { status: "invalid", reason: "Invalid installation or expected plan revision." };
  }
  if (!instant(observedAtUtc)) return { status: "invalid", reason: "Invalid observation time." };
  const invalid = validatePlan(plan, observedAtUtc);
  if (invalid) return { status: "invalid", reason: invalid };
  const inserted = await db.prepare(`INSERT INTO plan_revisions
      (installation_id, revision, plan_id, config_revision, created_at, valid_from, expires_at, zone,
       coverage_start_utc, coverage_end_utc, actions_json)
      SELECT i.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM installations i
      JOIN installation_config c ON c.installation_id = i.id AND c.revision = ?
        AND json_extract(c.config_json, '$.zone') = ?
      WHERE i.id = ? AND COALESCE((SELECT MAX(p.revision) FROM plan_revisions p WHERE p.installation_id = i.id), 0) = ?
      RETURNING revision`)
    .bind(expectedPlanRevision + 1, plan.planId, plan.configurationRevision, plan.createdAt, plan.validFrom,
      plan.expiresAt, plan.zone, plan.coverageStartUtc, plan.coverageEndUtc, JSON.stringify(plan.actions),
      plan.configurationRevision, plan.zone, installationId, expectedPlanRevision)
    .first<{ revision: number }>();
  if (inserted) return { status: "created", revision: inserted.revision };
  const installation = await db.prepare("SELECT id FROM installations WHERE id = ?").bind(installationId).first<{ id: string }>();
  if (!installation) return { status: "not_found" };
  const config = await db.prepare("SELECT revision, config_json FROM installation_config WHERE installation_id = ?").bind(installationId).first<{ revision: number; config_json: string }>();
  if (!config) return { status: "configuration_conflict", currentConfigurationRevision: 0 };
  if (config.revision !== plan.configurationRevision || JSON.parse(config.config_json).zone !== plan.zone) {
    return { status: "configuration_conflict", currentConfigurationRevision: config.revision };
  }
  const current = await db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM plan_revisions WHERE installation_id = ?")
    .bind(installationId).first<{ revision: number }>();
  return { status: "conflict", currentRevision: current?.revision ?? 0 };
}

export function validatePlan(plan: PlanInput, observedAtUtc: string): string | undefined {
  if (!plan || !safeId(plan.planId) || !Number.isSafeInteger(plan.configurationRevision) || plan.configurationRevision < 1 ||
      !instant(plan.createdAt) || !instant(plan.validFrom) || !instant(plan.expiresAt) ||
      plan.createdAt > observedAtUtc || plan.expiresAt <= observedAtUtc || plan.validFrom < plan.createdAt || plan.validFrom >= plan.expiresAt ||
      !["SE1", "SE2", "SE3", "SE4"].includes(plan.zone) || !instant(plan.coverageStartUtc) ||
      !instant(plan.coverageEndUtc) || plan.coverageStartUtc >= plan.coverageEndUtc ||
      !Array.isArray(plan.actions) || plan.actions.length === 0 || plan.actions.length > 128) return "Invalid plan metadata or validity window.";
  if (plan.actions.some(action => !action || !instant(action.atUtc) ||
      (action.target !== "domestic-hot-water" && action.target !== "house-heating") || typeof action.enabled !== "boolean")) {
    return "Invalid logical plan action.";
  }
  return undefined;
}

function isConfig(value: unknown): value is Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 2 &&
    ["SE1", "SE2", "SE3", "SE4"].includes(candidate["zone"] as string) &&
    (candidate["mode"] === "summer" || candidate["mode"] === "winter");
}
