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
 * `haQuemAtendaAOrganizacao` é a mesma pergunta, sem pausados, em qualquer
 * número: o "Não roda" das tarefas de pedido no cartão do Jev.
 *
 * `ignorarPausados`: só o worker do Jev pede. Pausar pela tela grava só
 * `paused_at` — a versão segue publicada e o ponteiro fica —, então o portão
 * do dreno abre, e o turno sai na pausa (`inbound-turn.ts`, `pausedAt`) ANTES
 * de a regra de hoje rodar. Sem a opção, o Jev contaria "pedidos que a regra
 * deixou passar" onde ela nem foi consultada. O dreno chama sem a opção, e o
 * SQL que ele manda sai idêntico ao de sempre: a pausa no dreno é outra frente.
 */
import type pg from "pg";

/**
 * O SQL do portão, com o número como predicado: `= $2` (o número da conversa,
 * o que o dreno pergunta) ou `is not null` (qualquer número da organização, o
 * que o cartão do Jev pergunta). Um texto só para as duas perguntas — o de uma
 * sessão sai byte a byte o que o dreno sempre mandou.
 */
function sqlDoPortao(doNumero: (coluna: string) => string, ignorarPausados: boolean): string {
  const semPausa = (agente: string): string => (ignorarPausados ? ` and ${agente}.paused_at is null` : "");
  return `select
       exists(
         select 1 from ai_agents a
         join ai_agent_versions v on v.id = a.published_version_id
         where a.organization_id = $1 and a.archived_at is null${semPausa("a")}
           and v.status = 'published' and ${doNumero("v.channel_session_id")}
       ) as tem_agente,
       exists(
         select 1 from ai_routers r
         where r.organization_id = $1 and r.is_active
           and ${doNumero("r.channel_session_id")}
           and (
             -- O fallback e os membros contam pelo que PODEM EXECUTAR, não por
             -- existirem. A versão anterior media fallback_agent_id is not null
             -- e a existência de LINHA em ai_router_members — e as duas
             -- sobrevivem a arquivar ou despublicar o agente. Um roteador cujos
             -- membros não tinham mais versão publicada continuava abrindo o
             -- portão: a organização pagava o classificador e o turno inteiro
             -- por mensagem recebida, para responder pelo genérico. A pausa
             -- pela tela NÃO limpa o ponteiro (grava só paused_at, e a versão
             -- segue publicada): só quem pede ignorarPausados a lê.
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
       ) as tem_roteador`;
}

async function responderOPortao(
  db: Pick<pg.Pool, "query">,
  texto: string,
  parametros: string[],
): Promise<boolean | null> {
  const { rows } = await db.query<{ tem_agente: boolean; tem_roteador: boolean }>(texto, parametros);
  const cap = rows[0];
  return cap === undefined ? null : cap.tem_agente || cap.tem_roteador;
}

export async function haQuemAtendaASessao(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
  channelSessionId: string,
  opcoes: { ignorarPausados?: boolean } = {},
): Promise<boolean | null> {
  return responderOPortao(
    db,
    sqlDoPortao((coluna) => `${coluna} = $2`, opcoes.ignorarPausados === true),
    [organizationId, channelSessionId],
  );
}

/**
 * HÁ QUEM ATENDA EM ALGUM NÚMERO DA ORGANIZAÇÃO, sem os pausados? — o portão
 * que o worker do Jev pede (`haQuemAtendaASessao(..., { ignorarPausados: true })`),
 * sem fixar o número. É a pergunta do cartão do Jev para as tarefas de pedido
 * (`app/api/v1/ai/jev/route.ts`): onde nenhum número tem quem atenda, o worker
 * nunca as pergunta, e o cartão diz "Não roda" em vez de "Só observa" com
 * "percebeu 0" para sempre. `null` quando o banco não devolve linha.
 */
export async function haQuemAtendaAOrganizacao(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
): Promise<boolean | null> {
  return responderOPortao(db, sqlDoPortao((coluna) => `${coluna} is not null`, true), [organizationId]);
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
