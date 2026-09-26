/**
 * PARCELAS de um contrato de honorários — o calendário de pagamento.
 *
 * Pagar uma parcela NÃO acontece aqui: é `/api/v1/honorarios/parcelas/[id]/pagar`, que cria o
 * `financial_entries` do caixa núcleo (DIRC "integrar" — não há tabela de "pagamento" própria).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const MODULO_NAO_INSTALADO =
  "O módulo de honorários não está instalado nesta instalação. Peça ao administrador para " +
  "instalar em Configurações da instalação › Módulos.";

function moduloNaoInstalado(error: { code?: string } | null): boolean {
  return error?.code === "42P01";
}

const criarSchema = z.object({
  numero: z.number().int().min(1),
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida."),
  valor_cents: z.number().int().min(1),
});

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "honorarios_parcelas" });
  if (!authz.ok) return authz.response;
  const { id: contratoId } = await ctx.params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("honorarios_parcelas")
    .select("id, contrato_id, numero, vencimento, valor_cents, financial_entry_id, status")
    .eq("contrato_id", contratoId)
    .order("numero", { ascending: true });

  if (error) {
    if (moduloNaoInstalado(error)) {
      return fail("module_not_installed", MODULO_NAO_INSTALADO, 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("manager", { requestId, resource: "honorarios_parcelas" });
  if (!authz.ok) return authz.response;
  const { id: contratoId } = await ctx.params;

  const lido = criarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, {
      requestId,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("honorarios_parcelas")
    .insert({
      organization_id: authz.org.orgId,
      contrato_id: contratoId,
      numero: lido.data.numero,
      vencimento: lido.data.vencimento,
      valor_cents: lido.data.valor_cents,
    })
    .select("id, contrato_id, numero, vencimento, valor_cents, status")
    .single();

  if (error) {
    if (moduloNaoInstalado(error)) {
      return fail("module_not_installed", MODULO_NAO_INSTALADO, 409, { requestId });
    }
    if (error.code === "23503") {
      return fail("validation_failed", "Contrato inválido para esta organização.", 422, {
        requestId,
      });
    }
    if (error.code === "23505") {
      return fail("validation_failed", "Já existe uma parcela com este número.", 422, {
        requestId,
      });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  await audit({
    action: "honorarios.parcela_criada",
    resourceType: "honorarios_parcela",
    resourceId: data.id,
    requestId,
    metadata: { contrato_id: contratoId, numero: data.numero, valor_cents: data.valor_cents },
  });

  return ok(data, { requestId });
}
