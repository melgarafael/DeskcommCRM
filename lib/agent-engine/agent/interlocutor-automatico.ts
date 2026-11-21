/**
 * INTERLOCUTOR AUTOMÁTICO — o outro lado é atendimento automático (#4590, item 2).
 *
 * ## O defeito que este arquivo mede
 *
 * Numa instalação self-host, o contato do outro lado era o atendimento automático
 * de um banco. A IA respondeu, o robô respondeu de volta, e os dois trocaram ~216
 * mensagens em uma hora, uma a cada ~18 s. O teto de respostas por conversa
 * (`agent/teto-de-respostas.ts`, item 1 da mesma issue) corta a CONTAGEM — ele é
 * a rede de segurança. Este gate é a detecção: quando as mensagens recebidas
 * têm cara de robô, a IA não entra na conversa, e a conversa é silenciada com
 * aviso na Central.
 *
 * ## O que ele NÃO duplica
 *
 *  - **Teto de respostas por conversa (item 1).** O teto conta quantas respostas
 *    a IA já mandou e veta na N-ésima; este gate olha o que o OUTRO lado mandou.
 *    Uma conversa pode ser barrada aqui na 2ª resposta (o teto só agiria na 21ª)
 *    e pode bater no teto sem nenhum sinal de robô do outro lado — são réguas
 *    independentes, e as duas continuam valendo.
 *  - **`spinning`.** Ele compara a candidata com as últimas cópias do NÚMERO,
 *    para pegar template em massa; aqui a leitura é das mensagens RECEBIDAS nesta
 *    conversa, e o molde é o do outro lado.
 *  - **`stop`/`force_human`.** O silêncio daqui é o mesmo mecanismo
 *    (`conversations.bot_silenced_until = 'infinity'`), mas o motivo é outro: o
 *    contato não pediu para sair, quem está do outro lado é um programa.
 *
 * ## Conservador por construção: três pistas e duas famílias
 *
 * Falso positivo aqui custa caro: uma loja que manda "1 - vendas / 2 - suporte"
 * é um cliente de verdade, e silenciar a conversa dela no primeiro menu é o
 * defeito que o mantenedor previu no comentário da issue. Por isso o gate exige
 * as DUAS condições ao mesmo tempo:
 *
 *  1. **pelo menos 3 pistas** na amostra — um menu sozinho nunca conta;
 *  2. **pelo menos 2 famílias distintas** de sinal (`menu`, `repeticao`,
 *     `molde`, `cadencia`, `molde_da_ia`) — um menu repetido já é anormal, mas
 *     ainda pode ser reenvio de rede; exige-se outra família
 *     (molde/repetição/cadência) para afirmar que é um programa.
 *
 * As cinco famílias, cada uma ancorada num sinal que o autor da issue mediu:
 *
 *  - `menu` — menu numerado (`1 - …` + `2 - …`) ou "digite/responda/escolha N";
 *  - `repeticao` — a MESMA mensagem recebida TRÊS vezes (texto idêntico depois
 *    de normalizar), com mínimo de 12 caracteres para "ok" não contar;
 *  - `molde` — 3+ mensagens recebidas com o mesmo começo (4 primeiras palavras)
 *    e tamanho parecido: é o "sempre com o mesmo molde" do relato;
 *  - `cadencia` — 3+ mensagens recebidas em sequência, cada uma a ≤ 30 s da
 *    anterior: robô responde em segundos, gente demora;
 *  - `molde_da_ia` — 3+ respostas da IA na mesma conversa com o mesmo molde: é
 *    o pingue-pongue já instalado, o retrato do incidente.
 *
 * ## Decisão de leitura: `messages`, sob o lock do número
 *
 * A amostra é a última dúzia de mensagens da conversa, lida pela mesma conexão
 * que já está sob `pg_advisory_xact_lock(hashtext(channel_session_id))` em
 * `runBeforeSend`. Nada de coluna nova, tabela nova ou migration: `messages` já
 * guarda direção, corpo e carimbo, e é a fonte que o resto do motor lê.
 *
 * ## Ao disparar
 *
 * O veto NÃO responde aquela mensagem; quem aplica os dois efeitos duráveis é o
 * turno (`inbound-turn.ts`), chamando `silenciarConversaPorInterlocutorAutomatico`:
 * aviso em `agent_inbox_items` (kind `other`, ref `conversation`) e depois
 * `conversations.bot_silenced_until = 'infinity'` com
 * `last_handoff_reason = 'interlocutor_automatico'`. O aviso vem PRIMEIRO e, se
 * ele não gravar, o silêncio não é aplicado — silêncio sem aviso é proibido.
 * A volta é a que já existe: "Devolver ao automático" na conversa.
 */
import type pg from 'pg';

import { instanteDoBanco } from '@/lib/tempo/agora';

import { insertInboxItem } from '../db/repository';
import type { Logger } from '../obs/logger';
import type { Gate, GateContext, GateVerdict } from '../guardrails/before-send';

type Queryable = Pick<pg.Pool, 'query'>;

/** Código do veto — rótulo fechado: vai ao modelo, ao log e a `before_send_traces`. */
export const CODIGO_DO_INTERLOCUTOR_AUTOMATICO = 'interlocutor_automatico';

/** Motivo gravado em `conversations.last_handoff_reason` ao silenciar. */
export const MOTIVO_DO_SILENCIO_DO_INTERLOCUTOR = 'interlocutor_automatico';

/** Quantas mensagens da conversa a leitura enxerga (as mais recentes). */
export const AMOSTRA_DE_MENSAGENS = 12;

/** Pistas mínimas para agir: um menu sozinho está a um passo de ser loja. */
export const MINIMO_DE_PISTAS = 3;

/** Famílias distintas mínimas: nenhuma família sozinha afirma "é um robô". */
export const MINIMO_DE_FAMILIAS = 2;

/** Abaixo disto o texto é curto demais para "repetir" significar algo ("ok", "sim"). */
export const MINIMO_PARA_REPETICAO = 12;
/**
 * Quantas vezes o MESMO texto precisa aparecer para contar como repetição.
 *
 * Três, não duas: uma duplicata pode ser reenvio de webhook, retry de rede ou
 * a mesma mensagem entregue duas vezes — e um turno de teste que reusa a mesma
 * fixture também produz exatamente duas. É a TERCEIRA que não se explica por
 * acidente. Este é o mínimo que evita o falso positivo mais barato de todos, e
 * o resto da régua (2 famílias) continua valendo.
 */
export const MINIMO_DE_REPETICOES = 3;

/** Abaixo disto o texto é curto demais para ter MOLDE (3+ saudações não são template). */
export const MINIMO_PARA_MOLDE = 24;

/** Grupo de molde: quantas mensagens com o mesmo começo e tamanho já são template. */
export const MINIMO_DO_GRUPO_DE_MOLDE = 3;

/** Intervalo máximo entre duas mensagens recebidas para a cadência contar. */
export const JANELA_DE_CADENCIA_MS = 30_000;

/** Mensagens em sequência, no intervalo acima, que já são cadência de robô. */
export const MINIMO_DE_CADENCIA = 3;

/** Respostas da IA com o mesmo molde que já retratam o pingue-pongue. */
export const MINIMO_DO_MOLDE_DA_IA = 3;

/** Tamanho máximo da diferença de comprimento dentro de um mesmo molde. */
const TOLERANCIA_DE_TAMANHO_NO_MOLDE = 0.35;

export type FamiliaDePista = 'menu' | 'repeticao' | 'molde' | 'cadencia' | 'molde_da_ia';

/** Uma linha da amostra — só o que a régua lê. */
export interface MensagemDaAmostra {
  direction: 'inbound' | 'outbound';
  body: string | null;
  sentAt: Date;
  sentVia: string | null;
}

/** O que o gate enxerga — ver `GateContext.interlocutorAutomatico`. */
export interface QuadroDoInterlocutor {
  /** `true` = a leitura falhou; o gate passa com `skipped: 'nao_conferido'`. */
  naoConferido: boolean;
  pistas: number;
  familias: readonly FamiliaDePista[];
  /** Quantas mensagens recebidas entraram na amostra (leitura humana do veredito). */
  recebidas: number;
}

/**
 * Normaliza para comparar: minúsculas, sem acento, espaço colapsado.
 *
 * Sem acento de propósito: o mesmo menu chega com "Opção" e "opcao" conforme o
 * canal, e duas grafias da MESMA mensagem não podem escapar da repetição.
 */
export function normalizarMensagem(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Menu numerado — os dois formatos que o relato cita.
 *
 *  - lista numerada de verdade: uma linha começando em `1` e outra em `2`
 *    (`1 - vendas`, `1) suporte`, `1. financeiro`);
 *  - instrução explícita: "digite 1", "responda com 2", "escolha 1".
 *
 * "1 - vendas" sozinho NÃO casa: o padrão exige as duas linhas. É o corte que
 * impede a loja legítima de ser marcada pelo primeiro menu.
 */
export function ehMenuNumerado(texto: string): boolean {
  const t = normalizarMensagem(texto);
  if (t.length === 0) return false;
  const linhas = texto
    .split('\n')
    .map((l) => normalizarMensagem(l))
    .filter((l) => l.length > 0);
  const temUm = linhas.some((l) => /^1\s*[-–).:]\s*\S/.test(l));
  const temDois = linhas.some((l) => /^2\s*[-–).:]\s*\S/.test(l));
  const instrucao = /\b(digite|responda|envie|escolha|tecle|selecione|informe)\b[^.!?\n]{0,20}\b\d{1,2}\b/.test(
    t,
  );
  return (temUm && temDois) || instrucao;
}

/** As `n` primeiras palavras da mensagem normalizada. */
function primeirasPalavras(texto: string, n: number): string {
  return normalizarMensagem(texto).split(' ').slice(0, n).join(' ');
}

/**
 * Duas mensagens no MESMO molde: começam igual (4 primeiras palavras) e têm
 * tamanho parecido.
 *
 * O tamanho entra porque menu de banco varia só no número/valor: começo igual
 * com tamanho muito diferente é texto humano sobre o mesmo assunto, não template.
 */
export function mesmoMolde(a: string, b: string): boolean {
  const na = normalizarMensagem(a);
  const nb = normalizarMensagem(b);
  if (Math.min(na.length, nb.length) < MINIMO_PARA_MOLDE) return false;
  if (primeirasPalavras(na, 4) !== primeirasPalavras(nb, 4)) return false;
  const maior = Math.max(na.length, nb.length);
  return Math.abs(na.length - nb.length) / maior <= TOLERANCIA_DE_TAMANHO_NO_MOLDE;
}

/**
 * A régua, PURA. Recebe a amostra em ordem cronológica e devolve as pistas.
 *
 * Conta cada mensagem recebida suspeita UMA vez, e soma 1 se as respostas da IA
 * também estão no mesmo molde. `dispara` exige as duas condições do cabeçalho —
 * `pistas >= MINIMO_DE_PISTAS` E `familias >= MINIMO_DE_FAMILIAS`.
 */
export function avaliarInterlocutor(
  mensagens: readonly MensagemDaAmostra[],
): { pistas: number; familias: FamiliaDePista[] } {
  const recebidas = mensagens.filter(
    (m) => m.direction === 'inbound' && m.body !== null && normalizarMensagem(m.body).length > 0,
  );
  const familias = new Set<FamiliaDePista>();
  const suspeitas = new Set<number>();

  // ── repetição: quantas vezes o MESMO texto normalizado aparece ──────────────
  const porTexto = new Map<string, number[]>();
  recebidas.forEach((m, i) => {
    const t = normalizarMensagem(m.body ?? '');
    if (t.length < MINIMO_PARA_REPETICAO) return;
    const lista = porTexto.get(t) ?? [];
    lista.push(i);
    porTexto.set(t, lista);
  });
  for (const indices of porTexto.values()) {
    if (indices.length >= MINIMO_DE_REPETICOES) {
      familias.add('repeticao');
      indices.forEach((i) => suspeitas.add(i));
    }
  }

  // ── molde: grupos de 3+ mensagens com o mesmo começo e tamanho parecido ─────
  const grupos: number[][] = [];
  const jaAgrupadas = new Set<number>();
  recebidas.forEach((m, i) => {
    if (jaAgrupadas.has(i) || (m.body ?? '').length === 0) return;
    const grupo = [i];
    recebidas.forEach((outra, j) => {
      if (j <= i || jaAgrupadas.has(j)) return;
      if (mesmoMolde(m.body ?? '', outra.body ?? '')) grupo.push(j);
    });
    if (grupo.length >= MINIMO_DO_GRUPO_DE_MOLDE) {
      grupo.forEach((k) => jaAgrupadas.add(k));
      grupos.push(grupo);
    }
  });
  for (const grupo of grupos) {
    familias.add('molde');
    grupo.forEach((i) => suspeitas.add(i));
  }

  // ── menu numerado ──────────────────────────────────────────────────────────
  recebidas.forEach((m, i) => {
    if (ehMenuNumerado(m.body ?? '')) {
      familias.add('menu');
      suspeitas.add(i);
    }
  });

  // ── cadência: 3+ recebidas em sequência, cada uma a ≤30 s da anterior ───────
  let sequencia = 1;
  for (let i = 1; i < recebidas.length; i += 1) {
    const anterior = recebidas[i - 1];
    const atual = recebidas[i];
    if (
      anterior !== undefined &&
      atual !== undefined &&
      atual.sentAt.getTime() - anterior.sentAt.getTime() <= JANELA_DE_CADENCIA_MS
    ) {
      sequencia += 1;
      if (sequencia >= MINIMO_DE_CADENCIA) {
        familias.add('cadencia');
        for (let k = i - sequencia + 1; k <= i; k += 1) suspeitas.add(k);
      }
    } else {
      sequencia = 1;
    }
  }

  let pistas = suspeitas.size;

  // ── molde da IA: o pingue-pongue já instalado ──────────────────────────────
  const respostasDaIa = mensagens.filter(
    (m) => m.direction === 'outbound' && m.sentVia === 'ai' && (m.body ?? '').length > 0,
  );
  const gruposDaIa: number[][] = [];
  const iaAgrupada = new Set<number>();
  respostasDaIa.forEach((m, i) => {
    if (iaAgrupada.has(i)) return;
    const grupo = [i];
    respostasDaIa.forEach((outra, j) => {
      if (j <= i || iaAgrupada.has(j)) return;
      if (mesmoMolde(m.body ?? '', outra.body ?? '')) grupo.push(j);
    });
    if (grupo.length >= MINIMO_DO_MOLDE_DA_IA) {
      grupo.forEach((k) => iaAgrupada.add(k));
      gruposDaIa.push(grupo);
    }
  });
  if (gruposDaIa.length > 0) {
    familias.add('molde_da_ia');
    pistas += 1;
  }

  return { pistas, familias: [...familias] };
}

/** O veredito de disparo — uma função só, para gate e teste não divergirem. */
export function interlocutorEhAutomatico(quadro: {
  pistas: number;
  familias: readonly FamiliaDePista[];
}): boolean {
  return quadro.pistas >= MINIMO_DE_PISTAS && quadro.familias.length >= MINIMO_DE_FAMILIAS;
}

/**
 * Lê a amostra da conversa. **Nunca lança** — falha vira `naoConferido`, e o
 * gate passa com `skipped: 'nao_conferido'`: trava auxiliar não derruba turno.
 */
export async function carregarQuadroDoInterlocutor(
  db: Queryable,
  input: {
    organizationId: string;
    conversationId: string;
    log?: Logger;
  },
): Promise<QuadroDoInterlocutor> {
  try {
    const { rows } = await db.query<{
      direction: string;
      body: string | null;
      sent_at: Date | string;
      sent_via: string | null;
    }>(
      `select m.direction, m.body, m.sent_at, m.sent_via
         from messages m
        where m.organization_id = $1
          and m.conversation_id = $2
          and m.body is not null
          and m.body <> ''
        order by m.sent_at desc
        limit $3`,
      [input.organizationId, input.conversationId, AMOSTRA_DE_MENSAGENS],
    );
    // A consulta vem do mais novo para o mais velho (o índice que existe); a
    // régua lê em ordem cronológica — a cadência depende disso.
    //
    // O carimbo passa pela borda canônica (`instanteDoBanco`, a régua ÚNICA do
    // repo para as duas formas em que a coluna chega: `Date` do driver e string
    // ISO do PostgREST/jsonb). Um `instanceof Date` local seria uma SEGUNDA régua
    // para a mesma coluna — e o invariante
    // `reguas-de-data-veem-o-date-do-driver` cobra exatamente isso. Carimbo
    // ilegível fica FORA da amostra: inventar cadência com hora inválida seria
    // pior que não ver a mensagem.
    const amostra: MensagemDaAmostra[] = [];
    for (const r of rows) {
      const instante = instanteDoBanco(r.sent_at);
      if (instante === null) continue;
      amostra.push({
        direction: r.direction === 'inbound' ? 'inbound' : 'outbound',
        body: r.body,
        sentAt: new Date(instante),
        sentVia: r.sent_via ?? null,
      });
    }
    amostra.reverse();
    const { pistas, familias } = avaliarInterlocutor(amostra);
    return {
      naoConferido: false,
      pistas,
      familias,
      recebidas: amostra.filter((m) => m.direction === 'inbound').length,
    };
  } catch (err) {
    input.log?.warn('interlocutor automático: amostra da conversa não lida — envio segue', {
      conversation_id: input.conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { naoConferido: true, pistas: 0, familias: [], recebidas: 0 };
  }
}

/**
 * O GATE. Puro/síncrono como os irmãos: a amostra chega pronta no contexto (lida
 * sob o lock do número). Três estados:
 *  - `ctx.interlocutorAutomatico` AUSENTE → não armado nesta tentativa (no-op);
 *  - `naoConferido`                      → armado, leitura falhou (`pass` + `nao_conferido`);
 *  - abaixo do limiar                    → `pass` (conversa humana normal);
 *  - no limiar                           → VETO `interlocutor_automatico`.
 */
export const interlocutorAutomaticoGate: Gate = {
  name: 'interlocutor_automatico',
  evaluate(ctx: GateContext): GateVerdict {
    const quadro = ctx.interlocutorAutomatico;
    if (quadro === undefined) return { pass: true };
    if (quadro.naoConferido) return { pass: true, skipped: 'nao_conferido' };
    if (!interlocutorEhAutomatico(quadro)) return { pass: true };

    return {
      pass: false,
      code: CODIGO_DO_INTERLOCUTOR_AUTOMATICO,
      // Texto de GENTE e do MODELO: diz o que foi visto e o que fazer. Veto que
      // só nega faz o modelo reescrever a mesma resposta — e o outro lado
      // continua sendo um robô, então o veredito não mudaria.
      reason:
        'do outro lado parece um ATENDIMENTO AUTOMÁTICO: as mensagens recebidas têm menu ' +
        'numerado, repetição, o mesmo molde ou cadência de robô. Não responda e não reescreva ' +
        'esta mensagem — a conversa foi marcada para uma pessoa conferir. Encerre o turno.',
      detail: {
        pistas: quadro.pistas,
        familias: quadro.familias.join(','),
        recebidas: quadro.recebidas,
      },
    };
  },
};

/** Título FIXO: é parte da chave do dedupe (`kind_ref_e_titulo`) — mudar o texto reabre avisos. */
export const TITULO_DO_AVISO_DO_INTERLOCUTOR_AUTOMATICO =
  'A IA parou: do outro lado parece atendimento automático';

/**
 * Avisa a equipe na Central que esta conversa tem um interlocutor automático.
 *
 * Kind `other` com ref `conversation`, no molde do aviso do teto de respostas
 * (`agent/teto-de-respostas.ts`) — o botão da Central leva a /app/inbox/<id>, e
 * não é preciso kind novo nem migration.
 *
 * **Nunca lança.** Devolve `false` quando não gravou, e quem chama NÃO silencia
 * nesse caso: silêncio sem aviso é proibido.
 */
export async function avisarEquipeDoInterlocutorAutomatico(
  db: Queryable,
  input: {
    organizationId: string;
    conversationId: string;
    pistas: number;
    familias: readonly FamiliaDePista[];
    log?: Logger;
  },
): Promise<boolean> {
  try {
    await insertInboxItem(
      db,
      input.organizationId,
      {
        kind: 'other',
        severity: 'warn',
        title: TITULO_DO_AVISO_DO_INTERLOCUTOR_AUTOMATICO,
        body:
          'As mensagens recebidas nesta conversa têm sinais de atendimento automático ' +
          `(${input.pistas} pistas: ${input.familias.join(', ') || 'sem família'}). ` +
          'A IA parou de responder e a conversa foi silenciada. Confira se do outro lado é um ' +
          'robô; se for um cliente, use "Devolver ao automático" para a IA voltar.',
        refKind: 'conversation',
        refId: input.conversationId,
      },
      'kind_ref_e_titulo',
    );
    return true;
  } catch (err) {
    input.log?.warn('interlocutor automático: aviso na Central não gravado', {
      conversation_id: input.conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Aplica os efeitos duráveis do veto: aviso na Central e, SÓ depois dele,
 * silêncio da conversa pelo mecanismo que já existe
 * (`conversations.bot_silenced_until = 'infinity'` + `last_handoff_reason`).
 *
 * Sem coluna nova: a conversa volta com "Devolver ao automático", o mesmo
 * caminho humano de sempre. `contacts.force_human` NÃO é tocado — este gate é
 * heurística, e uma heurística não pode marcar o contato como "sempre humano".
 *
 * **Nunca lança.**
 */
export async function silenciarConversaPorInterlocutorAutomatico(
  db: Queryable,
  input: {
    organizationId: string;
    conversationId: string;
    pistas: number;
    familias: readonly FamiliaDePista[];
    log?: Logger;
  },
): Promise<{ avisado: boolean; silenciada: boolean }> {
  const avisado = await avisarEquipeDoInterlocutorAutomatico(db, input);
  if (!avisado) {
    input.log?.warn('interlocutor automático: sem aviso na Central — silêncio NÃO aplicado', {
      conversation_id: input.conversationId,
    });
    return { avisado: false, silenciada: false };
  }
  try {
    await db.query(
      `update conversations
          set bot_silenced_until = 'infinity',
              last_handoff_reason = $3
        where organization_id = $1 and id = $2`,
      [input.organizationId, input.conversationId, MOTIVO_DO_SILENCIO_DO_INTERLOCUTOR],
    );
    return { avisado: true, silenciada: true };
  } catch (err) {
    input.log?.warn('interlocutor automático: conversa não silenciada (aviso já gravado)', {
      conversation_id: input.conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { avisado: true, silenciada: false };
  }
}
