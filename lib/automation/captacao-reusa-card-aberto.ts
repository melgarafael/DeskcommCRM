/**
 * #3101 — a captação por webhook REUSA o card aberto do contato no funil.
 *
 * ## O defeito que esta regra fecha
 *
 * A fonte de webhook criava card NOVO em todo envio sem `external_id`, mesmo
 * quando o contato casado (por telefone ou e-mail) já tinha negócio ABERTO no
 * MESMO funil. Medido em v1.86.0: um contato chegou a TRÊS cards abertos no
 * mesmo funil, e quem olha três cards do mesmo cliente não sabe qual dos três a
 * equipe está tocando.
 *
 * Com um `external_id` que JÁ existe o defeito não aparece — quem identifica o
 * card é o id do envio (`findLeadByExternalId`), e essa régua é a do #2316,
 * intocada. Com um `external_id` INÉDITO ele aparecia igual (#3357): o id ainda
 * não apontava para card nenhum, a captação abria o segundo card e o da conversa
 * ficava parado. Hoje a ROTA adota o card neste caminho e carimba o id nele; a
 * pergunta deste módulo continua sendo uma só — existe card aberto do contato
 * neste funil?
 *
 * ## O desenho é o da própria issue, e ele tem duas portas
 *
 * 1. É OPÇÃO DA FONTE (`webhook_sources.reuse_open_lead_on_capture`, migration
 *    0722) e nasce DESLIGADA. Desligada, o comportamento de hoje não muda um
 *    byte — é o critério de aceite da issue;
 * 2. o card que ela alcança é o do contato NESTE funil (`negocioAbertoDoContato`
 *    — o MESMO degrau que a ação `create_or_move_lead` usa para o gatilho de
 *    contato desde o #958). Escrever por cima de um card de outro funil seria
 *    trocar de quadro sem passar pela transferência (#992).
 *
 * ## O que este módulo NÃO faz
 *
 * Ele não escreve: devolve o card, e quem aplica é a rota, com os MESMOS
 * handlers (`updateLeadHandler` / `moveLeadHandler`) do resto da captação e a
 * MESMA comparação de campos do reenvio (`camposQueMudaram`). Uma segunda
 * implementação de "atualizar card" divergiria na primeira mudança da primeira.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { negocioAbertoDoContato, type NegocioAbertoNoFunil } from "@/lib/leads/negocio-aberto-do-contato";

/** O card que a captação passa a atualizar em vez de abrir outro. */
export type CardAbertoDaCaptacao = NegocioAbertoNoFunil;

export interface OpcoesDoReusoDaCaptacao {
  /** A opção da fonte (#3101). Desligada (o padrão da coluna) ⇒ não há reuso. */
  opcaoDaFonteLigada: boolean;
  organizationId: string;
  /** O contato CASADO por este envio — `null`/vazio ⇒ não há card a procurar. */
  contactId: string | null | undefined;
  /** O funil da fonte: é nele que o card novo nasceria. */
  pipelineId: string;
}

/**
 * O card ABERTO do contato no funil da fonte, quando a opção está ligada.
 *
 * `null` é a resposta para os três casos em que a captação segue criando o card
 * — opção desligada, envio sem contato casado, e contato sem card aberto ali. Os
 * três têm o MESMO desfecho de propósito: o envio entra, o que muda é se ele
 * atualiza um card existente ou abre um novo.
 */
export async function cardAbertoQueACaptacaoReusa(
  admin: SupabaseClient,
  opcoes: OpcoesDoReusoDaCaptacao,
): Promise<CardAbertoDaCaptacao | null> {
  if (!opcoes.opcaoDaFonteLigada) return null;
  if (!opcoes.contactId) return null;
  return negocioAbertoDoContato(
    admin,
    opcoes.organizationId,
    opcoes.contactId,
    opcoes.pipelineId,
  );
}
