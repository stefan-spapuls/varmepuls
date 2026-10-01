import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appendPlan, createInstallation, writeConfig, type StateDatabase, type SqlValue } from "../../src/cloud/store.ts";

class SqliteD1 implements StateDatabase {
  private readonly sqlite = new DatabaseSync(":memory:");
  constructor() { this.sqlite.exec(readFileSync(resolve("migrations/0001_initial.sql"), "utf8")); }
  prepare(sql: string) {
    return { bind: (...values: SqlValue[]) => ({
      first: async <T>() => this.sqlite.prepare(sql).get(...values) as T | undefined ?? null,
      run: async () => {
        const result = this.sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    }) };
  }
  query<T>(sql: string, ...values: SqlValue[]): T | undefined {
    return this.sqlite.prepare(sql).get(...values) as T | undefined;
  }
}

const now = "2026-10-01T12:00:00.000Z";
const config = { zone: "SE4" as const, mode: "winter" as const };
const plan = (planId: string, configurationRevision = 1) => ({
  planId, configurationRevision, createdAt: now, validFrom: "2026-10-01T12:15:00.000Z",
  expiresAt: "2026-10-02T00:00:00.000Z", zone: "SE4" as const,
  coverageStartUtc: "2026-10-01T12:00:00.000Z", coverageEndUtc: "2026-10-02T00:00:00.000Z",
  actions: [{ atUtc: "2026-10-01T12:15:00.000Z", target: "domestic-hot-water" as const, enabled: true }],
});
async function installation(db: StateDatabase, id = "varmepuls-test-a") {
  assert.equal(await createInstallation(db, id, now), true);
  assert.deepEqual(await writeConfig(db, id, 0, config, now), { status: "created", revision: 1 });
}
const observedAt = now;

test("migration creates only approved schema entities and plan immutability triggers", () => {
  const db = new SqliteD1();
  const tables = ["installation_config", "installations", "plan_revisions"];
  for (const name of tables) assert.ok(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name));
  assert.equal(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='device_registry'"), undefined);
  assert.ok(db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name='plan_revisions_immutable_update'"));
});
test("isolations keep config and plan revisions scoped per installation", async () => {
  const db = new SqliteD1(); await installation(db, "varmepuls-test-a"); await installation(db, "varmepuls-test-b");
  assert.equal(db.query<{ zone: string }>("SELECT json_extract(config_json, '$.zone') AS zone FROM installation_config WHERE installation_id=?", "varmepuls-test-b")?.zone, "SE4");
  assert.equal(db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM installations i
    JOIN installation_config c ON c.installation_id=i.id AND c.revision=? AND json_extract(c.config_json,'$.zone')=?
    WHERE i.id=? AND COALESCE((SELECT MAX(p.revision) FROM plan_revisions p WHERE p.installation_id=i.id),0)=?`,
    1, "SE4", "varmepuls-test-b", 0)?.n, 1);
  assert.deepEqual(await appendPlan(db, "varmepuls-test-a", 0, plan("plan-a"), observedAt), { status: "created", revision: 1 });
  assert.deepEqual(await appendPlan(db, "varmepuls-test-b", 0, plan("plan-b"), observedAt), { status: "created", revision: 1 });
  assert.equal(db.query<{ n: number }>("SELECT COUNT(*) AS n FROM plan_revisions WHERE installation_id='varmepuls-test-a'")?.n, 1);
  assert.equal(db.query<{ n: number }>("SELECT COUNT(*) AS n FROM plan_revisions WHERE installation_id='varmepuls-test-b'")?.n, 1);
});
test("installation and initial configuration creation", async () => {
  const db = new SqliteD1();
  assert.equal(await createInstallation(db, "varmepuls-test-a", now), true);
  assert.deepEqual(await writeConfig(db, "varmepuls-test-a", 0, config, now), { status: "created", revision: 1 });
  assert.equal((db.query<{ revision: number; config_json: string }>("SELECT revision, config_json FROM installation_config WHERE installation_id=?", "varmepuls-test-a"))?.revision, 1);
});
test("configuration compare-and-set increments revision", async () => {
  const db = new SqliteD1(); await installation(db);
  assert.deepEqual(await writeConfig(db, "varmepuls-test-a", 1, { zone: "SE3", mode: "summer" }, "2026-10-01T12:30:00.000Z"), { status: "updated", revision: 2 });
});
test("stale configuration expected revision conflicts without overwriting", async () => {
  const db = new SqliteD1(); await installation(db);
  assert.deepEqual(await writeConfig(db, "varmepuls-test-a", 1, { zone: "SE1", mode: "summer" }, now), { status: "updated", revision: 2 });
  assert.deepEqual(await writeConfig(db, "varmepuls-test-a", 1, { zone: "SE2", mode: "winter" }, now), { status: "conflict", currentRevision: 2 });
  assert.deepEqual(JSON.parse(db.query<{ config_json: string }>("SELECT config_json FROM installation_config WHERE installation_id=?", "varmepuls-test-a")?.config_json ?? "{}"), { zone: "SE1", mode: "summer" });
});
test("configuration write cannot cross installation scope", async () => {
  const db = new SqliteD1(); await installation(db);
  assert.deepEqual(await writeConfig(db, "varmepuls-test-b", 0, config, now), { status: "not_found" });
});
test("append plans links configuration and increments plan revision", async () => {
  const db = new SqliteD1(); await installation(db);
  assert.deepEqual(await appendPlan(db, "varmepuls-test-a", 0, plan("plan-1"), observedAt), { status: "created", revision: 1 });
  assert.deepEqual(await appendPlan(db, "varmepuls-test-a", 1, plan("plan-2"), observedAt), { status: "created", revision: 2 });
  assert.equal(db.query<{ config_revision: number }>("SELECT config_revision FROM plan_revisions WHERE plan_id='plan-2'")?.config_revision, 1);
});
test("plan rows cannot be updated or deleted", async () => {
  const db = new SqliteD1(); await installation(db); await appendPlan(db, "varmepuls-test-a", 0, plan("plan-immutable"), observedAt);
  assert.throws(() => db.query("UPDATE plan_revisions SET expires_at='2026-10-03T00:00:00.000Z' WHERE plan_id='plan-immutable'"), /immutable/);
  assert.throws(() => db.query("DELETE FROM plan_revisions WHERE plan_id='plan-immutable'"), /immutable/);
});
test("stale plan revision conflicts", async () => {
  const db = new SqliteD1(); await installation(db); await appendPlan(db, "varmepuls-test-a", 0, plan("plan-1"), observedAt);
  assert.deepEqual(await appendPlan(db, "varmepuls-test-a", 0, plan("plan-stale"), observedAt), { status: "conflict", currentRevision: 1 });
});
test("plan must reference the current configuration revision", async () => {
  const db = new SqliteD1(); await installation(db);
  await writeConfig(db, "varmepuls-test-a", 1, { zone: "SE4", mode: "summer" }, now);
  assert.deepEqual(await appendPlan(db, "varmepuls-test-a", 0, plan("plan-old-config"), observedAt), { status: "configuration_conflict", currentConfigurationRevision: 2 });
});
test("plan zone must match the current configuration", async () => {
  const db = new SqliteD1(); await installation(db);
  const candidate = plan("plan-wrong-zone"); Object.assign(candidate, { zone: "SE3" });
  assert.deepEqual(await appendPlan(db, "varmepuls-test-a", 0, candidate, observedAt), { status: "configuration_conflict", currentConfigurationRevision: 1 });
});
const malformedPlans: { name: string; mutate: (p: ReturnType<typeof plan>) => void }[] = [
  { name: "expiry before creation", mutate: p => { p.expiresAt = "2026-10-01T11:00:00.000Z"; } },
  { name: "invalid action", mutate: p => { Object.assign(p.actions[0], { target: "relay" }); } },
  { name: "malformed time", mutate: p => { p.createdAt = "yesterday"; } },
  { name: "coverage inversion", mutate: p => { p.coverageEndUtc = p.coverageStartUtc; } },
];
for (const { name, mutate } of malformedPlans) test(`malformed ${name} rejected`, async () => {
  const db = new SqliteD1(); await installation(db); const candidate = plan("invalid-plan"); mutate(candidate);
  const result = await appendPlan(db, "varmepuls-test-a", 0, candidate, observedAt);
  assert.equal(result.status, "invalid");
});
test("already expired plan is rejected against explicit observation time", async () => {
  const db = new SqliteD1(); await installation(db);
  const candidate = plan("expired-plan"); candidate.expiresAt = "2026-10-01T11:59:59.000Z";
  assert.equal((await appendPlan(db, "varmepuls-test-a", 0, candidate, observedAt)).status, "invalid");
});
test("invalid config returns an explicit rejection", async () => {
  const db = new SqliteD1(); await installation(db);
  assert.deepEqual(await writeConfig(db, "varmepuls-test-a", 1, { zone: "SE5", mode: "winter" }, now),
    { status: "invalid", reason: "Invalid installation, expected revision, configuration, or timestamp." });
});
test("duplicate installation does not overwrite existing row", async () => {
  const db = new SqliteD1(); await installation(db);
  assert.equal(await createInstallation(db, "varmepuls-test-a", "2026-10-02T00:00:00.000Z"), false);
  assert.equal(db.query<{ created_at: string }>("SELECT created_at FROM installations WHERE id=?", "varmepuls-test-a")?.created_at, now);
});
