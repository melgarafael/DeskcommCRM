import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { audit } from "@/lib/audit";
import type { WahaClient } from "@/lib/waha/client";
import { listSessionProxies, proxyEnabled, proxyRequired, SessionProxyError } from "./session-proxy";

export interface ManagedSessionConfig {
  proxy?: { server: string; username: string; password: string };
  webhooks?: { url: string; events: string[]; hmac: { key: string }; retries: { delaySeconds: number; attempts: number } }[];
  metadata: { crm_channel_id: string; crm_organization_id: string };
}
export interface ProxyChoice { proxy_country?: string; proxy_id?: string }
export const managedSessionsEnabled = () => process.env.WAHA_EXTERNAL === "true" || proxyEnabled() || proxyRequired();
const bindingSchema = z.object({ proxy_id: z.string(), country_code: z.string(), transport_origin: z.string() });

/** Resolve segredo somente no backend. O vínculo salvo nunca contém usuário/senha. */
export async function prepareManagedSession(db: SupabaseClient, transport: Pick<WahaClient, "getProxyOccupancy">,
  org: string, channelId: string, choice: ProxyChoice = {}, actor?: string): Promise<ManagedSessionConfig | undefined> {
  if (!managedSessionsEnabled()) return undefined;
  const { data: raw, error } = await db.from("channel_sessions").select("id,waha_session_name,webhook_path_token")
    .eq("organization_id", org).eq("id", channelId).is("archived_at", null).single();
  const channel = z.object({ id: z.string(), waha_session_name: z.string(), webhook_path_token: z.string().min(16) }).safeParse(raw);
  if (error || !channel.success) throw new SessionProxyError("proxy_channel_not_found");
  const origin = new URL(process.env.WAHA_API_BASE_URL!).origin;
  const config: ManagedSessionConfig = { metadata: { crm_channel_id: channelId, crm_organization_id: org } };
  if (process.env.WAHA_EXTERNAL === "true") {
    const secret = process.env.WAHA_HMAC_SECRET;
    const base = new URL(process.env.WAHA_WEBHOOK_BASE_URL!);
    if (!secret || secret.length < 16 || (process.env.NODE_ENV === "production" && base.protocol !== "https:")) throw new SessionProxyError("proxy_webhook_not_configured");
    config.webhooks = [{ url: `${base.toString().replace(/\/$/, "")}/api/v1/webhooks/waha/${channel.data.webhook_path_token}`,
      events: ["message.any", "message.ack", "message.edited", "message.revoked", "session.status", "state.change"],
      hmac: { key: secret }, retries: { delaySeconds: 2, attempts: 3 } }];
  }
  const { data: saved, error: savedError } = await db.from("channel_proxy_bindings").select("proxy_id,country_code,transport_origin")
    .eq("organization_id", org).eq("channel_session_id", channelId).maybeSingle();
  if (savedError) throw new SessionProxyError("proxy_binding_unavailable");
  const binding = saved ? bindingSchema.parse(saved) : null;
  if (binding && binding.transport_origin !== origin) throw new SessionProxyError("proxy_transport_changed");
  if (proxyRequired() || proxyEnabled() || binding || choice.proxy_country || choice.proxy_id) {
    const country = choice.proxy_country ?? binding?.country_code;
    if (!country) throw new SessionProxyError("proxy_selection_required");
    const proxies = await listSessionProxies();
    const occupied = await transport.getProxyOccupancy(channel.data.waha_session_name);
    // Reconexões mantêm a reserva; uma troca explícita de país procura um novo vínculo.
    const pinnedId = choice.proxy_id ?? (binding?.country_code === country ? binding.proxy_id : undefined);
    const { data: reserved, error: reservedError } = await db.rpc("fn_reserved_channel_proxies", { p_ids: proxies.map(p => p.id) });
    if (reservedError || !Array.isArray(reserved)) throw new SessionProxyError("proxy_binding_unavailable");
    const candidates = proxies.filter(p => p.country_code === country && (!pinnedId || p.id === pinnedId)
      && !occupied.includes(`${p.proxy_address}:${p.port}`)
      && (p.id === binding?.proxy_id || !reserved.includes(p.id))).sort((a, b) => a.id.localeCompare(b.id));
    let proxy: (typeof proxies)[number] | undefined;
    for (const candidate of candidates) {
      const { error: bindError } = await db.rpc("fn_bind_channel_proxy", { p_org: org, p_channel: channelId,
        p_proxy: candidate.id, p_country: candidate.country_code, p_origin: origin, p_previous: binding?.proxy_id ?? null });
      // Outra conexão pode reservar entre a consulta e a gravação. Tenta o próximo do mesmo país.
      if (bindError?.message.includes("proxy_in_use") && !pinnedId) continue;
      if (bindError) throw new SessionProxyError(["proxy_in_use", "proxy_change_requires_stop", "proxy_binding_changed"].find(x => bindError.message.includes(x)) ?? "proxy_binding_unavailable");
      proxy = candidate;
      break;
    }
    if (!proxy) throw new SessionProxyError("proxy_unavailable");
    config.proxy = { server: `${proxy.proxy_address}:${proxy.port}`, username: proxy.username, password: proxy.password };
    if (binding?.proxy_id !== proxy.id) await audit({ action: "channel.proxy_selected", actorUserId: actor,
      organizationId: org, resourceType: "channel_session", resourceId: channelId, metadata: { country: proxy.country_code, proxy_id: proxy.id } });
  }
  const { error: engineError } = await db.from("channel_sessions").update({ engine: process.env.WAHA_ENGINE ?? "NOWEB" })
    .eq("organization_id", org).eq("id", channelId);
  if (engineError) throw new SessionProxyError("proxy_binding_unavailable");
  return config;
}
