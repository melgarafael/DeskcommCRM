"use server";

/**
 * LIGAR E DESLIGAR "ATENDENTE VÊ SÓ AS PRÓPRIAS TAREFAS (E AS SEM
 * RESPONSÁVEL)" — a opção por organização da #4737, parte 2.
 *
 * DESLIGADA (o padrão de toda organização, e de quem atualizar o produto): o
 * atendente vê a organização inteira, como hoje. LIGADA: quem tem papel `agent`
 * lista e abre apenas as tarefas atribuídas a si e as sem responsável — inclusive
 * pela API (`GET /api/v1/tasks`), que é onde a restrição de fato acontece.
 * Gerente e administrador continuam vendo tudo.
 *
 * ⚠️ SERVICE ROLE COM `organization_id` DE FONTE CONFIÁVEL, como
 * `definirTelefoneDeFichaVazia`: pela sessão de um admin de tenant, o UPDATE em
 * `organizations` casa ZERO linhas e devolve sucesso — o defeito clássico que a
 * action da 0262 documenta. O id vem de `resolveActiveOrg`, nunca de argumento.
 *
 * ⚠️ NÃO EXISTE RPC para esta chave: a gravação é ler-mesclar-gravar no jsonb.
 * `settings` é COMPARTILHADO, então a mescla preserva as outras chaves —
 * `satisfacao`, `crm`, `routing`, `visibility_mode`, `task_plans` e o resto.
 *
 * O gate é `admin` (`podeAdministrarEmpresa`), o mesmo de `settings/marca` e da
 * pesquisa de satisfação: a decisão muda o que TODO atendente da empresa
 * enxerga.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { BLOCO_DAS_TAREFAS, CHAVE_DO_ESCOPO_DO_ATENDENTE } from "@/lib/tarefas/escopo-do-atendente";

export type ResultadoEscopoTarefasDoAtendente =
  | { ok: true; ligado: boolean }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_role"
        | "forbidden_tenant"
        | "mfa_required"
        | "erro_ao_gravar";
    };

export async function definirEscopoTarefasDoAtendente(
  ligar: boolean,
): Promise<ResultadoEscopoTarefasDoAtendente> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = z.boolean().safeParse(ligar);
  if (!entrada.success) return { ok: false, error: "validation_failed" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(user, org)) return { ok: false, error: "forbidden_role" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, error: "erro_ao_gravar" };

  const settings = (atual?.settings ?? {}) as Record<string, unknown>;
  const bloco = (settings[BLOCO_DAS_TAREFAS] ?? {}) as Record<string, unknown>;
  const novo = {
    ...settings,
    [BLOCO_DAS_TAREFAS]: { ...bloco, [CHAVE_DO_ESCOPO_DO_ATENDENTE]: entrada.data },
  };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) {
    logger.error("[escopo-tarefas-do-atendente] a gravação da opção falhou", {
      organization_id: org.orgId,
      code: error.code,
      error: error.message,
    });
    return { ok: false, error: "erro_ao_gravar" };
  }

  await audit({
    action: "crm.escopo_das_tarefas_do_atendente_alterado",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    // Só o booleano: o bloco `tarefas` carrega as outras chaves da organização.
    metadata: { ligado: entrada.data },
  });

  revalidatePath("/app/settings/atendimento");
  revalidatePath("/app/tasks");
  // O layout monta o `ActiveOrg`; sem invalidar, a mudança só apareceria no
  // próximo recarregamento completo.
  revalidatePath("/app", "layout");

  return { ok: true, ligado: entrada.data };
}
