/**
 * CONTRATOS DE HONORÁRIOS — o modelo de cobrança do caso (fixo, êxito ou misto).
 *
 * Módulo opcional (ADR-0002): as tabelas só existem depois que o administrador da instalação
 * instala `honorarios` em `/admin/modulos`. Enquanto não instalado, o Postgres devolve 42P01
 * (tabela inexistente) — traduzido aqui para uma mensagem clara, nunca um 500 cru.
 *
 * ⚠️ CLIENT DE SESSÃO. A RLS da migration 0385 já exige `manager`+ para escrever; a rota cobra
 * o mesmo degrau por clareza de mensagem, não como segunda régua de autoridade.
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

const criarSchema = z
  .object({
    lead_id: z.string().uuid().nullish(),
    modelo: z.enum(["fixo", "exito", "misto"]),
    valor_fixo_cents: z.number().int().min(1).nullish(),
    percentual_exito: z.number().min(0.01).max(100).nullish(),
    repasse_advogado_pct: z.number().min(0).max(100).nullish(),
  })
  .refine(
    (v) =>
      (v.modelo === "fixo" && v.valor_fixo_cents != null) ||
      (v.modelo === "exito" && v.percentual_exito != null) ||
      (v.modelo === "misto" && v.valor_fixo_cents != null && v.percentual_exito != null),
    { message: "O modelo escolhido exige o valor/percentual correspondente." },
  );

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "honorarios_contratos" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const leadId = url.searchParams.get("lead_id");

  const supabase = await createClient();
  let q = supabase
    .from("honorarios_contratos")
    .select(
      "id, lead_id, modelo, valor_fixo_cents, percentual_exito, repasse_advogado_pct, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(200);
  if (leadId) q = q.eq("lead_id", leadId);

  const { data, error } = await q;
  if (error) {
    if (moduloNaoInstalado(error)) {
      return fail("module_not_installed", MODULO_NAO_INSTALADO, 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("manager", { requestId, resource: "honorarios_contratos" });
  if (!authz.ok) return authz.response;

  const lido = criarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, {
      requestId,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("honorarios_contratos")
    .insert({
      organization_id: authz.org.orgId,
      lead_id: lido.data.lead_id ?? null,
      modelo: lido.data.modelo,
      valor_fixo_cents: lido.data.valor_fixo_cents ?? null,
      percentual_exito: lido.data.percentual_exito ?? null,
      repasse_advogado_pct: lido.data.repasse_advogado_pct ?? null,
    })
    .select("id, lead_id, modelo, valor_fixo_cents, percentual_exito, repasse_advogado_pct")
    .single();

  if (error) {
    if (moduloNaoInstalado(error)) {
      return fail("module_not_installed", MODULO_NAO_INSTALADO, 409, { requestId });
    }
    if (error.code === "23503") {
      return fail("validation_failed", "Lead inválido para esta organização.", 422, {
        requestId,
      });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  await audit({
    action: "honorarios.contrato_criado",
    resourceType: "honorarios_contrato",
    resourceId: data.id,
    requestId,
    metadata: { modelo: data.modelo, lead_id: data.lead_id },
  });

  return ok(data, { requestId });
}
