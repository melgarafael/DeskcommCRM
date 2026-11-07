import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { montarTextoConfirmacaoWhatsApp } from "@/lib/avaliacao/texto-confirmacao";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "avaliacao"))) return fail("not_found", "Not found", 404, { requestId });

  const authz = await requireRole("agent", { requestId, resource: "avaliacao_agendamentos" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("avaliacao_agendamentos")
    .select("scheduled_at, contacts(name), avaliacao_unidades(name), vehicle_plate, vehicle_brand, vehicle_model")
    .eq("id", id)
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Agendamento não encontrado.", 404, { requestId });

  const contato = Array.isArray(data.contacts) ? data.contacts[0] : data.contacts;
  const unidade = Array.isArray(data.avaliacao_unidades) ? data.avaliacao_unidades[0] : data.avaliacao_unidades;

  const texto = montarTextoConfirmacaoWhatsApp({
    client_name: (contato as { name?: string })?.name ?? "Cliente",
    scheduled_at: data.scheduled_at as string,
    unit_name: (unidade as { name?: string })?.name ?? "Unidade",
    vehicle_plate: data.vehicle_plate as string | null,
    vehicle_brand: data.vehicle_brand as string | null,
    vehicle_model: data.vehicle_model as string | null,
  });

  return ok({ texto }, { requestId });
}
