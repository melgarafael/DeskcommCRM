/**
 * GET /api/v1/billing/plans — catálogo de planos ativos.
 *
 * Qualquer autenticado lê (precisa aparecer no signup, antes de ter
 * organização, e no formulário de criar tenant do console admin). Em
 * self-host a tabela normalmente está vazia — ninguém populou plano nenhum —
 * então a resposta é `[]`, não erro: o formulário que consome isto trata lista
 * vazia como "sem billing configurado nesta instalação", sem precisar
 * perguntar a BILLING_MODE separadamente.
 */
import { randomUUID } from "node:crypto";

import { requireAuth } from "@/lib/auth/server";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const requestId = randomUUID();

  try {
    await requireAuth();
  } catch {
    return fail("unauthenticated", "Login required", 401, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("billing_plans")
    .select("id, code, name, description, price_cents, currency, billing_interval, features")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    return fail("internal_error", "Failed to load plans", 500, { requestId });
  }

  return ok(data ?? [], { requestId });
}
