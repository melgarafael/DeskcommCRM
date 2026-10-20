import { INSTRUCAO_CONTEXTO_COMPARTILHADO, type ContextoCompartilhadoDoTurno } from '@/lib/agent-engine/agent/contexto-compartilhado-do-turno';
import type { ConsultasAgendaDoTurno } from '@/lib/agenda/consulta-do-turno';
import type { FalhaDaRevisaoDeAgenda } from '@/lib/agenda/falha-revisao';
import type { OperacaoAgendaObservada } from '@/lib/agenda/recibo-do-turno';
/**
 * Camada SEMÂNTICA de promessa em texto livre (F4-02; blueprint 6.5) — classificador
 * binário BARATO que roda DEPOIS da camada determinística (F4-01) no gate before_send.
 * A regex+schema da F4-01 só pega valor ESTRUTURADO (R$/%/parcelas); promessa em texto
 * livre ("faço de graça", "te dou uma cortesia", "garanto entrega amanhã") escapa dela —
 * esta camada fecha o buraco.
 *
 * O classificador passa pela camada de modelo agnóstica (F2-23 — modelo auxiliar pequeno,
 * budget da org checado ANTES da chamada dentro de runModelCall; NÃO é roteamento do modelo
 * do agente). Binário: a mensagem candidata contém uma promessa/compromisso livre? Devolve
 * {isPromise, suspectPhrase}. suspectPhrase é o trecho da PRÓPRIA candidata (mensagem que o
 * agente quer enviar) — volta ao modelo no veto (erro de ensino), mas NUNCA vai a log.
 *
 * Como Gate.evaluate é SÍNCRONO (before-send.ts), a chamada async roda ANTES da cadeia e
 * entra no GateContext pronta; o `semanticPromiseGate` (sync) lê e veta. Ela roda antes de o
 * runBeforeSend tomar conexão, FORA do advisory lock do número: não lê nada do que o lock
 * protege, e dentro da transação ela fechava um ciclo de travas com DDL (o `runModelCall`
 * grava `llm_calls`, que tem FK para `contacts`, por outra conexão — #2363).
 * Este módulo não persiste nada.
 *
 * organization_id/contact_id vêm da ROW do job (closure do run), nunca do payload (regra dura 1).
 */
import type pg from "pg";
import { INSTRUCAO_ENVIO_AGENDA, INSTRUCAO_PROPOSTA_AGENDA, type PropostaDeAgenda } from "@/lib/agenda/pedido";
import { precisaRevisarAgenda } from "./contrato-contexto";
import { sinalAgendaDoTexto } from "./sinal-agenda";
import { pacoteFactualDaRevisao, INSTRUCAO_REPASSE, temDecisaoElegivel, precisaRevisarConclusaoHumana, type PacoteFactual } from "./contrato-contexto";
import type { ContextoDeDecisaoHumana } from "../../agent/contexto-de-decisao-humana";
import type { ContextoDoAtendimento } from "../../agent/contexto-do-atendimento";

import type { Logger } from "../../obs/logger";
import type { ProviderRegistry } from "../../edge/llm/providers";
import { runModelCall, type LlmEdgeConfig } from "../../edge/llm/run-model-call";
import type { LlmResolveOverride } from "../../edge/llm/credentials";
import { extrairObjetoJsonDoTexto } from "@/lib/agent-engine/texto/extrair-json-do-texto";
import type { EvidenciaComercial, CoberturaComercial } from "./evidencias-comerciais";
import type { ContextoDaRevisao } from "./contexto-da-revisao";
import { detectHumanPromise } from "../human-promise";
import { detectHumanCompletion } from "./conclusao-humana";
import { conferirOrcamentoDaRevisao } from "./orcamento-da-revisao";
import { revisarRespostaComJev } from "@/lib/ai/decisao/revisao-resposta";
import { PROMISE_SEMANTIC_INSTRUCTION, INSTRUCAO_COM_EVIDENCIAS, CONFIRMAR_RETORNO_INSTRUCTION } from "./instrucoes";
export { PROMISE_SEMANTIC_INSTRUCTION } from "./instrucoes";
import { carregarBinding } from "../../edge/llm/binding-do-ponto";

/** Veredito binário do classificador. suspectPhrase = null quando isPromise = false. */
export interface PromiseClassification {
  /** Inconclusivo técnico; mantém o envio fechado sem inventar incompatibilidade semântica. */
  agendaReviewIssue?: FalhaDaRevisaoDeAgenda;
  /** Positivo estrito; ausente/ilegível não autoriza execução nem confirmação de agenda. */
  agendaCompativel?: boolean;
  isPromise: boolean;
  /** Positivo fechado; só tem efeito junto da prova interna relida pelo servidor. */
  repasseConcluidoFiel?: boolean;
  /** Afirma conclusão/decisão humana individual, independentemente de ser fiel ou ter retorno futuro. */
  afirmouConclusaoHumana?: boolean;
  /** trecho literal da candidata que caracteriza a promessa (só quando isPromise=true). */
  suspectPhrase: string | null;
  /**
   * A mensagem promete que ALGUÉM DA EMPRESA volta a falar com o cliente?
   *
   * PERGUNTA DIFERENTE de `isPromise`. `isPromise` é sobre promessa COMERCIAL —
   * preço, desconto, prazo de entrega, cortesia. Este campo é sobre o COMPROMISSO
   * DE RETORNAR: "te retorno", "te dou um retorno", "vou encaminhar para análise",
   * "vou levar para avaliação interna", "vou passar para o setor X" — COM OU SEM
   * nomear a pessoa ou o setor. O que importa é o COMPROMISSO DE VOLTAR, não a
   * palavra usada.
   *
   * Existe porque o detector léxico (`detectHumanPromise`) exige palavra de alvo
   * humano colada ao verbo, e um objeto no meio ("as informações") quebra o padrão:
   * 5 das 7 frases medidas em 2026-09-16 vazaram por ali, inclusive uma que escreve
   * literalmente "equipe". O `casePromiseGate` lê os dois sinais em OU — o léxico é
   * o filtro barato que roda sem chamada de modelo; este campo é o que pega o resto.
   */
  prometeuRetornoHumano: boolean;
  /**
   * Quem volta é SÓ o próprio assistente ("te retorno amanhã de manhã"), sem pessoa,
   * setor, equipe ou análise interna? É o que deixa o `casePromiseGate` aceitar um
   * `schedule_followup` como destino da promessa no lugar de um caso (#1873, opção a).
   *
   * Degrade FECHADO, ao contrário dos outros dois: falha de parse, campo ausente ou tipo
   * trocado viram `false` — na dúvida, o follow-up não libera e o caso continua exigido.
   */
  retornoSoDoAssistente: boolean;
  /** Diagnóstico opcional, literal e privado; nunca libera um boolean positivo. */
  humanReturnPhrase?: string;
  humanReturnCategory?: "internal_action" | "human_contact" | "assistant_followup";
}

/**
 * Instrução FIXA do classificador — marcador estável (como STAGE_CLASSIFIER_INSTRUCTION)
 * para os testes reconhecerem a chamada do auxiliar. Descreve a tarefa binária, dá exemplos
 * de promessa vs. inocente (incl. as armadilhas de slogan) e força saída JSON.
 */

function buildPromiseMessage(candidate: string): string {
  return [
    "## Mensagem candidata (que o vendedor quer enviar ao lead)",
    candidate,
    "",
    PROMISE_SEMANTIC_INSTRUCTION,
  ].join("\n");
}


/**
 * Extrai {isPromise, suspectPhrase, prometeuRetornoHumano} do texto do modelo (tolerante a
 * code-fence/prosa em volta do JSON). Saída não-parseável → `isPromise` degrada para "sem
 * promessa" (a camada determinística F4-01 já rodou) e `prometeuRetornoHumano` degrada ao
 * veredito do léxico — o porquê da assimetria está no corpo.
 */
export function parsePromiseClassification(
  text: string,
  candidata: string,
  log?: Logger,
): PromiseClassification {
  // ⛔ DEGRADE ASSIMÉTRICO DE PROPÓSITO — e a assimetria é o ponto deste bloco.
  //
  // `isPromise` degrada para `false`: a camada determinística (F4-01) já rodou e
  // pegou o valor estruturado; fail-open ali é uma rede a menos, não uma
  // invariante ferida.
  //
  // `prometeuRetornoHumano` NÃO pode degradar para `false`. Não há camada anterior
  // equivalente para ELE: o detector léxico (`detectHumanPromise`) deixa passar 5
  // das 7 frases medidas em 2026-09-16. Degradar para `false` desarmaria a
  // invariante sagrada exatamente quando o sistema está com defeito — o pior
  // momento possível. Degrada para o veredito do LÉXICO: pior que o semântico,
  // melhor que nada.
  //
  // Por isto o parser precisa da CANDIDATA (assinatura mudou): o veredito de
  // degrade não sai do vazio, sai do detector barato que já existe.
  const fallbackLexico = detectHumanPromise(candidata);

  // O parser robusto devolve o PRIMEIRO objeto parseável (prosa, cerca de código e
  // JSON REPETIDO — o recorte antigo abria no primeiro `{` e fechava no último `}`,
  // abrangendo as DUAS cópias e quebrando o parse). O que NÃO muda é a falha: sem
  // objeto parseável continua o mesmo fail-open para "sem promessa" em `isPromise`,
  // com o warn de antes (acrescido do degrade do retorno humano) — e o `reason` usa o mesmo critério de antes (havia `{`…`}` para
  // o regex antigo = havia JSON candidato que não parseou → invalid_json; sem ele →
  // no_json). A regex abaixo é SÓ o critério do motivo do log, não o parser.
  const bruto = extrairObjetoJsonDoTexto(text);
  if (bruto === null || typeof bruto !== "object") {
    const haviaJsonCandidato = /\{[\s\S]*\}/.test(text);
    // degrade OBSERVÁVEL (F4-08 ressalva 2): sem o warn, um classificador sistematicamente
    // quebrado ficaria invisível (todo envio "sem promessa"). Loga só o FATO do parse-fail —
    // nunca o texto do modelo (poderia carregar trecho da candidata, PII fora de log).
    log?.warn(
      haviaJsonCandidato
        ? 'classificador semântico de promessa: JSON inválido — fail-open p/ "sem promessa"; retorno humano degrada ao léxico'
        : 'classificador semântico de promessa: saída sem JSON — fail-open p/ "sem promessa"; retorno humano degrada ao léxico',
      {
        event: "promise_semantic_parse_fail",
        reason: haviaJsonCandidato ? "invalid_json" : "no_json",
      },
    );
    return {
      isPromise: false,
      suspectPhrase: null,
      prometeuRetornoHumano: fallbackLexico,
      retornoSoDoAssistente: false,
    };
  }
  const obj = bruto as Record<string, unknown>;
  const isPromise = obj.isPromise === true || obj.isPromise === "true";
  const rawPhrase = typeof obj.suspectPhrase === "string" ? obj.suspectPhrase.trim() : "";
  // Campo novo ausente ou com tipo trocado cai no MESMO degrade do léxico. Um sinal
  // de segurança que sai `undefined` é pior que um que sai errado: o gate o leria
  // como ausência (compara `=== true`) e a invariante sagrada ficaria desarmada sem
  // ninguém perceber. Por isso o tipo é `boolean` obrigatório e o parser garante o valor.
  const prometeuRetornoHumano =
    typeof obj.prometeuRetornoHumano === "boolean" ? obj.prometeuRetornoHumano : fallbackLexico;
  // Degrade FECHADO (#1873): só `true` literal libera o follow-up como destino.
  const retornoSoDoAssistente = obj.retornoSoDoAssistente === true;
  const humanReturnPhrase =
    typeof obj.humanReturnPhrase === "string" ? obj.humanReturnPhrase.trim() : "";
  const humanReturnCategory = obj.humanReturnCategory;
  // Sem diagnóstico/diagnóstico inventado, preserva o contrato antigo. O boolean
  // e seu fallback nunca dependem destes campos; trecho não vai para log geral.
  const diagnostic: Pick<PromiseClassification, "humanReturnPhrase" | "humanReturnCategory"> =
    prometeuRetornoHumano &&
    humanReturnPhrase !== "" &&
    candidata.includes(humanReturnPhrase) &&
    (humanReturnCategory === "internal_action" ||
      humanReturnCategory === "human_contact" ||
      humanReturnCategory === "assistant_followup")
      ? { humanReturnPhrase, humanReturnCategory }
      : {};
  return {
    isPromise,
    ...(typeof obj.agendaCompativel === "boolean" ? { agendaCompativel: obj.agendaCompativel } : {}),
    suspectPhrase: isPromise && rawPhrase !== "" ? rawPhrase : null,
    prometeuRetornoHumano,
    retornoSoDoAssistente,
    ...(Object.hasOwn(obj, 'repasseConcluidoFiel') ? { repasseConcluidoFiel: obj.repasseConcluidoFiel === true } : {}),
    ...(typeof obj.afirmouConclusaoHumana === 'boolean' ? { afirmouConclusaoHumana: obj.afirmouConclusaoHumana } : {}),
    ...diagnostic,
  };
}

const objeto = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

/** Corrige somente a divergência sobre um resultado automático atual, não uma conclusão humana.
 * O confirmador precisa de um positivo vinculado ao recibo relido; false sozinho não derruba true.
 * A revisão de agenda conserva sua competência sobre pedido/candidata inteira. Nenhum gate é pulado.
 */
function confirmaConclusaoOperacional(
  args: PacoteFactual, initial: PromiseClassification, checked: Record<string, unknown>,
): boolean {
  if (args.agendaOperation || !args.agendaOperationReceipt || checked.consultaDeEstadoDaAgenda!=null || initial.agendaCompativel !== true ||
      args.serviceContext?.pedido?.estado !== 'present' || checked.afirmouConclusaoHumana !== false ||
      checked.repasseConcluidoFiel !== false || checked.prometeuRetornoHumano !== false ||
      checked.retornoSoDoAssistente !== false || detectHumanPromise(args.candidate)) return false;
  const packet = pacoteFactualDaRevisao(args);
  if (packet.limite_contexto === true) return false;
  const result = objeto(packet.resultado_agenda_do_turno);
  const receipt = objeto(result?.recibo), proof = objeto(checked.conclusaoOperacionalDaAgenda);
  if (!result || !receipt || !proof || proof.referencia_recibo !== result.referencia_recibo ||
      proof.revisao_relida !== result.revisao_relida || proof.acao_observada !== result.acao_observada) return false;
  if (String(receipt.revisao_google_local) !== String(result.revisao_relida) ||
      String(receipt.revisao_google_publicada) !== String(result.revisao_relida)) return false;
  // Naturezas calculadas pelo servidor; recibo de outra reserva/revisão não chega a este resultado.
  return result.acao_observada === 'cancelar'
    ? receipt.natureza_cancelamento === 'cancelamento_sincronizado_no_google'
    : receipt.natureza_confirmacao === 'reserva_publicada_sem_aprovacao_humana_exigida' ||
      receipt.natureza_confirmacao === 'reserva_publicada_pelo_fluxo_individual';
}



/** Segunda opinião positiva sobre uma LEITURA, distinta da prova de execução.
 * O pacote nasce da releitura scoped/fingerprint já revalidada no before-send.
 */
function confirmaConsultaDeEstadoAtual(
  args: PacoteFactual, initial: PromiseClassification, checked: Record<string, unknown>,
): boolean {
  const pedido=args.serviceContext?.pedido;
  if (args.agendaOperation || args.agendaOperationReceipt || initial.agendaCompativel!==true ||
      pedido?.estado!=='present' || pedido.tipoTurno!=='inbound_turn' ||
      pedido.mensagem?.origem!=='client_message' || !pedido.mensagem.text.trim() ||
      (args.serviceContext?.estadoDoJob && args.serviceContext.estadoDoJob!=='running') ||
      checked.afirmouConclusaoHumana!==false || checked.repasseConcluidoFiel!==false ||
      checked.prometeuRetornoHumano!==false || checked.retornoSoDoAssistente!==false ||
      checked.conclusaoOperacionalDaAgenda!=null || detectHumanPromise(args.candidate)) return false;
  const packet=pacoteFactualDaRevisao(args);
  if (packet.limite_contexto===true || packet.resultado_agenda_do_turno) return false;
  const proof=objeto(checked.consultaDeEstadoDaAgenda);
  const ctx=objeto(packet.contexto_atendimento), leituras=objeto(ctx?.leituras_de_estado_da_agenda);
  if (!proof || leituras?.origem!=='releitura_scoped_do_servidor' || !Array.isArray(leituras.recibos)) return false;
  const matches=leituras.recibos.filter(v=>{
    const r=objeto(v);return r?.referencia_recibo===proof.referencia_recibo &&
      r?.revisao_relida===proof.revisao_relida && r?.estado_relido===proof.estado_relido;
  });
  return matches.length===1;
}

/**
 * Roda o classificador semântico pelo seam agnóstico (purpose 'promise_semantic'; budget da
 * org checado ANTES da chamada dentro de runModelCall). Injetável (registry) para testes
 * determinísticos com MockLanguageModelV4. Devolve o veredito binário + a frase suspeita.
 */
export async function classifyPromise(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId?: string | null; jobId?: string },
  args: {
    agentContext?: ContextoCompartilhadoDoTurno;
    candidate: string;
    agendaReviewRequired?: boolean;
    agendaAvailability?: ConsultasAgendaDoTurno;
    agendaOperationReceipt?: OperacaoAgendaObservada;
    agendaOperation?: PropostaDeAgenda;
    pendingAgendaCommunication?: { candidate: string; code: string };
    humanDecisionContext?: ContextoDeDecisaoHumana;
    serviceContext?: ContextoDoAtendimento;
    sentAntecedents?: readonly string[];
    model?: string;
    llmOverride?: LlmResolveOverride;
    /** Somente evidências recolhidas das consultas reais do servidor neste turno. */
    commercialEvidence?: readonly EvidenciaComercial[];
    commercialCoverage?: CoberturaComercial;
    /** Conversa curada pelo servidor, nunca autorização comercial. */
    conversationContext?: ContextoDaRevisao;
  },
  deps: {
    registry?: ProviderRegistry;
    log: Logger;
    /** Seam de leitura para testes; produção usa o binding do mesmo tenant. */
    loadHumanReturnBinding?: typeof carregarBinding;
  },
): Promise<PromiseClassification> {
  if (precisaRevisarAgenda(args)) {
    const pacote = pacoteFactualDaRevisao(args);
    const pedido = args.serviceContext?.pedido;
    const cobertura = args.serviceContext?.cobertura ?? [];
    const fontesIndisponiveis = cobertura.length > 0 && cobertura.every(fonte => fonte.estado === 'unavailable');
    const incompleto = fontesIndisponiveis || pacote.limite_contexto === true ||
      pedido?.estado === 'unavailable' || pedido?.estado === 'excluded_by_limit' ||
      (Boolean(args.agendaOperationReceipt) && !args.agendaOperation && !pacote.resultado_agenda_do_turno);
    if (incompleto) {
      deps.log.warn('revisão de agenda aguarda contexto essencial', {
        event:'agenda_review_inconclusive', motivo:'contexto_incompleto',
        pacote_excluido:pacote.limite_contexto === true,
        pedido:pedido?.estado ?? 'not_collected',
        recibo_vinculado:Boolean(pacote.resultado_agenda_do_turno),
      });
      // Não enviar fonte sabidamente perdida ao JEV/reserva/confirmador para que a ausência vire veto.
      return { isPromise:false,suspectPhrase:null,prometeuRetornoHumano:detectHumanPromise(args.candidate),
        retornoSoDoAssistente:false,agendaCompativel:false,agendaReviewIssue:'contexto_incompleto' };
    }
  }
  if (args.agendaAvailability) {
    const pacote = pacoteFactualDaRevisao(args);
    deps.log.info("cobertura da consulta de agenda na revisão", {
      event:"agenda_availability_context", consultas:args.agendaAvailability.consultas.length,
      omitidas:args.agendaAvailability.omitidas,
      estados:args.agendaAvailability.consultas.map(c=>c.cobertura),
      presente_no_pacote:pacote.consultas_disponibilidade_do_turno !== undefined,
      pacote_excluido:pacote.limite_contexto === true,
    });
  }
  const reviewed = await revisarRespostaComJev(db, cfg, ids, args, async () => {
  const call = await runModelCall(
    db,
    cfg,
    {
      tenantId: ids.tenantId,
      ...(ids.leadId != null ? { leadId: ids.leadId } : {}),
      ...(ids.jobId !== undefined ? { jobId: ids.jobId } : {}),
      purpose: "promise_semantic",
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.llmOverride !== undefined ? { llmOverride: args.llmOverride } : {}),
      system: args.agendaOperation ? INSTRUCAO_PROPOSTA_AGENDA + INSTRUCAO_CONTEXTO_COMPARTILHADO :
        (args.commercialEvidence?.length ? INSTRUCAO_COM_EVIDENCIAS : PROMISE_SEMANTIC_INSTRUCTION) + INSTRUCAO_REPASSE,
      messages: args.agentContext || args.agendaOperation || args.agendaAvailability || args.commercialEvidence?.length || args.conversationContext || args.humanDecisionContext || args.serviceContext
        ? [
            {
              role: "user",
              content: JSON.stringify(pacoteFactualDaRevisao(args)),
            },
          ]
        : [{ role: "user", content: buildPromiseMessage(args.candidate) }],
    },
    { registry: deps.registry, log: deps.log },
  );
  // O parser recebe a CANDIDATA para poder degradar `prometeuRetornoHumano` pelo
  // veredito do léxico (a assimetria está documentada no corpo do parser).
  const initial = parsePromiseClassification(call.result.text, args.candidate, deps.log);
  if (args.agendaOperation) initial.agendaCompativel = sinalAgendaDoTexto(call.result.text, deps.log);
  if (precisaRevisarAgenda(args) && !args.agendaOperation) {
    // O JEV tem uma pergunta própria de agenda. Sua reserva LLM precisa da mesma
    // separação: promessa de retaguarda e ausência de recibo não são confirmação.
    // Mesmo provedor/binding, budget nativo, pacote factual e opt-in de diagnóstico.
    const pacoteAgenda = pacoteFactualDaRevisao(args);
    const agenda = await runModelCall(db, cfg, {
      tenantId:ids.tenantId,
      ...(ids.leadId != null ? {leadId:ids.leadId} : {}),
      ...(ids.jobId !== undefined ? {jobId:ids.jobId} : {}),
      purpose:"promise_semantic",
      ...(args.model !== undefined ? {model:args.model} : {}),
      ...(args.llmOverride !== undefined ? {llmOverride:args.llmOverride} : {}),
      system:INSTRUCAO_ENVIO_AGENDA + INSTRUCAO_CONTEXTO_COMPARTILHADO,
      messages:[
        {role:"user",content:JSON.stringify(pacoteAgenda)},
        // Reapresenta somente o alvo já saneado do pacote comum. Pedido, histórico
        // e candidata recusada são fontes, nunca a mensagem atual a julgar.
        {role:"user",content:JSON.stringify({
          alvo_da_revisao:"candidata_atual_do_atendente",
          candidata_atual:pacoteAgenda.mensagem,
        })},
      ],
    }, {registry:deps.registry,log:deps.log});
    // Sinal ausente/inválido NÃO herda um positivo da classificação comercial.
    initial.agendaCompativel=sinalAgendaDoTexto(agenda.result.text,deps.log);
    const bruto = extrairObjetoJsonDoTexto(agenda.result.text) as Record<string,unknown> | null;
    const frase = typeof bruto?.afirmacao_sem_suporte === 'string' ? bruto.afirmacao_sem_suporte.trim() : '';
    if (initial.agendaCompativel === undefined) initial.agendaReviewIssue = 'sinal_invalido';
    else if (initial.agendaCompativel === false && frase &&
        !String(pacoteAgenda.mensagem).normalize('NFC').includes(frase.normalize('NFC'))) {
      // Nunca trocar false por true. O negativo mal vinculado pede nova revisão, não acusação à candidata.
      initial.agendaReviewIssue = 'candidata_desvinculada';
      deps.log.warn('revisão de agenda vinculou diagnóstico a outro texto', {
        event:'agenda_review_inconclusive',motivo:'candidata_desvinculada',
      });
    }
  }
  if (precisaRevisarAgenda(args)) deps.log.info("sinal de agenda lido da revisão de reserva", {
    event: "agenda_review_signal", fase: args.agendaOperation ? "antes_da_escrita" : "envio",
    sinal: initial.agendaCompativel === true ? "positive" : initial.agendaCompativel === false ? "negative" : "absent_or_invalid",
  });
  if (initial.agendaReviewIssue) return initial;
  const completion = initial.afirmouConclusaoHumana === true ||
    (precisaRevisarConclusaoHumana(args) && initial.afirmouConclusaoHumana === undefined && detectHumanCompletion(args.candidate));
  if (!initial.prometeuRetornoHumano && !completion) return initial;
  let confirmationRequired = completion;
  try {
    const binding = await (deps.loadHumanReturnBinding ?? carregarBinding)(
      db,
      ids.tenantId,
      "human_return_confirmation",
    );
    // Sem escolha explícita, conserva a revisão existente sem chamada extra.
    if (!binding?.is_enabled || binding.purpose !== "human_return_confirmation") return initial;
    confirmationRequired = completion;
    const confirmation = await runModelCall(
      db,
      cfg,
      {
        tenantId: ids.tenantId,
        ...(ids.leadId != null ? { leadId: ids.leadId } : {}),
        ...(ids.jobId !== undefined ? { jobId: ids.jobId } : {}),
        purpose: "human_return_confirmation",
        // O seam resolve o binding deste ponto; não herda modelo do agente.
        system: CONFIRMAR_RETORNO_INSTRUCTION + INSTRUCAO_REPASSE,
        messages: [
          {
            role: "user",
            content: JSON.stringify(pacoteFactualDaRevisao(args)),
          },
        ],
      },
      { registry: deps.registry, log: deps.log },
    );
    const raw = extrairObjetoJsonDoTexto(confirmation.result.text);
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof (raw as Record<string, unknown>).prometeuRetornoHumano !== "boolean"
    ) {
      deps.log.warn("confirmação de retorno inválida — marcação inicial preservada", {
        event: "human_return_confirmation_invalid",
      });
      return completion ? { ...initial, repasseConcluidoFiel: false } : initial;
    }
    const checked = parsePromiseClassification(confirmation.result.text, args.candidate, deps.log);
    // O confirmador também precisa responder à conclusão quando assume esse julgamento.
    // Campo ausente/tipo trocado não transforma falha em autorização da marcação inicial.
    if (completion && (typeof (raw as Record<string, unknown>).afirmouConclusaoHumana !== 'boolean' ||
        typeof (raw as Record<string, unknown>).repasseConcluidoFiel !== 'boolean')) {
      deps.log.warn('confirmação da conclusão ilegível', { event: 'human_completion_confirmation_invalid' });
      return { ...initial, repasseConcluidoFiel: false };
    }
    deps.log.info("confirmação de retorno humano concluída", {
      event: "human_return_confirmed",
      confirmado: checked.prometeuRetornoHumano,
    });
    const operacional = completion && confirmaConclusaoOperacional(args, initial, raw as Record<string, unknown>);
    const consulta = completion && confirmaConsultaDeEstadoAtual(args, initial, raw as Record<string, unknown>);
    if (consulta) deps.log.info('leitura atual da agenda conciliada pelo confirmador', {
      event:'human_completion_current_state_reconciled',
    });
    if (operacional) deps.log.info('conclusão operacional conciliada pelo confirmador', {
      event: 'human_completion_operational_reconciled',
    });
    return {
      isPromise: initial.isPromise,
      ...(initial.agendaReviewIssue ? { agendaReviewIssue:initial.agendaReviewIssue } : {}),
      ...(initial.agendaCompativel !== undefined ? { agendaCompativel: initial.agendaCompativel } : {}),
      ...(args.humanDecisionContext ? { repasseConcluidoFiel: checked.repasseConcluidoFiel === true } : {}),
      ...((completion && !operacional && !consulta) || checked.afirmouConclusaoHumana === true
        ? { afirmouConclusaoHumana: true }
        : checked.afirmouConclusaoHumana === false ? { afirmouConclusaoHumana: false } : {}),
      suspectPhrase: initial.suspectPhrase,
      prometeuRetornoHumano: checked.prometeuRetornoHumano,
      retornoSoDoAssistente: checked.prometeuRetornoHumano && checked.retornoSoDoAssistente,
      ...(checked.humanReturnPhrase ? { humanReturnPhrase: checked.humanReturnPhrase } : {}),
      ...(checked.humanReturnCategory ? { humanReturnCategory: checked.humanReturnCategory } : {}),
    };
  } catch {
    // Falha de leitura, budget, chave ou fornecedor não libera a candidata.
    deps.log.warn("confirmação de retorno falhou — marcação inicial preservada", {
      event: "human_return_confirmation_failed",
    });
    return confirmationRequired ? { ...initial, repasseConcluidoFiel: false } : initial;
  }
  }, { log: deps.log, conferirOrcamento: conferirOrcamentoDaRevisao });
  // Mesma normalização para JEV, reserva e confirmador; nunca positiva por coerção/ausência.
  if (args.humanDecisionContext || precisaRevisarConclusaoHumana(args) || reviewed.afirmouConclusaoHumana === true) {
    reviewed.repasseConcluidoFiel = temDecisaoElegivel(args) && reviewed.afirmouConclusaoHumana === true &&
      reviewed.repasseConcluidoFiel === true && !reviewed.prometeuRetornoHumano && !detectHumanPromise(args.candidate);
  }
  if (precisaRevisarAgenda(args)) {
    const limitado = pacoteFactualDaRevisao(args).limite_contexto === true;
    const positivo = reviewed.agendaCompativel === true;
    if (reviewed.agendaCompativel === undefined) reviewed.agendaReviewIssue ??= 'sinal_invalido';
    if (limitado) reviewed.agendaReviewIssue = 'contexto_incompleto';
    reviewed.agendaCompativel = positivo && !limitado && !reviewed.agendaReviewIssue;
    deps.log.info("sinal de agenda normalizado", { event:"agenda_review_normalized",
      fase:args.agendaOperation ? "antes_da_escrita" : "envio", sinal_positivo:positivo,
      pacote_excluido:limitado, compativel:reviewed.agendaCompativel });
  }
  return reviewed;
}

/**
 * Erro de ENSINO que volta AO MODELO no veto semântico (acceptance 3): destaca a frase
 * suspeita e orienta a reformular. É o único lugar onde a frase (trecho da própria candidata)
 * aparece — vai ao modelo, jamais a log.
 */
export function renderSemanticPromiseVeto(suspectPhrase: string | null): string {
  const highlight = suspectPhrase !== null ? `frase suspeita: "${suspectPhrase}" — ` : "";
  return (
    `${highlight}isso é uma promessa/compromisso fora do playbook que a validação de valores ` +
    "estruturados não pega; reformule sem prometer prazo, cortesia, gratuidade, brinde ou garantia " +
    "não autorizada antes de reenviar. Se a oferta existe na empresa, consulte sua política e " +
    "condições explícitas antes de reenviar. Preserve a gratuidade realmente autorizada: não " +
    "a retire nem a troque por sinônimo para contornar a revisão. Convite não confirma vaga; " +
    "não acrescente reserva, prazo ou garantia sem comprovação."
  );
}

/**
 * Uma classificação por CORPO EXATO e pelo mesmo CONTEXTO, enquanto a função
 * memoizada viver — o turno cria uma por turno. Os fail-safes de vocabulário e
 * de promessa re-rodam a cadeia `before_send` com o mesmo texto, e cada
 * passagem pagava uma chamada de modelo nova para a mesma frase.
 *
 * `contexto` entra na chave porque o veredito não depende só do texto: as
 * evidências comerciais do turno também vão à classificação, e elas CRESCEM
 * entre um veto e o reenvio — o modelo vetado consulta o preço e manda a mesma
 * frase. Reaproveitar o veredito de antes da consulta vetaria de novo uma
 * promessa que agora tem prova. Falha sai do memo: a próxima passagem tenta de
 * novo, como antes.
 */
export function memoizarPorCandidata(
  classificar: (candidata: string) => Promise<PromiseClassification>,
  contexto: () => string = () => "",
): (candidata: string) => Promise<PromiseClassification> {
  const pedidas = new Map<string, Promise<PromiseClassification>>();
  return (candidata) => {
    const chave = `${contexto()}\u0000${candidata}`;
    const jaPedida = pedidas.get(chave);
    if (jaPedida !== undefined) return jaPedida;
    const pedida = classificar(candidata);
    pedidas.set(chave, pedida);
    pedida.then(v => { if (v.agendaReviewIssue) pedidas.delete(chave); }, () => pedidas.delete(chave));
    return pedida;
  };
}
