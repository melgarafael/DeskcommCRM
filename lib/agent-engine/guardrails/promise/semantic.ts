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

import type { Logger } from "../../obs/logger";
import type { ProviderRegistry } from "../../edge/llm/providers";
import { runModelCall, type LlmEdgeConfig } from "../../edge/llm/run-model-call";
import type { LlmResolveOverride } from "../../edge/llm/credentials";
import { extrairObjetoJsonDoTexto } from "@/lib/agent-engine/texto/extrair-json-do-texto";
import type { EvidenciaComercial } from "./evidencias-comerciais";
import type { ContextoDaRevisao } from "./contexto-da-revisao";
import { detectHumanPromise } from "../human-promise";
import { conferirOrcamentoDaRevisao } from "./orcamento-da-revisao";
import { revisarRespostaComJev } from "@/lib/ai/decisao/revisao-resposta";
import { PROMISE_SEMANTIC_INSTRUCTION, INSTRUCAO_COM_EVIDENCIAS, CONFIRMAR_RETORNO_INSTRUCTION } from "./instrucoes";
export { PROMISE_SEMANTIC_INSTRUCTION } from "./instrucoes";
import { carregarBinding } from "../../edge/llm/binding-do-ponto";

/** Veredito binário do classificador. suspectPhrase = null quando isPromise = false. */
export interface PromiseClassification {
  isPromise: boolean;
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
    suspectPhrase: isPromise && rawPhrase !== "" ? rawPhrase : null,
    prometeuRetornoHumano,
    retornoSoDoAssistente,
    ...diagnostic,
  };
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
    candidate: string;
    model?: string;
    llmOverride?: LlmResolveOverride;
    /** Somente evidências recolhidas das consultas reais do servidor neste turno. */
    commercialEvidence?: readonly EvidenciaComercial[];
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
  return revisarRespostaComJev(db, cfg, ids, args, async () => {
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
      ...(args.commercialEvidence?.length ? { system: INSTRUCAO_COM_EVIDENCIAS } : {}),
      messages: args.commercialEvidence?.length
        ? [
            {
              role: "user",
              content: JSON.stringify({
                mensagem: args.candidate,
                evidencias: args.commercialEvidence,
                ...(args.conversationContext
                  ? { contexto_conversa: args.conversationContext }
                  : {}),
              }),
            },
          ]
        : [{ role: "user", content: buildPromiseMessage(args.candidate) }],
    },
    { registry: deps.registry, log: deps.log },
  );
  // O parser recebe a CANDIDATA para poder degradar `prometeuRetornoHumano` pelo
  // veredito do léxico (a assimetria está documentada no corpo do parser).
  const initial = parsePromiseClassification(call.result.text, args.candidate, deps.log);
  if (!initial.prometeuRetornoHumano) return initial;
  try {
    const binding = await (deps.loadHumanReturnBinding ?? carregarBinding)(
      db,
      ids.tenantId,
      "human_return_confirmation",
    );
    // Sem escolha explícita, conserva a revisão existente sem chamada extra.
    if (!binding?.is_enabled || binding.purpose !== "human_return_confirmation") return initial;
    const confirmation = await runModelCall(
      db,
      cfg,
      {
        tenantId: ids.tenantId,
        ...(ids.leadId != null ? { leadId: ids.leadId } : {}),
        ...(ids.jobId !== undefined ? { jobId: ids.jobId } : {}),
        purpose: "human_return_confirmation",
        // O seam resolve o binding deste ponto; não herda modelo do agente.
        system: CONFIRMAR_RETORNO_INSTRUCTION,
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              mensagem: args.candidate,
              evidencias: args.commercialEvidence ?? [],
              ...(args.conversationContext ? { contexto_conversa: args.conversationContext } : {}),
            }),
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
      return initial;
    }
    const checked = parsePromiseClassification(confirmation.result.text, args.candidate, deps.log);
    deps.log.info("confirmação de retorno humano concluída", {
      event: "human_return_confirmed",
      confirmado: checked.prometeuRetornoHumano,
    });
    return {
      isPromise: initial.isPromise,
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
    return initial;
  }
  }, { log: deps.log, conferirOrcamento: conferirOrcamentoDaRevisao });
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
    pedida.catch(() => pedidas.delete(chave));
    return pedida;
  };
}
