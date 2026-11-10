import type { SupabaseClient } from "@supabase/supabase-js";

import { fecharAvisoDePausaDoCanalArquivado } from "@/lib/channels/central-de-pausa";
import { resolverSaudeDaConexaoRemovida } from "@/lib/channels/health";
import { logger } from "@/lib/logger";

/**
 * ARQUIVAR a sessão que nasceu só de um QR que ninguém leu (#3416).
 *
 * ─── O defeito, medido ──────────────────────────────────────────────────────
 *
 * No assistente do primeiro acesso (ou em Conexões › Conectar novo WhatsApp) a
 * pessoa abre o QR e não lê. O WAHA derruba a sessão em `FAILED` quando o
 * código expira, e a linha fica de pé: ela ocupa o "Máximo de números conectados"
 * do plano (tanto o gatilho `trg_trava_canais_do_plano` quanto `lerUsoDaOrganizacao`
 * contam linha com `archived_at is null`), a faixa vermelha anuncia "WhatsApp sem
 * nome está desconectado" e a Central recebe os críticos — um quando o QR foi
 * pedido, outro quando expirou. Para quem está só testando o produto, parece que
 * algo quebrou — e o contorno é achar Reconectar › Gerar novo QR.
 *
 * ─── Por que ARQUIVAR é o desfecho certo ────────────────────────────────────
 *
 * Arquivar é o que o produto inteiro já sabe fazer com canal que não existe
 * mais ("o caminho de volta"): some da tela, some do contador, some da faixa,
 * e NADA do que está pendurado nele some junto — conversas, mensagens, histórico
 * de ligações, roteador, knobs de ritmo ficam. Apagar seria destruir por nada:
 * a linha nunca teve número nem conversa que justifique risco.
 *
 * E o caminho de volta JÁ existe e está testado: `lib/channels/connect.ts`
 * escreve `archived_at: null` quando reconecta, e
 * `tests/unit/canal-arquivado-caminho-de-volta.test.ts` ("retomar o pareamento
 * ressuscita") prova que a linha arquivada do onboarding volta ATIVA com o mesmo
 * nome de sessão — é exatamente o cenário C da #3416: reabrir o assistente e
 * conectar de novo.
 *
 * ─── As três cercas ─────────────────────────────────────────────────────────
 *
 *  1. Sessão COM número nunca entra aqui — a guarda é o primeiro `return`, não
 *     um detalhe do chamador: nenhuma linha pareada pode ser arquivada por este
 *     caminho.
 *  2. Reserva em execução também não: uma conexão que está sendo preparada
 *     agora (lease vivo) tem o WAHA no meio da chamada; arquivar a linha embaixo
 *     dela derruba o fluxo que a pessoa acabou de pedir. É a mesma pergunta de
 *     `assertWahaConnectionIdle`.
 *  3. O aviso aberto sai junto (mesma função da rota DELETE) — a linha some da
 *     tela, e um crítico apontando para ela viraria o "Este contexto não está
 *     disponível para você" da issue #1023.
 *
 * E a regra de quem chama: este módulo NUNCA lança. Um webhook não pode virar
 * 500 porque a limpeza automática falhou; erro vira log e `preservada`, e o
 * evento segue o caminho de sempre.
 */

/** O que o descarte decidiu — é o que a logagem e o teste observam. */
export type DescarteDeSessaoSemNumero =
  /** Linha arquivada: fora do contador do plano, da faixa e dos avisos. */
  | "arquivada"
  /** Conexão em preparação agora — não se mexe. */
  | "em_execucao"
  /** Nada foi decidido (sessão com número, leitura ou escrita falhou). */
  | "preservada";

export async function descartarSessaoQueNuncaPareou(
  admin: SupabaseClient,
  sessao: {
    id: string;
    organization_id: string;
    /** O status que o evento trazia — é o que o aviso de saúde registra ao fechar. */
    status: string | null;
    phone_number: string | null;
  },
): Promise<DescarteDeSessaoSemNumero> {
  try {
    // (1) A guarda que torna o caminho inofensivo para quem já pareou.
    if ((sessao.phone_number ?? "").trim() !== "") return "preservada";

    // (2) Reserva viva = conexão em voo. Mesma leitura de
    // `assertWahaConnectionIdle`; erro de leitura vira "não decidi", que é o
    // lado seguro: uma linha preservada é esperada de novo no próximo evento.
    const { data: reserva, error: erroReserva } = await admin
      .from("channel_connection_requests")
      .select("id, lease_until")
      .eq("organization_id", sessao.organization_id)
      .eq("channel_session_id", sessao.id)
      .in("state", ["processing"])
      .order("lease_until", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (erroReserva) {
      logger.warn("descarte de sessão sem número: não consegui ler a reserva", {
        channel_session_id: sessao.id,
        organization_id: sessao.organization_id,
        detail: erroReserva.message,
      });
      return "preservada";
    }
    const lease = reserva ? Date.parse(String(reserva.lease_until ?? "")) : NaN;
    if (Number.isFinite(lease) && lease > Date.now()) return "em_execucao";

    // (a) Fora da UI e da conta — é isto, e só isto, que liberta a vaga do
    // plano: as duas réguas (a do gatilho e a da tela de assinatura) filtram
    // `archived_at is null`. `STOPPED` (e não `FAILED`) porque o que aconteceu
    // foi o fim do QR, não a queda de um número.
    const agora = new Date().toISOString();
    let arquivar = admin
      .from("channel_sessions")
      .update({ archived_at: agora, status: "STOPPED", last_status_change_at: agora })
      .eq("organization_id", sessao.organization_id)
      .eq("id", sessao.id)
      .is("archived_at", null)
      .neq("status", "WORKING");
    // O snapshot do webhook não decide pelo estado que mudou durante a leitura
    // da reserva. Número e estado são conferidos no próprio UPDATE atômico.
    arquivar = sessao.phone_number === null
      ? arquivar.is("phone_number", null)
      : arquivar.eq("phone_number", sessao.phone_number);
    const { data: arquivadas, error } = await arquivar.select("id");
    if (error) {
      logger.warn("descarte de sessão sem número: arquivamento falhou", {
        channel_session_id: sessao.id,
        organization_id: sessao.organization_id,
        detail: error.message,
      });
      return "preservada";
    }

    if (!arquivadas || arquivadas.length !== 1 || arquivadas[0]?.id !== sessao.id) return "preservada";

    // (b) O aviso não fica órfão — as MESMAS duas chamadas e o mesmo
    // best-effort da rota DELETE: saúde e pausa. Uma falha aqui não desfaz o
    // arquivamento, só vai para o log.
    try {
      await resolverSaudeDaConexaoRemovida(admin, sessao);
    } catch (err) {
      logger.warn("descarte de sessão sem número: não fechei os avisos de saúde", {
        channel_session_id: sessao.id,
        organization_id: sessao.organization_id,
        erro: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      // A pausa é o aviso que a cerca `arquivar-canal-fecha-aviso-de-pausa`
      // cobra de todo caminho que grava `archived_at` (#2389): um canal pausado
      // que some da tela deixaria o item pedindo "retomar" um canal que a tela
      // já não carrega — o "Este contexto não está disponível para você" do
      // #1023. Com a linha já arquivada a regra só resolve (`canal_arquivado`).
      await fecharAvisoDePausaDoCanalArquivado(admin, {
        id: sessao.id,
        organization_id: sessao.organization_id,
      });
    } catch (err) {
      logger.warn("descarte de sessão sem número: não fechei o aviso de pausa", {
        channel_session_id: sessao.id,
        organization_id: sessao.organization_id,
        erro: err instanceof Error ? err.message : String(err),
      });
    }

    return "arquivada";
  } catch (err) {
    logger.warn("descarte de sessão sem número: erro inesperado, sessão preservada", {
      channel_session_id: sessao.id,
      organization_id: sessao.organization_id,
      erro: err instanceof Error ? err.message : String(err),
    });
    return "preservada";
  }
}
