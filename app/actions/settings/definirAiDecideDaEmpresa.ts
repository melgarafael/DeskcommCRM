"use server";

/**
 * Liga e desliga o passo `ai_decide` para a EMPRESA INTEIRA (#2367).
 *
 * O que a chave decide e o default (LIGADO) estão em
 * `lib/automation/ai-decide-da-org.ts`; aqui só a gravação.
 *
 * ⚠️ SERVICE ROLE COM `organization_id` DE FONTE CONFIÁVEL, como
 * `definirVendaPeloCanal`: pelo client de sessão, o UPDATE de um admin de
 * tenant em `organizations` casa ZERO linhas e devolve sucesso. O id vem de
 * `resolveActiveOrg`, nunca de argumento.
 *
 * `settings` é jsonb compartilhado: ler, mesclar nos DOIS níveis e gravar
 * preserva o que não é nosso — um `update({ settings: { automacoes } })`
 * ingênuo apagaria `branding`, `conversions` e o resto em silêncio.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { CHAVE_DAS_AUTOMACOES } from "@/lib/automation/ai-decide-da-org";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoInterruptorAiDecide =
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

export async function definirAiDecideDaEmpresa(ligar: boolean): Promise<ResultadoInterruptorAiDecide> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = z.boolean().safeParse(ligar);
  if (!entrada.success) return { ok: false, error: "validation_failed" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  // Mesmo gate da tela: manager+ é quem monta a regra, e é para quem a regra
  // decide — nada aqui apaga conversa nem muda dinheiro.
  if (ROLE_RANK[org.role] < ROLE_RANK.manager) return { ok: false, error: "forbidden_role" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();
  const { data: atual, error: erroLeitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (erroLeitura) return { ok: false, error: "erro_ao_gravar" };

  const settings = (atual?.settings ?? {}) as Record<string, unknown>;
  const automacoes = (settings[CHAVE_DAS_AUTOMACOES] ?? {}) as Record<string, unknown>;
  const novo = { ...settings, [CHAVE_DAS_AUTOMACOES]: { ...automacoes, ai_decide: entrada.data } };

  const { error } = await admin.from("organizations").update({ settings: novo }).eq("id", org.orgId);
  if (error) return { ok: false, error: "erro_ao_gravar" };

  await audit({
    action: "settings.automation_ai_decide_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { ligado: entrada.data },
  });

  revalidatePath("/app/settings/automacoes");
  return { ok: true };
}
