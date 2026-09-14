import { env } from "@/lib/env";

export type AcessoCrm = {
  configured: boolean;
  enabled: boolean;
  source: "advomax" | "standalone" | "unavailable";
  expiresAt: string | null;
};

/** Consulta o entitlement jurídico sem expor a chave ao navegador. */
export async function verificarAcessoCrm(email: string, organizationId: string): Promise<AcessoCrm> {
  const base = env.ADVOMAX_API_URL.trim().replace(/\/$/, "");
  const key = env.ADVOMAX_CRM_INTEGRATION_KEY.trim();
  if (!base || !key) return { configured: false, enabled: true, source: "standalone", expiresAt: null };

  const response = await fetch(`${base}/integracoes/crm/acesso`, {
    headers: {
      "X-CRM-Integration-Key": key,
      "X-CRM-User-Email": email,
      "X-CRM-Organization-Id": organizationId,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response?.ok) return { configured: true, enabled: false, source: "unavailable", expiresAt: null };
  const body = (await response.json().catch(() => null)) as Partial<AcessoCrm> | null;
  const source = body?.source === "advomax" || body?.source === "standalone" ? body.source : "unavailable";
  return {
    configured: true,
    enabled: body?.enabled === true,
    source,
    expiresAt: typeof body?.expiresAt === "string" ? body.expiresAt : null,
  };
}
