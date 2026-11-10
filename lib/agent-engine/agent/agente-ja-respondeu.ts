/**
 * O AGENTE QUE VAI RESPONDER JÁ FALOU NESTE ATENDIMENTO? — a âncora do "já
 * engajado" que o filtro de palavra-chave lê (#3142).
 *
 * ## Por que a âncora NÃO é o sticky do roteador
 *
 * O primeiro desenho desta âncora foi `conversations.active_ai_agent_id` (o
 * sticky do Intent Router, migration 0085) — e o CR do mantenedor no #3240
 * mediu por que ele não serve, nos dois modos:
 *
 *  1. **Sem roteador, ele nunca é gravado.** A gravação mora em
 *     `inbound-turn.ts` dentro de `if (!preview && routed.routerId !== null)`;
 *     sem roteador criado, `resolveTurnAgent` devolve `no_router` com
 *     `stickyAgentId` nulo e o filtro passava a valer em TODA mensagem — o
 *     exemplo medido no #2696 ("camiseta azul, tamanho M") continuava calado na
 *     instalação padrão.
 *  2. **Com roteador, ele é gravado antes de o filtro julgar.** A gravação
 *     acontece no INÍCIO do turno, antes do portão: uma mensagem de entrada sem
 *     a palavra é calada, mas já marca a conversa como engajada — a mensagem
 *     seguinte entra sem filtro. Nesse modo o filtro passa a segurar só a
 *     primeira mensagem, não a ENTRADA do agente.
 *
 * Os dois são o mesmo defeito: aquela coluna registra que um ROTEADOR escolheu
 * um agente, nunca que o agente RESPONDEU. "Já engajado" é fato do PASSADO, e
 * precisa de uma testemunha que só exista depois do envio.
 *
 * ## A régua: uma outbound DESTE agente neste atendimento
 *
 * A testemunha é a própria linha de `messages` que o envio grava:
 *
 *  - `direction = 'outbound'` — resposta, não fala do cliente;
 *  - `sent_via = 'ai'` — fala da IA (o valor que a #652 decidiu para autoria de
 *    agente; `'automation'`, `'user'` e `'system'` não engajam este agente);
 *  - `metadata->>'ai_actor_id' = <agentId>` — **de QUEM é a fala**. O handler
 *    do app carimba a autoria de todo envio de IA
 *    (`app/api/v1/messages/_handler.ts`, `ai_actor_id: ctx.actor.id`) e o turno
 *    envia com `agentActorId: agentConfig.agentId` — é o `=== config.agentId`
 *    que o mantenedor pediu, lido da fonte. **Este ponto é o ponto 2 do CR:**
 *    com sticky = suporte e o roteador trocando para vendas (`reclassified`), o
 *    agente de vendas NÃO entra pulando o próprio filtro, porque quem falou foi
 *    o suporte. Sem roteador, o mesmo vale para um sticky antigo de outro
 *    agente.
 *  - `status <> 'failed'` — envio que não chegou ao cliente não é resposta.
 *  - **Dentro do atendimento corrente**: `sent_at >= conversations.service_started_at`
 *    (a MESMA fronteira que a leitura do histórico do turno usa, em
 *    `get-lead-context.ts`: inbound do `service_revision` corrente, outbound
 *    posterior à abertura do atendimento). `service_started_at` NULL conta como
 *    dentro — o silêncio é o desfecho que a doutrina do repositório menos quer.
 *
 * ## Por que não uma coluna nova
 *
 * `conversations.last_ai_reply_agent_id` seria a mesma informação com um custo
 * desnecessário: migration + `database.types.ts` + `MANIFEST.md` (a governance
 * do repo congela o manifesto) e uma SEGUNDA escrita no caminho de envio — um
 * segundo conceito de engajamento para divergir do primeiro. A linha de
 * `messages` já é a verdade do envio, já nasce com a autoria e já é a fonte que
 * `turno-ja-respondido.ts` e o disjuntor de saúde consultam.
 *
 * ## Custo
 *
 * Um `exists` por turno, servido por `idx_messages_conversation_sent
 * (conversation_id, sent_at desc)` — e só pago por agente que TEM filtro de
 * palavra-chave configurado (quem chama guarda a pergunta).
 */
import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

export interface AlvoDoEngajamento {
  organizationId: string;
  conversationId: string;
  /** `ai_agents.id` do agente que vai responder ESTE turno (`config.agentId`). */
  agentId: string;
}

/**
 * `true` quando ESTE agente já enviou algo neste atendimento — a âncora do
 * portão do filtro de palavra-chave (#3142). Erro de leitura NÃO é capturado:
 * ele sobe e o turno é re-tentado pela fila (`failJob` → `max_attempts` →
 * `job_dead`). Devolver `false` ali deixaria o filtro calar um cliente que já
 * está conversando com o agente. Só a linha ausente vira `false`; leitura
 * quebrada nunca inventa engajamento.
 */
export async function agenteJaRespondeuNoAtendimento(
  db: Queryable,
  alvo: AlvoDoEngajamento,
): Promise<boolean> {
  const { rows } = await db.query<{ respondeu: boolean }>(
    `select exists (
       select 1
         from messages m
         join conversations c
           on c.organization_id = m.organization_id and c.id = m.conversation_id
        where m.organization_id = $1
          and m.conversation_id = $2
          and m.direction = 'outbound'
          and m.sent_via = 'ai'
          and m.metadata->>'ai_actor_id' = $3
          and m.status <> 'failed'
          and (c.service_started_at is null or m.sent_at >= c.service_started_at)
     ) as respondeu`,
    [alvo.organizationId, alvo.conversationId, alvo.agentId],
  );
  return rows[0]?.respondeu === true;
}
