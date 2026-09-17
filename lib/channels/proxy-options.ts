import { listSessionProxies } from "./session-proxy";
import { getWahaClient } from "@/lib/waha/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** Expõe apenas país, identificador e disponibilidade; nunca credenciais. */
export async function loadSessionProxyOptions(org: string, required: boolean) {
    const client = getWahaClient();
    if (!client) throw new Error("transport_unavailable");
    const [proxies, occupied, bindings] = await Promise.all([
      listSessionProxies(), client.getProxyOccupancy(),
      (await createClient()).from("channel_proxy_bindings").select("channel_session_id,proxy_id,country_code")
        .eq("organization_id", org),
    ]);
    if (bindings.error) throw new Error("binding_unavailable");
    // O pool é compartilhado pela instalação. A RPC só retorna IDs que a
    // Webshare já forneceu, sem expor organização, canal ou credenciais.
    const reserved = await createAdminClient().rpc("fn_reserved_channel_proxies", { p_ids: proxies.map(p => p.id) });
    if (reserved.error) throw new Error("binding_unavailable");
    return { enabled: true, required, proxies: proxies.map(p => ({ id: p.id, country: p.country_code,
      available: !occupied.includes(`${p.proxy_address}:${p.port}`) && !reserved.data.includes(p.id) })), bindings: bindings.data };
}
