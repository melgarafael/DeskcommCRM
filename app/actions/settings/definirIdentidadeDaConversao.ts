"use server";

/**
 * Grava a identidade da Meta que a recusa do #2098 pedia: o ID da Página e o
 * ID da conta do WhatsApp Business, os dois em `organizations.settings.conversions`
 * (mesmo bolso de `report_via_channel`, mesma razão — ver
 * `lib/plataformas-de-anuncio/meta/identidade.ts`). Sem migration: `settings`
 * é jsonb e a linha já existe para toda organização.
 *
 * O que esses ids decidem está no cabeçalho de `meta/conversions.ts` (regra 4).
 * Esta action só GRAVA; quem lê é `lerIdentidadeDaMeta`, no caminho do envio.
 *
 * ⚠️ SERVICE ROLE COM `organization_id` DE FONTE CONFIÁVEL, como
 * `definirVendaPeloCanal`: pelo client de sessão, o UPDATE de um admin de
 * tenant em `organizations` casa ZERO linhas e devolve sucesso. O id vem de
 * `resolveActiveOrg`, nunca de argumento.
 *
 * VAZIO APAGA, e é o contrato do formulário: apagar os dois ids devolve o
 * envio ao comportamento anterior (a Meta recusa e o motivo fica no livro-razão)
 * — que é preferível a manter um id que alguém já sabe que está errado.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { FORMA_DO_ID_META } from "@/lib/plataformas-de-anuncio/meta/identidade";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoIdentidadeDaConversao =
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

/**
 * Id da Meta: `FORMA_DO_ID_META` (de 5 a 64 dígitos), ou vazio para apagar.
 * É a MESMA constante que `identidadeDaMeta` usa na leitura — as duas pontas
 * conferem a mesma forma por construção, e nenhuma delas deixa valor estranho
 * chegar ao fio nem aceita aqui o que a leitura descartaria.
 */
const idMeta = z
  .string()
  .trim()
  .refine((v) => v === "" || FORMA_DO_ID_META.test(v), "só dígitos, de 5 a 64");

const entradaSchema = z.object({
  page_id: idMeta,
  whatsapp_business_account_id: idMeta,
});

export type IdentidadeDaConversaoInput = z.infer<typeof entradaSchema>;

export async function definirIdentidadeDaConversao(
  input: IdentidadeDaConversaoInput,
): Promise<ResultadoIdentidadeDaConversao> {
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

  // `settings` é jsonb compartilhado: ler, mesclar e gravar preserva o que não é nosso.
  const settings = (atual?.settings ?? {}) as Record<string, unknown>;
  const conversions = (settings.conversions ?? {}) as Record<string, unknown>;
  const pageId = entrada.data.page_id || null;
  const wabaId = entrada.data.whatsapp_business_account_id || null;
  const novo = {
    ...settings,
    conversions: {
      ...conversions,
      meta_page_id: pageId,
      meta_whatsapp_business_account_id: wabaId,
    },
  };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) return { ok: false, error: "erro_ao_gravar" };

  await audit({
    action: "conversions.meta_identity_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { page_id: pageId, whatsapp_business_account_id: wabaId },
  });

  revalidatePath("/app/settings/conversoes");
  return { ok: true };
}
