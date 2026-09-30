/**
 * Módulo próprio, e não ao lado de `requirePlatformAdmin`, de propósito: assim
 * esta guarda chama a `requirePlatformAdmin` EXPORTADA — a mesma que os testes
 * de rota substituem —, e um teste que mocka o gate de plataforma continua
 * exercitando o escopo e a MFA daqui em vez de pular por cima deles.
 */
import type { NextResponse } from "next/server";

import { fail, type ApiError } from "@/lib/api/wrappers";
import { requirePlatformAdmin, type PlatformAdminContext } from "@/lib/auth/requirePlatformAdmin";
import { mfaEmDivida } from "@/lib/auth/server";

/**
 * Guarda de ESCRITA do admin da plataforma: as mutações de `/api/v1/admin/*`
 * sobre um tenant (suspender, reativar, editar, excluir, trocar e-mail).
 *
 * Existia só dentro do `POST /admin/tenants` (criação), escrita à mão; as rotas
 * de suspensão e reativação ficaram sem ela — um admin com `scope =
 * 'support_readonly'` suspendia qualquer organização, e sem a sessão `aal2` de
 * quem tem fator cadastrado (auditoria de 28/09/2026, C4). Aqui a regra mora num
 * lugar só:
 *
 *  - `scope = 'full'` — o acesso de suporte é de leitura;
 *  - `mfaEmDivida()` — quem TEM fator prova nesta sessão, como em `requireRole`.
 */
export type PlatformAdminWriteCheck =
  { ok: true; ctx: PlatformAdminContext } | { ok: false; response: NextResponse<ApiError> };

export async function requirePlatformAdminWrite(
  requestId: string,
): Promise<PlatformAdminWriteCheck> {
  let ctx: PlatformAdminContext;
  try {
    ctx = await requirePlatformAdmin();
  } catch {
    return {
      ok: false,
      response: fail("forbidden", "Platform admin required", 403, { requestId }),
    };
  }
  if (ctx.platformAdmin.scope !== "full") {
    return {
      ok: false,
      response: fail(
        "forbidden",
        "Seu acesso de suporte é somente leitura: esta ação exige acesso completo à plataforma.",
        403,
        { requestId },
      ),
    };
  }
  if (await mfaEmDivida()) {
    return {
      ok: false,
      response: fail("mfa_required", "Confirme a verificação em duas etapas", 403, { requestId }),
    };
  }
  return { ok: true, ctx };
}
