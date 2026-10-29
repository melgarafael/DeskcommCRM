/**
 * O AVISO DEPOIS DE APAGAR — o art. 12.º, n.º 3 do RGPD (só fora do Brasil).
 *
 * A cascata apaga e CALA. Quem pediu para ser esquecido recebe, hoje, o mesmo
 * silêncio de quem nunca pediu nada — e a lei diz o contrário: informada a
 * eliminação, sem demora, pelo mesmo canal pelo qual o pedido chegou. Este
 * módulo é a metade que faltava do worker de anonimização (`#2342`).
 *
 * ─── O e-mail tem de ser lido ANTES da cascata, e não depois ────────────────
 *
 * O passo 1 zera `contacts.email` — é o dado que está sendo apagado. O aviso,
 * porém, só pode sair DEPOIS do apagamento (é o que a norma descreve: informar
 * que os dados foram apagados). A saída é a ordem: o worker lê o endereço
 * enquanto ele ainda existe, roda a cascata, e só então chama daqui. Quando o
 * pedido veio de plataforma (Nuvemshop), o endereço está no payload do pedido e
 * serve de fallback — é o mesmo campo que o webhook entrega hoje.
 *
 * ─── O aviso NUNCA derruba o pedido ─────────────────────────────────────────
 *
 * O que o titular tem direito é ter os dados apagados; o e-mail é a prova, não
 * o produto. Transporte fora do ar ou endereço ausente viram `{ enviado: false,
 * motivo }` e um `logger.warn` sem endereço nenhum no log (L-08) — o pedido já
 * está completo quando este módulo é chamado, e uma exceção aqui só trocaria um
 * cumprimento por uma falha que o SLA registraria como atraso.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { marcaDaSaida } from "@/lib/branding/saida";
import { perfilDaOrganizacao } from "@/lib/legal/perfil-do-pais";
import { logger } from "@/lib/logger";
import { EmailNotConfigured } from "@/lib/lgpd/email-delivery";
import { prazoDeUmMes, sendAvisoArt12 } from "@/lib/lgpd/avisos-do-artigo-12";

export interface PedidoDeAviso {
  organizationId: string;
  requestId: string;
  /** O endereço do titular, lido pelo chamador ANTES da cascata zerar o contato. */
  emailTitular: string | null;
  /** Recebimento do pedido — de onde o prazo de um mês é contado. */
  recebidoEm: Date;
}

export interface ResultadoDoAviso {
  enviado: boolean;
  /** `null` quando enviado; a razão legível quando não. */
  motivo: string | null;
  mensagemId: string | null;
}

export async function avisarTitularAposApagamento(
  admin: SupabaseClient,
  pedido: PedidoDeAviso,
): Promise<ResultadoDoAviso> {
  const email = (pedido.emailTitular ?? "").trim();
  if (email === "") {
    return { enviado: false, motivo: "titular_sem_email", mensagemId: null };
  }

  try {
    const [perfil, marca] = await Promise.all([
      perfilDaOrganizacao(admin, pedido.organizationId),
      marcaDaSaida(pedido.organizationId, { semMemo: true }),
    ]);

    const { messageId } = await sendAvisoArt12(
      {
        desfecho: "apagamento",
        requestId: pedido.requestId,
        marca,
        perfil,
        prazoDeUmMes: prazoDeUmMes(pedido.recebidoEm),
        recebidoEm: pedido.recebidoEm,
        fuso: undefined,
      },
      email,
    );

    return { enviado: true, motivo: null, mensagemId: messageId };
  } catch (err) {
    // O MOTIVO distingue o que quem opera pode consertar: instalação sem
    // transporte configurado não é a mesma falha de rede que um envio que
    // voltou com erro — o dono da instalação resolve uma e só espera a outra.
    // É este `motivo` que vira `art12_notice` no pedido e na auditoria.
    const motivo = err instanceof EmailNotConfigured ? "email_nao_configurado" : "falha_no_envio";
    // Só o HASH da mensagem: o endereço do titular não entra em log nenhum.
    logger.warn("[lgpd] aviso do art. 12.º após o apagamento não saiu", {
      organization_id: pedido.organizationId,
      request_short: pedido.requestId.slice(0, 8),
      motivo,
      erro: err instanceof Error ? err.message : String(err),
    });
    return { enviado: false, motivo, mensagemId: null };
  }
}
