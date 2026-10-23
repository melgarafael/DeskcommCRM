"use server";

/**
 * LIGAR E DESLIGAR "TELEFONE INFORMADO PELO CLIENTE ENTRA SOZINHO NA FICHA
 * VAZIA" — a opção por organização da issue #2593.
 *
 * DESLIGADA (o padrão de toda organização, e de quem atualizar o produto):
 * o número que o cliente diz na conversa vira PROPOSTA e espera uma pessoa,
 * exatamente como a spec 17 §4b manda para o resto do dado ouvido. LIGADA: um
 * telefone que vira E.164 e uma ficha SEM número são gravados NA HORA — só
 * nesse caso, só nesse campo, com a trava `phone_number is null` dentro do
 * UNIQUE UPDATE e com rastro na timeline e na auditoria.
 *
 * ⚠️ SERVICE ROLE COM `organization_id` DE FONTE CONFIÁVEL, como
 * `definirVendaPeloCanal`: pela sessão de um admin de tenant, o UPDATE em
 * `organizations` casa ZERO linhas e devolve sucesso — o defeito clássico que a
 * action da 0262 documenta. O id vem de `resolveActiveOrg`, nunca de argumento.
 *
 * ⚠️ NÃO EXISTE RPC para esta chave, e é por isso que a gravação é
 * ler-mesclar-gravar no jsonb: nenhuma migration acompanha a entrega (o próprio
 * mantenedor apontou que `settings` é jsonb e não precisa de uma). A
 * consequência está tratada: `settings` é COMPARTILHADO, então a mescla
 * preserva as outras chaves — `crm.cliente_pela_agenda`, `routing`,
 * `visibility_mode`, `art15` e o que mais estiver lá.
 *
 * O gate é `admin`, o mesmo de `settings/marca` e de Conversões: a decisão
 * muda o que o SISTEMA grava na ficha de um cliente sem ninguém conferir.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoTelefoneDeFichaVazia =
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

export async function definirTelefoneDeFichaVazia(
  ligar: boolean,
): Promise<ResultadoTelefoneDeFichaVazia> {
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
  const novo = { ...settings, crm: { ...crm, telefone_de_ficha_vazia: entrada.data } };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) {
    logger.error("[telefone-de-ficha-vazia] a gravação da opção falhou", {
      organization_id: org.orgId,
      code: error.code,
      error: error.message,
    });
    return { ok: false, error: "erro_ao_gravar" };
  }

  await audit({
    action: "crm.telefone_de_ficha_vazia_alterado",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    // O `crm` anterior NÃO vai para o metadata: ele carrega as outras chaves de
    // CRM da organização, e audit é lido por quem audita, não por quem opera a
    // tela. O que importa aqui é o booleano que mudou.
    metadata: { ligado: entrada.data },
  });

  revalidatePath("/app/settings/atendimento");
  // O layout monta o `ActiveOrg`; sem invalidar, a mudança só apareceria no
  // próximo recarregamento completo — a mesma razão das outras duas actions.
  revalidatePath("/app", "layout");

  return { ok: true, ligado: entrada.data };
}
