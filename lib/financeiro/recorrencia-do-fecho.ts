/**
 * A RECORRÊNCIA DO NEGÓCIO EM TODA PORTA DE FECHO — #3602, fatia 5.
 *
 * ─── O que faltava ─────────────────────────────────────────────────────────
 *
 * A fatia 3/4 ligou o molde recorrente em UM escritor de etapa: o
 * `moveLeadHandler` (MCP, automação, lote, IA). As outras portas que fecham
 * negócio — o arrasto do quadro (`app/api/v1/leads/[id]/move`), o botão
 * Ganhar/Perder (`/win`, `/lose` e todo chamador de `encerraDemanda`) e o
 * mover em lote (`fn_mover_leads_em_lote`) — continuavam fechando o negócio
 * sem que o financeiro soubesse, e a receita mensal só existia como número no
 * card.
 *
 * ─── Por que um módulo, e não a mesma chamada em cada rota ─────────────────
 *
 * `recorrenciaDoNegocio`/`desativaRecorrenciaDoNegocio` são a REGRA; o que se
 * repete em cada porta é o CERCO: nunca lançar, nunca derrubar o movimento,
 * escolher o cliente de escrita e deixar rastro quando falha. Três cópias
 * desse cerco divergiriam na primeira correção — mesmo motivo pelo qual o
 * fecho do negócio virou `lib/leads/encerramento.ts`. Aqui só mora o cerco: a
 * conta, o dia, o valor e a idempotência continuam sendo daquelas funções
 * (índice único parcial `recurring_entries_org_lead_uidx`, migration 9246).
 *
 * ─── `!mesmaEtapa` é de quem move ──────────────────────────────────────────
 *
 * Este módulo não sabe comparar etapa: quem chama já decidiu que houve
 * ENTRADA numa etapa (o arrasto compara `stage_id` com o de origem, o lote usa
 * as linhas que o banco de fato moveu, o encerramento só chega aqui quando o
 * desfecho muda). Reordenar dentro da coluna Ganho não passa por aqui, e é
 * essa a garantia de que arrastar um card não cria um segundo molde.
 *
 * ─── Falha BAIXA, e contada ────────────────────────────────────────────────
 *
 * O negócio já fechou quando isto roda: o card moveu, o status mudou. Derrubar
 * o movimento por causa do financeiro seria pior do que um molde que alguém
 * cria à mão. Toda falha — inclusive `createAdminClient` lançando — vira
 * `console.error` com a origem, o negócio e o request, e o retorno da porta
 * segue intacto.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";

import { desativaRecorrenciaDoNegocio, recorrenciaDoNegocio } from "./recorrencia-do-negocio";

/**
 * O necessário para decidir — nada de regra aqui. `etapa` é o destino já
 * resolvido (`is_won`/`is_lost` vêm de `crm_stages`), e `valorRecorrente` é
 * `crm_leads.recurring_value_cents` do negócio que fechou.
 */
export interface FechoQueMoveARecorrencia {
  organizationId: string;
  leadId: string;
  pipelineId: string | null;
  etapa: { is_won: boolean; is_lost: boolean };
  valorRecorrente?: number | string | null;
  criadoEm?: string | null;
  userId?: string | null;
  /** A porta que fechou o negócio — só para o log de falha. */
  origem: string;
  /** O `request_id` da requisição que fechou, quando existe. */
  requestId?: string | null;
}

/**
 * Move a recorrência do negócio por causa de um fecho. Não lança, nunca:
 * o retorno é `void` de propósito para ninguém tratar o desfecho como parte do
 * movimento — o card já moveu.
 *
 * `cliente` existe para quem já tem um admin client em mãos (o
 * `moveLeadHandler` cria o dele para o evento). Ausente, o módulo usa
 * `createAdminClient()`: `recurring_entries` é tabela do módulo financeiro e a
 * policy de escrita exige `manager`, papel que o agente de IA que move o card
 * não tem — mesmo desenho de `comanda-do-ganho.handler.ts`. O isolamento por
 * empresa não vem do RLS: vem do `organization_id` do PRÓPRIO negócio, que as
 * duas funções gravam assim.
 */
export async function moveARecorrenciaNoFecho(
  entrada: FechoQueMoveARecorrencia,
  cliente?: SupabaseClient,
): Promise<void> {
  // Etapa comum não fecha nada: um card em "Proposta" não tem recorrência a
  // criar nem a desativar. Sai antes de qualquer ida ao banco.
  if (!entrada.etapa.is_won && !entrada.etapa.is_lost) return;

  try {
    const supabase = cliente ?? createAdminClient();

    if (entrada.etapa.is_won) {
      // Sem valor mensal declarado não há receita recorrente: o caminho comum
      // do ganho é o valor único. `null`/ausente nem chega ao banco.
      const valor = entrada.valorRecorrente;
      if (valor === null || valor === undefined) return;

      const desfecho = await recorrenciaDoNegocio(supabase, {
        organizationId: entrada.organizationId,
        leadId: entrada.leadId,
        pipelineId: entrada.pipelineId,
        valorCents: valor,
        criadoEm: entrada.criadoEm ?? null,
        userId: entrada.userId ?? null,
      });
      if (desfecho.estado === "falhou") {
        console.error(`[${entrada.origem}] recorrência do negócio falhou`, {
          request_id: entrada.requestId ?? null,
          lead_id: entrada.leadId,
          erro: desfecho.erro,
        });
      }
      return;
    }

    const desfecho = await desativaRecorrenciaDoNegocio(supabase, {
      organizationId: entrada.organizationId,
      leadId: entrada.leadId,
    });
    if (desfecho.estado === "falhou") {
      console.error(`[${entrada.origem}] desativação da recorrência falhou`, {
        request_id: entrada.requestId ?? null,
        lead_id: entrada.leadId,
        erro: desfecho.erro,
      });
    }
  } catch (erro) {
    // Inclui o próprio `createAdminClient`: sem service role configurada, o
    // financeiro fica de fora e o movimento continua.
    console.error(`[${entrada.origem}] financeiro do fecho lançou`, {
      request_id: entrada.requestId ?? null,
      lead_id: entrada.leadId,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
  }
}
