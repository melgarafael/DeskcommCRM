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
import { EVENTO_AVISO_HANDOFF, MARCA_EPISODIO_HANDOFF, MARCA_SOLICITACAO_HANDOFF } from '@/lib/escalacao/aviso-de-handoff';
import {
  CHAVE_DO_HANDOFF_TECNICO,
  derivacaoPendenteDoGatilho,
  turnoSemPalavraDoCliente,
} from '@/lib/escalacao/handoff-tecnico';
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
import { sqlContatoInterno } from '@/lib/contacts/tags-internas';
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
 * ═══ A GUARDA CONTRA O MENU DO ROBÔ DO OUTRO LADO (issue 3106) ═══
 *
 * O defeito medido: a empresa abordada responde à nossa primeira mensagem com o
 * menu automático dela ("1 - Ver produtos · 4 - Falar com um atendente"), o
 * primeiro padrão casa o rótulo da QUARTA OPÇÃO, o turno avisa o robô ("Claro!
 * Já estou chamando alguém da equipe…"), marca `force_human`, joga a conversa na
 * Fila e abre demanda — e o modelo nunca vê a mensagem. Cada caso vira trabalho
 * manual, e o autor mediu dois na mesma semana.
 *
 * A FRASE continua casando: `HUMAN_HANDOFF_PATTERNS` não muda, porque um pedido
 * de verdade precisa ser reconhecido sempre. O que muda é a LEITURA do
 * casamento — antes de passar a conversa, o turno pergunta se o que casou é fala
 * de GENTE. As três marcas abaixo dizem quando NÃO é, e todas se decidem sobre o
 * que o turno JÁ tem em memória (o mesmo histórico que o modelo lê), sem
 * consulta nova e sem relógio do banco:
 *
 *   1. MENU — o texto é um menu E o pedido casado é UMA DAS OPÇÕES dele (o item
 *      numerado "4 - Falar com um atendente", ou um menu que pede "digite o
 *      número" e traz opções numeradas): o rótulo casado não é um pedido;
 *   2. MARCA DE ROBÔ — o texto se DECLARA automação ("sou o assistente
 *      virtual", "esta é uma mensagem automática"): quem escreve isso não é quem
 *      pede uma pessoa. Citar o robô não basta — quem reclama do NOSSO bot cita;
 *   3. JANELA DA ABERTURA — a mensagem chegou segundos depois da mensagem NOSSA
 *      que ABRIU a conversa (o disparo da Prospecção/campanha): é a saudação
 *      automática de quem recebeu o disparo, antes de qualquer pessoa escrever.
 *
 * O que a guarda barra NÃO é silêncio: o turno segue para o MODELO, que vê a
 * mensagem e já sabe reconhecer robô — é a decisão do desenho do autor da issue.
 * E ela erra para o lado de DEIXAR PASSAR: sem histórico, sem casamento ou com
 * data ilegível, a resposta é "é de gente" e a passagem acontece — `force_human`
 * é irrevogável (regra dura 2), e só marca de automação o justifica barrar.
 */

/**
 * Uma mensagem do histórico do turno, como a guarda a lê.
 *
 * ESTRUTURAL de propósito: a guarda é pura e não arrasta o edge do CRM para
 * dentro do detector determinístico. O `LeadContextMessage` que o turno carrega
 * casa por estrutura, sem adaptador — e `sent_at` é lido com defensividade
 * porque há fixture (e há turno sem relógio) que não o traz.
 */
export interface MensagemDoHistorico {
  direction: 'inbound' | 'outbound';
  body: string;
  sent_at?: string;
}

/**
 * Quantos segundos depois da NOSSA abertura a resposta ainda é a saudação
 * automática do outro lado.
 *
 * Teto CURTO de propósito: quem recebeu um disparo e responde por si costuma
 * levar minutos; um robô responde no mesmo minuto. Passado o minuto, a guarda
 * desta marca para de agir — e as marcas 1 e 2 seguem valendo para o menu.
 */
const SEGUNDOS_DA_SAUDACAO_AUTOMATICA = 60;

/**
 * Onde começa um ITEM de menu: quebra de linha, ou o separador com espaço dos
 * dois lados (" / ", " | ", " • ") do menu de uma linha só — o da issue é
 * "1-Médicos / 2-Terapias / 3-Exames / 4-Falar com um atendente". O espaço é
 * exigido para que a data "12/10" não vire dois itens.
 */
const SEPARADOR_DE_ITEM = /\n|\s[/|•]\s/;

/**
 * Rótulos de OPÇÃO numerada: "1 - …", "2)", "3.", "*4*. Só no começo de um ITEM
 * (ver `SEPARADOR_DE_ITEM`), não números soltos no meio de uma frase: quem
 * escreve "chegou em 2 minutos" não está montando um menu.
 */
const OPCAO_NUMERADA = /(?:^|\n|\s[/|•]\s)\s*\*{0,2}\d{1,2}\s*[-–—.)\]]|\*\d{1,2}\*|\d\ufe0f?\u20e3/g;

/** O mesmo rótulo, perguntado a UM item já separado (sem `g`: `test` sem estado). */
const ITEM_NUMERADO = /^\s*\*{0,2}\d{1,2}\s*[-–—.)\]]|\*\d{1,2}\*|\d\ufe0f?\u20e3/;

/**
 * Como um menu PEDE a escolha. "digite o número", "responda com a opção",
 * "selecione uma opção", "menu de opções" — a moldura que transforma uma frase
 * de passagem em RÓTULO de menu.
 */
const INSTRUCOES_DE_MENU: readonly RegExp[] = [
  /\bdigite\s+(?:o\s+|a\s+)?(?:numero|opcao|palavra)\b/,
  /\b(?:responda|responde|escolha|escolhe|selecione|seleciona|aperte|toque)\s+(?:com\s+)?(?:o\s+|a\s+|um\s+|uma\s+)?(?:numero|opcao|palavra)\b/,
  /\bopcao\s+desejada\b/,
  /\bmenu\s+(?:de\s+opcoes|abaixo|acima|principal)\b/,
  /\b(?:as|nas)\s+opcoes\s+(?:abaixo|acima|ao\s+lado)\b/,
];

/**
 * Marcas em que a própria mensagem se declara AUTOMAÇÃO. Lista CURTA e
 * deliberada: só entra o que uma pessoa não escreve sobre si ao pedir uma
 * pessoa passar a conversa — por isso só AUTODECLARAÇÃO ("sou o…", "esta é
 * uma…"), nunca a menção solta. "esse assistente virtual não resolve nada",
 * "cansei de mensagem automática de vocês" e "aqui é o bot de novo?" são gente
 * reclamando do NOSSO robô, e têm de passar — como "não sou um robô", que é
 * gente provando que é gente.
 */
const MARCAS_DE_ROBO: readonly RegExp[] = [
  /(?<!\bnao\s+)\bsou\s+(?:o|a|um|uma)\s+(?:assistente\s+(?:virtual|digital)|robo|bot)\b/,
  /\best[ae]\s+(?:e\s+uma\s+(?:mensagem|resposta)\s+automatica|(?:mensagem|resposta)\s+e\s+automatica)\b/,
];

/**
 * A mensagem é um MENU de opções numeradas? (marca 1)
 *
 * Duas linhas numeradas, OU uma instrução explícita de escolha. O limiar de duas
 * é a diferença entre um menu e uma frase que cita "opção 4"; `HUMAN_HANDOFF_
 * PATTERNS` casa os dois, e é o menu que não pode virar passagem.
 */
export function ehMenuDeOpcoesNumeradas(mensagem: string): boolean {
  if (mensagem.trim() === '') return false;
  const normalizada = normalize(mensagem);
  if (INSTRUCOES_DE_MENU.some((re) => re.test(normalizada))) return true;
  const opcoes = normalizada.match(OPCAO_NUMERADA);
  return opcoes !== null && new Set(opcoes.map((o) => o.replace(/\D/gu, ''))).size >= 2;
}

/**
 * O pedido casado é UMA OPÇÃO do menu? (marca 1, a que a guarda usa)
 *
 * Ser menu não basta: uma pessoa que numera as próprias dúvidas ("1. o preço /
 * 2. o prazo / quero falar com um atendente") escreve um "menu" e pede gente
 * numa linha sem número; e quem reclama do nosso ("não sei qual a opção
 * desejada") cita a instrução sem montar opção nenhuma. Por isso, além de ser
 * menu, exige uma das duas: o pedido cai num ITEM numerado, ou há instrução de
 * menu JUNTO com pelo menos uma opção numerada.
 */
export function pedidoEhOpcaoDoMenu(mensagem: string): boolean {
  if (!ehMenuDeOpcoesNumeradas(mensagem)) return false;
  const normalizada = normalize(mensagem);
  const numerados = normalizada.split(SEPARADOR_DE_ITEM).filter((item) => ITEM_NUMERADO.test(item));
  if (numerados.some((item) => HUMAN_HANDOFF_PATTERNS.some((re) => re.test(item)))) return true;
  return numerados.length > 0 && INSTRUCOES_DE_MENU.some((re) => re.test(normalizada));
}

/**
 * A mensagem se declara automação? (marca 2)
 *
 * `false` para vazio e para o que não casa nada — o turno pergunta isto a TODA
 * mensagem pendente, e a maioria é fala de gente.
 */
export function ehMensagemDeRobo(mensagem: string): boolean {
  if (mensagem.trim() === '') return false;
  const normalizada = normalize(mensagem);
  return MARCAS_DE_ROBO.some((re) => re.test(normalizada));
}

/**
 * A mensagem chegou na janela em que o ROBÔ do outro lado responde sozinho?
 * (marca 3)
 *
 * Exige as três coisas, porque cada uma sozinha é fraca:
 *
 *   • a PRIMEIRA mensagem do histórico é NOSSA — a conversa nasceu de um disparo
 *     nosso (Prospecção/campanha), e não de alguém que procurou a empresa;
 *   • a mensagem avaliada é a ocorrência MAIS RECENTE daquele texto no histórico
 *     (as pendentes são a cauda do histórico; sem ocorrência, não há o que medir);
 *   • a distância até a nossa abertura cabe em `SEGUNDOS_DA_SAUDACAO_AUTOMATICA`.
 *
 * Data ilegível ou ausente desliga a marca (devolve `false`): a passagem
 * continua acontecendo, que é o lado seguro.
 */
export function chegouNaJanelaDaSaudacaoAutomatica(
  mensagem: string,
  historico: readonly MensagemDoHistorico[],
): boolean {
  const abertura = historico[0];
  if (abertura === undefined || abertura.direction !== 'outbound') return false;

  const corpo = mensagem.trim();
  let avaliada: MensagemDoHistorico | null = null;
  for (let i = historico.length - 1; i >= 0; i -= 1) {
    const m = historico[i];
    if (m !== undefined && m.direction === 'inbound' && m.body.trim() === corpo) {
      avaliada = m;
      break;
    }
  }
  if (avaliada === null) return false;

  const t0 = typeof abertura.sent_at === 'string' ? Date.parse(abertura.sent_at) : NaN;
  const t1 = typeof avaliada.sent_at === 'string' ? Date.parse(avaliada.sent_at) : NaN;
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return false;

  const segundos = (t1 - t0) / 1000;
  return segundos >= 0 && segundos <= SEGUNDOS_DA_SAUDACAO_AUTOMATICA;
}

/**
 * A resposta que casou um padrão de pedido de humano é de um ROBÔ? (issue 3106)
 *
 * É a pergunta que o turno faz ANTES de passar a conversa: `true` = o casamento
 * veio de menu/automação, e o turno segue para o modelo; `false` = é fala de
 * gente (ou não há evidência em contrário), e a passagem determinística acontece
 * como sempre.
 */
export function ehRespostaDeRobo(
  mensagem: string,
  historico: readonly MensagemDoHistorico[] = [],
): boolean {
  if (mensagem.trim() === '') return false;
  if (pedidoEhOpcaoDoMenu(mensagem)) return true;
  if (ehMensagemDeRobo(mensagem)) return true;
  return chegouNaJanelaDaSaudacaoAutomatica(mensagem, historico);
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
 *
 * #2353: a MESMA guarda barra o CONTATO INTERNO (equipe, sócio, família, fornecedor) —
 * quem tem uma etiqueta da lista da organização
 * (`organizations.settings.crm.internal_contact_tags`) não recebe atendimento
 * automático, igual a uma conversa em "Assumir". A régua é a única
 * (`lib/contacts/tags-internas.ts`); aqui ela entra pela forma SQL de lá, porque este
 * predicado é SQL direto e roda no caminho quente do worker — o envio FIXO do follow-up
 * e o modelo aprovado do worker passam por ele ANTES de qualquer gate de elegibilidade,
 * e era por ali que o texto fixo continuava saindo para quem ganhou a etiqueta depois de
 * o card nascer.
 */
export async function isLeadInHandoff(db: pg.Pool, tenantId: string, leadId: string): Promise<boolean> {
  const { rows } = await db.query<{ handoff: boolean }>(
    `select (
       c.force_human
       -- A marca PERMANENTE "sempre atendimento humano" (issue 2379): mesma
       -- leitura, mesmo efeito — o turno nem começa. force_human é a trava de
       -- handoff, que a devolução limpa; esta é a que ela não alcança.
       or c.ai_opt_out
       or ${sqlContatoInterno('c')}
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
    /**
     * A mensagem cuja derivação ainda estava ABERTA quando o handoff disparou
     * (#2210). Presente = o handoff nasceu de falha de infraestrutura, e a marca
     * gravada em `conversations.metadata.handoff_tecnico` autoriza a devolução
     * automática quando `media_derived_status` virar `ready`.
     *
     * Só `applyRequestHumanHandoff` o preenche, e só quando nada do que o
     * cliente disse no turno era legível (`turnoSemPalavraDoCliente`). Os
     * outros chamadores — pedido explícito detectado, opt-out, "Assumir eu",
     * orçamento — nunca o passam, e a ferramenta do modelo não o passa quando
     * havia palavra do cliente (um pedido explícito em texto, por exemplo):
     * sem marca, o handoff continua `infinity`.
     */
    derivacaoPendente?: { messageId: string };
    /**
     * Os campos que um fluxo DETERMINÍSTICO coletou no turno (pergunta de um
     * campo por turno), em pares rótulo/valor — nome, exame, data…
     *
     * Presente E `passagem` ausente = o handoff grava sozinho a linha de
     * `passagens_de_atendimento` com motivo canônico `verificacao_manual`, e os
     * campos chegam a quem assume SOB `fn_can_view_conversation` — nunca no
     * corpo da Central, que a rota entrega a qualquer `agent`. Com `passagem`
     * declarada (o caminho da ferramenta do modelo), este campo é ignorado: o
     * briefing do chamador já carrega o que o turno tem.
     */
    camposColetados?: Readonly<Record<string, string>>;
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
  // #2210: a marca só existe quando o handoff nasceu com a derivação ABERTA.
  // Escrevemos e apagamos na MESMA cláusula (`- $5 || $6`): um handoff sem
  // marca remove qualquer marca anterior — um handoff novo por outro motivo
  // invalida o antigo, e é o `motivo_gravado` que amarra um ao outro.
  const marcaDaDerivacao = opts.derivacaoPendente
    ? JSON.stringify({
        [CHAVE_DO_HANDOFF_TECNICO]: {
          causa: "derivacao_ausente",
          message_id: opts.derivacaoPendente.messageId,
          motivo_gravado: opts.reason,
        },
      })
    : "{}";

  await guardServiceEffect();
  const conversaSilenciada = await db.query<{ aviso_episodio: string }>(
    `update conversations
        set status = case when status = 'ai_handling' then 'pending' else status end,
            bot_silenced_until = $3,
            last_handoff_at = now(),
            last_handoff_reason = $4,
            -- marcado_em sai do now() do BANCO, o mesmo relógio do created_at
            -- das mensagens com que a reação compara (handoff-tecnico.ts).
            metadata = (coalesce(metadata, '{}'::jsonb) - $5::text)
                       || case when $6::jsonb = '{}'::jsonb then '{}'::jsonb
                               else jsonb_set($6::jsonb, array[$5::text, 'marcado_em'], to_jsonb(now())) end
                       || jsonb_build_object($7::text,
                            case when bot_silenced_until > now()
                                      and metadata->>$7::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                                 then metadata->>$7::text else gen_random_uuid()::text end),
            active_ai_agent_id = null,
            active_intent = null,
            active_agent_set_at = null
      where organization_id = $1 and id = $2
      returning metadata->>$7::text as aviso_episodio`,
    [ids.tenantId, ids.conversationId, SILENCE_INFINITY, opts.reason, CHAVE_DO_HANDOFF_TECNICO, marcaDaDerivacao, MARCA_EPISODIO_HANDOFF],
  );
  // O UPDATE trava a linha: chamadas concorrentes no mesmo silêncio reutilizam
  // o UUID. Depois de devolver ao automático (silêncio limpo), nasce outro episódio.
  const episodioDoAviso = conversaSilenciada.rows[0]?.aviso_episodio ?? null;

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

  // (c3) SEM passagem declarada, mas com DADOS COLETADOS: o fluxo
  // determinístico que pergunta campo a campo encerra em handoff, e os campos
  // perguntados precisam chegar a quem assume. Chegam na PASSAGEM — o lugar
  // que a rota da Central lê sob `fn_can_view_conversation` —, e nunca no
  // corpo do aviso, que a mesma rota entrega a QUALQUER `agent`. O motivo é o
  // canônico `verificacao_manual`: o cliente não pediu uma pessoa, um fluxo
  // coletou dados e precisa de verificação humana — o rótulo tem de dizer o
  // que houve, porque é a primeira frase de quem abre a conversa.
  if (opts.passagem === undefined && temCamposColetados(opts.camposColetados)) {
    await guardServiceEffect();
    const briefing = montarBriefingDaPassagem({
      checkpoint: null,
      camposColetados: opts.camposColetados,
      motivo: { codigo: 'verificacao_manual' },
    });
    const gravou = await registrarPassagem(db, {
      organizationId: ids.tenantId,
      contactId: ids.leadId,
      conversationId: ids.conversationId,
      motor: 'engine',
      origem: 'runtime_nativo',
      motivoCodigo: 'verificacao_manual',
      briefing,
    });
    // Mesma disciplina do (c2): a passagem já aconteceu, o erro vira log.
    if (!gravou.gravada) {
      opts.log.warn('passagem com dados coletados não registrada — o aviso sai, os campos não', {
        erro: gravou.erro,
      });
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
     ), criado as (
       insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       select $1, 'handoff', 'critical', $2, $3, 'conversation', $4
        where not exists (select 1 from alvo)
       returning id
     ), evento as (
       -- Central e solicitação saem no MESMO commit. Sem opt-in, só a Central.
       insert into event_log (id, organization_id, event_type, entity_kind, entity_id, payload, metadata)
       select $5::uuid, $1, $6, 'conversation', $4,
              jsonb_build_object('central_id', central.id), '{"source":"human_handoff"}'::jsonb
         from (select id from adendo union all select id from criado) central
        where $5::uuid is not null
          and exists (select 1 from config_aviso_de_caso where organization_id = $1 and ligado)
          -- Opção própria das transferências (ligada por padrão): a mesma régua de
          -- avisoDeTransferenciaLigado — só o booleano false desliga.
          and exists (select 1 from organizations where id = $1
                        and (settings->'crm'->'avisar_transferencia_no_whatsapp') is distinct from 'false'::jsonb)
          and exists (select 1 from conversations where organization_id = $1 and id = $4
                        and metadata->>$8::text = $5::text
                        and metadata->>$7::text is distinct from $5::text)
       on conflict (id) do nothing returning id
     )
     -- A poda normal de event_log não pode permitir outro aviso no mesmo episódio.
     update conversations set metadata = coalesce(metadata, '{}'::jsonb)
       || jsonb_build_object($7::text, $5::text)
      where organization_id = $1 and id = $4
        and metadata->>$8::text = $5::text
        and exists (select 1 from evento)`,
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
      episodioDoAviso,
      EVENTO_AVISO_HANDOFF,
      MARCA_SOLICITACAO_HANDOFF,
      MARCA_EPISODIO_HANDOFF,
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
 * Há algum campo realmente preenchido? Um objeto `{ nome: "  " }` é coleta sem
 * resultado — e sem resultado não há passagem a gravar: o caminho é o legado,
 * byte a byte, que `tests/invariants/escalacao-ciclo-humano.test.ts` (arquivo
 * congelado) chama com a assinatura antiga.
 */
function temCamposColetados(campos: Readonly<Record<string, string>> | undefined): boolean {
  if (campos === undefined) return false;
  return Object.values(campos).some((v) => typeof v === 'string' && v.trim() !== '');
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
  motivo_codigo: z.enum(['requested_human', 'critical_stage']).optional(),
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
  'Campos aceitos: motivo_codigo (requested_human para pedido de uma pessoa; critical_stage para ' +
  'uma etapa do atendimento que exige finalização humana), por_que (por que você está passando, em uma frase), o_que_tentei (lista curta ' +
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
    /**
     * A mensagem que TRIGGOU o turno (#2210). Com ela o handoff pergunta ao
     * banco se a derivação da mídia ainda estava em aberto — e, se estiver,
     * grava a marca que permite devolver o atendimento sozinho quando o texto
     * chegar. Sem gatilho não há marca (chamador sem turno), que é o caso seguro.
     */
    gatilho?: { inboundMessageId?: string };
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
  // ⚠️ **AUSENTE NÃO É "O CLIENTE PEDIU" (#3310).** Era `?? 'requested_human'`,
  // e o modelo que passava a conversa sem declarar o motivo — escalar por não ter
  // a informação, ou por regra do próprio prompt, que é o caso da issue — fazia o
  // cartão de quem assume afirmar um pedido que o cliente nunca fez. O código
  // default é `low_confidence`, o motivo do vocabulário fechado que descreve o
  // que houve (o assistente não resolveu sozinho) sem afirmar nada sobre o
  // cliente; quem de fato pediu uma pessoa vem com `motivo_codigo:
  // 'requested_human'` e continua recebendo a frase do pedido.
  //
  // O código classifica a passagem, sem escolher destino nem alterar a
  // autoridade da ferramenta: a DECISÃO de passar a conversa é a mesma.
  const motivoCodigo = declarado.motivo_codigo ?? 'low_confidence';
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
    motivo: { codigo: motivoCodigo, texto: porQue },
  });

  // #2210: o handoff só carrega a marca quando a causa é a falta de texto —
  // a mensagem que disparou o turno ainda sem derivação E nada legível do
  // cliente no turno. Com palavra do cliente (um pedido explícito em texto no
  // mesmo lote do áudio, por exemplo) o motivo pode ser ela, e não há marca.
  // `reason` e a marca saem do MESMO `opts.porQue`, e é esse par que a reação
  // compara depois para saber se o handoff atual ainda é o marcado.
  const derivacaoPendente = turnoSemPalavraDoCliente(opts.contextoDoTurno?.pendentesDoCliente)
    ? await derivacaoPendenteDoGatilho(db, ids.tenantId, opts.gatilho?.inboundMessageId)
    : null;

  await performHumanHandoff(db, ids, {
    reason: porQue ?? motivoCodigo,
    conversationSummary: briefing.body,
    passagem: { origem: 'ferramenta_do_modelo', motivoCodigo, briefing },
    ...(opts.avisoAoLead !== undefined ? { avisoAoLead: opts.avisoAoLead } : {}),
    ...(derivacaoPendente !== null ? { derivacaoPendente } : {}),
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
