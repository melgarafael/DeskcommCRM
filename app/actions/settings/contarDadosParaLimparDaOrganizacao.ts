"use server";

import { supportWriteError } from "@/lib/impersonate/support";

import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { contarDadosParaLimparDaOrg, type ContagensApagadas } from "@/lib/settings/apagar-dados-operacionais";
import { createAdminClient } from "@/lib/supabase/admin";

export type PreviaDaLimpezaResult =
  | { ok: true; counts: ContagensApagadas }
  | { ok: false; error: "unauthenticated" | "forbidden_tenant" | "forbidden_role" | "mfa_required" | "db_error" };

/**
 * A prévia da "Limpar dados de teste" (A22, issue #4887): quantos registros de
 * cada tipo o reset vai apagar HOJE na organização ativa. Não apaga nada.
 *
 * Mesmas portas da action que apaga: sessão, organização ativa vinda do cookie
 * validado no servidor (nunca do input — o client é o de service role e bypassa
 * RLS) e papel de administrador. Quem não pode apagar não tem por que contar o
 * que a organização guarda por esta porta. Sem a confirmação por nome:
 * ler a contagem não muda nada.
 */
export async function contarDadosParaLimparDaOrganizacao(): Promise<PreviaDaLimpezaResult> {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(authUser.support)) return { ok: false, error: "forbidden_role" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(authUser, activeOrg)) return { ok: false, error: "forbidden_role" };
  // A mesma régua de toda action que autoriza por `podeAdministrarEmpresa`
  // (`tests/unit/acoes-da-empresa-pedem-o-codigo.test.ts`): o admin da plataforma
  // só lê o que a organização guarda depois de provar o segundo fator.
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const previa = await contarDadosParaLimparDaOrg(createAdminClient(), activeOrg.orgId);
  if (!previa.ok) return { ok: false, error: "db_error" };
  return { ok: true, counts: previa.counts };
}
