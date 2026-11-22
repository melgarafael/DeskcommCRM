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
 * ## Os limites deste arquivo, de propósito
 *
 *  - **Silencia a conversa com HORIZONTE, e nunca com `'infinity'`.** O veto
 *    sozinho já impede a resposta de sair, mas o pingue-pongue continuaria
 *    abrindo turno (e gastando modelo) a cada mensagem do outro robô. Ao bater o
 *    teto, a conversa é pausada em `conversations.bot_silenced_until` — a MESMA
 *    coluna que o botão de pausar do atendente usa, então ele devolve para a IA
 *    quando quiser, sem SQL. `'infinity'` continua reservado ao handoff, que é
 *    decisão humana; e `silenciarConversaPeloTeto` não encurta silêncio maior.
 *    A equipe também é AVISADA na Central (`avisarEquipeDoTetoDeRespostas`) —
 *    a pausa não substitui o aviso.
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

// ─── O TETO POR ORGANIZAÇÃO, E O SILÊNCIO QUE ELE DEIXA ─────────────────────
//
// Até aqui os dois números vinham do env da INSTALAÇÃO
// (`TETO_DE_RESPOSTAS_POR_CONVERSA` / `TETO_DE_RESPOSTAS_JANELA_MIN`), um valor
// para todo mundo que roda na mesma máquina. Numa instalação self-host com mais
// de uma empresa, isso obriga uma decisão de negócio (quanto é "conversa demais"
// no atendimento DELA) a ser tomada mexendo em arquivo de servidor e
// reiniciando o worker. A chave passa a morar em
// `organizations.settings.anti_ban.teto_de_respostas` — o mesmo jsonb que já
// guarda `crm`, `llm` e `voz`, sem coluna nova e sem migration: organização que
// nunca configurou lê `null` e cai no padrão conservador (20 em 60 min).
//
// O env NÃO morre: ele continua sendo o padrão da instalação e o piso de quem
// não configurou nada, que é o que mantém instalações existentes idênticas às de
// hoje.

/** Chave dentro de `organizations.settings.anti_ban`. */
export const CHAVE_DO_TETO_NO_ANTI_BAN = 'teto_de_respostas';

/**
 * Silêncio padrão ao bater o teto, em minutos — a MESMA largura da janela, para
 * o pingue-pongue não voltar no minuto seguinte.
 *
 * O silêncio é LIMITADO e nunca `'infinity'`: é o `conversations.bot_silenced_until`
 * que o atendente liga e desliga na conversa (o mesmo que `pause-ai` grava), então
 * quem discorda da pausa devolve o atendimento à IA em um clique. `'infinity'` é
 * o silêncio do HANDOFF — durável por decisão humana —, e o teto não pode se
 * apropriar dele para uma decisão automática.
 *
 * `0` desliga o silêncio: o veto continua (a resposta não sai) e o aviso na
 * Central continua abrindo; o que não acontece é a pausa da conversa.
 */
export const SILENCIO_DO_TETO_DE_RESPOSTAS_MINUTOS_PADRAO = 60;

/** Teto de sanidade do silêncio: 24 h. Acima disso é `'infinity'` disfarçado. */
export const SILENCIO_DO_TETO_DE_RESPOSTAS_MINUTOS_MAXIMO = 1_440;

/** O que a organização pode ajustar — o N, a janela e o silêncio. */
export interface TetoDeRespostasDaOrganizacao extends TetoDeRespostasKnobs {
  /** Minutos de silêncio ao bater o teto. `0` = não silencia (só veta e avisa). */
  silenciarMinutos: number;
}

/** Objeto jsonb, ou `null` para qualquer outra coisa (jsonb é escrito à mão). */
function objetoJson(valor: unknown): Record<string, unknown> | null {
  if (valor === null || typeof valor !== 'object' || Array.isArray(valor)) return null;
  return valor as Record<string, unknown>;
}

/** Número inteiro de um campo jsonb — `null` para ausência, texto, NaN. */
function numeroJson(valor: unknown): number | null {
  const n = typeof valor === 'number' ? valor : typeof valor === 'string' ? Number(valor) : NaN;
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/**
 * Lê a subárvore `teto_de_respostas` do Anti-ban.
 *
 * Trata jsonb torto como AUSÊNCIA de cada campo, não do bloco inteiro: quem
 * gravou só `janela_minutos` mantém o N do padrão. Campo inválido nunca vira
 * teto — um `0` de digitação viraria "não responda nunca", e é justamente o
 * desfecho que este arquivo existe para não causar por acidente.
 */
export function lerTetoDoAntiBan(
  valor: unknown,
  base?: Partial<TetoDeRespostasKnobs> | null,
): TetoDeRespostasDaOrganizacao {
  const bruto = objetoJson(valor);
  const padrao = knobsDoTetoDeRespostas(base);
  const n = numeroJson(bruto?.por_conversa);
  const w = numeroJson(bruto?.janela_minutos);
  const s = numeroJson(bruto?.silenciar_minutos);
  const janelaMinutos = w !== null && w >= 1 ? w : padrao.janelaMinutos;
  return {
    porConversa: n !== null && n >= 1 ? n : padrao.porConversa,
    janelaMinutos,
    // O silêncio padrão acompanha a JANELA da organização (a pausa não pode ser
    // maior que o período em que o pingue-pongue foi medido), limitado a 1 h.
    silenciarMinutos:
      s !== null && s >= 0
        ? Math.min(s, SILENCIO_DO_TETO_DE_RESPOSTAS_MINUTOS_MAXIMO)
        : Math.min(janelaMinutos, SILENCIO_DO_TETO_DE_RESPOSTAS_MINUTOS_PADRAO),
  };
}

/** O mesmo, a partir do `organizations.settings` inteiro (leitura de tela). */
export function tetoDeRespostasDasSettings(
  settings: unknown,
  base?: Partial<TetoDeRespostasKnobs> | null,
): TetoDeRespostasDaOrganizacao {
  const antiBan = objetoJson(objetoJson(settings)?.anti_ban);
  return lerTetoDoAntiBan(antiBan?.[CHAVE_DO_TETO_NO_ANTI_BAN], base);
}

/**
 * Os números que valem para ESTA organização — a leitura que o turno faz.
 *
 * Custo no caminho quente: UMA linha por chave primária
 * (`where id = $1` em `organizations`) e só o caminho jsonb, não o `settings`
 * inteiro (que carrega marca, `llm`, política de MFA). Não é varredura de
 * `organizations`, e não toca `messages`: a contagem — essa sim, a consulta
 * quente — continua sendo a do índice `idx_messages_conversation_sent`.
 *
 * **Nunca lança.** Organização com `settings` ilegível ou banco fora cai no
 * padrão da instalação, com uma linha de log: um teto auxiliar não derruba
 * turno (mesma doutrina de `contarRespostasAutomaticas`).
 */
export async function resolverTetoDeRespostasDaOrganizacao(
  db: Queryable,
  input: {
    organizationId: string;
    base?: Partial<TetoDeRespostasKnobs> | null;
    log?: Logger;
  },
): Promise<TetoDeRespostasDaOrganizacao> {
  const padrao = lerTetoDoAntiBan(null, input.base);
  try {
    const { rows } = await db.query<{ teto: unknown }>(
      `select settings -> 'anti_ban' -> $2 as teto
         from organizations
        where id = $1`,
      [input.organizationId, CHAVE_DO_TETO_NO_ANTI_BAN],
    );
    return lerTetoDoAntiBan(rows[0]?.teto, input.base);
  } catch (err) {
    input.log?.warn('teto de respostas por conversa: configuração da organização não lida — vale o padrão', {
      organization_id: input.organizationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return padrao;
  }
}

/** Motivo gravado em `conversations.last_handoff_reason` ao silenciar pelo teto. */
export const MOTIVO_DO_SILENCIO_PELO_TETO =
  'Teto de respostas automáticas por conversa';

/**
 * Silencia a conversa pelo caminho que o atendente já usa: a coluna
 * `conversations.bot_silenced_until`, que os guards do motor leem e que o botão
 * "Devolver para a IA" (`reactivate-bot`) limpa.
 *
 * Duas escolhas que não são detalhe:
 *
 *  - **Horizonte, nunca `'infinity'`.** `'infinity'` é o silêncio do handoff,
 *    decidido por uma pessoa; uma trava automática que o gravasse tiraria do
 *    atendente a única forma de discordar sem SQL.
 *  - **Não encurta silêncio maior.** O `where` só casa quando o silêncio atual é
 *    nulo ou termina ANTES do novo alvo — então um `'infinity'` de handoff (ou
 *    uma pausa mais longa do operador) continua de pé. Trava automática não
 *    desfaz decisão humana, e não tem como "estender para sempre" por repetição:
 *    cada veto grava o mesmo horizonte.
 *
 * **Nunca lança.** Devolve `true` quando a linha mudou. O veto e o aviso já
 * aconteceram; falhar aqui não pode derrubar o turno.
 */
export async function silenciarConversaPeloTeto(
  db: Queryable,
  input: {
    organizationId: string;
    conversationId: string;
    minutos: number;
    log?: Logger;
  },
): Promise<boolean> {
  if (!(input.minutos > 0)) return false;
  const minutos = Math.min(
    Math.floor(input.minutos),
    SILENCIO_DO_TETO_DE_RESPOSTAS_MINUTOS_MAXIMO,
  );
  try {
    const { rows } = await db.query<{ id: string }>(
      `update conversations
          set bot_silenced_until = now() + make_interval(mins => $3::int),
              last_handoff_reason = $4
        where id = $1
          and organization_id = $2
          and (bot_silenced_until is null
               or bot_silenced_until < now() + make_interval(mins => $3::int))
      returning id`,
      [input.conversationId, input.organizationId, minutos, MOTIVO_DO_SILENCIO_PELO_TETO],
    );
    return rows.length > 0;
  } catch (err) {
    input.log?.warn('teto de respostas por conversa: conversa não silenciada', {
      conversation_id: input.conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

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
