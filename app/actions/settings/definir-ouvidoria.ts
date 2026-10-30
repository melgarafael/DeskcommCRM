"use server";

/**
 * LIGAR/DESLIGAR O MÓDULO DE OUVIDORIA DA EMPRESA (#3611, fatia 1).
 *
 * O que a chave decide e como ela é lida estão em `lib/schemas/settings.ts`
 * (`ouvidoriaDeclarada`); quem a consulta é `lib/ouvidoria/registro.ts`. Aqui só
 * a gravação.
 *
 * ⚠️ SERVICE ROLE COM `organization_id` DE FONTE CONFIÁVEL, como
 * `definirEntradaAutomaticaNoFunil` e `definirAiDecideDaEmpresa`: pelo cliente de
 * sessão, o UPDATE de um admin de tenant em `organizations` casa ZERO linhas e o
 * PostgREST devolve sucesso — a tela diria "salvo" e nada teria sido gravado. O
 * id vem de `resolveActiveOrg`, nunca de argumento.
 *
 * ⚠️ `settings` é jsonb COMPARTILHADO: ler, mesclar NO NÍVEL DA CHAVE e gravar.
 * Um `update({ settings: { ouvidoria } })` ingênuo apagaria `branding`,
 * `conversions`, `crm`, `fidelidade` e o resto em silêncio.
 *
 * ⚠️ ADMIN, e não `manager`: quem liga a porta por onde entra reclamação com
 * dado sensível é o mesmo papel que pode LER o que entrou (a RLS da 9030 exige
 * `admin`). Deixar o Gerente ligar criaria a promessa de um módulo que ele
 * próprio não consegue abrir.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { OUVIDORIA_CHAVE } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";

const ativacaoSchema = z.strictObject({ ativa: z.boolean() });

export type OuvidoriaInput = z.infer<typeof ativacaoSchema>;

export type ResultadoDaOuvidoria =
  | { ok: true }
  | {
      ok: false;
      error: "validation_failed" | "unauthenticated" | "forbidden_tenant" | "forbidden_role" | "mfa_required" | "erro_ao_gravar";
    };

export async function definirOuvidoriaDaEmpresa(
  entrada: OuvidoriaInput,
): Promise<ResultadoDaOuvidoria> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const lido = ativacaoSchema.safeParse(entrada);
  if (!lido.success) return { ok: false, error: "validation_failed" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  if (ROLE_RANK[org.role] < ROLE_RANK.admin) return { ok: false, error: "forbidden_role" };
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
    [OUVIDORIA_CHAVE]: { ativa: lido.data.ativa },
  };

  const { error } = await admin
    .from("organizations")
    .update({ settings: novo })
    .eq("id", org.orgId);
  if (error) {
    logger.error("[ouvidoria] a gravação da ativação falhou", {
      organization_id: org.orgId,
      error: error.message.slice(0, 120),
    });
    return { ok: false, error: "erro_ao_gravar" };
  }

  await audit({
    action: "settings.ouvidoria_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { ativa: lido.data.ativa },
  });

  // `/app` lê a chave pelo `ActiveOrg` que o layout monta: sem invalidar, a tela
  // continuaria com a decisão antiga até um recarregamento completo.
  revalidatePath("/app", "layout");
  return { ok: true };
}
