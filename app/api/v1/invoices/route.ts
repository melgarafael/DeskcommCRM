/**
 * GET  /api/v1/invoices — notas da organização ativa.
 * POST /api/v1/invoices — emite nota a partir de um pedido faturado.
 *
 * Sem config fiscal, 422 nomeando a tela de configuração — nunca presume
 * série 1. Sem emissor real, a nota nasce `pendente` via stub (honesto):
 * o estado diz "registrada, não autorizada", e a tela diz o que falta.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { emitirNota } from "@/lib/fiscal/emitir-nota";
import {
  COLUNAS_DA_NOTA,
  notaCreateSchema,
  STATUS_DA_NOTA,
} from "@/lib/schemas/fiscal";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "invoices" });
  if (!authz.ok) return authz.response;

  const status = req.nextUrl.searchParams.get("status")?.trim() ?? "";
  const orderId = req.nextUrl.searchParams.get("order_id")?.trim() ?? "";
  const supabase = await createClient();
  let q = supabase
    .from("invoices")
    .select(COLUNAS_DA_NOTA)
    .eq("organization_id", authz.org.orgId);

  if (status !== "" && (STATUS_DA_NOTA as readonly string[]).includes(status)) {
    q = q.eq("status", status);
  }
  if (orderId !== "") {
    q = q.eq("order_id", orderId);
  }

  const { data, error } = await q.order("created_at", { ascending: false }).limit(200);
  if (error) return fail("internal_error", "Erro ao listar as notas.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "invoices" });
  if (!authz.ok) return authz.response;

  const parsed = notaCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  // A regra mora em `lib/fiscal/emitir-nota.ts` — a rota autentica, valida e
  // traduz, e o assistente interno chama a MESMA função na `/executar`.
  try {
    const nota = await emitirNota({
      supabase,
      admin: createAdminClient(),
      orgId: authz.org.orgId,
      userId: authz.user.id,
      requestId,
      orderId: parsed.data.order_id,
    });

    await audit({
      organizationId: authz.org.orgId,
      actorUserId: authz.user.id,
      action: "invoice.created",
      resourceType: "invoices",
      resourceId: nota.id,
      requestId,
    });

    return ok(nota, { requestId, status: 201 });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(
        err.code as "validation_failed" | "not_found" | "conflict" | "internal_error",
        err.message,
        err.status,
        { requestId },
      );
    }
    throw err;
  }
}
