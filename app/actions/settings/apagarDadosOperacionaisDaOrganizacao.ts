"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  apagarDadosOperacionaisDaOrg,
  type ContagensApagadas,
} from "@/lib/settings/apagar-dados-operacionais";
import { createAdminClient } from "@/lib/supabase/admin";

const entradaSchema = z.object({ confirmNome: z.string().min(1).max(200) });

export type ApagarDadosOperacionaisResult =
  | { ok: true; counts: ContagensApagadas }
  | {
      ok: false;
      error:
        | "validation_failed"
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
 * conversas, leads, contatos, agendamentos e pedidos da organização ATIVA.
 *
 * Capacidade extraída da contribuição de @maugarciasa (PR #556).
 *
 * Três coisas que esta action não pode delegar a ninguém:
 *
 *  1. `organization_id` sai de `resolveActiveOrg(authUser)` — cookie de sessão
 *     validado no servidor — e nunca do input. O client abaixo é o de service
 *     role (bypassa RLS): sem esse filtro, um DELETE aqui esvazia o banco
 *     inteiro, não só uma organização.
 *  2. A confirmação por NOME é conferida no servidor, contra o
 *     `display_name` lido do banco. No original ela morava só no componente,
 *     e uma server action é um endpoint público: quem chamasse a função direto
 *     pulava o diálogo inteiro.
 *  3. A auditoria é daqui. Um DELETE não deixa rastro sozinho — a linha em
 *     `api_audit_log` (append-only) é o único registro de que a organização
 *     foi zerada, por quem, e de quanto.
 */
export async function apagarDadosOperacionaisDaOrganizacao(input: {
  confirmNome: string;
}): Promise<ApagarDadosOperacionaisResult> {
  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

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

  const supabase = createAdminClient();

  const { data: orgRow, error: readErr } = await supabase
    .from("organizations")
    .select("display_name")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (readErr) return { ok: false, error: "db_error", details: readErr.message };
  if (!orgRow) return { ok: false, error: "forbidden_tenant" };

  const nomeGravado = String((orgRow as { display_name: string }).display_name).trim();
  if (parsed.data.confirmNome.trim() !== nomeGravado) {
    return { ok: false, error: "confirmacao_nao_confere" };
  }

  const resultado = await apagarDadosOperacionaisDaOrg(supabase, activeOrg.orgId);

  const hdrs = await headers();
  await audit({
    action: "org.dados_operacionais_apagados",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId: hdrs.get("x-request-id"),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent") ?? null,
    bypassedRls: true,
    actingAsPlatformAdmin: authUser.is_platform_admin,
    metadata: {
      counts: resultado.counts,
      ...(resultado.ok ? {} : { falhou_em: resultado.falha.tabela }),
    },
  });

  // As telas que o reset esvazia. `/app/pipelines` é o quadro de um funil
  // (`/app/pipelines/[id]`), e o `layout: "page"` alcança as rotas dinâmicas
  // debaixo dele — sem isso o RSC servido pelo cache mostraria os cartões que
  // acabaram de sair do banco.
  revalidatePath("/app/settings/tenant");
  revalidatePath("/app/inbox");
  revalidatePath("/app/contacts");
  revalidatePath("/app/pipelines/[id]", "page");

  if (!resultado.ok) {
    return { ok: false, error: "db_error", details: resultado.falha.mensagem };
  }
  return { ok: true, counts: resultado.counts };
}
