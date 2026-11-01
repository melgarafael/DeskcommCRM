import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * Épico Operação Visível (F1) — PATCH: arquiva/reativa uma entrada de memória
 * da org (migration 0067). Filtro `organization_id` sempre (admin client
 * bypassa RLS).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * #2369 — a validade também se ajusta por aqui (renovar a programação da
 * semana, tirar o prazo de um aprendizado que virou regra permanente). Um
 * campo só continua valendo: `status`, `valid_until` ou os dois.
 */
const patchSchema = z
  .object({
    status: z.enum(["archived", "active"]).optional(),
    valid_until: z.string().date().nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.valid_until !== undefined, {
    message: "informe status ou valid_until",
  });

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "org_memory" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org } = authz;

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", t("Informe um status ou uma data de validade válidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // Só o que veio no corpo é gravado: `valid_until: undefined` no UPDATE do
  // PostgREST não apaga a data, mas confiar nisso deixaria a intenção refém de
  // detalhe da biblioteca — e "apagar o prazo" precisa ser `null` explícito.
  const alteracoes: { status?: string; valid_until?: string | null; updated_at: string } = {
    updated_at: new Date().toISOString(),
  };
  if (parsed.data.status !== undefined) alteracoes.status = parsed.data.status;
  if (parsed.data.valid_until !== undefined) alteracoes.valid_until = parsed.data.valid_until;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("org_memory_entries")
    .update(alteracoes)
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select("id, status, valid_until")
    .single();
  if (error || !data) {
    return fail("not_found", t("Entrada de memória não encontrada nesta organização."), 404, {
      requestId,
    });
  }

  await audit({
    action: "ai.org_memory_entry_updated",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "org_memory_entries",
    resourceId: id,
    requestId,
    metadata: { status: parsed.data.status ?? null, valid_until: parsed.data.valid_until ?? null },
  });

  return ok({ id: data.id, status: data.status, valid_until: data.valid_until }, { requestId });
}
