import test from "node:test";
import assert from "node:assert/strict";
import { ElprisetJustNuAdapter, priceUrl, stockholmDayWindow } from "../src/adapters/elprisetjustnu.ts";
import type { FetchPrices, LivePriceResult } from "../src/adapters/elprisetjustnu.ts";
import { ZONES } from "../src/core/models.ts";

const request = { zone: "SE4" as const, date: "2026-10-01" };
function fixture(date = request.date) {
  const window = stockholmDayWindow(date); const from = Date.parse(window.startUtc); const to = Date.parse(window.endUtc);
  return Array.from({ length: (to - from) / 900_000 }, (_, i) => {
    const timestamp = (ms: number) => new Date(ms + 7_200_000).toISOString().replace(".000Z", "+02:00");
    return { SEK_per_kWh: i === 1 ? -0.2 : i === 2 ? 0 : 0.5, EUR_per_kWh: 999, EXR: 999,
      time_start: timestamp(from + i * 900_000), time_end: timestamp(from + (i + 1) * 900_000) };
  });
}
const mock = (payload: unknown, status = 200): FetchPrices => async () => ({ status, json: async () => payload });
function success(result: LivePriceResult) {
  if (!result.ok) assert.fail(result.reason);
  return result.batch;
}
function failure(result: LivePriceResult, code: string) {
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("Unexpected batch");
  assert.equal(result.code, code); assert.ok(result.reason); assert.equal("batch" in result, false);
}
test("valid SE4 offsets normalize to canonical quarter-hour UTC coverage", async () => {
  const batch = success(await new ElprisetJustNuAdapter(mock(fixture())).getPrices(request));
  assert.equal(batch.intervals.length, 96);
  assert.deepEqual(batch.window, { startUtc: "2026-09-30T22:00:00.000Z", endUtc: "2026-10-01T22:00:00.000Z" });
  assert.equal(batch.intervals[0].startUtc, batch.window.startUtc);
  assert.equal(batch.intervals[95].endUtc, batch.window.endUtc);
  assert.equal(batch.intervals[1].priceSekPerKwh, -0.2);
  assert.equal(batch.intervals[2].priceSekPerKwh, 0);
  assert.equal(batch.intervals[0].priceSekPerKwh, 0.5);
  assert.equal(batch.unit, "SEK/kWh");
});
for (const zone of ZONES) test(`safe URL for ${zone}`, () => {
  assert.equal(priceUrl({ zone, date: request.date }), `https://www.elprisetjustnu.se/api/v1/prices/2026/10-01_${zone}.json`);
});
test("invalid date and zone rejected without fetching", async () => {
  const adapter = new ElprisetJustNuAdapter(async () => { assert.fail("Must not fetch"); });
  failure(await adapter.getPrices({ ...request, date: "2026-02-30" }), "INVALID_REQUEST");
  failure(await adapter.getPrices({ ...request, date: "../../evil" }), "INVALID_REQUEST");
  failure(await adapter.getPrices({ ...request, zone: "SE5" } as unknown as typeof request), "INVALID_REQUEST");
});
test("request supplies abort signal and disallows redirects", async () => {
  const adapter = new ElprisetJustNuAdapter(async (url, options) => {
    assert.equal(url, priceUrl(request)); assert.equal(options.redirect, "error"); assert.ok(options.signal instanceof AbortSignal);
    return { status: 200, json: async () => fixture() };
  });
  success(await adapter.getPrices(request));
});
for (const value of [null, "0.1", NaN, Infinity, undefined]) test(`malformed price ${String(value)}`, async () => {
  const data: unknown[] = fixture(); data[0] = { ...fixture()[0], SEK_per_kWh: value };
  failure(await new ElprisetJustNuAdapter(mock(data)).getPrices(request), "INVALID_SOURCE");
});
for (const timestamp of ["invalid", "2026-02-30T00:00:00+01:00", "2026-10-01T00:00:00", "2026-10-01T00:00:00+25:00"]) test(`malformed timestamp ${timestamp}`, async () => {
  const data = fixture(); data[0].time_start = timestamp;
  failure(await new ElprisetJustNuAdapter(mock(data)).getPrices(request), "INVALID_INTERVAL");
});
test("historical hourly intervals rejected without synthesizing quarters", async () => {
  const data = fixture("2025-09-30").filter((_, i) => i % 4 === 0);
  data.forEach(row => { row.time_end = new Date(Date.parse(row.time_start) + 3_600_000).toISOString(); });
  failure(await new ElprisetJustNuAdapter(mock(data)).getPrices({ ...request, date: "2025-09-30" }), "INVALID_INTERVAL");
});
test("duplicate rejected", async () => {
  const data = fixture(); data.push(data[0]);
  failure(await new ElprisetJustNuAdapter(mock(data)).getPrices(request), "DUPLICATE");
});
test("missing quarter rejected", async () => failure(await new ElprisetJustNuAdapter(mock(fixture().filter((_, i) => i !== 9))).getPrices(request), "MISSING_COVERAGE"));
test("overlap rejected", async () => {
  const data = fixture(); data[0].time_end = data[1].time_end;
  failure(await new ElprisetJustNuAdapter(mock(data)).getPrices(request), "OVERLAP");
});
for (const shape of [{}, null, [null], [[]]]) test(`wrong response shape ${JSON.stringify(shape)}`, async () => failure(await new ElprisetJustNuAdapter(mock(shape)).getPrices(request), "INVALID_SOURCE"));
test("404 explicitly unavailable", async () => failure(await new ElprisetJustNuAdapter(mock({}, 404)).getPrices(request), "UNAVAILABLE"));
test("non-2xx explicitly rejected", async () => failure(await new ElprisetJustNuAdapter(mock({}, 503)).getPrices(request), "HTTP_ERROR"));
test("malformed JSON explicitly rejected", async () => {
  const fetch: FetchPrices = async () => ({ status: 200, json: async () => { throw new SyntaxError("bad JSON"); } });
  failure(await new ElprisetJustNuAdapter(fetch).getPrices(request), "MALFORMED_JSON");
});
test("network failure explicitly rejected", async () => {
  failure(await new ElprisetJustNuAdapter(async () => { throw new Error("offline"); }).getPrices(request), "NETWORK_ERROR");
});
test("timeout bounds an unresponsive fetch and aborts it", async () => {
  let signal: AbortSignal | undefined;
  const adapter = new ElprisetJustNuAdapter(async (_, options) => { signal = options.signal; return new Promise(() => {}); }, 5);
  failure(await adapter.getPrices(request), "TIMEOUT"); assert.equal(signal?.aborted, true);
});
test("timeout includes JSON body read", async () => {
  failure(await new ElprisetJustNuAdapter(async () => ({ status: 200, json: async () => new Promise(() => {}) }), 5).getPrices(request), "TIMEOUT");
});
test("repeated normalization deterministic and input untouched", async () => {
  const data = fixture().reverse(); const before = structuredClone(data); const adapter = new ElprisetJustNuAdapter(mock(data));
  assert.deepEqual(await adapter.getPrices(request), await adapter.getPrices(request)); assert.deepEqual(data, before);
});
for (const [date, from, to, count] of [
  ["2026-01-15", "2026-01-14T23:00:00.000Z", "2026-01-15T23:00:00.000Z", 96],
  ["2026-03-29", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z", 92],
  ["2026-10-25", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z", 100],
] as const) test(`Stockholm ${date} resolves and normalizes ${count} quarters`, async () => {
  assert.deepEqual(stockholmDayWindow(date), { startUtc: from, endUtc: to });
  const batch = success(await new ElprisetJustNuAdapter(mock(fixture(date))).getPrices({ ...request, date }));
  assert.equal(batch.intervals.length, count);
});
