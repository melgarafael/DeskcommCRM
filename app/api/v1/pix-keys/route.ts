import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/pix-keys — lista chaves Pix visíveis (pessoais + compartilhadas).
 * POST /api/v1/pix-keys — cria chave. shared=true exige manager+.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createPixKeySchema, normalizarChavePix } from "@/lib/schemas/pix";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLS =
  "id, organization_id, owner_user_id, name, key_type, key_value, created_by_user_id, created_at, updated_at";
const ENDPOINT = "/api/v1/pix-keys";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pix_keys" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pix_keys")
    .select(COLS)
    .eq("organization_id", org.orgId)
    .order("updated_at", { ascending: false });
  if (error) return fail("internal_error", "Erro ao listar chaves Pix.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pix_keys" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const raw = await req.json().catch(() => null);
  const parsed = createPixKeySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { name, key_type, key_value, shared } = parsed.data;
  if (shared && !roleAtLeast(org.role, "manager")) {
    return fail("forbidden", t("Só manager+ cria chave Pix compartilhada."), 403, { requestId });
  }

  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }

  const supabase = await createClient();
  const valorNormalizado = normalizarChavePix(key_type, key_value);

  async function criar() {
    const { data, error } = await supabase
      .from("pix_keys")
      .insert({
        organization_id: org.orgId,
        owner_user_id: shared ? null : user.id,
        name,
        key_type,
        key_value: valorNormalizado,
        created_by_user_id: user.id,
      })
      .select(COLS)
      .single();
    if (error || !data) throw new Error("Erro ao criar chave Pix.");

    void audit({
      action: "pix_key.created",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "pix_key",
      resourceId: data.id,
      requestId,
      metadata: { shared, key_type },
    });
    return data;
  }

  if (chave === null) {
    try {
      return ok(await criar(), { requestId, status: 201 });
    } catch {
      return fail("internal_error", "Erro ao criar chave Pix.", 500, { requestId });
    }
  }

  try {
    const desfecho = await comIdempotencia({
      db: supabase,
      organizationId: org.orgId,
      endpoint: ENDPOINT,
      chave,
      corpo: parsed.data,
      executar: async () => ({ resposta: await criar(), status: 201 }),
    });

    if (desfecho.tipo === "conflito")
      return fail(
        "idempotency_conflict",
        t("Esta chave de idempotência já foi usada com outro conteúdo."),
        409,
        { requestId },
      );
    if (desfecho.tipo === "em_curso")
      return fail(
        "idempotency_in_progress",
        t("A mesma requisição ainda está em curso. Tente de novo em instantes."),
        409,
        { requestId },
      );
    return ok(desfecho.resposta, { requestId, status: 201 });
  } catch {
    return fail("internal_error", "Erro ao criar chave Pix.", 500, { requestId });
  }
}
