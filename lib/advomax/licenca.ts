import { env } from "@/lib/env";

export type AcessoCrm = {
  configured: boolean;
  enabled: boolean;
  source: "advomax" | "standalone" | "unavailable";
  expiresAt: string | null;
};

export type MotivoBloqueioAcessoCrm =
  | "bridge_not_configured"
  | "organization_unmapped"
  | "organization_inactive"
  | "license_inactive"
  | "license_unavailable"
  | "identity_missing";

export type GateAcessoCrm =
  | { ok: true; acesso: AcessoCrm }
  | { ok: false; reason: MotivoBloqueioAcessoCrm; acesso: AcessoCrm };

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

/**
 * Gate único dos jobs que falam com a Gestão.
 *
 * A coluna local `advomax_empresa_codigo` é necessária, mas não suficiente:
 * o endpoint de licença também confirma que a organização CRM está realmente
 * mapeada na Gestão e que o produto CRM está vigente. O retorno deliberadamente
 * não carrega chave, e-mail ou detalhes do upstream para estatísticas públicas.
 */
export async function verificarAcessoCrmDaOrganizacao(
  email: string | null | undefined,
  organizationId: string,
  advomaxEmpresaCodigo: number | null | undefined,
): Promise<GateAcessoCrm> {
  const indisponivel: AcessoCrm = {
    configured: false,
    enabled: false,
    source: "unavailable",
    expiresAt: null,
  };
  if (!Number.isSafeInteger(advomaxEmpresaCodigo) || (advomaxEmpresaCodigo as number) <= 0) {
    return { ok: false, reason: "organization_unmapped", acesso: indisponivel };
  }
  const emailNormalizado = email?.trim();
  if (!emailNormalizado) return { ok: false, reason: "identity_missing", acesso: indisponivel };

  const acesso = await verificarAcessoCrm(emailNormalizado, organizationId);
  if (!acesso.configured) return { ok: false, reason: "bridge_not_configured", acesso };
  if (acesso.source === "unavailable") return { ok: false, reason: "license_unavailable", acesso };
  if (acesso.source !== "advomax") return { ok: false, reason: "organization_unmapped", acesso };
  if (!acesso.enabled) {
    return { ok: false, reason: "license_inactive", acesso };
  }
  return { ok: true, acesso };
}
