"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoLeadSubmittedCausal =
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

export async function definirLeadSubmittedCausal(
  ligar: boolean,
): Promise<ResultadoLeadSubmittedCausal> {
  const entrada = z.boolean().safeParse(ligar);
  if (!entrada.success) return { ok: false, error: "validation_failed" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  if (!podeAdministrarEmpresa(user, org)) return { ok: false, error: "forbidden_role" };
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  // A RPC atualiza apenas a coluna própria e usa o relógio do banco.
  // O orgId vem da sessão, nunca do argumento enviado pelo navegador.
  const admin = createAdminClient();
  const { error } = await admin.rpc(
    "fn_definir_meta_lead_birth" as never,
    {
      p_org: org.orgId,
      p_enabled: entrada.data,
    } as never,
  );
  if (error) return { ok: false, error: "erro_ao_gravar" };

  const hdrs = await headers();
  await audit({
    action: "conversions.meta_lead_birth_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    requestId: hdrs.get("x-request-id") ?? undefined,
    metadata: { enabled: entrada.data },
  });
  revalidatePath("/app/settings/conversoes");
  return { ok: true };
}
