"use server";

/**
 * LIGAR E DESLIGAR "QUEM JÁ COMPROU VOLTA PELO FUNIL DE CLIENTES" — a opção por
 * organização da issue #3644, e a janela de pós-venda que anda junto.
 *
 * DESLIGADA (o padrão de toda organização, e de quem atualizar o produto): o
 * roteamento é exatamente o de antes — `first_service_at` com a regra da agenda
 * ligada. LIGADA: contato com negócio `won` e nenhum aberto conta como cliente,
 * e a conversa nova nasce no funil de clientes (`is_client_pipeline`), ou no
 * padrão quando a organização não marcou nenhum.
 *
 * `posVendaDias` (0–365, padrão 0) é a janela em que a conversa de quem acabou
 * de comprar não abre negócio nenhum — o "chegou certinho?" de dois dias depois.
 * Zero desliga a janela.
 *
 * ⚠️ SERVICE ROLE COM `organization_id` DE FONTE CONFIÁVEL, como as vizinhas
 * (`definirTelefoneDeFichaVazia`, `definirVendaPeloCanal`): pela sessão de um
 * admin de tenant, o UPDATE em `organizations` casa ZERO linhas e devolve
 * sucesso. O id vem de `resolveActiveOrg`, nunca de argumento.
 *
 * ⚠️ NÃO EXISTE RPC para estas chaves, e é por isso que a gravação é
 * ler-mesclar-gravar no jsonb: nenhuma migration acompanha a entrega (`settings`
 * é jsonb e a linha já existe para toda organização). `settings` é
 * COMPARTILHADO, então a mescla preserva as outras chaves — `crm.cliente_pela_agenda`,
 * `crm.internal_contact_tags`, `routing`, `visibility_mode`, `art15` e o resto.
 *
 * O gate é `admin`, o mesmo da chave da agenda: a decisão muda em que funil
 * nasce o negócio de quem já é cliente.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { crmSettingsSchema } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

/** Os dois campos são independentes: desligar a regra não apaga a janela. */
const entradaSchema = z.object({
  ligado: z.boolean(),
  posVendaDias: z.number().int().min(0).max(365),
});

export type EntradaClientePelaVenda = z.infer<typeof entradaSchema>;

export type ResultadoClientePelaVenda =
  | { ok: true; ligado: boolean; posVendaDias: number }
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

export async function definirClientePelaVenda(
  input: EntradaClientePelaVenda,
): Promise<ResultadoClientePelaVenda> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = entradaSchema.safeParse(input);
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
  const novo = {
    ...settings,
    crm: {
      ...crm,
      cliente_pela_venda: entrada.data.ligado,
      pos_venda_dias: entrada.data.posVendaDias,
    },
  };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) {
    logger.error("[cliente-pela-venda] a gravação da opção falhou", {
      organization_id: org.orgId,
      code: error.code,
      error: error.message,
    });
    return { ok: false, error: "erro_ao_gravar" };
  }

  await audit({
    action: "crm.cliente_pela_venda_alterado",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    // O `crm` inteiro NÃO vai para o metadata: ele carrega as outras chaves da
    // organização, e audit é lido por quem audita, não por quem opera a tela.
    metadata: { ligado: entrada.data.ligado, pos_venda_dias: entrada.data.posVendaDias },
  });

  // Retrato do que ficou gravado, lido pela MESMA régua que o servidor aplica:
  // se o jsonb antigo tivesse uma chave torta que a mescla não corrigiu, a tela
  // não pode exibir "ligado" o que o nascimento do lead lê como desligado.
  const gravado = crmSettingsSchema.parse(novo.crm);

  revalidatePath("/app/settings/atendimento");
  // O layout monta o `ActiveOrg`; sem invalidar, o menu e o selo do quadro só
  // mudariam no próximo recarregamento completo.
  revalidatePath("/app", "layout");

  return {
    ok: true,
    ligado: gravado.cliente_pela_venda === true,
    posVendaDias: gravado.pos_venda_dias,
  };
}
