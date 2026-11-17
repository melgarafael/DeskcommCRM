"use server";

/**
 * LIGAR E DESLIGAR "SUGERIR DUPLICADOS PELO NOME" — a opção por organização da
 * issue #4138.
 *
 * DESLIGADA (o padrão de toda organização, e de quem atualizar o produto): a tela
 * Contatos › Duplicados mostra só os motivos fortes — telefone, e-mail, CPF e o
 * telefone que a ingestão parkou em conflito. LIGADA: a seção "Parecidos —
 * confira" volta, com a mesma régua da Spec 31 (palavra rara e nome contido) e o
 * mesmo "Não são a mesma empresa".
 *
 * ⚠️ Nada aqui junta contato. A opção decide se a SUGESTÃO aparece; juntar
 * continua sendo um clique de gestor na conferência, com os dados lado a lado.
 *
 * ⚠️ SERVICE ROLE COM `organization_id` DE FONTE CONFIÁVEL, como
 * `definirTelefoneDeFichaVazia`: pela sessão de um admin de tenant o UPDATE em
 * `organizations` casa ZERO linhas e devolve sucesso — o defeito clássico que a
 * action da 0262 documenta. O id vem de `resolveActiveOrg`, nunca de argumento.
 *
 * ⚠️ SEM MIGRATION: `settings` é jsonb e a chave é um booleano, como as vizinhas
 * de `settings.crm` (#2593, #3644). A gravação é ler-mesclar-gravar, então as
 * outras chaves de CRM da organização ficam intactas.
 *
 * O gate é `admin`, o mesmo de `definirTelefoneDeFichaVazia`: a opção muda o que
 * TODO mundo vê na tela de limpeza de contatos.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoDuplicadosPorNome =
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

export async function definirDuplicadosPorNome(
  ligar: boolean,
): Promise<ResultadoDuplicadosPorNome> {
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
  const crm = (settings.crm ?? {}) as Record<string, unknown>;
  const novo = { ...settings, crm: { ...crm, duplicados_por_nome: entrada.data } };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) {
    logger.error("[duplicados-por-nome] a gravação da opção falhou", {
      organization_id: org.orgId,
      code: error.code,
      error: error.message,
    });
    return { ok: false, error: "erro_ao_gravar" };
  }

  await audit({
    action: "crm.duplicados_por_nome_alterado",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    // O `crm` anterior NÃO vai para o metadata: ele carrega as outras regras da
    // organização. O que importa aqui é o booleano que mudou.
    metadata: { ligado: entrada.data },
  });

  revalidatePath("/app/settings/atendimento");
  // O layout monta o `ActiveOrg`; sem invalidar, a mudança só apareceria no
  // próximo recarregamento completo.
  revalidatePath("/app", "layout");

  return { ok: true, ligado: entrada.data };
}
