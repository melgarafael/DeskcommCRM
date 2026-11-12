/**
 * Quem atende quem responde a uma CAMPANHA.
 *
 * ═══ A dívida que este arquivo paga ═══
 *
 * `lib/ai/elegibilidade/campanha.ts` declarou, por escrito e antes desta
 * entrega: "o match de campanha só torna o contato elegível; quem assume o
 * turno é sempre o roteador / agente publicado da sessão. Encaminhar por
 * campanha exige levar o `agent_id` (…) e o `resolve-turn-agent` respeitá-lo —
 * não feito nesta entrega". O campo `agent_id` existia no schema de lá e era
 * ignorado.
 *
 * ═══ Por que importa, e não é preferência ═══
 *
 * Quem aborda gente que nunca falou com a empresa segue um roteiro que não é o
 * do atendimento: apresenta quem fala, explica de onde veio o contato, oferece
 * a saída. A LIA-2026-01 do controlador PROMETE que quem perguntar "de onde
 * veio meu contato?" recebe a resposta exata na hora — e essa promessa só se
 * cumpre se QUEM ATENDE souber respondê-la. Com o agente do número atendendo, a
 * promessa depende de alguém ter lembrado de pôr isso no material dele.
 *
 * ═══ Só conversa que NASCE da campanha ═══
 *
 * Decisão do dono (2026-09-19). O contato antigo que responde a uma reativação
 * continua com quem já o atendia; seria hostil trocar o atendente de alguém no
 * meio da relação porque ele reagiu a uma mensagem. Por isso a consulta exige
 * que a conversa seja a MESMA que a campanha criou (`campaign_recipients.
 * conversation_id`), e não "esse contato está em alguma campanha".
 *
 * ═══ A outra campanha: a de ENTRADA (a frase do anúncio, #4024) ═══
 *
 * A de ENTRADA não cria a conversa — o cliente escreve "quero saber mais sobre
 * implantes" e a conversa pode até já existir. Ela também não põe o contato em
 * `campaign_recipients`. O que ela tem é a FRASE, casada na ingestão
 * (`lib/ai/elegibilidade/campanha.ts`) com a config
 * `organizations.settings.campanhas_whatsapp`, que declara `agent_id` desde a
 * 0203 e não era lido por ninguém. Aqui ele é lido.
 *
 * A partir da decisão do mantenedor (2026-11-05) ela vale em TODO turno da
 * conversa em que a frase casou — a mesma regra da de saída. Só essa conversa é
 * afetada: uma conversa nova do mesmo contato volta à régua do número, e uma
 * troca explícita de agente no meio da conversa continua possível. O mecanismo
 * anterior (uso único, carimbado pelo próprio turno) foi medido gastando o
 * carimbo num turno ADIADO pela janela anti-ban, e a conversa perdia o agente
 * da campanha sem nunca ter sido atendida por ele — por isso ele saiu.
 *
 * As duas entram no MESMO degrau do `resolve-turn-agent`, acima do roteador: a
 * campanha é a razão de a conversa existir, e ela sabe algo que o classificador
 * de intenção não tem como inferir.
 */
import type pg from 'pg';

/**
 * Teto de tempo da consulta.
 *
 * Um `await` sem limite no caminho quente do agente é defeito por si só: num dia
 * de banco lento ou de lock preso, ele seguraria o TURNO INTEIRO — a pessoa fica
 * sem resposta por causa de um enfeite de roteamento. Meio segundo é muito mais
 * que uma leitura indexada por `conversation_id` precisa, e estourar aqui só
 * significa seguir pela régua do número.
 */
const TETO_MS = 500;

/**
 * O agente declarado pela campanha que criou ESTA conversa, se houver.
 *
 * `null` em qualquer dúvida: campanha sem agente, conversa que não nasceu de
 * campanha, erro de consulta, ou banco que demorou demais. Falhar aqui não pode
 * calar o atendimento — o turno segue pela régua normal (roteador, agente do
 * número, genérico).
 */
export async function agenteDaCampanhaDaConversa(
  db: pg.Pool,
  tenantId: string,
  conversationId: string,
): Promise<string | null> {
  return comTeto(() => db.query<{ agent_id: string | null }>(
    `select c.agent_id
       from campaign_recipients r
       join campaigns c on c.id = r.campaign_id
      where r.organization_id = $1
        and r.conversation_id = $2
        and c.agent_id is not null
      order by r.sent_at desc nulls last
      limit 1`,
    [tenantId, conversationId],
  ));
}

/**
 * CORRE A CONSULTA COM TETO DE TEMPO, e transforma qualquer dúvida em `null`.
 *
 * `Promise.race` e não `statement_timeout`: o teto tem de valer também quando a
 * conexão nem chega a ser obtida (pool esgotado), que é exatamente o caso em que
 * o turno ficaria pendurado. Falhar aqui não pode calar o atendimento — quem
 * chama segue pela régua do número.
 */
async function comTeto<T extends { rows: Array<Record<string, unknown>> }>(
  consulta: () => Promise<T>,
): Promise<string | null> {
  try {
    const resultado = await Promise.race([
      consulta(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TETO_MS)),
    ]);
    if (resultado === null) return null;
    const linha = resultado.rows[0] as { agent_id?: string | null } | undefined;
    return linha?.agent_id ?? null;
  } catch {
    return null;
  }
}

/**
 * O agente declarado pela campanha de ENTRADA — a frase do anúncio (issue
 * #4024).
 *
 * ═══ Igual à campanha de saída, por decisão do mantenedor (2026-11-05) ═══
 *
 * A de saída nasce da conversa: `campaign_recipients.conversation_id` é a
 * prova, e o degrau vale em todo turno daquela conversa. A de ENTRADA não tem
 * vínculo nenhum — o cliente escreveu a frase do anúncio e a conversa podia
 * existir antes. O vínculo é a COLUNA que a ingestão gravou quando a frase
 * casou (`conversations.campaign_entry_agent_id`, migration 9348), e ele vale
 * em todo turno DESSA conversa: quem chega pelo anúncio é atendido pelo agente
 * daquela campanha, e não pelo agente do número que atende vários nichos.
 *
 * ═══ Por que uma leitura, e não o carimbo de uso único que existia ═══
 *
 * A primeira versão carimbava o uso num `update … returning` e valia só no
 * primeiro turno. O defeito medido: o turno adiado pela janela anti-ban
 * (`fora da janela anti-ban`) gastava o carimbo sem responder nada, e a
 * conversa — que nunca tinha sido atendida pelo agente da campanha — voltava
 * para o número. Sem escrita não existe estado a gastar: o adiamento não tira
 * a conversa do agente da campanha, e o turno seguinte, dentro da janela,
 * ainda sai por ele.
 *
 * ═══ O que NÃO passa por aqui ═══
 *
 * - Conversa que não veio do anúncio: `campaign_entry_agent_id` é nulo;
 * - dono humano, silêncio, opt-out: a régua de elegibilidade barra ANTES, no
 *   drain e no início do turno (`decidirElegibilidadeDaConversa`) — este degrau
 *   não tem como passar por cima dela, porque nem chega a rodar;
 * - agente de outra organização: a FK composta da 9348 recusa a gravação, e o
 *   `loadPublishedAgentConfigById` filtra por `organization_id` na leitura;
 * - agente arquivado ou sem versão publicada: `_loadAgentById` devolve `null` e
 *   o turno segue pela régua do número (falha aberta).
 */
export async function agenteDaCampanhaDeEntrada(
  db: pg.Pool,
  tenantId: string,
  conversationId: string,
): Promise<string | null> {
  return comTeto(() => db.query<{ campaign_entry_agent_id: string | null }>(
    `select c.campaign_entry_agent_id as agent_id
       from public.conversations c
      where c.organization_id = $1
        and c.id = $2`,
    [tenantId, conversationId],
  ));
}
