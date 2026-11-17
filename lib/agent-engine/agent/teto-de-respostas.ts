/**
 * TETO DE RESPOSTAS AUTOMÁTICAS POR CONVERSA NUMA JANELA (#4590).
 *
 * ## O defeito que este arquivo mede
 *
 * Numa instalação self-host, o contato do outro lado era o atendimento
 * automático de um banco. Ele respondeu à primeira mensagem da IA, e daí em
 * diante os dois robôs conversaram sozinhos: **216 respostas em uma hora para o
 * MESMO contato**, uma a cada ~18 s. Nenhuma trava do `before_send` barrou,
 * porque cada resposta, olhada sozinha, é legítima:
 *
 *  - `pacing` mede o RITMO do número, e resposta não entra no cap diário por
 *    decisão escrita (`pacing/engine.ts`): o cap mede quem o número ABORDA;
 *  - `spinning` compara a candidata com as últimas cópias do NÚMERO — ele pega
 *    template repetido para muita gente, não a mesma conversa girando;
 *  - `stop`, `lgpd`, `promise` etc. julgam o CONTEÚDO de uma mensagem.
 *
 * O que faltava era uma trava de CONTAGEM: quantas respostas automáticas esta
 * conversa já recebeu na última janela. É este arquivo. Ele não substitui
 * nenhum dos de cima — soma-se a eles, e um veto aqui não afrouxa nada.
 *
 * ## A conta mora em `messages`, e é a linha que o envio já grava
 *
 * `messages` é a verdade do que saiu (a mesma fonte que `agente-ja-respondeu.ts`
 * e o intervalo entre respostas consultam), já tem a autoria (`sent_via = 'ai'`,
 * #652) e já tem índice por conversa e carimbo
 * (`idx_messages_conversation_sent (conversation_id, sent_at desc)`). Criar
 * tabela/coluna nova seria um SEGUNDO contador para divergir do primeiro — e
 * migration a mais num repo que congela o manifesto.
 *
 * Os filtros são os mesmos da régua vizinha, e cada um tem razão:
 * `direction = 'outbound'` (o que o cliente escreveu não conta), `sent_via = 'ai'`
 * (disparo de prospecção nasce noutro caminho e não é resposta; fala de humano
 * não é resposta AUTOMÁTICA), `status <> 'failed'` (envio que não chegou ao
 * cliente não é resposta) e `sent_at >= desde` (a janela).
 *
 * ## Por que a leitura acontece SOB o lock do número
 *
 * `runBeforeSend` já serializa por `channel_session_id` antes de montar o
 * contexto dos gates. Ler a contagem ali dentro é o que faz a conta enxergar a
 * resposta que o job anterior efetivou no commit dele: fora do lock, dois jobs
 * do mesmo número leriam o mesmo número antigo e ambos passariam — o
 * pingue-pongue voltaria pela porta da corrida.
 *
 * ## O que este arquivo NÃO faz, de propósito
 *
 *  - **Não silencia a conversa.** `conversations.bot_silenced_until` é o
 *    silêncio humano, mais forte e reversível pela tela, e continua intocado.
 *    Aqui só se VETA o envio, com registro (trace em `before_send_traces` +
 *    timeline do veto), e a equipe é AVISADA na Central
 *    (`avisarEquipeDoTetoDeRespostas`), para decidir se do outro lado é um robô
 *    ou um cliente.
 *  - **Não conta disparo nem follow-up.** Chega armado só no caminho de
 *    RESPOSTA (`RunBeforeSendArgs.tetoDeRespostas` só é passado pelo
 *    `send_message` do turno de entrada); follow-up e prospecção ficam de fora
 *    por construção, não por um `if` que alguém pode inverter.
 *  - **Não consulta o teto diário nem o warm-up.** Esses medem o número e
 *    continuam valendo como estão — este mede UMA conversa.
 */
import type pg from 'pg';

import { instanteDoBanco } from '@/lib/tempo/agora';

import { insertInboxItem } from '../db/repository';
import type { Logger } from '../obs/logger';
import type { Gate, GateContext, GateVerdict } from '../guardrails/before-send';

type Queryable = Pick<pg.Pool, 'query'>;

const MS_POR_MINUTO = 60_000;

/** Código do veto — rótulo fechado: vai ao modelo, ao log e a `before_send_traces`. */
export const CODIGO_DO_TETO_DE_RESPOSTAS = 'teto_de_respostas';

/**
 * N padrão — mensagens da IA por conversa dentro da janela.
 *
 * A conta é de LINHAS de `messages`: cada bolha e cada foto de um turno contam
 * uma a uma (um turno com 3 bolhas vale 3). Com 10, um cliente de verdade numa
 * conversa animada (manda fotos, a IA responde em bolhas, confirma endereço,
 * manda o horário…) batia no teto. 20 ainda corta o pingue-pongue medido
 * (**216** em uma hora) com folga para o cliente. Quem tem um atendimento mais
 * conversado sobe o número no env.
 */
export const TETO_DE_RESPOSTAS_PADRAO = 20;

/**
 * W padrão — largura da janela, em minutos (1 h).
 *
 * Casa com a janela em que o incidente foi medido (216 respostas em 1 hora) e
 * não precisa ser maior: o pingue-pongue é contínuo, e uma janela longa demais
 * seguraria conversa normal de um atendimento inteiro.
 */
export const JANELA_DO_TETO_DE_RESPOSTAS_MINUTOS_PADRAO = 60;

export interface TetoDeRespostasKnobs {
  /** N — quantas respostas automáticas cabem na janela, por conversa. */
  porConversa: number;
  /** W — largura da janela, em minutos. */
  janelaMinutos: number;
}

/**
 * O que o turno arma: os dois números e a CONVERSA. Carregar o id junto não é
 * conveniência — é o que impede meio-argumento (contagem armada sem saber de
 * que conversa) virar gate cego.
 */
export interface TetoDeRespostasArmado extends TetoDeRespostasKnobs {
  conversationId: string;
}

/** O que os gates enxergam — ver `GateContext.tetoDeRespostas`. */
export interface RespostasDaConversa extends TetoDeRespostasKnobs {
  /**
   * Quantas respostas a IA já mandou nesta conversa dentro da janela.
   * `null` = a leitura falhou (o gate passa, com o motivo no trace).
   */
  naJanela: number | null;
  /** Carimbo da resposta mais antiga AINDA dentro da janela — base do `nextAllowedAt`. */
  maisAntigaEm: Date | null;
}

/**
 * Os knobs com os defaults deste arquivo. Número inválido (zero, negativo, NaN
 * vindo de um env digitado à mão) cai no padrão: um teto que aceita `0` viraria
 * "não responda nunca", e um `NaN` viraria "não compare nada" — os dois calariam
 * o atendimento por um erro de digitação.
 */
export function knobsDoTetoDeRespostas(
  parcial?: Partial<TetoDeRespostasKnobs> | null,
): TetoDeRespostasKnobs {
  const n = parcial?.porConversa;
  const w = parcial?.janelaMinutos;
  return {
    porConversa:
      typeof n === 'number' && Number.isFinite(n) && n >= 1
        ? Math.floor(n)
        : TETO_DE_RESPOSTAS_PADRAO,
    janelaMinutos:
      typeof w === 'number' && Number.isFinite(w) && w >= 1
        ? Math.floor(w)
        : JANELA_DO_TETO_DE_RESPOSTAS_MINUTOS_PADRAO,
  };
}

/**
 * Conta as respostas automáticas desta conversa na janela que termina em `now`.
 *
 * **Nunca lança.** Falha de leitura devolve `null`, e quem chama transforma isso
 * em `naJanela: null` → o gate passa com `skipped: 'nao_conferido'` (fail-open
 * COM registro). A alternativa — deixar o erro subir — derrubaria o turno por
 * causa de uma trava auxiliar: o cliente ficaria sem resposta e sem ninguém
 * sabendo por quê. A doutrina do repo para camada auxiliar é esta: falhar
 * aberto, e nunca em silêncio.
 */
export async function contarRespostasAutomaticas(
  db: Queryable,
  input: {
    organizationId: string;
    conversationId: string;
    now: Date;
    janelaMinutos: number;
  },
): Promise<{ naJanela: number; maisAntigaEm: Date | null } | null> {
  const desde = new Date(input.now.getTime() - input.janelaMinutos * MS_POR_MINUTO);
  try {
    const { rows } = await db.query<{ na_janela: number; mais_antiga: Date | string | null }>(
      `select count(*)::int as na_janela, min(m.sent_at) as mais_antiga
         from messages m
        where m.organization_id = $1
          and m.conversation_id = $2
          and m.direction = 'outbound'
          and m.sent_via = 'ai'
          and m.status <> 'failed'
          and m.sent_at >= $3`,
      [input.organizationId, input.conversationId, desde],
    );
    const linha = rows[0];
    const bruto = linha?.mais_antiga ?? null;
    // `min(m.sent_at)` chega em DUAS formas, como toda coluna de data lida do
    // banco: `Date` no driver `pg` (OID 1184) e string ISO no PostgREST/`jsonb`.
    // A normalização é a da borda canônica (`instanteDoBanco`, que já tem
    // cobertura no invariante `reguas-de-data-veem-o-date-do-driver`) — um
    // `instanceof Date` local seria uma SEGUNDA régua de transporte para a mesma
    // coluna. Hora ilegível vira `null`, e o veto sai sem horário em vez de
    // carregar um `Date` inválido para `nextAllowedAt`.
    const maisAntiga = instanteDoBanco(bruto);
    return {
      naJanela: linha?.na_janela ?? 0,
      maisAntigaEm: maisAntiga === null ? null : new Date(maisAntiga),
    };
  } catch {
    return null;
  }
}

/**
 * A leitura do turno, já no formato do contexto dos gates. `undefined` = o
 * chamador NÃO armou o teto (follow-up, resposta aprovada, template): o gate
 * fica no-op. Objeto com `naJanela: null` = armado, leitura falhou.
 */
export async function carregarRespostasDaConversa(
  db: Queryable,
  input: {
    organizationId: string;
    armado: TetoDeRespostasArmado;
    now: Date;
    log?: Logger;
  },
): Promise<RespostasDaConversa> {
  const { porConversa, janelaMinutos } = knobsDoTetoDeRespostas(input.armado);
  const contagem = await contarRespostasAutomaticas(db, {
    organizationId: input.organizationId,
    conversationId: input.armado.conversationId,
    now: input.now,
    janelaMinutos,
  });
  if (contagem === null) {
    // Uma linha por envio é caro num número movimentado; o evento é raro (banco
    // fora/DDL) e sem ele o "por que não barrou" ficaria invisível.
    input.log?.warn('teto de respostas por conversa: contagem não lida — envio segue', {
      conversation_id: input.armado.conversationId,
    });
    return { porConversa, janelaMinutos, naJanela: null, maisAntigaEm: null };
  }
  return { porConversa, janelaMinutos, ...contagem };
}

/**
 * O GATE. Puro/síncrono como os irmãos da cadeia: a contagem chega pronta no
 * contexto (lida sob o lock do número por `carregarRespostasDaConversa`).
 *
 * Três estados, e a diferença entre eles é o que a auditoria lê:
 *  - `ctx.tetoDeRespostas` AUSENTE   → não armado nesta tentativa (no-op, `pass`);
 *  - `naJanela === null`             → armado, leitura falhou (`pass` + `nao_conferido`);
 *  - `naJanela >= porConversa`       → VETO `teto_de_respostas`.
 */
export const tetoDeRespostasGate: Gate = {
  name: 'teto_de_respostas',
  evaluate(ctx: GateContext): GateVerdict {
    const estado = ctx.tetoDeRespostas;
    if (estado === undefined) return { pass: true };
    if (estado.naJanela === null) return { pass: true, skipped: 'nao_conferido' };
    if (estado.naJanela < estado.porConversa) return { pass: true };

    // O carimbo da mais antiga + a janela é quando a conta volta a caber. Sem ele
    // (min() nulo só aconteceria com contagem 0, impossível aqui) o veto sai sem
    // horário, e o chamador decide — melhor que inventar um instante.
    const nextAllowedAt =
      estado.maisAntigaEm === null
        ? undefined
        : new Date(estado.maisAntigaEm.getTime() + estado.janelaMinutos * MS_POR_MINUTO);

    return {
      pass: false,
      code: CODIGO_DO_TETO_DE_RESPOSTAS,
      // Texto de GENTE e do MODELO: diz o número, a janela e o que fazer. Um veto
      // que só nega faz o modelo reescrever a mesma frase — e o veredito não muda,
      // porque o problema é a contagem, não o texto.
      reason:
        `esta conversa já recebeu ${estado.naJanela} resposta(s) automática(s) em ` +
        `${estado.janelaMinutos} min (teto: ${estado.porConversa}). ` +
        'Não reescreva a mensagem — o limite é de quantidade, não de conteúdo. ' +
        'Encerre o turno e deixe a conversa para uma pessoa.',
      detail: {
        na_janela: estado.naJanela,
        teto: estado.porConversa,
        janela_minutos: estado.janelaMinutos,
      },
      ...(nextAllowedAt !== undefined ? { nextAllowedAt } : {}),
    };
  },
};

/** Título FIXO: é parte da chave do dedupe (`kind_ref_e_titulo`) — mudar o texto reabre avisos. */
export const TITULO_DO_AVISO_DO_TETO_DE_RESPOSTAS =
  'A IA parou de responder esta conversa: muitas respostas em pouco tempo';

/**
 * Avisa a equipe na Central que o teto vetou uma resposta nesta conversa.
 *
 * "Uma vez" = um aviso ABERTO por conversa: o dedupe `kind_ref_e_titulo` não
 * insere se já há um aberto com o mesmo kind, a mesma conversa e o mesmo título.
 * Cada veto seguinte do mesmo pingue-pongue cai nele. Se a equipe resolve o aviso
 * e o loop volta, abre-se outro — e é o certo: é um episódio novo.
 *
 * Kind `other` com ref `conversation` (o botão da Central leva a
 * /app/inbox/<id>), no molde de `lib/catalogo/retomada-de-apresentacao.ts`: não
 * precisa de kind novo nem de migration.
 *
 * **Nunca lança.** O veto já foi registrado (trace + timeline); o aviso é camada
 * auxiliar, e falhar nele não pode derrubar o turno.
 */
export async function avisarEquipeDoTetoDeRespostas(
  db: Queryable,
  input: {
    organizationId: string;
    conversationId: string;
    porConversa: number;
    janelaMinutos: number;
    log?: Logger;
  },
): Promise<void> {
  try {
    await insertInboxItem(
      db,
      input.organizationId,
      {
        kind: 'other',
        severity: 'warn',
        title: TITULO_DO_AVISO_DO_TETO_DE_RESPOSTAS,
        body:
          `A IA já mandou ${input.porConversa} respostas nesta conversa em ${input.janelaMinutos} min ` +
          'e parou de responder. Confira se do outro lado é um robô (atendimento automático) ' +
          'ou um cliente. Se for cliente, assuma a conversa.',
        refKind: 'conversation',
        refId: input.conversationId,
      },
      'kind_ref_e_titulo',
    );
  } catch (err) {
    input.log?.warn('teto de respostas por conversa: aviso na Central não gravado', {
      conversation_id: input.conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
