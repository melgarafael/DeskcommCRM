/**
 * FATURAR EM LOTE os atendimentos que ficaram sem comanda.
 *
 * O segundo passo da rotina: a lista foi conferida em
 * `comandas/pendentes`, e aqui ela vira dinheiro.
 *
 * ⚠️ CADA ATENDIMENTO É UMA TRANSAÇÃO PRÓPRIA, e isso é deliberado. Um lote de
 * trinta que aborta inteiro porque o décimo tem problema deixa a pessoa sem
 * saber o que aconteceu e com trinta para reconferir. Aqui cada linha tem
 * desfecho próprio, e a resposta diz qual foi o de cada uma.
 *
 * ⚠️ O PREÇO VEM DO CATÁLOGO, NUNCA DO CORPO. Aceitar valor por atendimento
 * daria a quem chama a rota o poder de faturar qualquer quantia em nome de um
 * atendimento passado, sem ninguém digitar nada numa tela. Tipo sem preço é
 * pulado com motivo — o lote não inventa número.
 *
 * ⚠️ UMA FORMA DE PAGAMENTO PARA O LOTE INTEIRO. É a mesma decisão do sistema de
 * origem, e pelo mesmo motivo: deixar a forma variar por linha abre espaço para
 * a errada entrar sem ninguém notar, e o erro só aparece depois, no financeiro.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Teto do lote. Acima disso a requisição estoura antes de terminar. */
const TETO_DO_LOTE = 50;

const corpoSchema = z.object({
  appointment_ids: z.array(z.string().uuid()).min(1).max(TETO_DO_LOTE),
  payment_method_id: z.string().uuid(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "financeiro" });
  if (!authz.ok) return authz.response;

  const lido = corpoSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, {
      requestId,
    });
  }

  const supabase = await createClient();
  const org = authz.org.orgId;

  const { data: agendamentos, error } = await supabase
    .from("calendar_appointments")
    .select(
      "id, title, contact_id, event_type_id, status, calendar_event_types(name, default_price_cents)",
    )
    .in("id", lido.data.appointment_ids)
    .in("status", ["confirmed", "completed"]);

  if (error) return fail("internal_error", error.message, 500, { requestId });

  let faturados = 0;
  const pulados: Record<string, number> = {};
  const pular = (motivo: string) => {
    pulados[motivo] = (pulados[motivo] ?? 0) + 1;
  };
  const numeros: number[] = [];

  for (const ag of agendamentos ?? []) {
    const tipo = Array.isArray(ag.calendar_event_types)
      ? ag.calendar_event_types[0]
      : ag.calendar_event_types;
    const preco = tipo?.default_price_cents ?? null;

    if (preco === null) {
      // O tipo não diz quanto custa. Inventar um número aqui é o pior desfecho
      // possível: ninguém confere o que já foi cobrado.
      pular("sem_preco");
      continue;
    }

    // 1. a comanda. O índice único da 0243 garante uma por atendimento mesmo com
    // dois lotes simultâneos; aqui o conflito vira "já faturado", não erro.
    const { data: numero } = await supabase.rpc("fn_proximo_numero_de_comanda", { p_org: org });
    const { data: comanda, error: erroComanda } = await supabase
      .from("sales")
      .insert({
        organization_id: org,
        number: numero as number,
        contact_id: ag.contact_id,
        appointment_id: ag.id,
        attendant_user_id: authz.user.id,
        created_by_user_id: authz.user.id,
      })
      .select("id, number")
      .single();

    if (erroComanda) {
      if (erroComanda.code === "23505") pular("ja_faturado");
      else {
        pular("erro_ao_abrir");
        logger.error("[faturar-lote] abrir comanda falhou", {
          appointment_id: ag.id,
          error: erroComanda.message,
          requestId,
        });
      }
      continue;
    }

    // 2. o item, com o preço do catálogo e a descrição congelada.
    const { error: erroItem } = await supabase.from("sale_items").insert({
      organization_id: org,
      sale_id: comanda.id,
      event_type_id: ag.event_type_id,
      description: tipo?.name ?? ag.title,
      quantity: 1,
      unit_price_cents: preco,
      total_cents: preco,
    });

    if (erroItem) {
      // A comanda fica ABERTA, e é o desfecho certo: ela aparece na lista do
      // balcão para alguém terminar à mão. Cancelá-la aqui esconderia o
      // problema e devolveria o atendimento para a fila de pendentes, onde o
      // próximo lote tentaria de novo e falharia de novo.
      pular("erro_no_item");
      logger.error("[faturar-lote] item falhou", {
        sale_id: comanda.id,
        error: erroItem.message,
        requestId,
      });
      continue;
    }

    // 3. a finalização — as seis coisas numa transação, no banco.
    const { error: erroFinal } = await supabase.rpc("fn_finalizar_comanda", {
      p_org: org,
      p_sale: comanda.id,
      p_payment_method: lido.data.payment_method_id,
      p_loyalty_points: 0,
    });

    if (erroFinal) {
      pular(
        erroFinal.message.includes("forma_sem_conta")
          ? "forma_sem_conta"
          : erroFinal.message.includes("forma_de_pagamento_invalida")
            ? "forma_invalida"
            : "erro_ao_finalizar",
      );
      logger.error("[faturar-lote] finalizar falhou", {
        sale_id: comanda.id,
        error: erroFinal.message,
        requestId,
      });
      continue;
    }

    faturados += 1;
    numeros.push(comanda.number as number);
  }

  if (faturados > 0) {
    await audit({
      action: "comanda.faturada_em_lote",
      resourceType: "sale",
      requestId,
      metadata: {
        faturados,
        pulados,
        numeros,
        payment_method_id: lido.data.payment_method_id,
      },
    });
  }

  return ok({ faturados, pulados, numeros }, { requestId });
}
