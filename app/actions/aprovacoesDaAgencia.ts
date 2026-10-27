"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { registrarCiencia, registrarResposta } from "@/lib/agencia/aprovacoes/servico";
import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { roleAtLeast } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { capacidadesDaOrganizacao } from "@/lib/organizacao/capacidades";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * A resposta do CLIENTE da agência a uma aprovação (docs/agencia/SPEC-aprovacoes.md,
 * P3/P4), pela organização dele. A organização vem da sessão (nunca do corpo); a
 * aprovação só é respondida se for DESTA organização e estiver pendente.
 */
const respostaSchema = z
  .object({
    aprovacaoId: z.string().uuid(),
    decisao: z.enum(["aprovado", "ajustes"]),
    comentario: z.string().trim().max(2000).nullable(),
  })
  .refine((r) => r.decisao === "aprovado" || !!r.comentario, { message: "comentario_obrigatorio" });

export type ResultadoDaResposta =
  | { ok: true }
  | { ok: false; error: "auth_required" | "no_active_org" | "forbidden" | "comentario_obrigatorio" | "invalid" | "nao_pendente" };

export async function responderAprovacao(entrada: z.input<typeof respostaSchema>): Promise<ResultadoDaResposta> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "auth_required" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return { ok: false, error: "no_active_org" };
  if (!roleAtLeast(activeOrg.role, "agent")) return { ok: false, error: "forbidden" };
  const db = createAdminClient();
  if (!(await capacidadesDaOrganizacao(db, activeOrg.orgId)).includes("aprovacoes_da_agencia")) return { ok: false, error: "forbidden" };

  const p = respostaSchema.safeParse(entrada);
  if (!p.success) return { ok: false, error: p.error.issues[0]?.message === "comentario_obrigatorio" ? "comentario_obrigatorio" : "invalid" };

  const respondida = await registrarResposta({
    aprovacaoId: p.data.aprovacaoId,
    organizationId: activeOrg.orgId,
    userId: user.id,
    decisao: p.data.decisao,
    comentario: p.data.comentario || null,
  });
  if (!respondida) return { ok: false, error: "nao_pendente" };

  await audit({
    action: p.data.decisao === "aprovado" ? "agencia.aprovacao_aprovada" : "agencia.aprovacao_ajustes",
    organizationId: activeOrg.orgId,
    actorUserId: user.id,
    resourceType: "agencia_aprovacao",
    resourceId: p.data.aprovacaoId,
  });
  revalidatePath("/app/aprovacoes");
  return { ok: true };
}

/** "Ciente" no aviso da agência (SPEC-envios, E5): as mesmas guardas da resposta. */
export async function marcarCiente(aprovacaoId: string): Promise<ResultadoDaResposta> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "auth_required" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return { ok: false, error: "no_active_org" };
  if (!roleAtLeast(activeOrg.role, "agent")) return { ok: false, error: "forbidden" };
  const db = createAdminClient();
  if (!(await capacidadesDaOrganizacao(db, activeOrg.orgId)).includes("aprovacoes_da_agencia")) return { ok: false, error: "forbidden" };
  if (!z.string().uuid().safeParse(aprovacaoId).success) return { ok: false, error: "invalid" };

  const feito = await registrarCiencia({ aprovacaoId, organizationId: activeOrg.orgId, userId: user.id });
  if (!feito) return { ok: false, error: "nao_pendente" };
  await audit({
    action: "agencia.aviso_ciente",
    organizationId: activeOrg.orgId,
    actorUserId: user.id,
    resourceType: "agencia_aprovacao",
    resourceId: aprovacaoId,
  });
  revalidatePath("/app/aprovacoes");
  return { ok: true };
}
