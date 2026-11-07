/**
 * A QUARENTENA DE UMA MENSAGEM RECEBIDA — o estado que segura o EFEITO, não a mensagem.
 *
 * ─── O que este arquivo NÃO é ──────────────────────────────────────────────
 *
 * Não é detecção. Nada aqui decide que uma mensagem "parece spam": o marcador é
 * aplicado por caminho explícito (a rota de revisão hoje, a classificação da
 * fatia seguinte amanhã). Heurística, lista de palavras e classificador moram
 * fora daqui de propósito — regra de detecção muda com o tempo, e o estado que
 * ela escreve precisa de um lugar estável para ser lido.
 *
 * Não apaga nem esconde: a mensagem continua na conversa, com o mesmo id, o
 * mesmo `body` e a mesma mídia. O que a marca compra é tempo — enquanto ela
 * existir, o agente, a automação e o aviso à equipe não agem sobre ESTA
 * mensagem.
 *
 * ─── Por que a leitura falha ABERTA ────────────────────────────────────────
 *
 * `lerQuarentenaDaMensagem` responde `emQuarentena: false` quando a leitura dá
 * erro, e os três consumidores tratam isso como "segue o fluxo". O motivo é o
 * mesmo do cabeçalho de `pos-entrada.ts`: a mensagem do cliente JÁ está
 * gravada, e transformar um erro de leitura numa exceção derrubaria a ingestão
 * (o provider reentrega tudo) ou calaria uma conversa legítima para sempre. O
 * pior desfecho de uma leitura falha é a IA responder uma mensagem que alguém
 * ia segurar — o comportamento de hoje; o pior desfecho de falhar fechado é a
 * conversa parar em silêncio, com o cliente achando que foi atendido.
 *
 * ─── As duas escritas ──────────────────────────────────────────────────────
 *
 * `marcarMensagemEmQuarentena` é IDEMPOTENTE: a primeira marca manda, e uma
 * segunda chamada (duplo clique, retentativa, a detecção chegando depois de
 * alguém já ter marcado à mão) responde `jaEstava: true` SEM sobrescrever o
 * motivo original. Rastro de auditoria que se reescreve não é rastro.
 *
 * `liberarMensagemDaQuarentena` zera as três colunas e diz se havia o que
 * liberar. Quem chama é a rota, e é ela que decide se o fluxo daquela mensagem
 * volta (`retomada-da-quarentena.ts`) — este módulo não conhece a ingestão,
 * senão o import vira ciclo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * O detalhe que os consumidores gravam quando pulam por causa da marca.
 *
 * Um só, exportado, porque ele aparece no `event_log.consumed_by`-adjacente
 * (`detail` do `skipped`), no log do dreno do turno e no log da ingestão: três
 * lugares que precisam dizer a MESMA coisa quando alguém for investigar por que
 * a IA não respondeu.
 */
export const DETALHE_DA_MENSAGEM_EM_QUARENTENA = "mensagem_em_quarentena";

/** Piso e teto do motivo. Curto demais não audita; longo demais não cabe na tela. */
export const MOTIVO_MINIMO = 4;
export const MOTIVO_MAXIMO = 500;

export interface PedidoDeQuarentena {
  organizationId: string;
  messageId: string;
  /** Por que esta mensagem foi segurada — texto de quem decidiu. */
  motivo: string;
  /** Quem decidiu. `null` no caminho automático (a fatia de detecção). */
  porUserId: string | null;
}

export type DesfechoDaMarca =
  | { ok: true; jaEstava: boolean; em: string | null }
  | { ok: false; erro: "motivo_invalido" | "nao_encontrada" | "falha"; detalhe?: string };

export type DesfechoDaLiberacao =
  | { ok: true; estava: boolean; motivo: string | null }
  | { ok: false; erro: "nao_encontrada" | "falha"; detalhe?: string };

export interface LeituraDaQuarentena {
  emQuarentena: boolean;
  motivo: string | null;
}

/**
 * O motivo como ele é gravado: sem espaço nas pontas e com lugar para existir.
 *
 * Devolve `null` quando não serve — vazio, só espaço, curto demais ou acima do
 * teto. O CHECK do banco recusa marca sem motivo; esta função existe para a
 * rota responder 422 com o motivo ANTES de tentar gravar, e para o texto que
 * chega à auditoria ser o mesmo que chega ao banco.
 */
export function normalizarMotivo(motivo: string | null | undefined): string | null {
  if (typeof motivo !== "string") return null;
  const limpo = motivo.replace(/\s+/g, " ").trim();
  if (limpo.length < MOTIVO_MINIMO || limpo.length > MOTIVO_MAXIMO) return null;
  return limpo;
}

/**
 * Marca a mensagem como em quarentena. Idempotente e escopada por organização.
 *
 * O filtro `.is("quarantined_at", null)` é o que torna o duplo clique inofensivo
 * no BANCO: a segunda escrita casa zero linhas em vez de reescrever o motivo e a
 * hora da primeira. Só depois de ver zero linhas é que a função consulta para
 * distinguir "já estava" de "não existe nesta organização" — e as duas respostas
 * são diferentes de propósito: a primeira é sucesso silencioso, a segunda é 404.
 */
export async function marcarMensagemEmQuarentena(
  supabase: SupabaseClient,
  pedido: PedidoDeQuarentena,
): Promise<DesfechoDaMarca> {
  const motivo = normalizarMotivo(pedido.motivo);
  if (!motivo) return { ok: false, erro: "motivo_invalido" };

  const agora = new Date().toISOString();
  const { data, error } = await supabase
    .from("messages")
    .update({
      quarantined_at: agora,
      quarantine_reason: motivo,
      quarantined_by_user_id: pedido.porUserId,
    })
    .eq("organization_id", pedido.organizationId)
    .eq("id", pedido.messageId)
    .is("quarantined_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    logger.warn("[quarentena] marca não gravada", {
      organization_id: pedido.organizationId,
      message_id: pedido.messageId,
      detail: error.message.slice(0, 160),
    });
    return { ok: false, erro: "falha", detalhe: error.message };
  }
  if (data) return { ok: true, jaEstava: false, em: agora };

  // Zero linhas: ou já estava marcada, ou a mensagem não é desta organização.
  const { data: atual, error: erroLeitura } = await supabase
    .from("messages")
    .select("id, quarantined_at")
    .eq("organization_id", pedido.organizationId)
    .eq("id", pedido.messageId)
    .maybeSingle();

  if (erroLeitura) {
    logger.warn("[quarentena] releitura da mensagem falhou", {
      organization_id: pedido.organizationId,
      message_id: pedido.messageId,
      detail: erroLeitura.message.slice(0, 160),
    });
    return { ok: false, erro: "falha", detalhe: erroLeitura.message };
  }
  if (!atual) return { ok: false, erro: "nao_encontrada" };

  const linha = atual as { quarantined_at: string | null };
  return { ok: true, jaEstava: true, em: linha.quarantined_at ?? null };
}

/**
 * Tira a mensagem da quarentena. O motivo ANTERIOR volta para quem chamou — é
 * ele que a auditoria da liberação registra, para o par marcar/liberar contar a
 * história inteira sem consultar a linha antes.
 */
export async function liberarMensagemDaQuarentena(
  supabase: SupabaseClient,
  pedido: { organizationId: string; messageId: string },
): Promise<DesfechoDaLiberacao> {
  const { data, error } = await supabase
    .from("messages")
    .update({
      quarantined_at: null,
      quarantine_reason: null,
      quarantined_by_user_id: null,
    })
    .eq("organization_id", pedido.organizationId)
    .eq("id", pedido.messageId)
    .not("quarantined_at", "is", null)
    .select("id, quarantine_reason")
    .maybeSingle();

  if (error) {
    logger.warn("[quarentena] liberação não gravada", {
      organization_id: pedido.organizationId,
      message_id: pedido.messageId,
      detail: error.message.slice(0, 160),
    });
    return { ok: false, erro: "falha", detalhe: error.message };
  }
  if (data) {
    const linha = data as { quarantine_reason: string | null };
    return { ok: true, estava: true, motivo: linha.quarantine_reason };
  }

  // Nada casou: ou não estava em quarentena (liberar duas vezes é inofensivo),
  // ou a mensagem não é desta organização — e aí é 404.
  const { data: existe, error: erroLeitura } = await supabase
    .from("messages")
    .select("id")
    .eq("organization_id", pedido.organizationId)
    .eq("id", pedido.messageId)
    .maybeSingle();

  if (erroLeitura) {
    logger.warn("[quarentena] releitura da mensagem falhou", {
      organization_id: pedido.organizationId,
      message_id: pedido.messageId,
      detail: erroLeitura.message.slice(0, 160),
    });
    return { ok: false, erro: "falha", detalhe: erroLeitura.message };
  }
  if (!existe) return { ok: false, erro: "nao_encontrada" };

  return { ok: true, estava: false, motivo: null };
}

/**
 * A pergunta que os consumidores fazem: esta mensagem está segurada?
 *
 * Falha ABERTA (ver cabeçalho): erro de leitura responde "não está", com log,
 * porque segurar uma conversa legítima por causa de um timeout é pior do que o
 * comportamento de hoje.
 */
export async function lerQuarentenaDaMensagem(
  supabase: SupabaseClient,
  pedido: { organizationId: string; messageId: string },
): Promise<LeituraDaQuarentena> {
  try {
    const { data, error } = await supabase
      .from("messages")
      .select("quarantined_at, quarantine_reason")
      .eq("organization_id", pedido.organizationId)
      .eq("id", pedido.messageId)
      .maybeSingle();

    if (error) {
      logger.warn("[quarentena] leitura falhou — seguindo o fluxo normal", {
        organization_id: pedido.organizationId,
        message_id: pedido.messageId,
        detail: error.message.slice(0, 160),
      });
      return { emQuarentena: false, motivo: null };
    }

    const linha = data as { quarantined_at: string | null; quarantine_reason: string | null } | null;
    if (!linha?.quarantined_at) return { emQuarentena: false, motivo: null };
    return { emQuarentena: true, motivo: linha.quarantine_reason ?? null };
  } catch (err) {
    logger.warn("[quarentena] leitura lançou — seguindo o fluxo normal", {
      organization_id: pedido.organizationId,
      message_id: pedido.messageId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "unknown",
    });
    return { emQuarentena: false, motivo: null };
  }
}
