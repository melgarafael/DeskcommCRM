"use server";

/**
 * LIGAR OU DESLIGAR A ENTRADA AUTOMÁTICA NO FUNIL (#3603, fatia 1).
 *
 * Um interruptor: `{ ativa }`. O que ele liga e como é lido estão em
 * `lib/schemas/settings.ts` (`entradaAutomaticaNoFunilDeclarada`); quem APLICA é
 * `lib/leads/entrada-automatica-no-funil.ts`. O destino do card NÃO é escolhido
 * aqui — é o mesmo da entrada (opção (a), decidida na thread do #3616).
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

const entradaSchema = z.object({ ativa: z.boolean() });

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
        | "erro_ao_gravar";
    };

export async function definirEntradaAutomaticaNoFunil(
  entrada: EntradaAutomaticaNoFunilInput,
): Promise<ResultadoDaEntradaAutomatica> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const lido = entradaSchema.safeParse(entrada);
  if (!lido.success) return { ok: false, error: "validation_failed" };

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
    [ENTRADA_AUTOMATICA_NO_FUNIL_CHAVE]: { ativa: lido.data.ativa },
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
    metadata: { ativa: lido.data.ativa },
  });

  // Configurações lê a chave pelo `ActiveOrg` que o layout monta: sem invalidar,
  // a tela continuaria mostrando a escolha antiga até um recarregamento completo.
  revalidatePath("/app", "layout");
  return { ok: true };
}
