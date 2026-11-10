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
 * ─── Onde a passagem vale — e a fronteira do número ────────────────────────
 *
 * O sticky gravado aqui só é lido pelo turno seguinte quando o número tem
 * roteador ativo com sticky, fora do modo de regras por remetente, e a conversa
 * não nasceu de campanha com agente publicado: em cada um desses casos o turno
 * escolhe o agente por outra régua ANTES de olhar o agente fixo da conversa
 * (`resolve-turn-agent.ts`). Fora disso a ação RECUSA com código próprio
 * (`sem_roteador`, `roteador_sem_sticky`, `roteador_por_remetente`,
 * `conversa_de_campanha`), em vez de responder "feito" e o turno ignorar.
 *
 * A fronteira entre números é "membro do roteador ativo deste número": o turno
 * carrega o membro pelo id, sem olhar em que número ele está publicado, então
 * qualquer membro desse roteador atende aqui. A passagem para um agente que não
 * é membro (inclusive o de outro número) é recusada — `agente_fora_do_roteador`.
 * A origem de serviço (`serviceForAutomation`, `fn_service_event_origin`) segue
 * recusando `channel_session_id` diferente do da conversa; esta ação não toca
 * nessa trava.
 */
import type pg from 'pg';
import { z } from 'zod';

import { logger } from '@/lib/logger';

import { tool } from '../edge/llm/run-model-call';
import { loadPublishedAgentConfigById } from './agent-config';
import { agenteDaCampanhaDaConversa } from './agente-da-campanha';
import { loadActiveRouter, type LoadedRouter, type RouterMember } from './router-config';

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
  /** O número da conversa não tem roteador ativo: o turno escolhe o agente do número. */
  'sem_roteador',
  /** O roteador não guarda o agente da conversa (sticky desligado). */
  'roteador_sem_sticky',
  /** O roteador escolhe pelo telefone de quem escreve, antes do agente da conversa. */
  'roteador_por_remetente',
  /** A conversa nasceu de campanha com agente publicado: é ele quem atende. */
  'conversa_de_campanha',
  /** O agente não existe, está arquivado, está fora da organização ou não tem versão publicada. */
  'agente_inexistente',
  /** O agente está pausado: o turno sairia calado. */
  'agente_pausado',
  /** O agente não é membro do roteador ativo deste número. */
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
  /** A intenção do membro de destino no roteador. */
  intentName: string;
  routerId: string;
}

interface ConversaRow {
  channel_session_id: string | null;
  active_ai_agent_id: string | null;
}

/**
 * O roteador está no modo de regras por remetente: o turno escolhe o agente pelo
 * telefone de quem escreve, ANTES de olhar o agente fixo da conversa. Uma regra
 * só: `resolve-turn-agent.ts` importa daqui.
 */
export function roteadorPorRemetente(router: LoadedRouter): boolean {
  return router.senderRoutes !== undefined &&
    (!Array.isArray(router.senderRoutes) || router.senderRoutes.length > 0);
}

/**
 * O roteador em que a passagem VALE para esta conversa — ou a recusa que diz por
 * que o turno seguinte não a respeitaria. A mesma pergunta para a ação e para a
 * ferramenta do agente: a ferramenta só é oferecida quando isto não recusa.
 *
 * As réguas são as do turno (`resolve-turn-agent.ts`): regras por remetente,
 * campanha e sem roteador vêm antes do sticky ali — qualquer uma delas faz o
 * turno ignorar o agente gravado na conversa.
 */
export async function roteadorDaPassagem(
  db: pg.Pool,
  organizationId: string,
  conversationId: string,
  channelSessionId: string | null,
): Promise<LoadedRouter> {
  const router =
    channelSessionId === null ? null : await loadActiveRouter(db, organizationId, channelSessionId);
  if (router === null) {
    throw new TransferenciaDeAgenteRecusada(
      'sem_roteador',
      'O número desta conversa não tem roteador ativo — o agente do número é quem atende.',
    );
  }
  if (roteadorPorRemetente(router)) {
    throw new TransferenciaDeAgenteRecusada(
      'roteador_por_remetente',
      'O roteador deste número escolhe o agente pelo telefone de quem escreve.',
    );
  }
  const idDaCampanha = await agenteDaCampanhaDaConversa(db, organizationId, conversationId);
  if (idDaCampanha !== null && (await loadPublishedAgentConfigById(db, organizationId, idDaCampanha)) !== null) {
    throw new TransferenciaDeAgenteRecusada(
      'conversa_de_campanha',
      'A conversa nasceu de uma campanha com agente próprio — é ele quem atende.',
    );
  }
  if (!router.sticky) {
    throw new TransferenciaDeAgenteRecusada(
      'roteador_sem_sticky',
      'O roteador deste número não mantém o agente da conversa (sticky desligado).',
    );
  }
  return router;
}

/**
 * Passa a conversa para outro agente de IA do MESMO número, de forma
 * determinística, e registra a decisão.
 *
 * Para na primeira recusa, sem tocar em nada:
 *
 *  1. a conversa (organização + sticky atual);
 *  2. o roteador em que a passagem vale (`roteadorDaPassagem`);
 *  3. o agente de destino: existe, não está arquivado, tem versão publicada e
 *     não está pausado — a mesma leitura que o turno faz do membro;
 *  4. o destino é MEMBRO desse roteador — um sticky que não é membro é ignorado
 *     pelo turno (`stickyMember` em `resolve-turn-agent.ts`);
 *  5. UM statement: o sticky muda e a linha de trilha nasce na MESMA escrita
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

  const roteador = await roteadorDaPassagem(
    db,
    organizationId,
    conversationId,
    conversa.channel_session_id,
  );

  const destino = await loadPublishedAgentConfigById(db, organizationId, agenteDestinoId);
  if (destino === null) {
    throw new TransferenciaDeAgenteRecusada(
      'agente_inexistente',
      'Agente de destino não existe nesta organização ou não tem versão publicada.',
    );
  }
  if (destino.pausedAt) {
    throw new TransferenciaDeAgenteRecusada(
      'agente_pausado',
      'O agente de destino está pausado — com ele a conversa ficaria sem resposta.',
    );
  }

  const membro = roteador.members.find((m) => m.agentId === agenteDestinoId);
  if (membro === undefined) {
    throw new TransferenciaDeAgenteRecusada(
      'agente_fora_do_roteador',
      'O agente de destino não é membro do roteador deste número.',
    );
  }
  const routerId = roteador.id;
  const intentName = membro.intentName;

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

/**
 * A ferramenta `transfer_to_agent` do agente em turno — o consumidor da ação
 * com motivo `pedido_do_agente`.
 *
 * Só existe onde a passagem vale (`roteadorDaPassagem` não recusa) e só oferece
 * os OUTROS membros desse roteador: o destino é um enum das intenções deles, e o
 * modelo não tem como nomear um agente fora da lista. `null` = sem ferramenta
 * neste turno. Recusa vira resultado da ferramenta (`ok: false`), nunca exceção.
 */
export async function ferramentaDePassagemEntreAgentes(
  db: pg.Pool,
  ctx: {
    organizationId: string;
    conversationId: string;
    channelSessionId: string;
    agenteAtualId: string;
    jobId: string;
    noteRunError: (err: Error) => void;
  },
) {
  let roteador: LoadedRouter;
  try {
    roteador = await roteadorDaPassagem(db, ctx.organizationId, ctx.conversationId, ctx.channelSessionId);
  } catch (err) {
    if (err instanceof TransferenciaDeAgenteRecusada) return null;
    throw err;
  }
  const destinos = roteador.members.filter((m) => m.agentId !== ctx.agenteAtualId);
  const [primeiro, ...demais] = destinos.map((m) => m.intentName);
  if (primeiro === undefined) return null;
  const porIntencao = new Map<string, RouterMember>(destinos.map((m) => [m.intentName, m]));

  return tool({
    description:
      'Passa esta conversa para outro agente de IA deste número. A partir da próxima mensagem do ' +
      'cliente, quem responde é o agente escolhido. Use só quando o assunto é claramente de outro ' +
      'agente da lista, e avise o cliente antes. Agentes disponíveis:\n' +
      destinos.map((m) => `- ${m.intentName}: ${m.intentDescription}`).join('\n'),
    inputSchema: z.object({
      destino: z.enum([primeiro, ...demais]).describe('a intenção do agente que deve assumir a conversa'),
    }),
    execute: async ({ destino }: { destino: string }) => {
      const membro = porIntencao.get(destino);
      if (membro === undefined) {
        return { ok: false, error: { code: 'agente_fora_do_roteador', message: 'Destino fora da lista.' } };
      }
      try {
        await transferirAgenteDaConversa(db, {
          organizationId: ctx.organizationId,
          conversationId: ctx.conversationId,
          agenteDestinoId: membro.agentId,
          motivo: 'pedido_do_agente',
          solicitadoPor: null,
          jobId: ctx.jobId,
        });
        return {
          ok: true,
          status: 'transferida',
          message:
            `Conversa passada para o agente "${destino}", que responde a partir da próxima mensagem ` +
            'do cliente. Se ainda não avisou o cliente, avise agora e encerre o turno.',
        };
      } catch (err) {
        if (err instanceof TransferenciaDeAgenteRecusada) {
          return { ok: false, error: { code: err.codigo, message: err.message } };
        }
        ctx.noteRunError(err instanceof Error ? err : new Error(String(err)));
        return {
          ok: false,
          error: { code: 'internal_error', message: 'erro interno ao passar a conversa — siga atendendo.' },
        };
      }
    },
  });
}
