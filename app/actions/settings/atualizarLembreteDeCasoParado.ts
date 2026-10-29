"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A mesma faixa das CHECK de `organizations` (migration 0766). A duplicação é
 * declarada: sem ela, um valor fora da faixa só voltaria como erro cru do
 * Postgres em vez de `validation_failed`.
 */
const lembreteSchema = z
  .object({
    ligado: z.boolean(),
    intervaloHoras: z.number().int().min(1).max(168),
    teto: z.number().int().min(1).max(10),
  })
  .strict();

export type LembreteDeCasoParado = z.infer<typeof lembreteSchema>;
export type LembreteDeCasoParadoResult = { ok: true } | { ok: false; error: string };

/**
 * Grava a cadência do lembrete de caso parado da ORGANIZAÇÃO — o que o
 * `case-stale-watcher` lê para cobrar na Central o caso que espera a equipe.
 *
 * Os gates são os de `atualizarInterfaceDaEmpresa`: sessão de suporte não
 * escreve, papel `admin` (ou super-admin fora de suporte), dívida de MFA. A
 * escrita vai pelo admin client porque a única policy de escrita de
 * `organizations` é a de plataforma (issue #144), e a organização vem da
 * SESSÃO, nunca do corpo.
 */
export async function atualizarLembreteDeCasoParado(
  input: LembreteDeCasoParado,
): Promise<LembreteDeCasoParadoResult> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const parsed = lembreteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(authUser, activeOrg)) return { ok: false, error: "forbidden_role" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const novo = {
    lembrete_caso_ligado: parsed.data.ligado,
    lembrete_caso_intervalo_horas: parsed.data.intervaloHoras,
    lembrete_caso_teto: parsed.data.teto,
  };

  const { error } = await createAdminClient()
    .from("organizations")
    .update(novo)
    .eq("id", activeOrg.orgId);
  if (error) return { ok: false, error: "internal_error" };

  const hdrs = await headers();
  await audit({
    action: "ai.lembrete_de_caso_configurado",
    organizationId: activeOrg.orgId,
    actorUserId: authUser.id,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId: hdrs.get("x-request-id"),
    ip: ipDoCliente(hdrs),
    userAgent: hdrs.get("user-agent") ?? null,
    metadata: novo,
  });

  revalidatePath("/app/ai/inbox");
  return { ok: true };
}
