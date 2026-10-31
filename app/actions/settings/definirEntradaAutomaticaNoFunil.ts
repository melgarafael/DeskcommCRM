"use server";

/**
 * ESCOLHER O FUNIL E A ETAPA DA ENTRADA AUTOMÁTICA (#3603, fatia 1).
 *
 * O que a chave decide e como ela é lida estão em
 * `lib/schemas/settings.ts` (`entradaAutomaticaNoFunilDeclarada`); quem APLICA é
 * `lib/leads/entrada-automatica-no-funil.ts`. Aqui só a gravação — e a
 * conferência que só o banco pode fazer.
 *
 * ⚠️ SERVICE ROLE COM `organization_id` DE FONTE CONFIÁVEL, como
 * `definirAiDecideDaEmpresa` e `definirVendaPeloCanal`: pelo client de sessão, o
 * UPDATE de um admin de tenant em `organizations` casa ZERO linhas e o PostgREST
 * devolve sucesso — a tela diria "salvo" e nada teria sido gravado. O id vem de
 * `resolveActiveOrg`, nunca de argumento.
 *
 * ⚠️ `settings` é jsonb COMPARTILHADO: ler, mesclar no nível da chave e gravar.
 * Um `update({ settings: { entrada_automatica_no_funil } })` ingênuo apagaria
 * `branding`, `conversions`, `crm` e o resto em silêncio.
 *
 * ⚠️ A VALIDAÇÃO QUE VALE É ESTA: id com forma de uuid não é funil nem etapa.
 * Gravar um `pipeline_id` de outra organização (que uma FK não pegaria, porque a
 * coluna é jsonb) faria toda conversa nova bater em `sem_funil` e o funil
 * escolhido nunca valer — falha silenciosa que só aparece dias depois, no log de
 * quem abriu a conversa. Aqui o erro chega na hora, com nome.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { ENTRADA_AUTOMATICA_NO_FUNIL_CHAVE } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

const entradaSchema = z.object({
  ativa: z.boolean(),
  pipeline_id: z.uuid().nullable(),
  stage_id: z.uuid().nullable(),
});

export type EntradaAutomaticaNoFunilInput = z.infer<typeof entradaSchema>;

export type ResultadoDaEntradaAutomatica =
  | { ok: true }
  | {
      ok: false;
      error:
        | "validation_failed"
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "funil_invalido"
        | "etapa_invalida"
        | "erro_ao_gravar";
    };

export async function definirEntradaAutomaticaNoFunil(
  entrada: EntradaAutomaticaNoFunilInput,
): Promise<ResultadoDaEntradaAutomatica> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const lido = entradaSchema.safeParse(entrada);
  if (!lido.success) return { ok: false, error: "validation_failed" };
  // Ligar sem funil é a configuração incompleta que o serviço trata como
  // "desligado": aceitar aqui seria prometer na tela o que nada faria.
  if (lido.data.ativa && !lido.data.pipeline_id) return { ok: false, error: "validation_failed" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  // Manager+ é quem monta a regra de entrada do funil — a mesma régua das demais
  // preferências comerciais da empresa.
  if (ROLE_RANK[org.role] < ROLE_RANK.manager) return { ok: false, error: "forbidden_role" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();

  // O funil e a etapa, conferidos contra o banco DESTA organização.
  if (lido.data.pipeline_id) {
    const { data: funil, error: erroDoFunil } = await admin
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", org.orgId)
      .eq("id", lido.data.pipeline_id)
      .eq("is_archived", false)
      .maybeSingle();
    if (erroDoFunil) {
      logger.warn("[entrada-automatica] conferência do funil falhou na gravação", {
        organization_id: org.orgId,
        error: erroDoFunil.message,
      });
      return { ok: false, error: "erro_ao_gravar" };
    }
    if (!funil) return { ok: false, error: "funil_invalido" };
  }

  if (lido.data.pipeline_id && lido.data.stage_id) {
    const { data: etapa, error: erroDaEtapa } = await admin
      .from("crm_stages")
      .select("id")
      .eq("organization_id", org.orgId)
      .eq("pipeline_id", lido.data.pipeline_id)
      .eq("id", lido.data.stage_id)
      .eq("is_archived", false)
      .eq("is_won", false)
      .eq("is_lost", false)
      .maybeSingle();
    if (erroDaEtapa) {
      logger.warn("[entrada-automatica] conferência da etapa falhou na gravação", {
        organization_id: org.orgId,
        error: erroDaEtapa.message,
      });
      return { ok: false, error: "erro_ao_gravar" };
    }
    if (!etapa) return { ok: false, error: "etapa_invalida" };
  }

  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, error: "erro_ao_gravar" };

  const settings = ((atual as { settings?: unknown } | null)?.settings ?? {}) as Record<
    string,
    unknown
  >;
  const novo = {
    ...settings,
    [ENTRADA_AUTOMATICA_NO_FUNIL_CHAVE]: {
      ativa: lido.data.ativa,
      pipeline_id: lido.data.pipeline_id,
      // Desligar NÃO apaga a etapa escolhida — a mesma decisão de
      // `settings.entrada_do_inbox`: religar não obriga a escolher de novo.
      stage_id: lido.data.stage_id,
    },
  };

  const { error } = await admin
    .from("organizations")
    .update({ settings: novo })
    .eq("id", org.orgId);
  if (error) {
    logger.error("[entrada-automatica] a gravação da preferência falhou", {
      organization_id: org.orgId,
      error: error.message.slice(0, 120),
    });
    return { ok: false, error: "erro_ao_gravar" };
  }

  await audit({
    action: "settings.entrada_automatica_no_funil_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: novo[ENTRADA_AUTOMATICA_NO_FUNIL_CHAVE] as Record<string, unknown>,
  });

  // Configurações lê a chave pelo `ActiveOrg` que o layout monta: sem invalidar,
  // a tela continuaria mostrando a escolha antiga até um recarregamento completo.
  revalidatePath("/app", "layout");
  return { ok: true };
}
