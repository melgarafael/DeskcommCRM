"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

interface Contagens {
  messages: number;
  calendar_appointments: number;
  conversations: number;
  crm_leads: number;
  contacts: number;
  orders: number;
}

export type ApagarDadosOperacionaisResult =
  | { ok: true; counts: Contagens }
  | {
      ok: false;
      error:
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "confirmacao_nao_confere"
        | "db_error";
      details?: unknown;
    };

/**
 * Zona de perigo de Configurações › Organização: apaga de vez mensagens,
 * conversas, leads, contatos, agendamentos e pedidos da org ativa.
 *
 * Toda a autorização (papel admin, nome digitado == nome gravado) é
 * re-verificada DENTRO de `fn_apagar_dados_operacionais_da_organizacao`
 * (SECURITY DEFINER) — o gate de papel aqui é só o que evita a viagem ao
 * banco para quem claramente não pode. A função em si não grava em
 * `api_audit_log` (é puro DELETE em SQL), então é esta action que audita.
 */
export async function apagarDadosOperacionaisDaOrganizacao(input: {
  confirmNome: string;
}): Promise<ApagarDadosOperacionaisResult> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!authUser.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) {
    return { ok: false, error: "mfa_required" };
  }

  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  const { data, error } = await createAdminClient().rpc(
    "fn_apagar_dados_operacionais_da_organizacao",
    {
      p_org: activeOrg.orgId,
      p_actor: authUser.id,
      p_confirm_nome: input.confirmNome,
    },
  );

  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden_role" };
    if (error.code === "22023") return { ok: false, error: "confirmacao_nao_confere" };
    return { ok: false, error: "db_error", details: error.message };
  }

  const counts = data as Contagens;

  await audit({
    action: "org.dados_operacionais_apagados",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    ip,
    userAgent,
    metadata: { counts },
  });

  revalidatePath("/app/settings/tenant");
  revalidatePath("/app/inbox");
  return { ok: true, counts };
}
