import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import {
  classificarEntrada,
  lerOpcaoDoFiltroDeSpam,
  vaiParaQuarentena,
  type VereditoDaEntrada,
} from "./filtro-de-spam";

/**
 * A QUARENTENA DE ENTRADA (#4026) — o lado do banco.
 *
 * ─── A REGRA QUE NÃO SE NEGOCIA: NADA É DESCARTADO ─────────────────────────
 *
 * Quando esta função roda, a mensagem JÁ está em `messages` (o ingestor do canal
 * gravou antes de pedir os efeitos) e NADA aqui a apaga, esconde ou muda de
 * status. O que a quarentena faz é impedir os EFEITOS: sem demanda nova, sem
 * campanha, sem follow-up, sem turno do agente, sem evento drenado, sem
 * notificação. A mensagem fica exatamente onde está, com o texto e a mídia, e a
 * fila mostra que ela está retida.
 *
 * ─── Por que a guarda de erro é "segue o caminho normal" ───────────────────
 *
 * Se a leitura do settings ou o INSERT da quarentena falharem, a resposta é
 * `false` (não retida) e a mensagem segue o fluxo de hoje. A alternativa —
 * tratar falha como suspeita — pararia a caixa de entrada de uma organização
 * inteira por causa de um timeout, e a issue é explícita: o pior caso é
 * quarentena, nunca perda; e perder a OPERAÇÃO por precaução também é perder.
 */

export interface EntradaAVerificar {
  organizationId: string;
  conversationId: string;
  contactId: string | null;
  messageId: string | null;
  channelSessionId: string;
  texto: string | null;
  origem: string;
}

export interface LinhaDeQuarentena {
  id: string;
  organization_id: string;
  conversation_id: string;
  contact_id: string | null;
  message_id: string;
  channel_session_id: string | null;
  veredito: string;
  confianca: number;
  sinais: string[];
  status: "em_quarentena" | "liberada";
}

/**
 * Decide e, quando for o caso, RETÉM a mensagem. `true` = retida: quem chama
 * (os efeitos pós-entrada) devolve sem rodar nada.
 *
 * Sem `messageId` não há o que reter: reentrega de uma linha que não nasceu
 * agora já passou por aqui na primeira vez, e criar quarentena sem mensagem
 * seria a única forma de perda que este desenho admite.
 */
export async function avaliarQuarentenaDaEntrada(
  admin: SupabaseClient,
  entrada: EntradaAVerificar,
): Promise<boolean> {
  if (!entrada.messageId) return false;
  const texto = (entrada.texto ?? "").trim();
  if (texto.length < 4) return false;

  try {
    const { data: org, error } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", entrada.organizationId)
      .maybeSingle();
    if (error) return false;
    const opcao = lerOpcaoDoFiltroDeSpam((org as { settings?: unknown } | null)?.settings);
    if (!opcao.ligado) return false;

    const veredito = classificarEntrada(texto);
    if (!vaiParaQuarentena(veredito, opcao)) return false;

    // A MENSAGEM JÁ FOI RETIDA — OU JÁ FOI LIBERADA?
    //
    // Esta leitura é o que faz a liberação funcionar: a rota de liberar chama
    // ESTES mesmos efeitos, e se a classificação retivesse de novo, a mensagem
    // liberada voltaria para a quarentena e nunca produziria trabalho — o
    // "recuperável" da issue virando decoração. Uma linha `liberada` para esta
    // mensagem é uma decisão humana, e decisão humana vence classificador.
    const { data: existente } = await admin
      .from("quarentena_de_entrada")
      .select("status")
      .eq("organization_id", entrada.organizationId)
      .eq("message_id", entrada.messageId)
      .maybeSingle();
    const statusExistente = (existente as { status?: string } | null)?.status;
    if (statusExistente === "liberada") return false;
    if (statusExistente === "em_quarentena") return true;

    const { error: erroDoInsert } = await admin.from("quarentena_de_entrada").insert({
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      contact_id: entrada.contactId,
      message_id: entrada.messageId,
      channel_session_id: entrada.channelSessionId || null,
      veredito: primeiroSinal(veredito),
      confianca: veredito.confianca,
      sinais: veredito.sinais,
    });
    // 23505 = a mesma mensagem já está na fila (reentrega): continua retida.
    if (erroDoInsert && erroDoInsert.code !== "23505") {
      logger.warn("[quarentena] não consegui reter; a mensagem segue o fluxo normal", {
        organization_id: entrada.organizationId,
        message_id: entrada.messageId,
        erro: erroDoInsert.message,
      });
      return false;
    }

    logger.info("[quarentena] mensagem retida: não acorda agente, não abre demanda", {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      message_id: entrada.messageId,
      confianca: veredito.confianca,
      sinais: veredito.sinais,
    });
    return true;
  } catch (erro) {
    logger.warn("[quarentena] classificação falhou; a mensagem segue o fluxo normal", {
      organization_id: entrada.organizationId,
      message_id: entrada.messageId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return false;
  }
}

/** O sinal mais pesado vira o `veredito` da linha (a fila mostra o motivo). */
function primeiroSinal(veredito: VereditoDaEntrada): string {
  return veredito.sinais[0] ?? "suspeita";
}

export type DesfechoDaLiberacao =
  | { ok: true; linha: LinhaDeQuarentena }
  | { ok: false; motivo: "nao_encontrada" | "ja_liberada" | "erro" };

/**
 * A pessoa da equipe libera a mensagem retida. O status da MENSAGEM nunca mudou
 * — o que muda aqui é a autorização para os efeitos rodarem, e quem os roda é a
 * rota, com a mesma função de sempre (`aplicarEfeitosPosEntrada`).
 *
 * O UPDATE é um CAS em `status = 'em_quarentena'`: dois cliques no botão não
 * liberam duas vezes nem duplicam demanda, campanha ou turno.
 */
export async function liberarDaQuarentena(
  admin: SupabaseClient,
  entrada: { organizationId: string; id: string; userId: string; agora?: Date },
): Promise<DesfechoDaLiberacao> {
  const { data: existente, error: erroDaLeitura } = await admin
    .from("quarentena_de_entrada")
    .select("*")
    .eq("id", entrada.id)
    .eq("organization_id", entrada.organizationId)
    .maybeSingle();
  if (erroDaLeitura) return { ok: false, motivo: "erro" };
  const linha = existente as LinhaDeQuarentena | null;
  if (!linha) return { ok: false, motivo: "nao_encontrada" };
  if (linha.status === "liberada") return { ok: false, motivo: "ja_liberada" };

  const { data: gravado, error } = await admin
    .from("quarentena_de_entrada")
    .update({
      status: "liberada",
      liberada_por: entrada.userId,
      liberada_em: (entrada.agora ?? new Date()).toISOString(),
    })
    .eq("id", entrada.id)
    .eq("organization_id", entrada.organizationId)
    .eq("status", "em_quarentena")
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, motivo: "erro" };
  if (!gravado) return { ok: false, motivo: "ja_liberada" };
  return { ok: true, linha: gravado as LinhaDeQuarentena };
}

export interface ResumoDaQuarentena {
  em_quarentena: number;
  liberadas: number;
  /** Linhas de quarentena sem a mensagem correspondente. Tem de ser SEMPRE 0. */
  perdidas: number;
}

/**
 * O contador de perda. `perdidas > 0` significa que uma mensagem retida deixou
 * de existir em `messages` — o único desfecho que a issue proíbe.
 */
export async function resumoDaQuarentena(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ResumoDaQuarentena> {
  const { data, error } = await admin.rpc("fn_quarentena_resumo", { p_org: organizationId });
  if (error) throw new Error(error.message);
  const bruto = (data ?? {}) as Record<string, unknown>;
  const numero = (chave: string): number => {
    const valor = Number(bruto[chave]);
    return Number.isFinite(valor) ? valor : 0;
  };
  return {
    em_quarentena: numero("em_quarentena"),
    liberadas: numero("liberadas"),
    perdidas: numero("perdidas"),
  };
}

/** A fila que a tela mostra — mais recente primeiro, só o que está retido. */
export async function listarQuarentena(
  admin: SupabaseClient,
  entrada: { organizationId: string; limite?: number },
): Promise<LinhaDeQuarentena[]> {
  const limite = Math.min(Math.max(entrada.limite ?? 50, 1), 200);
  const { data, error } = await admin
    .from("quarentena_de_entrada")
    .select("*")
    .eq("organization_id", entrada.organizationId)
    .eq("status", "em_quarentena")
    .order("created_at", { ascending: false })
    .limit(limite);
  if (error) throw new Error(error.message);
  return (data ?? []) as LinhaDeQuarentena[];
}
