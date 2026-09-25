"use server";

import { supportWriteError } from "@/lib/impersonate/support";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import {
  interfaceSettingsSchema,
  interfaceTemDestino,
  type InterfaceSettings,
} from "@/lib/navigation/interface";

export type InterfaceDaEmpresaResult = { ok: true } | { ok: false; error: string };

/**
 * Grava as portas da EMPRESA (issue #1341) — o universo de itens do menu lateral
 * da instalação inteira. Cada vínculo continua escolhendo MENOS dentro dele
 * (`PATCH /api/v1/team/:user_id/interface`); ninguém abre além daqui, porque a
 * leitura resolve a INTERSEÇÃO (`combinarInterfaces`).
 *
 * Isto é configuração de APRESENTAÇÃO, como a escolha por vínculo: não concede
 * nem tira acesso. Papel, RLS e permissões seguem decidindo o que cada pessoa
 * alcança, e desmarcar uma área aqui apenas a esconde — link contextual, aviso e
 * busca continuam abrindo o que o papel autoriza.
 */
export async function atualizarInterfaceDaEmpresa(input: InterfaceSettings): Promise<InterfaceDaEmpresaResult> {
  const parsed = interfaceSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  // Sessão de suporte é somente-leitura: quem está do outro lado não muda o menu
  // da instalação (mesma trava de `updateTenant` e da rota por vínculo).
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!authUser.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false, error: "forbidden_role" };
  }

  // Mesma guarda da escolha por vínculo: recusa a seleção que deixaria a empresa
  // sem NENHUMA área além das essenciais. As essenciais continuariam aparecendo
  // de qualquer forma, então essa seleção não é escolha — é menu vazio.
  if (!interfaceTemDestino(parsed.data, activeOrg.role)) {
    return { ok: false, error: "sem_area" };
  }

  /**
   * A ESCRITA EM `organizations` VAI PELO ADMIN CLIENT — pelo mesmo motivo medido
   * em `updateTenant` (issue #144): a única policy de escrita da tabela é
   * `orgs_write_platform_admin`, então o UPDATE de um admin de organização pelo
   * client de sessão casa ZERO linhas e o PostgREST devolve sucesso. O gate
   * continua sendo o de cima (papel resolvido de fonte confiável) e o filtro por
   * organização é explícito — a organização vem da SESSÃO, nunca do corpo.
   */
  const supabase = createAdminClient();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = hdrs.get("user-agent") ?? null;

  const { error } = await supabase
    .from("organizations")
    .update({ interface_settings: parsed.data })
    .eq("id", activeOrg.orgId);
  if (error) return { ok: false, error: "internal_error" };

  await audit({
    action: "org.interface_changed",
    organizationId: activeOrg.orgId,
    actorUserId: authUser.id,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    ip,
    userAgent,
    metadata: { fields_changed: ["interface_settings"], interface_settings: parsed.data },
  });

  // Mesmo evento que `updateTenant` publica: quem escuta "a empresa mudou" não
  // deveria descobrir por recarregar a tela. É LITERALMENTE o mesmo TIPO — um
  // tipo novo (`org.interface_changed`) não teria assinante, não entraria no
  // vocabulário de `fn_event_log_e_registro` (migration 0239) e o fato nasceria
  // pendente para sempre; o detalhe fino de QUAL campo mudou fica no `audit_log`
  // (`action: "org.interface_changed"`), que é onde a pergunta é feita.
  await supabase
    .rpc("emit_event", {
      p_event_type: "org.updated",
      p_entity_kind: "organization",
      p_entity_id: activeOrg.orgId,
      p_payload: { organization_id: activeOrg.orgId },
      p_metadata: { request_id: requestId },
      p_organization_id: activeOrg.orgId,
    })
    .then(({ error: e }) => {
      if (e) console.error("[atualizarInterfaceDaEmpresa] emit_event failed", e.message);
    });

  revalidatePath("/app/settings/tenant");
  // O menu vive no layout do /app: sem isto quem acabou de escolher continuaria
  // vendo o menu antigo até o próximo carregamento completo.
  revalidatePath("/app", "layout");
  return { ok: true };
}
