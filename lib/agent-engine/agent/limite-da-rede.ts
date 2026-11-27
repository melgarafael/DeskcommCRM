/**
 * O LIMITE DE RESPOSTA DA REDE, NA CADEIA `before_send` (A21, TikTok).
 *
 * A regra mora em `lib/channels/social/limites-da-rede.ts` (pura): janela de 48 h,
 * teto de 10 mensagens e reserva de 2 para a equipe. Este arquivo é a COLA da
 * cadeia da IA, no mesmo desenho do `teto-de-respostas.ts` vizinho: lê o que a
 * regra precisa SOB o lock do número e entrega um gate puro, síncrono.
 *
 * ## Por que um gate, e não um `if` no adapter
 *
 * O limite do TikTok é hetero-restrição (a plataforma me proíbe, e o pedido falha
 * na hora). A doutrina (`docs/doctrine/restricao-de-canal.md`, invariantes 2 e 4)
 * manda declarar a origem e a física da restrição, e registrar `skipped` quando
 * ela não se aplica. Um `if` dentro do adapter esconderia as duas coisas, e
 * adapter não lê banco.
 *
 * ## A conta mora em `messages`
 *
 * Mesma fonte do `teto-de-respostas.ts`: as linhas que o envio já grava. Aqui a
 * contagem é de TODA mensagem da empresa depois da última do cliente — IA, equipe e
 * automação, porque o TikTok conta todas —, sem as que falharam (`failed` não
 * chegou ao cliente e não gasta o limite da rede). A conta é a
 * função SQL `fn_respostas_na_janela` — a MESMA que o envio da equipe e o trigger
 * `trg_limite_da_rede_na_insercao` chamam, e que conta o que VAI sair (`queued`
 * e `sending` valem pelo `created_at`).
 *
 * ## Só a IA passa por aqui
 *
 * O envio da equipe não atravessa a cadeia; ele aplica a MESMA função pura em
 * `sendMessageHandler`, com `autor: "equipe"` (e o teto cheio de 10).
 *
 * A leitura NÃO é fail-open. Ela roda no `client` do `before-send`, que já está dentro
 * de `begin` (com o lock do número): no Postgres uma consulta que falha ABORTA a
 * transação inteira, e o `insert` do envio que vem depois cai junto
 * ("current transaction is aborted"). Capturar o erro e seguir só esconderia o
 * erro — medido pelo mantenedor no #5258. Por isso o erro propaga, como o das
 * outras leituras desta cadeia, e o turno é refeito. O `nao_conferido` do gate
 * fica para quem entregar a contagem como `null` (o envio da equipe, que lê pelo
 * cliente HTTP do Supabase e não está numa transação).
 */
import type pg from 'pg';

import {
  decidirLimiteDaRede,
  limitesDaRede,
  type LimitesDaRede,
  type PoliticaDaRede,
} from '@/lib/channels/social/limites-da-rede';
import { instanteDoBanco } from '@/lib/tempo/agora';

import { insertInboxItem } from '../db/repository';
import type { Gate, GateContext, GateVerdict } from '../guardrails/before-send';
import type { Logger } from '../obs/logger';

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/** O que o gate lê do contexto. `respostasNaJanela: null` = a leitura da contagem falhou. */
export interface LimiteDaRedeDoEnvio {
  limites: LimitesDaRede;
  respostasNaJanela: number | null;
  lastInboundAt: Date | null;
}

/**
 * A leitura desta tentativa. `undefined` = a rede da sessão não tem limite próprio
 * medido (WhatsApp, Instagram, Facebook...): nada é lido além de uma linha da sessão
 * e o gate registra `skipped`.
 */
export async function carregarLimiteDaRede(
  db: Queryable,
  input: {
    organizationId: string;
    contactId: string;
    channelSessionId: string;
  },
): Promise<LimiteDaRedeDoEnvio | undefined> {
  const sessao = await db.query<{ rede: string | null }>(
    `select metadata->>'social_platform' as rede
       from channel_sessions
      where organization_id = $1 and id = $2`,
    [input.organizationId, input.channelSessionId],
  );
  const limites = limitesDaRede(sessao.rows[0]?.rede ?? null);
  if (limites === null) return undefined;

  const conversa = await db.query<{ id: string; last_inbound_at: Date | string | null }>(
    `select id, last_inbound_at from conversations
      where organization_id = $1 and contact_id = $2 and channel_session_id = $3
      order by last_inbound_at desc nulls last
      limit 1`,
    [input.organizationId, input.contactId, input.channelSessionId],
  );
  const linha = conversa.rows[0];
  const bruto = linha?.last_inbound_at ?? null;
  const instante = bruto === null ? null : instanteDoBanco(bruto);
  const lastInboundAt = instante === null ? null : new Date(instante);
  // Sem conversa ou sem mensagem do cliente a janela está fechada e a contagem
  // não muda o veredito: não gasta a segunda leitura.
  if (linha === undefined || lastInboundAt === null) {
    return { limites, respostasNaJanela: 0, lastInboundAt };
  }

  const contagem = await db.query<{ total: number }>(
    `select public.fn_respostas_na_janela($1, $2, $3) as total`,
    [input.organizationId, linha.id, lastInboundAt],
  );
  return { limites, respostasNaJanela: contagem.rows[0]?.total ?? 0, lastInboundAt };
}

/** Código que o turno reconhece no veto para deixar a conversa com uma pessoa. */
export const CODIGOS_DO_LIMITE_DA_REDE = [
  'janela_da_rede_fechada',
  'teto_da_rede',
  'reserva_da_equipe',
] as const;

/**
 * O GATE. Puro e síncrono, como os irmãos: a leitura chega pronta no contexto.
 *
 * Três estados, e a diferença entre eles é o que a auditoria lê:
 *  - `ctx.limiteDaRede` AUSENTE → a rede não tem limite medido (`not_applicable`);
 *  - `respostasNaJanela === null` → a leitura falhou (`nao_conferido`);
 *  - senão, a decisão da regra pura, com a IA como autora.
 */
export const limiteDaRedeGate: Gate = {
  name: 'limite_da_rede',
  evaluate(ctx: GateContext): GateVerdict {
    const estado = ctx.limiteDaRede;
    if (estado === undefined) return { pass: true, skipped: 'not_applicable' };
    if (estado.respostasNaJanela === null) return { pass: true, skipped: 'nao_conferido' };

    const veredito = decidirLimiteDaRede({
      limites: estado.limites,
      autor: 'ia',
      respostasNaJanela: estado.respostasNaJanela,
      lastInboundAt: estado.lastInboundAt,
      now: ctx.now,
    });
    if (veredito.permitido) return { pass: true };

    return {
      pass: false,
      code: veredito.codigo,
      reason: veredito.mensagem,
      detail: {
        na_janela: estado.respostasNaJanela,
        teto: estado.limites.maxRespostas,
        reserva_da_equipe: estado.limites.reservaParaEquipe,
      },
    };
  },
};

/**
 * A REDE da sessão (`metadata.social_platform`), ou `null` para quem não é rede
 * social. É o que o turno pergunta UMA vez no começo para saber se esta conversa tem
 * limites próprios (`limitesDaRede`): se tem, a IA manda uma mensagem por turno, sem
 * dividir em bolhas e com as fotos sem legenda. Nunca lança — sem a rede, o turno
 * segue como sempre foi.
 */
export async function carregarRedeDoCanal(
  db: Queryable,
  organizationId: string,
  channelSessionId: string,
): Promise<string | null> {
  try {
    const { rows } = await db.query<{ rede: string | null }>(
      `select metadata->>'social_platform' as rede
         from channel_sessions
        where organization_id = $1 and id = $2`,
      [organizationId, channelSessionId],
    );
    return rows[0]?.rede ?? null;
  } catch {
    return null;
  }
}

/** Título FIXO por código: é parte da chave do dedupe (`kind_ref_e_titulo`). */
const TITULO_DO_AVISO: Record<(typeof CODIGOS_DO_LIMITE_DA_REDE)[number], string> = {
  janela_da_rede_fechada: 'A janela de resposta desta rede fechou: a IA não pode mais responder',
  teto_da_rede: 'O limite de respostas desta rede foi usado: ninguém pode responder agora',
  reserva_da_equipe: 'A IA parou de responder nesta conversa para deixar as últimas respostas à equipe',
};

/**
 * A equipe é AVISADA na Central, um aviso aberto por conversa e por motivo (dedupe
 * no repositório): a IA não vai tentar de novo, e quem atende precisa saber que a
 * conversa está com ela. Nunca lança.
 */
export async function avisarEquipeDoLimiteDaRede(
  db: Queryable,
  input: {
    organizationId: string;
    conversationId: string;
    codigo: string;
    mensagem: string;
    log?: Logger;
  },
): Promise<void> {
  const titulo = (TITULO_DO_AVISO as Record<string, string | undefined>)[input.codigo];
  if (titulo === undefined) return;
  try {
    await insertInboxItem(
      db,
      input.organizationId,
      {
        kind: 'other',
        severity: 'warn',
        title: titulo,
        body: input.mensagem,
        refKind: 'conversation',
        refId: input.conversationId,
      },
      'kind_ref_e_titulo',
    );
  } catch (err) {
    input.log?.warn('limite da rede: aviso na Central não gravado', {
      conversation_id: input.conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A config do agente NESTE canal: na rede com limite próprio a IA não divide a
 * resposta em bolhas — cada bolha gastaria uma das mensagens da janela, e o TikTok
 * aceita até 6.000 caracteres numa só. Rede sem limite devolve a MESMA config.
 */
export function configDoAgenteNaRede<T extends { splitMessages: boolean }>(
  config: T | null,
  limites: LimitesDaRede | null,
): T | null {
  if (config === null || limites === null) return config;
  return { ...config, splitMessages: false };
}

/**
 * Os tetos de mensagens de UM turno da IA. Na rede com limite próprio o turno manda
 * UM texto (o que `send_message` confere) e, depois dele, até `fotosPorTurnoDaIa`
 * fotos sem legenda: o teto físico é a soma. Fora dela, os dois são o `padrao` de
 * sempre.
 */
export function tetosDeEnvioDoTurno(
  politica: PoliticaDaRede | null,
  padrao: number,
): { maxSendsPerTurn: number; maxTextosPorTurno: number } {
  if (politica === null) return { maxSendsPerTurn: padrao, maxTextosPorTurno: padrao };
  return { maxSendsPerTurn: 1 + politica.fotosPorTurnoDaIa, maxTextosPorTurno: 1 };
}

/**
 * Quantas fotos do turno da IA CABEM na janela: o texto vai primeiro e gasta uma resposta;
 * as fotos só usam o que sobra depois da reserva da equipe. Sem isto, com 7 respostas já
 * usadas o texto saía (a 8ª) e a foto seguinte era recusada no meio do turno.
 */
export function fotosQueCabemNaJanela(
  limites: LimitesDaRede,
  politica: PoliticaDaRede,
  respostasNaJanela: number,
): number {
  const saldo = limites.maxRespostas - limites.reservaParaEquipe - respostasNaJanela - 1;
  return Math.max(0, Math.min(politica.fotosPorTurnoDaIa, saldo));
}
