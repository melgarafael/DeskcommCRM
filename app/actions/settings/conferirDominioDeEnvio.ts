"use server";

import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { conferirDominioDeEnvio as conferirNoDns } from "@/lib/email/dominio-de-envio-dns";
import {
  carregarContaResend,
  dominioOficialDaContaResend,
} from "@/lib/email/resend-da-organizacao";
import type { DiagnosticoDoDominioDeEnvio } from "@/lib/email/dominio-de-envio";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

type FalhaDoProvedor = Exclude<
  Awaited<ReturnType<typeof dominioOficialDaContaResend>>,
  { ok: true }
>["motivo"];
export type ResultadoDaConferenciaDoDominio =
  | { ok: true; diagnostico: DiagnosticoDoDominioDeEnvio }
  | {
      ok: false;
      error:
        | "unauthenticated"
        | "forbidden_tenant"
        | "forbidden_role"
        | "mfa_required"
        | "conta_nao_conectada"
        | "conta_indisponivel"
        | "dominio_invalido"
        | FalhaDoProvedor;
    };

/** Não aceita domínio nem tenant do browser: confere o From da conta conectada agora. */
export async function conferirDominioDeEnvio(): Promise<ResultadoDaConferenciaDoDominio> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(user, org)) return { ok: false, error: "forbidden_role" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  let conta;
  try {
    conta = await carregarContaResend(createAdminClient(), org.orgId);
  } catch {
    return { ok: false, error: "conta_indisponivel" };
  }
  if (!conta) return { ok: false, error: "conta_nao_conectada" };
  try {
    const oficial = await dominioOficialDaContaResend(conta);
    if (!oficial.ok) return { ok: false, error: oficial.motivo };
    const conferencia = await conferirNoDns(oficial.dominio);
    return conferencia.ok ? conferencia : { ok: false, error: conferencia.motivo };
  } catch {
    // Nem a chave nem a mensagem bruta do transporte entram na trilha.
    logger.error("[dominio-de-envio] consulta indisponível", { organization_id: org.orgId });
    return { ok: false, error: "consulta_indisponivel" };
  }
}
