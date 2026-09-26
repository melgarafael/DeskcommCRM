/**
 * HÁ QUEM ATENDA ESTA SESSÃO? — o portão de custo do dreno do agent-engine
 * (`lib/agent-engine/edge/crm/drain.ts`), numa função só.
 *
 * O dreno pergunta isto antes de enfileirar o turno, e pula o evento quando a
 * resposta é não: sem agente publicado para a sessão e sem roteador que possa
 * resolver alguém, "pausei o agente" tem de significar "parou de gastar".
 *
 * Mora fora do dreno porque o worker de clima faz a MESMA pergunta antes de
 * perguntar ao Jev pelos pedidos do cliente (`workers/ai-sentiment-worker.pedidos.ts`):
 * o Jev só conta um pedido que a regra de hoje "deixou passar" onde o turno —
 * e com ele a regra — de fato rodaria. Duas cópias da pergunta divergiram uma
 * vez neste repositório (o resolvedor do worker elegia o agente único da
 * empresa publicado em OUTRO número, e o dreno pulava o turno ali). Uma função
 * só, e a paridade provada contra o dreno em
 * `tests/invariants/jev-pergunta-so-onde-o-dreno-atende.test.ts` (o portão do
 * dreno em si é congelado em `portao-de-capacidade-mede-quem-executa.test.ts`).
 *
 * Aqui também mora a outra pergunta que o worker faz sobre quem atende: as
 * palavras de passagem de quem pode atender a conversa
 * (`palavrasDeQuemPodeAtender`), provadas no mesmo arquivo de invariante.
 *
 * `null` quando o banco não devolve linha — o que um `select exists(...)` não
 * faz. O dreno segue nesse caso (o comportamento de sempre); o worker do Jev
 * não pergunta.
 *
 * `ignorarPausados`: só o worker do Jev pede. Pausar pela tela grava só
 * `paused_at` — a versão segue publicada e o ponteiro fica —, então o portão
 * do dreno abre, e o turno sai na pausa (`inbound-turn.ts`, `pausedAt`) ANTES
 * de a regra de hoje rodar. Sem a opção, o Jev contaria "pedidos que a regra
 * deixou passar" onde ela nem foi consultada. O dreno chama sem a opção, e o
 * SQL que ele manda sai idêntico ao de sempre: a pausa no dreno é outra frente.
 */
import type pg from "pg";

export async function haQuemAtendaASessao(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
  channelSessionId: string,
  opcoes: { ignorarPausados?: boolean } = {},
): Promise<boolean | null> {
  const semPausa = (agente: string): string => (opcoes.ignorarPausados === true ? ` and ${agente}.paused_at is null` : "");
  const { rows } = await db.query<{
    tem_agente: boolean;
    tem_roteador: boolean;
  }>(
    `select
       exists(
         select 1 from ai_agents a
         join ai_agent_versions v on v.id = a.published_version_id
         where a.organization_id = $1 and a.archived_at is null${semPausa("a")}
           and v.status = 'published' and v.channel_session_id = $2
       ) as tem_agente,
       exists(
         select 1 from ai_routers r
         where r.organization_id = $1 and r.is_active
           and r.channel_session_id = $2
           and (
             -- O fallback e os membros contam pelo que PODEM EXECUTAR, não por
             -- existirem. A versão anterior media fallback_agent_id is not null
             -- e a existência de LINHA em ai_router_members — e as duas
             -- sobrevivem à pausa do agente, que só limpa published_version_id.
             -- Um roteador cujos membros foram todos pausados continuava
             -- abrindo o portão: a organização pagava o classificador e o turno
             -- inteiro por mensagem recebida, para responder pelo genérico.
             -- O predicado aqui é o MESMO que loadConversationAgentConfigById
             -- aplica na hora de executar (agent-config.ts) — é o que garante
             -- que o portão não promete um agente que o resolvedor vai recusar.
             exists (
               select 1 from ai_agents fa
               join ai_agent_versions fv on fv.id = fa.published_version_id
               where fa.id = r.fallback_agent_id and fa.organization_id = $1
                 and fa.archived_at is null and fv.status = 'published'${semPausa("fa")}
             )
             or exists (
               select 1 from ai_router_members m
               join ai_agents ma on ma.id = m.agent_id
               join ai_agent_versions mv on mv.id = ma.published_version_id
               where m.router_id = r.id and ma.organization_id = $1
                 and ma.archived_at is null and mv.status = 'published'${semPausa("ma")}
             )
           )
       ) as tem_roteador`,
    [organizationId, channelSessionId],
  );
  const cap = rows[0];
  return cap === undefined ? null : cap.tem_agente || cap.tem_roteador;
}

/**
 * As palavras de passagem (`handoff_keywords`, brutas) de todo agente que pode
 * atender esta conversa: as versões publicadas no número dela, o fallback e os
 * membros do roteador ativo nele, e os agentes das campanhas que a criaram. O
 * turno aplica as de UM deles, e qual depende do roteador (e da campanha mais
 * recente, `agenteDaCampanhaDaConversa`); a união pega o pedido que qualquer um
 * pegaria — o lado de não perguntar ao Jev. "Pode atender" é o mesmo "pode
 * executar" do portão acima: não arquivado, com a versão apontada publicada.
 */
export async function palavrasDeQuemPodeAtender(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
  channelSessionId: string | null,
  conversationId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ handoff_keywords: string[] | null }>(
    `select v.handoff_keywords
       from ai_agents a
       join ai_agent_versions v on v.id = a.published_version_id
      where a.organization_id = $1 and a.archived_at is null and v.status = 'published'
        and (
          v.channel_session_id = $2
          or a.id in (
            select r.fallback_agent_id from ai_routers r
             where r.organization_id = $1 and r.is_active and r.channel_session_id = $2
            union
            select m.agent_id from ai_router_members m
              join ai_routers r on r.id = m.router_id
             where r.organization_id = $1 and r.is_active and r.channel_session_id = $2
          )
          or a.id in (
            select c.agent_id from campaign_recipients cr
              join campaigns c on c.id = cr.campaign_id
             where cr.organization_id = $1 and cr.conversation_id = $3
          )
        )`,
    [organizationId, channelSessionId, conversationId],
  );
  return rows.flatMap((r) => r.handoff_keywords ?? []);
}
