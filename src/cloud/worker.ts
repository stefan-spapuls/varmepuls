import { fetchDeviceAuth } from "./device-auth.ts";

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method_not_allowed" }, 405);
      try {
        const result = await env.VARMEPULS_STATE_DB.prepare("SELECT 1 AS connected").first<{ connected: number }>();
        if (result?.connected !== 1) return json({ service: "varmepuls-api-production", status: "unavailable" }, 503);
        return json({ service: "varmepuls-api-production", status: "ok", stateStore: "ok" });
      } catch {
        return json({ service: "varmepuls-api-production", status: "unavailable" }, 503);
      }
    }
    const authResponse = await fetchDeviceAuth(request, env);
    if (authResponse) return authResponse;
    return json({ error: "not_found" }, 404);
  },
};
