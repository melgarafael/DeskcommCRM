import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { proxyEnabled, proxyRequired, proxyErrorMessage } from "@/lib/channels/session-proxy";
import { loadSessionProxyOptions } from "@/lib/channels/proxy-options";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  const required = proxyRequired();
  if (!proxyEnabled() && !required) return ok({ enabled: false, required: false, proxies: [], bindings: [] }, { requestId });
  try {
    return ok(await loadSessionProxyOptions(auth.org.orgId, required), { requestId });
  } catch {
    return fail("proxy_provider_unavailable", proxyErrorMessage("proxy_provider_unavailable"), 503, { requestId });
  }
}
