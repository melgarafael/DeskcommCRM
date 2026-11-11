import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * Épico Operação Visível (F1) — POST: cria entrada manual de memória da org
 * (migration 0067). source='manual', status='active' direto (sem gate de
 * proposta — quem cria é já manager+).
 *
 * Aceita sessão de navegador OU Bearer `dsk_…` com escopo `config:write`
 * e papel admin (`tokenRole`). A organização vem da linha do token, nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const postSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  /**
   * #2369 — último dia em que o aprendizado vale (YYYY-MM-DD), no fuso da
   * organização. Ausente ou `null` = sem prazo, que é o caso de toda entrada
   * criada antes desta coluna: nenhum cliente antigo muda de comportamento.
   */
  valid_until: z.string().date().nullable().optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "org_memory_entry_create",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const actorUserId = authz.actor.type === "user" ? authz.actor.id : null;
  const teto = await tetoDeEscritaDoToken(authz, "org_memory_entries", requestId);
  if (teto) return teto;

  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", t("title e body são obrigatórios."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("org_memory_entries")
    .insert({
      organization_id: authz.organizationId,
      title: parsed.data.title,
      body: parsed.data.body,
      source: "manual",
      status: "active",
      created_by: actorUserId,
      valid_until: parsed.data.valid_until ?? null,
    })
    .select("id")
    .single();
  if (error || !data) {
    return fail("internal_error", t("Erro ao criar entrada de memória."), 500, { requestId });
  }

  await audit({
    action: "ai.org_memory_entry_created",
    actorUserId,
    actorApiTokenId: authz.apiTokenId,
    organizationId: authz.organizationId,
    resourceType: "org_memory_entries",
    resourceId: data.id as string,
    requestId,
    metadata: { valid_until: parsed.data.valid_until ?? null },
  });

  return ok({ id: data.id }, { requestId });
}
