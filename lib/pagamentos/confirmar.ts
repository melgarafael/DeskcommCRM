/**
 * CONFIRMAR O PAGAMENTO (issue #3509, degrau 1 — item 3).
 *
 * ─── Quem decide que pagou ──────────────────────────────────────────────────
 *
 * O aviso do provedor, depois de o segredo DESTE recebimento conferir (a
 * conferência é da rota, `lib/pagamentos/assinatura.ts`) e de o valor do aviso
 * bater com o registrado (aqui). Aqui é o EFEITO, e ele tem de ser
 * exatamente-uma-vez: o provedor reentrega, o usuário recarrega o painel dele, o
 * retry da fila acontece — e nada disso pode mover o negócio de novo nem
 * escrever uma segunda linha de "pagamento recebido" na timeline.
 *
 * ─── O compare-and-set é a idempotência ─────────────────────────────────────
 *
 * `update ... where id = ? and status = 'pendente'`. Chegar primeiro = 1 linha
 * atualizada = efeito. Chegar depois = 0 linhas = NADA acontece (nem timeline,
 * nem etapa). Um `select` seguido de `update` seria check-then-act
 * e duas entregas SIMULTÂNEAS passariam as duas pela janela — o mesmo defeito
 * que a 0027 matou nos contatos. O índice único da 9312 cobre o outro lado:
 * o MESMO pagamento do provedor não confirma dois recebimentos.
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

import { ApiError } from "@/lib/api/types";
import { logger } from "@/lib/logger";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { formatCents } from "@/lib/money";

import { COLUNAS_DO_RECEBIMENTO, type Recebimento } from "./registrar";
import type { SituacaoDoRecebimento } from "./vocabulario";

export type MotivoDoNaoMovimento =
  | "sem_negocio"
  | "negocio_encerrado"
  | "sem_etapa_de_ganho"
  | "ja_esta_la"
  | "campos_obrigatorios"
  | "conflito_humano"
  | "falha_de_escrita";

export type VereditoDoMovimento =
  | { moveu: true }
  /** `detalhe` só em `campos_obrigatorios`: a frase do que falta, a mesma do 422 das rotas. */
  | { moveu: false; motivo: MotivoDoNaoMovimento; detalhe?: string };

export type ResultadoDaConfirmacao =
  | { ok: true; efeito: "pago"; recebimento: Recebimento; movido: VereditoDoMovimento }
  /** Já estava resolvido (ou outra entrega do mesmo evento chegou primeiro): NADA mudou. */
  | { ok: true; efeito: "duplicado"; status: SituacaoDoRecebimento }
  /** O valor do aviso não é o registrado: NADA muda, e o humano confere. */
  | { ok: true; efeito: "valor_divergente" }
  /** Este pagamento do provedor já confirmou OUTRO recebimento da empresa: NADA muda. */
  | { ok: true; efeito: "id_ja_usado" }
  | { ok: false; code: "internal_error"; message: string; status: 500 };

export type RecebimentoDoAviso = Recebimento & { aviso_token_hash: string };

/**
 * A linha que o aviso diz ser dele — pelo id que veio NA URL, nunca por um dado
 * que outra empresa consiga escrever. `null` é "não existe", e a rota responde
 * igual a segredo errado (não confirma existência).
 */
export async function lerRecebimentoDoAviso(
  admin: SupabaseClient,
  provedor: string,
  recebimentoId: string,
): Promise<{ ok: true; recebimento: RecebimentoDoAviso | null } | { ok: false }> {
  const { data, error } = await admin
    .from("pagamento_recebimentos")
    .select(`${COLUNAS_DO_RECEBIMENTO}, aviso_token_hash`)
    .eq("id", recebimentoId)
    .eq("provedor", provedor)
    .maybeSingle();
  if (error) {
    logger.error("[pagamentos.confirmar] recebimento ilegível", { provedor, codigo: error.code ?? null });
    return { ok: false };
  }
  return { ok: true, recebimento: (data as unknown as RecebimentoDoAviso | null) ?? null };
}

export async function confirmarPagamento(
  admin: SupabaseClient,
  entrada: {
    recebimento: Recebimento;
    /** O id do pagamento NO PROVEDOR (o `invoice_slug` da InfinitePay). */
    idNoProvedor: string;
    /** O valor que o aviso diz, em centavos; `null` quando o aviso não traz. */
    valorAvisadoCents: number | null;
    quando: Date;
  },
): Promise<ResultadoDaConfirmacao> {
  const { recebimento, quando } = entrada;
  // Já resolvido antes desta entrega: sai sem escrever NADA. Esta leitura é
  // atalho; a garantia é o compare-and-set abaixo.
  if (recebimento.status !== "pendente") {
    return { ok: true, efeito: "duplicado", status: recebimento.status };
  }

  // A conferência do valor pega DIVERGÊNCIA entre o link criado no provedor e o
  // valor registrado aqui (link de outro valor, dígito trocado): o recebimento
  // não vira pago por um valor que ninguém registrou. Ela não segura quem tem a
  // URL — o valor não é segredo. Aviso sem valor não marca.
  if (entrada.valorAvisadoCents !== recebimento.valor_cents) {
    logger.warn("[pagamentos.confirmar] valor do aviso diverge do registrado; nada marcado", {
      organization_id: recebimento.organization_id,
      recebimento_id: recebimento.id,
      com_valor: entrada.valorAvisadoCents !== null,
    });
    return { ok: true, efeito: "valor_divergente" };
  }

  // ── O compare-and-set ─────────────────────────────────────────────────────
  const pagoEm = quando.toISOString();
  const { data: atualizadas, error: erroDoUpdate } = await admin
    .from("pagamento_recebimentos")
    .update({ status: "paga", pago_em: pagoEm, external_id: entrada.idNoProvedor })
    .eq("id", recebimento.id)
    .eq("organization_id", recebimento.organization_id)
    .eq("status", "pendente")
    .select("id");
  if (erroDoUpdate) {
    if (erroDoUpdate.code === "23505") {
      logger.warn("[pagamentos.confirmar] pagamento do provedor já confirmou outro recebimento", {
        organization_id: recebimento.organization_id,
        recebimento_id: recebimento.id,
      });
      return { ok: true, efeito: "id_ja_usado" };
    }
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

  const pago: Recebimento = { ...recebimento, status: "paga", pago_em: pagoEm, external_id: entrada.idNoProvedor };
  const movido = await moverParaGanho(admin, pago);
  await registrarNaTimeline(admin, pago, movido);

  return { ok: true, efeito: "pago", recebimento: pago, movido };
}

/**
 * O GANHO passa pelo MESMO fecho do botão "Marcar como ganho" (`encerraDemanda`):
 * a régua de campos obrigatórios e de motivo de ganho do funil, a etapa `is_won`,
 * a linha "Demanda encerrada" na timeline e a auditoria `lead.won`. O `status` e
 * o evento `lead.won` são do trigger, como em todo ganho. Um segundo caminho de
 * ganho aqui seria a porta de trás da régua — o defeito da #917 com outro nome.
 *
 * Quem pagou um negócio encerrado não reescreve o desfecho que alguém decidiu:
 * negócio fechado na leitura é `negocio_encerrado`, e o fecho vai com
 * `travaOtimista` — se alguém encerrar ou mexer no card antes da escrita, a
 * decisão humana vence (`conflito_humano`).
 */
const ATOR_DO_AVISO = { type: "webhook_source", id: "pagamentos" } as const;

async function moverParaGanho(admin: SupabaseClient, recebimento: Recebimento): Promise<VereditoDoMovimento> {
  if (!recebimento.lead_id) return { moveu: false, motivo: "sem_negocio" };

  const { data: leadBruto, error: erroDoLead } = await admin
    .from("crm_leads")
    .select("id, status")
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
  const lead = leadBruto as { id: string; status: string } | null;
  if (!lead) return { moveu: false, motivo: "sem_negocio" };
  if (lead.status !== "open") return { moveu: false, motivo: "negocio_encerrado" };

  try {
    const { jaEstava } = await encerraDemanda(
      admin,
      { organization_id: recebimento.organization_id, actor: ATOR_DO_AVISO, requestId: `pagamento:${recebimento.id}` },
      { leadId: lead.id, desfecho: "won", travaOtimista: true, payloadNaTimeline: { recebimento_id: recebimento.id } },
    );
    return jaEstava ? { moveu: false, motivo: "ja_esta_la" } : { moveu: true };
  } catch (err) {
    if (err instanceof ApiError) {
      // Funil sem etapa de ganho é estado legítimo: o pagamento fica registrado.
      if (err.code === "pipeline_no_won_stage") return { moveu: false, motivo: "sem_etapa_de_ganho" };
      if (err.code === "not_found") return { moveu: false, motivo: "sem_negocio" };
      if (err.code === "state_conflict") return { moveu: false, motivo: "conflito_humano" };
      if (err.code === "required_fields_missing") {
        logger.warn("[pagamentos.confirmar] funil exige campos para ganhar; card não movido", {
          organization_id: recebimento.organization_id,
          lead_id: lead.id,
        });
        return { moveu: false, motivo: "campos_obrigatorios", detalhe: err.message };
      }
    }
    logger.warn("[pagamentos.confirmar] ganho não gravado", {
      organization_id: recebimento.organization_id,
      lead_id: lead.id,
      codigo: err instanceof ApiError ? err.code : null,
    });
    return { moveu: false, motivo: "falha_de_escrita" };
  }
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
  const valor = formatCents(recebimento.valor_cents, recebimento.moeda);
  const sufixo = movido.moveu
    ? " · negócio marcado como ganho"
    : movido.motivo === "campos_obrigatorios" && movido.detalhe
      ? ` · negócio não movido: ${movido.detalhe}`
      : "";
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
