import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/pix-keys/[id] — atualiza nome/tipo/chave.
 * DELETE /api/v1/pix-keys/[id] — remove a chave.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok, noContent } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  createPixKeySchema,
  normalizarChavePix,
  updatePixKeySchema,
  type PixKeyType,
} from "@/lib/schemas/pix";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLS =
  "id, organization_id, owner_user_id, name, key_type, key_value, created_by_user_id, created_at, updated_at";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pix_keys" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;

  const raw = await req.json().catch(() => null);
  const parsed = updatePixKeySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (parsed.data.name !== undefined) patch.name = parsed.data.name;

  if (parsed.data.key_type !== undefined || parsed.data.key_value !== undefined) {
    const { data: atual } = await supabase
      .from("pix_keys")
      .select("key_type, key_value")
      .eq("id", id)
      .eq("organization_id", org.orgId)
      .maybeSingle();
    if (!atual) return fail("not_found", t("Chave Pix não encontrada."), 404, { requestId });

    const tipo = (parsed.data.key_type ?? atual.key_type) as PixKeyType;
    const valorBruto = parsed.data.key_value ?? atual.key_value;
    const check = createPixKeySchema.safeParse({
      name: "ok",
      key_type: tipo,
      key_value: valorBruto,
      shared: false,
    });
    if (!check.success) {
      return fail("validation_failed", t("Chave Pix inválida para o tipo escolhido."), 422, {
        requestId,
      });
    }
    patch.key_type = tipo;
    patch.key_value = normalizarChavePix(tipo, valorBruto);
  }

  const { data, error } = await supabase
    .from("pix_keys")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select(COLS)
    .single();
  if (error || !data) return fail("not_found", t("Chave Pix não encontrada."), 404, { requestId });

  void audit({
    action: "pix_key.updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "pix_key",
    resourceId: data.id,
    requestId,
    metadata: { fields: Object.keys(parsed.data) },
  });
  return ok(data, { requestId });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "pix_keys" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data: deleted, error } = await supabase
    .from("pix_keys")
    .delete()
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select("id")
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao excluir chave Pix.", 500, { requestId });
  if (!deleted) return fail("not_found", t("Chave Pix não encontrada."), 404, { requestId });

  void audit({
    action: "pix_key.deleted",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "pix_key",
    resourceId: deleted.id,
    requestId,
  });
  return noContent(requestId);
}
