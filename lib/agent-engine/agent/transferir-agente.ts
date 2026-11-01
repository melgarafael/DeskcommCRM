/**
 * A AÇÃO EXPLÍCITA DE PASSAR A CONVERSA DE UM AGENTE DE IA PARA OUTRO — no
 * MESMO número (#3770).
 *
 * ─── O que isto resolve, e por que não é o roteador ────────────────────────
 *
 * Com roteador sticky, passar a conversa de um agente para outro JÁ funciona —
 * mas só quando o classificador acerta: a passagem acontece porque a próxima
 * mensagem do cliente casa com a `intent_description` de outro membro, e o
 * desfecho na trilha é `reclassified` (`resolve-turn-agent.ts`). Não existe uma
 * ação "leve esta conversa para o agente X": quem decide é um modelo, a cada
 * mensagem, e o agente que queria passar não tem como declarar isso.
 *
 * Aqui a passagem é DETERMINÍSTICA: quem chama diz o agente de destino, o
 * destino é validado contra o banco, o sticky da conversa muda e a decisão fica
 * registrada em `ai_router_decisions` com desfecho próprio (`transferred`) e
 * `origem = 'acao'` — nunca `reclassified`, que significa "o classificador
 * decidiu". Nenhum classificador é chamado em caminho nenhum deste módulo.
 *
 * ─── A trilha: os cinco campos que o brief pede ────────────────────────────
 *
 * `ai_router_decisions` ganhou quatro colunas na migration 9064 e a lista de
 * `outcome` ganhou o valor `transferred`:
 *
 *   quem pediu  → `solicitado_por` (usuário, quando a ação parte de uma pessoa)
 *                 e `motivo` (vocabulário fechado: ver abaixo)
 *   de qual     → `agente_anterior_id` (o sticky que a conversa tinha)
 *   para qual   → `agent_id` (coluna que já existia)
 *   quando      → `created_at`
 *   por quê     → `motivo`
 *
 * NADA de texto livre aqui: `ai_router_decisions` é lida por toda a organização
 * e o contrato da tabela desde a 0085 é "sem PII — o texto do lead nunca entra
 * aqui". Um motivo em prosa escrito pelo modelo seria exatamente isso.
 *
 * ─── A fronteira do número (declarada, não contornada) ─────────────────────
 *
 * A passagem entre NÚMEROS DIFERENTES é outra coisa e continua impossível por
 * aqui (#3770, fora de escopo): `serviceForAutomation`
 * (`lib/atendimento/origem-automacao.ts`) e `fn_service_event_origin` recusam
 * `channel_session_id` diferente do da conversa, e esta ação não toca nessa
 * trava. O que ela faz é RECUSAR com erro claro o destino que não atende neste
 * número — `agente_de_outro_numero` —, em vez de gravar um sticky que o próximo
 * turno ignoraria em silêncio.
 */
import type pg from 'pg';

import { logger } from '@/lib/logger';

/**
 * POR QUE a passagem aconteceu — vocabulário FECHADO, espelhado no CHECK da
 * migration 9064. Nada de texto livre: este valor vai para uma tabela lida por
 * toda a organização, com contrato de "sem PII" desde a 0085.
 *
 *  - `pedido_do_agente`    — o próprio agente em turno pediu a passagem;
 *  - `pedido_do_operador`  — uma pessoa clicou/chamou a ação;
 *  - `regra_de_automacao`  — uma regra de automação pediu.
 */
export const MOTIVOS_DA_TRANSFERENCIA_DE_AGENTE = [
  'pedido_do_agente',
  'pedido_do_operador',
  'regra_de_automacao',
] as const;
export type MotivoDaTransferenciaDeAgente =
  (typeof MOTIVOS_DA_TRANSFERENCIA_DE_AGENTE)[number];

/**
 * Os códigos de recusa. Cada um vira uma mensagem para quem chamou — e todos
 * garantem a MESMA coisa: NADA é escrito (nem sticky, nem linha de trilha).
 */
export const CODIGOS_DE_RECUSA_DA_TRANSFERENCIA = [
  /** A conversa não existe nesta organização. */
  'conversa_nao_encontrada',
  /** O agente não existe, está arquivado, está fora da organização ou não tem versão publicada. */
  'agente_inexistente',
  /** O agente é desta organização, mas não atende neste número. */
  'agente_de_outro_numero',
  /** O número tem roteador ativo e o agente não é membro dele. */
  'agente_fora_do_roteador',
  /** A conversa já está com esse agente — passar de novo não é uma decisão. */
  'ja_esta_no_agente',
] as const;
export type CodigoDeRecusaDaTransferencia =
  (typeof CODIGOS_DE_RECUSA_DA_TRANSFERENCIA)[number];

/**
 * Recusa da ação. É `Error` de propósito: quem chama decide o status HTTP, e um
 * `try/catch` genérico não confunde a recusa com falha de banco.
 */
export class TransferenciaDeAgenteRecusada extends Error {
  constructor(
    readonly codigo: CodigoDeRecusaDaTransferencia,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = 'TransferenciaDeAgenteRecusada';
  }
}

export interface EntradaDaTransferencia {
  organizationId: string;
  conversationId: string;
  agenteDestinoId: string;
  motivo: MotivoDaTransferenciaDeAgente;
  /** Quem pediu, quando foi uma pessoa (uuid do usuário). O agente em turno não manda. */
  solicitadoPor?: string | null;
  /** O job do turno, quando a ação nasceu dentro de um turno (correlação). */
  jobId?: string | null;
}

export interface ResultadoDaTransferencia {
  /** O sticky que a conversa tinha — `null` = a conversa ainda não tinha agente ativo. */
  agenteAnteriorId: string | null;
  agenteDestinoId: string;
  /** A intenção do membro de destino no roteador; `null` sem roteador. */
  intentName: string | null;
  routerId: string | null;
}

interface ConversaRow {
  channel_session_id: string | null;
  active_ai_agent_id: string | null;
}

/**
 * Passa a conversa para outro agente de IA do MESMO número, de forma
 * determinística, e registra a decisão.
 *
 * Executa, em ordem, quatro leituras/escritas — e para na primeira que recusar,
 * sem tocar em nada:
 *
 *  1. a conversa (organização + sticky atual);
 *  2. o agente de destino: existe, não está arquivado, tem versão publicada
 *     NESTE número (é `ai_agent_versions.channel_session_id` que diz em que
 *     número um agente atende);
 *  3. se o número tem roteador ativo, o destino tem que ser MEMBRO dele — um
 *     sticky que não é membro é ignorado pelo resolvedor do turno
 *     (`stickyMember` em `resolve-turn-agent.ts`), então aceitar aqui seria
 *     gravar uma passagem que não acontece;
 *  4. UM statement: o sticky muda e a linha de trilha nasce na MESMA escrita
 *     (`with destino as (update … returning id) insert … select from destino`).
 *     Conversa que não existe na organização não casa com o `update`, e a
 *     trilha não nasce — não há como sobrar linha sem mudança.
 */
export async function transferirAgenteDaConversa(
  db: pg.Pool,
  entrada: EntradaDaTransferencia,
): Promise<ResultadoDaTransferencia> {
  const { organizationId, conversationId, agenteDestinoId, motivo } = entrada;

  const { rows: conversas } = await db.query<ConversaRow>(
    `select channel_session_id, active_ai_agent_id
       from conversations
      where organization_id = $1 and id = $2`,
    [organizationId, conversationId],
  );
  const conversa = conversas[0];
  if (conversa === undefined) {
    throw new TransferenciaDeAgenteRecusada(
      'conversa_nao_encontrada',
      'Conversa não encontrada nesta organização.',
    );
  }

  if (conversa.active_ai_agent_id === agenteDestinoId) {
    throw new TransferenciaDeAgenteRecusada(
      'ja_esta_no_agente',
      'A conversa já está com este agente.',
    );
  }

  // Quem atende NESTE número: versão publicada na sessão de canal da conversa.
  // `loadPublishedAgentConfigById` não serve aqui de propósito — ele responde
  // "existe versão publicada?" para qualquer número, e é justamente o destino de
  // outro número que esta ação precisa recusar (ver o cabeçalho).
  const { rows: destinos } = await db.query<{ channel_session_id: string | null }>(
    `select v.channel_session_id
       from ai_agents a
       join ai_agent_versions v on v.id = a.published_version_id
      where a.organization_id = $1
        and a.id = $2
        and a.archived_at is null
        and v.status = 'published'`,
    [organizationId, agenteDestinoId],
  );
  const destino = destinos[0];
  if (destino === undefined) {
    throw new TransferenciaDeAgenteRecusada(
      'agente_inexistente',
      'Agente de destino não existe nesta organização ou não tem versão publicada.',
    );
  }
  if (
    conversa.channel_session_id !== null &&
    destino.channel_session_id !== conversa.channel_session_id
  ) {
    // A passagem ENTRE números é outra issue (#3770, fora de escopo): a origem
    // de serviço recusa `channel_session_id` diferente. Recusar aqui é o que
    // impede um sticky que o turno ignoraria.
    throw new TransferenciaDeAgenteRecusada(
      'agente_de_outro_numero',
      'Agente de destino não atende neste número — a passagem entre números é outra ação.',
    );
  }

  // Roteador do número: com um ativo, só membro dele pode virar sticky.
  const { rows: roteadores } = await db.query<{
    router_id: string;
    intent_name: string | null;
  }>(
    `select r.id as router_id, m.intent_name
       from ai_routers r
       left join ai_router_members m on m.router_id = r.id and m.agent_id = $2
      where r.organization_id = $1
        and r.channel_session_id = $3
        and r.is_active
      limit 1`,
    [organizationId, agenteDestinoId, conversa.channel_session_id],
  );
  const roteador = roteadores[0] ?? null;
  if (roteador !== null && roteador.intent_name === null) {
    throw new TransferenciaDeAgenteRecusada(
      'agente_fora_do_roteador',
      'O número tem roteador ativo e o agente de destino não é um dos membros.',
    );
  }
  const routerId = roteador === null ? null : roteador.router_id;
  const intentName = roteador === null ? null : roteador.intent_name;

  // UMA escrita: o sticky e a linha de trilha nascem juntos, ou nada nasce.
  const { rowCount } = await db.query(
    `with destino as (
       update conversations
          set active_ai_agent_id = $3, active_intent = $4, active_agent_set_at = now()
        where organization_id = $1 and id = $2
        returning id
     )
     insert into ai_router_decisions
       (organization_id, router_id, conversation_id, intent_name, confidence, agent_id,
        outcome, job_id, origem, agente_anterior_id, motivo, solicitado_por)
     select $1, $5, d.id, $4, null, $3,
            'transferred', $6, 'acao', $7, $8, $9
       from destino d`,
    [
      organizationId,
      conversationId,
      agenteDestinoId,
      intentName,
      routerId,
      entrada.jobId ?? null,
      conversa.active_ai_agent_id,
      motivo,
      entrada.solicitadoPor ?? null,
    ],
  );
  if ((rowCount ?? 0) === 0) {
    // A conversa sumiu entre a leitura e a escrita (RLS/delete concorrente). A
    // trilha não nasceu junto, então nada foi gravado.
    throw new TransferenciaDeAgenteRecusada(
      'conversa_nao_encontrada',
      'Conversa não encontrada nesta organização.',
    );
  }

  logger.info('conversa passada para outro agente de IA', {
    organization_id: organizationId,
    conversation_id: conversationId,
    router_id: routerId,
    agente_anterior_id: conversa.active_ai_agent_id,
    agente_destino_id: agenteDestinoId,
    intent: intentName,
    motivo,
    solicitado_por: entrada.solicitadoPor ?? null,
  });

  return {
    agenteAnteriorId: conversa.active_ai_agent_id,
    agenteDestinoId,
    intentName,
    routerId,
  };
}
