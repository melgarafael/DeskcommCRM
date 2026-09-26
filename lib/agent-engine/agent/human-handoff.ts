import { guardServiceEffect } from "@/lib/atendimento/fronteira-server";
/**
 * Handoff humano como cidadão de 1ª classe (F4-06; blueprint 5.5 — escalação humana
 * clara e imediata é EXIGÊNCIA fiscalizada da Meta, não fallback). Dois gatilhos, uma
 * ação idempotente:
 *   1. DETERMINÍSTICO — regex PT-BR na última mensagem do lead ("falar com atendente",
 *      "quero falar com uma pessoa"…). Roda no runtime ANTES do modelo: o turno não gasta
 *      LLM. Ele AVISA o lead (texto de código, `avisarLeadDaEscalacao`) e só então silencia
 *      — nesta ordem, porque `force_human` arma o `stopGate` e mata todo envio posterior.
 *   2. TOOL request_human_handoff — o modelo aciona quando percebe o limite da automação.
 *
 * A ação (performHumanHandoff), idempotente e at-least-once — TUDO no mesmo banco agora
 * (a fusão matou o transporte MCP):
 *   (a) FONTE DA VERDADE: contacts.force_human=true — irrevogável (regra dura 2);
 *   (b) conversa: status transiciona SÓ 'ai_handling'→'pending' (CASE — nunca pisa em
 *       claimed/closed) + bot_silenced_until='infinity' + last_handoff_at/reason;
 *   (c) cancela os crons PENDENTES do lead (follow-ups agendados não disparam após handoff);
 *   (c2) grava a LINHA DE FATO em passagens_de_atendimento — o porquê, o que a IA
 *        já tentou, o que o cliente quer e as palavras literais dele. Sem dedup:
 *        uma passagem é uma passagem;
 *   (d) cria/enriquece agent_inbox_items(kind='handoff', ref_kind='conversation')
 *        com o corpo CURTO — o contexto mora na passagem, não no aviso.
 *
 * tenant/lead/conversation vêm da ROW do job (closure do run), NUNCA do payload (regra dura 1).
 * O contexto vai à passagem (é PARA o humano assumir) — mas NUNCA a log (PII fora de log, regra 8).
 */
import { z } from 'zod';
import type pg from 'pg';

import { expectativaDeAtendimento } from '@/lib/escalacao/disponibilidade';
import {
  montarBriefingDaPassagem,
  type BriefingDaPassagem,
  type CheckpointParaBriefing,
} from '@/lib/escalacao/briefing-da-passagem';
import {
  corpoCurtoDoAviso,
  linhaDoAvisoAoCliente,
  registrarPassagem,
  type DesfechoDoAvisoDaPassagem,
  type MotivoDaPassagem,
  type OrigemDaPassagem,
} from '@/lib/escalacao/passagem';
import { traduzir } from '@/lib/i18n/dicionario';
import { normalizarIdioma, type Idioma } from '@/lib/i18n/idiomas';
import { ehOptOutProvavel } from '@/lib/opt-out/deteccao';
import { emitAgentActivityForContact } from '@/lib/leads/agent-activity';

import type { DesfechoDoAviso } from './aviso-de-escalacao';

import type { Logger } from '../obs/logger';
import { cancelPendingCronsForLead } from '../cron/scheduler';
import { findForbiddenKey, zodIssuesSummary } from './lead-state';
import type { DeclaracaoDoTurno } from './declaracao';

/** Postgres `infinity`: o bot nunca reassume após handoff. */
const SILENCE_INFINITY = 'infinity';

/**
 * Normaliza para a detecção determinística: minúsculas + sem acento (NFD) — os padrões
 * abaixo são escritos sem acento, então "atendente"/"consultor" casam com/sem diacrítico.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '');
}

/**
 * Padrões PT-BR CONSERVADORES de pedido explícito de atendimento humano (evita falso
 * positivo: exige o verbo de contato + o alvo humano, ou expressões inequívocas). Rodam
 * sobre o texto normalizado (sem acento).
 */
const HUMAN_HANDOFF_PATTERNS: readonly RegExp[] = [
  /\b(?:falar|conversar)\s+com\s+(?:um[a]?\s+)?(?:atendente|humano|pessoa|gente|consultor|vendedor|representante|responsavel)\b/,
  /\bme\s+(?:passa|passe|transfere|transfira|encaminha|encaminhe|manda|mande)\s+(?:pra|para|pro)\s+(?:um[a]?\s+)?(?:atendente|humano|pessoa|gente|setor|comercial)\b/,
  /\batendimento\s+humano\b/,
  /\b(?:atendente|humano|pessoa)\s+de\s+verdade\b/,
];

/** True se a mensagem do lead é um pedido explícito de atendimento humano (determinístico). */
export function detectHumanHandoffRequest(message: string): boolean {
  if (message.trim() === '') return false;
  const normalized = normalize(message);
  return HUMAN_HANDOFF_PATTERNS.some((re) => re.test(normalized));
}


/**
 * True se a última mensagem do lead SUGERE opt-out. A regra mora em
 * `lib/opt-out/deteccao.ts` — a MESMA que a ingestão usa para gravar o bloqueio,
 * e é o ponto: enquanto eram duas, o runtime era o lado calibrado e a ingestão
 * bloqueava paciente que só perguntou como parar a dor.
 *
 * Aqui vale o nível PROVÁVEL (inequívoco + ambíguo), e não o inequívoco: este
 * sinal só para de responder e escala à inbox — não silencia ninguém para
 * sempre. Quem tem esse poder é a pessoa que confirma o bloqueio no CRM.
 */
export function detectAmbiguousOptOut(message: string): boolean {
  return ehOptOutProvavel(message);
}

/**
 * NO-OP de runs futuros (acceptance 2): o lead está em handoff quando force_human está
 * setado no contato OU alguma conversa dele ainda está silenciada (bot_silenced_until no
 * futuro — 'infinity' sempre vale). Lido no INÍCIO do turno, antes de qualquer chamada
 * de modelo. Só o humano (via CRM) libera.
 */
export async function isLeadInHandoff(db: pg.Pool, tenantId: string, leadId: string): Promise<boolean> {
  const { rows } = await db.query<{ handoff: boolean }>(
    `select (
       c.force_human
       or exists (
         select 1 from conversations v
         where v.organization_id = $1 and v.contact_id = c.id
           and v.bot_silenced_until is not null and v.bot_silenced_until > now()
       )
     ) as handoff
     from contacts c
     where c.organization_id = $1 and c.id = $2`,
    [tenantId, leadId],
  );
  return rows[0]?.handoff === true;
}

export interface HandoffIds {
  tenantId: string;
  leadId: string;
  /** conversations.id — a conversa que transiciona para a fila humana. */
  conversationId: string;
}

/**
 * Executa o handoff (idempotente, at-least-once) — tudo no banco do CRM, sem transporte.
 * Re-executar no mesmo episódio é no-op semântico: force_human/silêncio já setados, o
 * CASE do status não pisa em estado humano (claimed/closed) e o inbox deduplica.
 */
export async function performHumanHandoff(
  db: pg.Pool,
  ids: HandoffIds,
  opts: {
    reason: string;
    conversationSummary: string;
    inboxTitle?: string;
    /**
     * Os fatos da passagem, para a LINHA de `passagens_de_atendimento`.
     *
     * OPCIONAL, e é escolha: `tests/invariants/escalacao-ciclo-humano.test.ts` é
     * arquivo congelado e chama esta função com a assinatura antiga. Torná-lo
     * obrigatório forçaria um bypass de invariante que esta entrega não precisa.
     * Ausente = nenhuma linha é gravada, e o chamador é um caminho que ainda não
     * declara a sua origem (hoje, só o harness de teste).
     */
    passagem?: {
      origem: OrigemDaPassagem;
      motivoCodigo: MotivoDaPassagem;
      /** O briefing montado por `montarBriefingDaPassagem`. */
      briefing: BriefingDaPassagem;
      casoId?: string | null;
      /** O idioma da ORGANIZAÇÃO, quando o chamador já o tem. Default: pt-BR. */
      idioma?: Idioma;
    };
    /**
     * O desfecho do aviso que o chamador mandou ao lead ANTES desta passagem
     * (`avisarLeadDaEscalacao`). Opcional porque nem todo chamador é o motor de
     * conversa — o "Assumir eu" de um caso é acionado por uma pessoa que já está
     * na conversa e fala por si.
     *
     * Quando presente, ele vira LINHA no aviso da Central. A pergunta que o
     * atendente faz ao abrir a conversa é "essa pessoa sabe que estou vindo?", e
     * a resposta muda a primeira frase que ele digita. Falhar fechado na ação,
     * aberto na informação.
     */
    avisoAoLead?: DesfechoDoAviso;
    log: Logger;
  },
): Promise<void> {
  // (a) FONTE DA VERDADE: force_human no contato — irrevogável pelo agente (regra dura 2).
  await guardServiceEffect();
  await db.query(`update contacts set force_human = true where organization_id = $1 and id = $2`, [
    ids.tenantId,
    ids.leadId,
  ]);

  // (b) Conversa: silencia o bot para sempre e devolve à fila humana. O status SÓ
  // transiciona 'ai_handling'→'pending' — conversa já claimed/closed/pending fica como
  // está (nunca rouba do humano nem reabre encerrada). Fase 3: junto, zera a aderência
  // ao agente do router — se o bot for reativado, o router decide de novo (não reassume
  // o mesmo agente por inércia).
  await guardServiceEffect();
  await db.query(
    `update conversations
        set status = case when status = 'ai_handling' then 'pending' else status end,
            bot_silenced_until = $3,
            last_handoff_at = now(),
            last_handoff_reason = $4,
            active_ai_agent_id = null,
            active_intent = null,
            active_agent_set_at = null
      where organization_id = $1 and id = $2`,
    [ids.tenantId, ids.conversationId, SILENCE_INFINITY, opts.reason],
  );

  // (c) Cancela os crons PENDENTES do lead (follow-ups agendados — F3-01/02). Idempotente,
  // via o cancel compartilhado (mesma garantia que o opt-out irrevogável usa — F4-07).
  await guardServiceEffect();
  await cancelPendingCronsForLead(db, ids.tenantId, ids.leadId);

  // (c2) A LINHA DE FATO. Vem antes do aviso porque o aviso REMETE a ela: o
  // corpo da Central diz "abra a conversa para ver o contexto", e o contexto é
  // esta linha. Não deduplica — uma passagem é uma passagem, e duas seguidas são
  // dois fatos; quem deduplica é o aviso, que é alerta e não registro.
  //
  // Dentro do guard de fronteira como os quatro efeitos acima: escrita fora dele
  // pode gravar sobre um atendimento que já trocou de mãos.
  if (opts.passagem !== undefined) {
    await guardServiceEffect();
    const gravou = await registrarPassagem(db, {
      organizationId: ids.tenantId,
      contactId: ids.leadId,
      conversationId: ids.conversationId,
      casoId: opts.passagem.casoId ?? null,
      motor: 'engine',
      origem: opts.passagem.origem,
      motivoCodigo: opts.passagem.motivoCodigo,
      briefing: opts.passagem.briefing,
      ...(opts.avisoAoLead !== undefined ? { aviso: desfechoDaPassagem(opts.avisoAoLead) } : {}),
    });
    // Falhar fechado na AÇÃO, aberto na INFORMAÇÃO: a passagem já aconteceu
    // (force_human gravado, conversa fora do automático). Derrubar o turno aqui
    // replicaria tudo no retry. O erro não some — ele vira log, e o aviso da
    // Central abaixo sai do mesmo jeito.
    if (!gravou.gravada) {
      opts.log.warn('passagem não registrada — o aviso sai, o contexto não', { erro: gravou.erro });
    }
  }

  // (d) O AVISO na Central. Dois consertos no mesmo statement:
  //
  //  1. **`ref_kind` é `conversation`, não `contact`.** O dedup por CONTATO
  //     fazia um cliente com duas conversas abertas render um aviso só — a
  //     segunda ficava invisível. O destino da Central também passa a ser a
  //     conversa, que é onde a pessoa responde.
  //  2. **Segunda passagem ENRIQUECE, não é descartada.** O `where not exists`
  //     puro descartava em silêncio: o sentimento chegava primeiro (sem
  //     contexto), o pedido explícito chegava depois (com contexto) e o segundo
  //     sumia. Agora ele vira ADENDO datado no item aberto.
  //
  // O corpo é CURTO e não carrega conversa — ver `corpoCurtoDoAviso`.
  await guardServiceEffect();
  await db.query(
    `with alvo as (
       select id, body from agent_inbox_items
        where organization_id = $1 and kind = 'handoff' and ref_kind = 'conversation'
          and ref_id = $4 and status = 'open'
        order by created_at desc limit 1
     ), adendo as (
       update agent_inbox_items i
          set body = coalesce(i.body, '') || chr(10) || chr(10) || $3, severity = 'critical'
         from alvo where i.id = alvo.id
       returning i.id
     )
     insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     select $1, 'handoff', 'critical', $2, $3, 'conversation', $4
      where not exists (select 1 from alvo)`,
    [
      ids.tenantId,
      // No idioma da ORGANIZAÇÃO, como o corpo: o título da Central sai como foi
      // gravado (nunca passa por t() na tela).
      opts.inboxTitle ??
        traduzir(
          'Handoff humano solicitado — assumir a conversa',
          opts.passagem?.idioma ?? (await idiomaDaOrganizacao(db, ids.tenantId, opts.log)),
        ),
      await corpoDaCentral(db, ids.tenantId, opts),
      ids.conversationId,
    ],
  );

  // (e) A IDA na linha do tempo do NEGÓCIO. `triggerHandoff` (o caminho do CRM)
  // já gravava `handoff_triggered`; este caminho — o do harness e o do "Assumir
  // eu" dos casos — não gravava nada. Metade das passagens era invisível no
  // dossiê do cliente, e quem lesse a timeline veria a volta sem a ida.
  //
  // O `reason` é FIXO de propósito: `opts.reason` pode ser o texto livre que o
  // atendente escreveu ao escalar, e esta linha aparece na tela e no export de
  // LGPD (regra do activity-emitter: o porquê é legível, sem PII).
  //
  // Try/catch porque a timeline não pode derrubar a operação que ela descreve —
  // mesma disciplina fire-and-forget do emissor da API.
  try {
    const roteou = await emitAgentActivityForContact({
      pool: db,
      organizationId: ids.tenantId,
      contactId: ids.leadId,
      type: 'handoff_triggered',
      sourceModule: 'human-handoff',
      sourceId: ids.conversationId,
      reason: 'Atendimento passado para uma pessoa',
      payload: { conversation_id: ids.conversationId },
    });
    if (!roteou.routed) {
      opts.log.warn('handoff: atividade não roteada para um negócio', { reason: roteou.reason });
    }
  } catch (err) {
    opts.log.warn('handoff: atividade da passagem não foi gravada', {
      error: err instanceof Error ? err.message.slice(0, 200) : 'erro desconhecido',
    });
  }

  // PII fora do log — e agora de verdade. A linha anterior logava `opts.reason`,
  // que no caminho do caso escalado É O TEXTO QUE O ATENDENTE ESCREVEU sobre o
  // cliente: o comentário "PII fora do log" já era falso quando foi escrito. O
  // que sai agora é o código canônico do motivo, que é vocabulário fechado.
  opts.log.info('handoff humano aplicado (force_human + silêncio + crons cancelados + inbox)', {
    motivo_codigo: opts.passagem?.motivoCodigo ?? 'nao_declarado',
    origem: opts.passagem?.origem ?? 'nao_declarada',
  });
}

/**
 * Traduz o desfecho técnico do aviso para o vocabulário FECHADO que a linha da
 * passagem guarda. `porque` (o código do gate) fica de fora: ele é diagnóstico,
 * e a coluna é lida por uma tela que traduz.
 */
function desfechoDaPassagem(aviso: DesfechoDoAviso): DesfechoDoAvisoDaPassagem {
  if (aviso.avisado) return { avisado: true };
  return {
    avisado: false,
    ...(aviso.motivoCodigo !== undefined ? { motivoCodigo: aviso.motivoCodigo } : {}),
  };
}

/**
 * O idioma da ORGANIZAÇÃO — ninguém está logado quando o motor escreve.
 *
 * Nunca lança: idioma é enfeite comparado à passagem, e um `select` que falhe
 * não pode impedir o aviso de nascer. O default é o idioma do produto.
 */
async function idiomaDaOrganizacao(db: pg.Pool, tenantId: string, log: Logger): Promise<Idioma> {
  try {
    const { rows } = await db.query<{ locale: string | null }>(
      'select locale from organizations where id = $1',
      [tenantId],
    );
    return normalizarIdioma(rows[0]?.locale ?? null);
  } catch (err) {
    log.warn('idioma da organização não lido — aviso da Central em português', {
      error: err instanceof Error ? err.message.slice(0, 120) : 'erro desconhecido',
    });
    return 'pt-BR';
  }
}

/**
 * O CORPO do aviso da Central. Curto, e sem conteúdo da conversa.
 *
 * ⚠️ MUDOU nesta entrega, e a versão antiga era `Motivo: <código cru>. <linha do
 * aviso>Resumo da conversa até aqui:\n<resumo>`. Dois defeitos num texto só: o
 * código cru (`requested_human`) aparecia para quem não fala inglês nem jargão,
 * e o resumo da conversa ficava numa tabela que a rota da Central lê com o
 * client de serviço e entrega a QUALQUER `agent` — inclusive a quem a política
 * de visibilidade de conversa não deixaria abrir aquele atendimento. O contexto
 * mudou de casa: ele mora na passagem, que é lida sob `fn_can_view_conversation`.
 *
 * **As duas frases do aviso ao cliente saem literalmente iguais às de antes** —
 * `tests/invariants/handoff-avisa-o-lead.test.ts` casa `/JÁ FOI avisado/` num
 * turno real, e rótulo visível é contrato.
 *
 * Sem `passagem` (o chamador legado), o corpo degrada para a forma antiga sem o
 * resumo: é o único caso em que não há motivo canônico a traduzir.
 */
async function corpoDaCentral(
  db: pg.Pool,
  tenantId: string,
  opts: {
    reason: string;
    avisoAoLead?: DesfechoDoAviso;
    passagem?: { motivoCodigo: MotivoDaPassagem; idioma?: Idioma };
    log: Logger;
  },
): Promise<string> {
  const idioma = opts.passagem?.idioma ?? (await idiomaDaOrganizacao(db, tenantId, opts.log));
  const t = (texto: string): string => traduzir(texto, idioma);
  const aviso = opts.avisoAoLead === undefined ? null : desfechoDaPassagem(opts.avisoAoLead);
  if (opts.passagem === undefined) {
    const linha = linhaDoAvisoAoCliente(aviso, t);
    return [`${t('Motivo')}: ${opts.reason}.`, ...(linha === null ? [] : [linha])].join(' · ');
  }
  return corpoCurtoDoAviso({ motivoCodigo: opts.passagem.motivoCodigo, aviso }, t);
}

/**
 * Whitelist EXATA do payload da tool (mesmo padrão .strict() da F2-10/F3-02).
 *
 * ⚠️ **ESTE SCHEMA TEM UM ESPELHO** em `AGENT_TOOL_DEFS.request_human_handoff.
 * inputSchema` (`inbound-turn.ts`), que é o largo que o SDK mostra ao modelo.
 * Mexer só num dos dois faz o modelo ver um campo que esta whitelist recusa — e
 * o desfecho é um erro de ENSINO a cada chamada. Os dois conjuntos de chaves são
 * comparados por `tests/unit/passagem-tool-schema-espelhado.test.ts`.
 *
 * Os campos novos são o que uma pessoa lê ao assumir a conversa: hoje ela recebe
 * um resumo montado do checkpoint e mais nada — nem o porquê, nem o que a IA já
 * tentou, nem o que o cliente pediu com as palavras dele.
 */
export const requestHumanHandoffInputSchema = z.strictObject({
  reason: z.string().min(1).max(500).optional(),
  por_que: z.string().min(1).max(500).optional(),
  o_que_tentei: z
    .array(
      z.strictObject({
        o_que: z.string().min(1).max(200),
        desfecho: z.string().min(1).max(200).optional(),
      }),
    )
    .max(6)
    .optional(),
  cliente_quer: z.string().min(1).max(300).optional(),
});

const PAYLOAD_TEACHING =
  'Campos aceitos: por_que (por que você está passando, em uma frase), o_que_tentei (lista curta ' +
  'do que você já tentou, com o desfecho de cada um), cliente_quer (o que a pessoa está pedindo, ' +
  'nas palavras dela). `reason` ainda é aceito como sinônimo de por_que. Nada além disso. Lead, ' +
  'organização e conversa vêm do runtime, nunca do payload da tool.';

export type RequestHumanHandoffResult =
  | { ok: true; status: 'handoff_solicitado'; message: string }
  | { ok: false; error: { code: 'invalid_payload'; message: string } };

/**
 * Wrapper da tool request_human_handoff exposta ao modelo. Valida o payload e delega a
 * performHumanHandoff. Erros de DB (ex.: lead sumiu) sobem — o tool wrapper do run os
 * captura e ensina o modelo a encerrar (padrão F2-09).
 */
export async function applyRequestHumanHandoff(
  db: pg.Pool,
  ids: HandoffIds,
  opts: {
    conversationSummary: string;
    /** Ver `performHumanHandoff` — o desfecho do aviso vira linha no aviso da Central. */
    avisoAoLead?: DesfechoDoAviso;
    /**
     * O checkpoint durável e o que o cliente disse e ainda não foi respondido —
     * o que a montagem do briefing precisa e que só o turno tem.
     *
     * Opcional porque o chamador de teste não tem turno; ausente, o briefing é o
     * piso (só o que o modelo declarou).
     */
    contextoDoTurno?: {
      checkpoint?: CheckpointParaBriefing | null;
      pendentesDoCliente?: readonly string[];
      declaracaoDoTurno?: DeclaracaoDoTurno | null;
    };
    log: Logger;
  },
  rawInput: unknown,
): Promise<RequestHumanHandoffResult> {
  const forbidden = findForbiddenKey(rawInput);
  if (forbidden !== null) {
    return { ok: false, error: { code: 'invalid_payload', message: `campos não reconhecidos: ${forbidden}. ${PAYLOAD_TEACHING}` } };
  }
  const parsed = requestHumanHandoffInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: { code: 'invalid_payload', message: `payload inválido em request_human_handoff (${zodIssuesSummary(parsed.error)}). ${PAYLOAD_TEACHING}` } };
  }

  // O que o MODELO declarou é dado NÃO CONFIÁVEL, e a montagem sabe disso: ela
  // rotula os blocos de leitura da IA e cita a fala do cliente entre aspas.
  // `por_que` vence `reason` porque `reason` é o sinônimo antigo — quem preenche
  // os dois está declarando o mesmo campo duas vezes.
  const declarado = parsed.data;
  const porQue = declarado.por_que ?? declarado.reason ?? null;
  const briefing = montarBriefingDaPassagem({
    checkpoint: opts.contextoDoTurno?.checkpoint ?? null,
    declaradoPeloModelo: {
      ...(declarado.o_que_tentei !== undefined ? { tentativas: declarado.o_que_tentei } : {}),
      cliente_quer: declarado.cliente_quer ?? null,
    },
    ...(opts.contextoDoTurno?.pendentesDoCliente !== undefined
      ? { pendentesDoCliente: opts.contextoDoTurno.pendentesDoCliente }
      : {}),
    ...(opts.contextoDoTurno?.declaracaoDoTurno !== undefined
      ? { declaracaoDoTurno: opts.contextoDoTurno.declaracaoDoTurno }
      : {}),
    motivo: { codigo: 'requested_human', texto: porQue },
  });

  await performHumanHandoff(db, ids, {
    reason: porQue ?? 'requested_human',
    conversationSummary: briefing.body,
    passagem: { origem: 'ferramenta_do_modelo', motivoCodigo: 'requested_human', briefing },
    ...(opts.avisoAoLead !== undefined ? { avisoAoLead: opts.avisoAoLead } : {}),
    log: opts.log,
  });

  // ACH-03: a expectativa vai JUNTO com a confirmação. Antes, a mensagem afirmava
  // que "um atendente vai assumir" sem que ninguém tivesse olhado se havia
  // alguém — e o agente repassava essa promessa ao cliente. Agora a resposta
  // carrega o estado real da equipe, e o modelo não precisa lembrar de perguntar.
  const { frase } = await expectativaDeAtendimento(db, ids.tenantId, new Date());

  // ⚠️ A frase anterior era "encerre o turno AGORA, sem enviar mais mensagens ao
  // lead além do aviso" — e prometia uma saída que a PRIMEIRA linha de
  // `performHumanHandoff` acabou de fechar: `force_human = true` arma o
  // `stopGate`, que veta todo envio seguinte. O modelo que obedecesse ao "além
  // do aviso" mandaria uma mensagem que morre no gate, e o lead ficaria mudo.
  // Agora a mensagem AFIRMA o que é verdade: o aviso ou já foi dele, antes da
  // chamada, ou foi do sistema — em nenhum dos casos há uma fala a mais.
  const jaAvisado =
    opts.avisoAoLead === undefined || opts.avisoAoLead.avisado
      ? 'O lead JÁ foi avisado de que uma pessoa vai assumir.'
      : 'ATENÇÃO: não foi possível avisar o lead (o canal recusou a mensagem); a equipe foi alertada disso.';

  return {
    ok: true,
    status: 'handoff_solicitado',
    message:
      `Handoff humano acionado; a conversa saiu do atendimento automático. ${jaAvisado} ${frase} ` +
      'Encerre o turno AGORA — você não consegue mais enviar mensagens a este lead.',
  };
}

/**
 * Resumo curto da conversa para o inbox de escalação — a partir do checkpoint durável
 * (compromissos/objeções/próxima ação/resumo). Vai ao inbox (PARA o humano), nunca a log.
 *
 * ⚠️ ESTA FUNÇÃO NÃO MONTA MAIS NADA: ela é um ADAPTADOR FINO de
 * `montarBriefingDaPassagem` (`lib/escalacao/briefing-da-passagem.ts`, migration
 * 0291), chamado com SÓ o checkpoint. A assinatura fica porque quatro call sites
 * e `tests/unit/declaracao-do-turno.test.ts` apontam para ela; o texto que sai é
 * BYTE A BYTE o de antes, porque a montagem só acrescenta blocos quando recebe o
 * que só a passagem enriquecida tem (motivo, tentativas, fala pendente, caso).
 *
 * Por que adaptador e não duas funções: enquanto havia duas montagens, o motor A
 * produzia este texto e o motor B não produzia texto nenhum — quem assumia a
 * conversa recebia coisas diferentes conforme o caminho, e ninguém media a
 * diferença. Uma montagem só é o que impede a divergência de voltar.
 */
export function buildHandoffSummary(
  previous: {
    commitments: string[];
    objections: string[];
    next_action: string | null;
    rolling_summary: string;
    /**
     * A declaração do último turno (spec 16 §5). Opcional na assinatura porque
     * chamador antigo (e checkpoint gravado antes da coluna existir) não a tem —
     * ausência degrada para o resumo de hoje, nunca quebra o handoff.
     */
    declaracao?: DeclaracaoDoTurno | null;
  } | null,
): string {
  return montarBriefingDaPassagem({ checkpoint: previous }).body;
}
