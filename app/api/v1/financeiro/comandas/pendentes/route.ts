/**
 * OS ATENDIMENTOS QUE ACONTECERAM E FICARAM SEM COMANDA.
 *
 * É a rotina que, no sistema de origem, um agente externo disparava às 20h — e a
 * medição mostrou que ela era a **única** capacidade dele realmente viva, de 22
 * declaradas. Aqui ela vira o que sempre deveria ter sido: uma lista que alguém
 * confere e fatura.
 *
 * ⚠️ ISTO NÃO FATURA NADA. Só lista. A separação entre ver e confirmar é a razão
 * de a rotina existir em dois passos: faturar em lote é irreversível (o desfazer
 * é estorno, um por um), e ninguém deve descobrir o que foi cobrado depois.
 *
 * ⚠️ O QUE ENTRA: agendamento que já COMEÇOU, não cancelado, não faltou, e sem
 * comanda viva. `completed` entra junto com `confirmed` porque concluir e
 * faturar são coisas diferentes: alguém pode ter marcado o atendimento como
 * concluído na agenda e não ter aberto a comanda.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Quantos atendimentos a lista mostra. O lote de faturamento tem teto próprio. */
const TETO = 100;

/** Até quantos dias para trás a varredura olha, quando ninguém disse. */
const JANELA_PADRAO_DIAS = 30;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const agora = new Date();
  const de =
    url.searchParams.get("de") ??
    new Date(agora.getTime() - JANELA_PADRAO_DIAS * 86_400_000).toISOString();

  const supabase = await createClient();

  const { data: agendamentos, error } = await supabase
    .from("calendar_appointments")
    .select(
      "id, title, starts_at, contact_id, event_type_id, status, calendar_event_types(name, default_price_cents)",
    )
    .in("status", ["confirmed", "completed"])
    .gte("starts_at", de)
    .lt("starts_at", agora.toISOString())
    .order("starts_at", { ascending: true })
    .limit(TETO);

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!agendamentos?.length) return ok([], { requestId });

  // Quais já têm comanda. Uma consulta só, e não uma por agendamento: a segunda
  // forma funciona em desenvolvimento e derruba a tela com trinta atendimentos.
  const ids = agendamentos.map((a) => a.id);
  const { data: comandas } = await supabase
    .from("sales")
    .select("appointment_id")
    .in("appointment_id", ids)
    .neq("status", "cancelled");

  const jaFaturados = new Set((comandas ?? []).map((c) => c.appointment_id as string));

  const pendentes = agendamentos
    .filter((a) => !jaFaturados.has(a.id))
    .map((a) => {
      const tipo = Array.isArray(a.calendar_event_types)
        ? a.calendar_event_types[0]
        : a.calendar_event_types;
      return {
        appointment_id: a.id,
        title: a.title,
        starts_at: a.starts_at,
        contact_id: a.contact_id,
        event_type_id: a.event_type_id,
        service_name: tipo?.name ?? null,
        // Null quando o tipo não tem preço padrão. A tela mostra isso como
        // "sem preço" e o lote recusa a linha, em vez de faturar um valor
        // inventado.
        suggested_price_cents: tipo?.default_price_cents ?? null,
      };
    });

  return ok(pendentes, { requestId });
}
