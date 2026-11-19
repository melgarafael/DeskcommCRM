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
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { percentualDoItem } from "@/lib/financeiro/comissao-do-item";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
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
  // #1907 item 4 — comanda é MÓDULO DE TABELA: sem `modulos_instalados` a
  // linha ativa as cinco tabelas não existem e a rota não existe. 404,
  // mesmo molde da cobrança desligada (falha fechada, dois lados).
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "financeiro"))) return fail("not_found", "Not found", 404, { requestId });
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

  // ─── #4845 — o lote não atravessa a fronteira da empresa ────────────────────
  //
  // A leitura era `.in("id", appointment_ids)` sem empresa. A RLS de
  // `calendar_appointments` libera TODAS as empresas de que a pessoa é membro
  // (e todas, para o admin da plataforma), então um id da empresa B voltava
  // daqui e era gravado na A: comanda, item, comissão e lançamento PAGO no
  // caixa da A, de um serviço prestado na B — e o atendimento da B continuava
  // pendente lá, pronto para ser cobrado de novo.
  //
  // O filtro por `organization_id` resolve a leitura. O que sobra é o que fazer
  // com um id do corpo que não volta: aqui o lote é RECUSADO INTEIRO, antes de
  // qualquer escrita. Faturar metade e recusar a outra metade deixaria a pessoa
  // com um lote pela metade e sem saber qual — e a atomicidade é o que torna a
  // recusa verificável (nenhuma linha em `sales`, `sale_items`, `commissions`
  // ou `financial_entries`).
  //
  // A recusa diz QUANTOS ids ficaram de fora e nada mais: nem nome, nem valor,
  // nem de qual empresa são. Um id que não existe em empresa nenhuma recebe a
  // mesma resposta de um id de outra empresa — assim a rota também não serve de
  // sonda para descobrir quais ids existem no vizinho.
  const pedidos = [...new Set(lido.data.appointment_ids)];

  const { data: agendamentos, error } = await supabase
    .from("calendar_appointments")
    .select(
      "id, title, contact_id, event_type_id, owner_user_id, status, calendar_event_types(name, default_price_cents)",
    )
    .eq("organization_id", org)
    .in("id", pedidos);

  if (error) return fail("internal_error", error.message, 500, { requestId });

  const daEmpresa = new Set((agendamentos ?? []).map((ag) => ag.id));
  const deFora = pedidos.filter((id) => !daEmpresa.has(id));

  if (deFora.length > 0) {
    return fail(
      "financeiro_agendamento_fora_da_empresa",
      `${deFora.length} atendimento(s) do lote não pertencem a esta empresa. Nada foi faturado.`,
      422,
      { requestId, details: { fora_da_empresa: deFora.length } },
    );
  }

  // O STATUS passou a ser filtrado aqui, e não na consulta: a leitura precisa
  // ver o agendamento da empresa em QUALQUER status para saber que ele existe
  // (senão um cancelado da própria empresa seria contado como "de fora" e
  // derrubaria o lote). O que se fatura continua sendo só confirmado/concluído,
  // como antes.
  const faturáveis = (agendamentos ?? []).filter(
    (ag) => ag.status === "confirmed" || ag.status === "completed",
  );

  // ─── o CONTATO também tem empresa ──────────────────────────────────────────
  //
  // O agendamento é da empresa, mas o `contact_id` dele pode apontar para um
  // contato de fora (dado corrompido por outro caminho, ou por escrita direta).
  // A venda nasceria na A carregando o cliente da B, e a ficha da B passaria a
  // mostrar uma comanda que não é dela. Mesma decisão da leitura acima: confere
  // antes de gravar e recusa o lote inteiro.
  const contatosDoLote = [
    ...new Set(
      faturáveis
        .map((ag) => ag.contact_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];

  if (contatosDoLote.length > 0) {
    const { data: contatos, error: erroContatos } = await supabase
      .from("contacts")
      .select("id")
      .eq("organization_id", org)
      .in("id", contatosDoLote);

    if (erroContatos) return fail("internal_error", erroContatos.message, 500, { requestId });

    const contatosDaEmpresa = new Set((contatos ?? []).map((c) => c.id));
    const contatosDeFora = contatosDoLote.filter((id) => !contatosDaEmpresa.has(id));

    if (contatosDeFora.length > 0) {
      return fail(
        "financeiro_contato_fora_da_empresa",
        `${contatosDeFora.length} cliente(s) do lote não pertencem a esta empresa. Nada foi faturado.`,
        422,
        { requestId, details: { fora_da_empresa: contatosDeFora.length } },
      );
    }
  }

  let faturados = 0;
  const pulados: Record<string, number> = {};
  const pular = (motivo: string) => {
    pulados[motivo] = (pulados[motivo] ?? 0) + 1;
  };
  const numeros: number[] = [];

  // A MOEDA VEM DA ORGANIZAÇÃO, lida UMA vez para o lote inteiro — cada linha
  // nasce na mesma unidade que a organização declarou. Sem isto a comanda
  // nascia em BRL (default `'BRL'` de `sales.currency`) em toda organização
  // que opera em euro, e o faturamento em lote escrevia a venda no bloco BRL
  // do relatório (#2160). O corpo nem declara `currency`: o Zod descarta.
  const moeda = await moedaDaOrganizacao(supabase, org);

  for (const ag of faturáveis) {
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

    // Resolve the rate before opening the sale: a failed lookup must leave
    // the appointment available for a later batch, without an empty sale.
    const comissao = await percentualDoItem(supabase, org, {
      attendantUserId: ag.owner_user_id,
      eventTypeId: ag.event_type_id,
    });
    if (!comissao.ok) {
      pular("erro_no_item");
      logger.error("[faturar-lote] commission lookup failed", {
        appointment_id: ag.id,
        error: comissao.error,
        requestId,
      });
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
        currency: moeda,
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

    // 2. o item, com o preço do catálogo e a descrição congelada. Atendente e
    // percentual entram aqui: sem eles `fn_finalizar_comanda` não gera comissão.
    // O atendente é o DONO do agendamento, nunca quem roda o lote (a recepção
    // levaria a comissão do serviço que outro prestou). Sem dono, sem comissão.
    const { error: erroItem } = await supabase.from("sale_items").insert({
      organization_id: org,
      sale_id: comanda.id,
      event_type_id: ag.event_type_id,
      description: tipo?.name ?? ag.title,
      quantity: 1,
      unit_price_cents: preco,
      total_cents: preco,
      attendant_user_id: ag.owner_user_id,
      commission_percent: comissao.percent,
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
