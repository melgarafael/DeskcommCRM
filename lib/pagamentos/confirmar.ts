/**
 * CONFIRMAR O PAGAMENTO (issue #3509, degrau 1 — item 3).
 *
 * ─── Quem decide que pagou ──────────────────────────────────────────────────
 *
 * O aviso do provedor, depois de a assinatura conferir (a conferência é da
 * rota, `lib/pagamentos/assinatura.ts`). Aqui é o EFEITO, e ele tem de ser
 * exatamente-uma-vez: o provedor reentrega, o usuário recarrega o painel dele, o
 * retry da fila acontece — e nada disso pode mover o negócio de novo nem
 * escrever uma segunda linha de "pagamento recebido" na timeline.
 *
 * ─── O compare-and-set é a idempotência ─────────────────────────────────────
 *
 * `update ... where id = ? and status = 'pendente'`. Chegar primeiro = 1 linha
 * atualizada = efeito. Chegar depois = 0 linhas = NADA acontece (nem timeline,
 * nem etapa, nem metadata). Um `select` seguido de `update` seria check-then-act
 * e duas entregas SIMULTÂNEAS passariam as duas pela janela — o mesmo defeito
 * que a 0027 matou nos contatos. O índice único da 9026 cobre o outro lado
 * (reentrega que tenta CRIAR outra linha).
 *
 * ─── Por que a etapa de destino é `is_won` ──────────────────────────────────
 *
 * Porque o produto já decidiu isso, e não é esta entrega decidindo: a migration
 * do funil semeado escreve, com todas as letras, "Pago -> won (is_won)", e
 * `agent_stage_hint = 'won'` é o vocabulário do agente para o mesmo lugar. Um
 * marcador novo ("esta etapa é a de pagamento") seria uma segunda régua para a
 * mesma pergunta. Funil SEM etapa de ganho é estado legítimo — o pagamento é
 * registrado e o card fica onde está, exatamente como `agent-stage-sync.ts`
 * trata `sem_mapeamento`.
 *
 * ─── O que esta função NÃO faz ──────────────────────────────────────────────
 *
 * Não lança no caixa, não concilia extrato, não estorna, não manda mensagem ao
 * cliente. Nada sai daqui para o WhatsApp: aviso automático em nome da empresa é
 * decisão de produto e de anti-banimento, não efeito colateral de webhook.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";

import { CHAVE_DO_METADADO, lerPagamentoDoMetadado, metadadoDoPagamento, valorEmTexto } from "./link";
import type { Recebimento } from "./registrar";
import type { SituacaoDoRecebimento } from "./vocabulario";

export type MotivoDoNaoMovimento =
  | "sem_negocio"
  | "negocio_encerrado"
  | "sem_etapa_de_ganho"
  | "ja_esta_la"
  | "conflito_humano"
  | "falha_de_escrita";

export type VereditoDoMovimento =
  | { moveu: true; stageId: string; stageName: string }
  | { moveu: false; motivo: MotivoDoNaoMovimento };

export type ResultadoDaConfirmacao =
  | { ok: true; efeito: "pago"; recebimento: Recebimento; movido: VereditoDoMovimento }
  /** Já estava resolvido (ou outra entrega do mesmo evento chegou primeiro): NADA mudou. */
  | { ok: true; efeito: "duplicado"; status: SituacaoDoRecebimento }
  /** Id que não é nosso: não é erro do provedor, e a conciliação futura cura. */
  | { ok: true; efeito: "desconhecido" }
  | { ok: false; code: "internal_error"; message: string; status: 500 };

const COLUNAS: string = [
  "id",
  "organization_id",
  "conversation_id",
  "message_id",
  "lead_id",
  "provedor",
  "external_id",
  "valor_cents",
  "moeda",
  "status",
  "pago_em",
].join(", ");

export async function confirmarPagamento(
  admin: SupabaseClient,
  entrada: { provedor: string; externalId: string; quando: Date },
): Promise<ResultadoDaConfirmacao> {
  // ⚠️ O aviso chega SEM organização (não há sessão num webhook), então a busca
  // é por (provedor, id externo) e o índice único da 9026 é por organização —
  // duas organizações da MESMA instalação poderiam, em tese, ter o mesmo id
  // externo se apontassem para a mesma conta do provedor. Ambiguidade aqui não
  // se resolve escolhendo: duas linhas com o mesmo id é conta compartilhada
  // entre empresas, e quem decide isso é gente. Recusa ALTA (500) para o
  // provedor reentregar depois de alguém olhar — nunca marcar a linha errada.
  const { data: achados, error: erroDaBusca } = await admin
    .from("pagamento_recebimentos")
    .select(COLUNAS)
    .eq("provedor", entrada.provedor)
    .eq("external_id", entrada.externalId)
    .limit(2);
  if (erroDaBusca) {
    logger.error("[pagamentos.confirmar] recebimento ilegível", {
      provedor: entrada.provedor,
      codigo: erroDaBusca.code ?? null,
    });
    return { ok: false, code: "internal_error", message: "Não foi possível ler o recebimento.", status: 500 };
  }
  const linhas = (achados ?? []) as Recebimento[];
  if (linhas.length === 0) return { ok: true, efeito: "desconhecido" };
  if (linhas.length > 1) {
    logger.error("[pagamentos.confirmar] id externo ambíguo entre organizações", {
      provedor: entrada.provedor,
      ocorrencias: linhas.length,
    });
    return {
      ok: false,
      code: "internal_error",
      message: "Este identificador de pagamento existe em mais de uma empresa.",
      status: 500,
    };
  }
  return confirmarUm(admin, linhas[0]!, entrada.quando);
}

async function confirmarUm(
  admin: SupabaseClient,
  recebimento: Recebimento,
  quando: Date,
): Promise<ResultadoDaConfirmacao> {
  // Já resolvido antes desta entrega: sai sem escrever NADA. Esta leitura é
  // atalho; a garantia é o compare-and-set abaixo.
  if (recebimento.status !== "pendente") {
    return { ok: true, efeito: "duplicado", status: recebimento.status };
  }

  // ── O compare-and-set ─────────────────────────────────────────────────────
  const { data: atualizadas, error: erroDoUpdate } = await admin
    .from("pagamento_recebimentos")
    .update({ status: "paga", pago_em: quando.toISOString() })
    .eq("id", recebimento.id)
    .eq("organization_id", recebimento.organization_id)
    .eq("status", "pendente")
    .select("id");
  if (erroDoUpdate) {
    logger.error("[pagamentos.confirmar] pagamento não marcado", {
      organization_id: recebimento.organization_id,
      provedor: recebimento.provedor,
      codigo: erroDoUpdate.code ?? null,
    });
    return { ok: false, code: "internal_error", message: "Não foi possível marcar o pagamento.", status: 500 };
  }
  if ((atualizadas ?? []).length === 0) {
    // Outra entrega do MESMO evento ganhou a corrida entre a leitura e a
    // escrita. Zero linhas = o efeito já aconteceu, e repeti-lo seria o defeito.
    return { ok: true, efeito: "duplicado", status: "paga" };
  }

  const pago: Recebimento = { ...recebimento, status: "paga", pago_em: quando.toISOString() };

  // O ponteiro da conversa acompanha. Falhar aqui NÃO desfaz o pagamento: a
  // verdade já está gravada, e o balão que ficar "pendente" é consertado pela
  // próxima leitura da tela (o metadado é cópia, não fonte).
  await atualizarMetadadoDaMensagem(admin, pago);

  const movido = await moverParaGanho(admin, pago);
  await registrarNaTimeline(admin, pago, movido);

  return { ok: true, efeito: "pago", recebimento: pago, movido };
}

async function atualizarMetadadoDaMensagem(admin: SupabaseClient, recebimento: Recebimento): Promise<void> {
  if (!recebimento.message_id) return;
  const { data, error } = await admin
    .from("messages")
    .select("id, metadata")
    .eq("organization_id", recebimento.organization_id)
    .eq("id", recebimento.message_id)
    .maybeSingle();
  if (error || !data) return;
  const linha = data as { id: string; metadata: Record<string, unknown> | null };
  const atual = lerPagamentoDoMetadado(linha.metadata);
  // Só reescreve se o ponteiro é DESTE recebimento: metadado trocado à mão não
  // vira pagamento pago por engano.
  if (!atual || atual.recebimento_id !== recebimento.id) return;
  await admin
    .from("messages")
    .update({
      metadata: {
        ...(linha.metadata ?? {}),
        [CHAVE_DO_METADADO]: metadadoDoPagamento({
          provedor: recebimento.provedor,
          id: recebimento.external_id,
          valor: recebimento.valor_cents,
          moeda: recebimento.moeda,
          status: "paga",
          recebimento_id: recebimento.id,
        }),
      },
    })
    .eq("organization_id", recebimento.organization_id)
    .eq("id", linha.id);
}

interface LeadLido {
  id: string;
  stage_id: string | null;
  pipeline_id: string | null;
  status: string;
  contact_id: string | null;
}

async function moverParaGanho(admin: SupabaseClient, recebimento: Recebimento): Promise<VereditoDoMovimento> {
  if (!recebimento.lead_id) return { moveu: false, motivo: "sem_negocio" };

  const { data: leadBruto, error: erroDoLead } = await admin
    .from("crm_leads")
    .select("id, stage_id, pipeline_id, status, contact_id")
    .eq("organization_id", recebimento.organization_id)
    .eq("id", recebimento.lead_id)
    .maybeSingle();
  if (erroDoLead) {
    logger.warn("[pagamentos.confirmar] negócio ilegível", {
      organization_id: recebimento.organization_id,
      codigo: erroDoLead.code ?? null,
    });
    return { moveu: false, motivo: "falha_de_escrita" };
  }
  const lead = leadBruto as LeadLido | null;
  if (!lead) return { moveu: false, motivo: "sem_negocio" };
  // Ganho ou perdido é HISTÓRICO: quem pagou um negócio já encerrado não
  // reescreve o desfecho que alguém decidiu.
  if (lead.status !== "open") return { moveu: false, motivo: "negocio_encerrado" };
  if (!lead.pipeline_id) return { moveu: false, motivo: "sem_etapa_de_ganho" };

  const { data: etapaBruta, error: erroDaEtapa } = await admin
    .from("crm_stages")
    .select("id, name")
    .eq("pipeline_id", lead.pipeline_id)
    .eq("is_won", true)
    .eq("is_archived", false)
    .maybeSingle();
  if (erroDaEtapa) {
    logger.warn("[pagamentos.confirmar] etapa de ganho ilegível", {
      organization_id: recebimento.organization_id,
      pipeline_id: lead.pipeline_id,
      codigo: erroDaEtapa.code ?? null,
    });
    return { moveu: false, motivo: "falha_de_escrita" };
  }
  const etapa = etapaBruta as { id: string; name: string } | null;
  if (!etapa) return { moveu: false, motivo: "sem_etapa_de_ganho" };
  if (lead.stage_id === etapa.id) return { moveu: false, motivo: "ja_esta_la" };

  // Trava otimista pelo estágio de ORIGEM: se um humano moveu o card entre a
  // leitura e a escrita, a decisão dele vence (o desenho de
  // `appointment-stage-move.ts`).
  const { data: movidas, error: erroDoMovimento } = await admin
    .from("crm_leads")
    .update({ stage_id: etapa.id })
    .eq("organization_id", recebimento.organization_id)
    .eq("id", lead.id)
    .eq("stage_id", lead.stage_id)
    .select("id");
  if (erroDoMovimento) {
    logger.error("[pagamentos.confirmar] etapa não gravada", {
      organization_id: recebimento.organization_id,
      lead_id: lead.id,
      codigo: erroDoMovimento.code ?? null,
    });
    return { moveu: false, motivo: "falha_de_escrita" };
  }
  if ((movidas ?? []).length === 0) return { moveu: false, motivo: "conflito_humano" };

  return { moveu: true, stageId: etapa.id, stageName: etapa.name };
}

/**
 * A linha na timeline do negócio — "Aviso de 'pago'", como a issue pede.
 *
 * ⚠️ Só chega aqui quem venceu o compare-and-set, então a linha nasce UMA vez
 * por pagamento. Evento repetido nem chega nesta função.
 */
async function registrarNaTimeline(
  admin: SupabaseClient,
  recebimento: Recebimento,
  movido: VereditoDoMovimento,
): Promise<void> {
  if (!recebimento.lead_id) return;
  const valor = valorEmTexto(recebimento.valor_cents, recebimento.moeda);
  const sufixo = movido.moveu ? ` · negócio movido para ${movido.stageName}` : "";
  const r = await emitLeadActivity(admin, {
    organizationId: recebimento.organization_id,
    leadId: recebimento.lead_id,
    type: "payment_confirmed",
    sourceModule: "pagamentos",
    sourceId: recebimento.id,
    actor: { type: "webhook_source", id: "pagamentos" },
    reason: `Pagamento confirmado — ${valor}${sufixo}`,
    payload: {
      recebimento_id: recebimento.id,
      provedor: recebimento.provedor,
      external_id: recebimento.external_id,
      valor_cents: recebimento.valor_cents,
      moeda: recebimento.moeda,
      movimento: movido,
    },
  });
  if (!r.ok) {
    // A timeline não derruba o pagamento: o fato está gravado e o log fica.
    logger.warn("[pagamentos.confirmar] atividade não gravada", {
      organization_id: recebimento.organization_id,
      lead_id: recebimento.lead_id,
    });
  }
}
