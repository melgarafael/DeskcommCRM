import { z } from "zod";

const proxySchema = z.object({
  id: z.string().min(1).max(100), proxy_address: z.ipv4(), port: z.number().int().min(1).max(65535),
  username: z.string().min(1), password: z.string().min(1), country_code: z.string().regex(/^[A-Z]{2}$/), valid: z.boolean(),
});
export type SessionProxy = z.infer<typeof proxySchema>;
export class SessionProxyError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function proxyEnabled(): boolean { return Boolean(process.env.WEBSHARE_API_KEY); }
export function proxyRequired(): boolean { return process.env.WHATSAPP_PROXY_REQUIRED === "true"; }
export function permittedProxies(proxies: SessionProxy[]): SessionProxy[] {
  const ids = (process.env.WEBSHARE_PROXY_IDS ?? "").split(",").map(x => x.trim()).filter(Boolean);
  return proxies.filter(p => p.valid && (!ids.length || ids.includes(p.id)));
}

/** A paginação nunca envia a credencial ao host indicado no campo next. */
export async function listSessionProxies(key = process.env.WEBSHARE_API_KEY): Promise<SessionProxy[]> {
  if (!key) throw new SessionProxyError("proxy_not_configured");
  const proxies: SessionProxy[] = [];
  for (let page = 1; page <= 50; page++) {
    let res: Response;
    try {
      res = await fetch(`https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=${page}&page_size=100`, {
        headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(10_000), redirect: "error", cache: "no-store",
      });
    } catch { throw new SessionProxyError("proxy_provider_unavailable"); }
    if (!res.ok) throw new SessionProxyError("proxy_provider_unavailable");
    const parsed = z.object({ results: z.array(proxySchema), next: z.string().nullable() }).safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new SessionProxyError("proxy_provider_unavailable");
    proxies.push(...parsed.data.results);
    if (!parsed.data.next) return permittedProxies(proxies);
  }
  throw new SessionProxyError("proxy_provider_unavailable");
}

/** Seleção explícita e estável. Nunca muda o país para compensar falta de estoque. */
export function chooseSessionProxy(proxies: SessionProxy[], choice: { country: string; proxyId?: string }): SessionProxy {
  const proxy = permittedProxies(proxies).filter(p => p.country_code === choice.country && (!choice.proxyId || p.id === choice.proxyId))
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!proxy) throw new SessionProxyError("proxy_unavailable");
  return proxy;
}

export function proxyErrorMessage(code: string): string {
  if (code === "proxy_selection_required") return "Selecione o país em Conexões antes de conectar.";
  if (code === "proxy_in_use") return "O proxy reservado está em uso. Tente novamente mais tarde.";
  if (code === "proxy_change_requires_stop") return "Desconecte a sessão antes de trocar o proxy.";
  if (code === "proxy_unavailable") return "Não há proxy disponível para esta conexão no país escolhido. Tente novamente mais tarde.";
  if (code === "proxy_not_configured") return "O serviço de proxy precisa ser configurado pelo administrador da instalação.";
  return "Não foi possível conferir o proxy. A conexão não foi iniciada. Tente novamente.";
}
