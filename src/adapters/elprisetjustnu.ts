import { ZONES } from "../core/models.ts";
import type { PlanningWindow, Zone } from "../core/models.ts";
import { normalizePrices } from "./price-provider.ts";
import type { PriceProviderResult, SourcePriceInterval } from "./price-provider.ts";

export interface MarketDateRequest { zone: Zone; date: string }
export interface HttpResponse { status: number; json(): Promise<unknown> }
export type FetchPrices = (url: string, options: { signal: AbortSignal; redirect: "error" }) => Promise<HttpResponse>;
export type LivePriceResult = PriceProviderResult | {
  ok: false;
  code: "UNAVAILABLE" | "HTTP_ERROR" | "MALFORMED_JSON" | "TIMEOUT" | "NETWORK_ERROR";
  reason: string;
};

const stockholm = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function validDate(date: string): boolean {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000")) return false;
  const ms = Date.parse(date + "T00:00:00Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}

function localMidnight(date: string): number {
  const target = Date.parse(date + "T00:00:00Z");
  let candidate = target;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(stockholm.formatToParts(new Date(candidate)).map(p => [p.type, p.value]));
    const represented = Date.parse(`${parts["year"]?.padStart(4, "0")}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}:${parts["second"]}Z`);
    if (represented === target) return candidate;
    candidate += target - represented;
  }
  throw new Error("Cannot resolve Stockholm midnight.");
}

/** Resolve two local midnights independently; never add 24h to UTC start. */
export function stockholmDayWindow(date: string): PlanningWindow {
  if (!validDate(date)) throw new Error("Date must be a real YYYY-MM-DD calendar date.");
  const next = new Date(Date.parse(date + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
  return { startUtc: new Date(localMidnight(date)).toISOString(), endUtc: new Date(localMidnight(next)).toISOString() };
}

export function priceUrl(request: MarketDateRequest): string {
  if (!request || !ZONES.includes(request.zone) || !validDate(request.date)) throw new Error("Invalid zone or date.");
  const [year, month, day] = request.date.split("-");
  return `https://www.elprisetjustnu.se/api/v1/prices/${year}/${month}-${day}_${request.zone}.json`;
}

function sourceUtc(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.000)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || Number(match[3] ?? 0) > 23 || Number(match[4] ?? 0) > 59) return;
  const wall = Date.parse(match[1] + "Z");
  const ms = Date.parse(value);
  if (!Number.isFinite(wall) || !Number.isFinite(ms) || new Date(wall).toISOString() !== match[1] + ".000Z") return;
  return new Date(ms).toISOString();
}

export class ElprisetJustNuAdapter {
  private readonly fetchPrices: FetchPrices;
  private readonly timeoutMs: number;
  constructor(fetchPrices: FetchPrices = (url, options) => fetch(url, options), timeoutMs = 10_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error("Invalid timeout.");
    this.fetchPrices = fetchPrices;
    this.timeoutMs = timeoutMs;
  }

  async getPrices(request: MarketDateRequest): Promise<LivePriceResult> {
    let url: string;
    let window: PlanningWindow;
    try { url = priceUrl(request); window = stockholmDayWindow(request.date); }
    catch { return { ok: false, code: "INVALID_REQUEST", reason: "Invalid Swedish zone or calendar date." }; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<LivePriceResult>(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, code: "TIMEOUT", reason: "Price request exceeded its timeout." });
      }, this.timeoutMs);
    });
    const operation = async (): Promise<LivePriceResult> => {
      let response: HttpResponse;
      try { response = await this.fetchPrices(url, { signal: controller.signal, redirect: "error" }); }
      catch { return { ok: false, code: controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR", reason: "Price request failed; no fallback data used." }; }
      if (response.status === 404) return { ok: false, code: "UNAVAILABLE", reason: "Requested date is not available (HTTP 404)." };
      if (response.status < 200 || response.status >= 300) return { ok: false, code: "HTTP_ERROR", reason: `Price provider returned HTTP ${response.status}.` };
      let payload: unknown;
      try { payload = await response.json(); }
      catch { return { ok: false, code: controller.signal.aborted ? "TIMEOUT" : "MALFORMED_JSON", reason: "Unable to read provider JSON." }; }
      if (!Array.isArray(payload)) return { ok: false, code: "INVALID_SOURCE", reason: "Provider response must be an array." };
      const mapped: SourcePriceInterval[] = [];
      for (const record of payload as unknown[]) {
        if (!record || typeof record !== "object" || Array.isArray(record)) return { ok: false, code: "INVALID_SOURCE", reason: "Provider rows must be objects." };
        const row = record as Record<string, unknown>;
        const startUtc = sourceUtc(row["time_start"]);
        const endUtc = sourceUtc(row["time_end"]);
        if (!startUtc || !endUtc) return { ok: false, code: "INVALID_INTERVAL", reason: "Invalid provider timestamp or missing explicit offset." };
        mapped.push({ startUtc, endUtc, zone: request.zone, value: row["SEK_per_kWh"] });
      }
      // EUR_per_kWh and EXR are deliberately unused. SEK is already canonical.
      return normalizePrices({ zone: request.zone, window }, mapped, "SEK/kWh");
    };
    try { return await Promise.race([operation(), deadline]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
