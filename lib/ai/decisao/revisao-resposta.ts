import { INSTRUCAO_CONTEXTO_COMPARTILHADO, type ContextoCompartilhadoDoTurno } from '@/lib/ai/contexto-observado-do-turno';
import type { ConsultasAgendaDoTurno } from '@/lib/agenda/consulta-do-turno';
import type { OperacaoAgendaObservada } from '@/lib/agenda/recibo-do-turno';
import {capturarRevisao} from '@/lib/ai/diagnostico-revisao/captura';
/** Revisor de resposta nativo: JEV primeiro, IA configurada na dúvida/falha. */
import type pg from "pg";
import { CRITERIO_PROPOSTA_AGENDA, CRITERIO_ENVIO_AGENDA, type PropostaDeAgenda } from "@/lib/agenda/pedido";
import { precisaRevisarAgenda } from "@/lib/agent-engine/guardrails/promise/contrato-contexto";
import type { LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/run-model-call";
import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import type { PromiseClassification } from "@/lib/agent-engine/guardrails/promise/semantic";
import type { EvidenciaComercial, CoberturaComercial } from "@/lib/agent-engine/guardrails/promise/evidencias-comerciais";
import type { ContextoDaRevisao } from "@/lib/agent-engine/guardrails/promise/contexto-da-revisao";
import { PERGUNTA_COMERCIAL_COM_EVIDENCIAS, PERGUNTA_COMERCIAL_SEM_EVIDENCIA, PERGUNTA_RETORNO_SEM_FORMATO } from "@/lib/agent-engine/guardrails/promise/instrucoes";
import { decidirRevisao, SINAIS_DA_REVISAO, type ProbabilidadesDaRevisao, type SinalDaRevisao } from "@/lib/agent-engine/guardrails/promise/decisao-do-jev";
import { pacoteFactualDaRevisao, CRITERIO_REPASSE, precisaRevisarConclusaoHumana } from "@/lib/agent-engine/guardrails/promise/contrato-contexto";
import type { ContextoDeDecisaoHumana } from "@/lib/agent-engine/agent/contexto-de-decisao-humana";
import type { ContextoDoAtendimento } from "@/lib/agent-engine/agent/contexto-do-atendimento";
import { MODELO_DO_JEV, type Pergunta, type ResultadoDaDecisao } from "./cliente";
import { podeTentar, registrarFalha, registrarSucesso } from "./disjuntor";
import { decidirNoPonto } from "./ponto";
import { configDaTarefaNoPool, registrarFalhaQuePedeAcao } from "./pool";
import { estadoEfetivoDaTarefa, TAREFA_DA_REVISAO_DE_RESPOSTA } from "./tarefas";

export interface PacoteDaRevisao {
  agentContext?: ContextoCompartilhadoDoTurno;
  agendaReviewRequired?: boolean;
  agendaAvailability?: ConsultasAgendaDoTurno;
  agendaOperationReceipt?: OperacaoAgendaObservada;
  agendaOperation?: PropostaDeAgenda;
  pendingAgendaCommunication?: { candidate: string; code: string };
  candidate: string;
  humanDecisionContext?: ContextoDeDecisaoHumana;
  serviceContext?: ContextoDoAtendimento;
  sentAntecedents?: readonly string[];
  commercialEvidence?: readonly EvidenciaComercial[];
  commercialCoverage?: CoberturaComercial;
  conversationContext?: ContextoDaRevisao;
}
type Ids = { tenantId: string; leadId?: string | null; jobId?: string };
export interface DependenciasDaRevisao {
  log: Logger;
  lerConfig?: typeof configDaTarefaNoPool;
  perguntar?: typeof decidirNoPonto;
  conferirOrcamento: (pool: pg.Pool, cfg: LlmEdgeConfig, ids: Ids, log: Logger) => Promise<void>;
}

/** Mesmos conteúdos consultados, sem IDs empresariais; só PII reconhecida é ocultada. */
export function pacoteParaJev(p: PacoteDaRevisao): Record<string, unknown> {
  return pacoteFactualDaRevisao(p);
}

export function perguntasDaRevisao(temEvidencias: boolean, temDecisao = false, temAgenda = false, proposta = false): Record<Exclude<SinalDaRevisao, 'repasse' | 'conclusao' | 'agenda'>, Pergunta> & { repasse?: Pergunta; conclusao?: Pergunta; agenda?: Pergunta } {
  // Cada noul recebe só sua regra, sem o formato JSON do revisor LLM.
  // As duas primeiras regras são compartilhadas, não uma política paralela.
  return {
    ...(temAgenda ? { agenda: { tipo: "noul" as const, instrucao: (proposta ? CRITERIO_PROPOSTA_AGENDA : CRITERIO_ENVIO_AGENDA) + INSTRUCAO_CONTEXTO_COMPARTILHADO,
      criterios: { true: "A proposta corresponde ao pedido autorizado; sem proposta, a candidata não confirma nem promete operação divergente ou sem prova.",
        false: "Divergência ou insuficiência entre pedido, ação, serviço, beneficiário, data/hora/fuso ou comprovação atual." } } } : {}),
    ...(temDecisao ? { conclusao: { tipo:"noul" as const, instrucao:CRITERIO_REPASSE, criterios:{ true:"A candidata afirma decisão/conclusão humana individual, mesmo fora do escopo ou sem fonte suficiente.", false:"Não afirma conclusão humana: comunicação fiel de reserva/publicação operacional comprovada sem atribuir aprovação a pessoa, fala neutra, convite, hipótese, pergunta, descrição ou citação sem endosso." } }, repasse: { tipo:"noul" as const, instrucao:CRITERIO_REPASSE, criterios:{ true:"A candidata inteira repassa fielmente a decisão humana elegível, sem nova promessa.", false:"Sem decisão suficiente, fora do escopo, dúvida ou promessa adicional." } } } : {}),
    comercial: {
      tipo: "noul",
      instrucao: (temEvidencias ? PERGUNTA_COMERCIAL_COM_EVIDENCIAS : PERGUNTA_COMERCIAL_SEM_EVIDENCIA) + (temDecisao ? CRITERIO_REPASSE : INSTRUCAO_CONTEXTO_COMPARTILHADO),
      criterios: {
        true: "A candidata contém compromisso COMERCIAL concreto não autorizado pelas evidências.",
        false: "Não contém compromisso comercial não autorizado; oferta cadastrada e linguagem comercial natural podem passar.",
      },
    },
    retorno: {
      tipo: "noul", instrucao: PERGUNTA_RETORNO_SEM_FORMATO + (temDecisao ? CRITERIO_REPASSE : INSTRUCAO_CONTEXTO_COMPARTILHADO),
      criterios: {
        true: "A candidata assume pendência de retaguarda, transferência/registro para análise em execução ou já registrado, ou retorno adicional ao cliente.",
        false: "A candidata não assume nova pendência: comunica decisão elegível concluída, descreve serviço, cita autores, convida, pede aviso AO CLIENTE ou oferece transferência sujeita a consentimento.",
      },
    },
    so_assistente: {
      tipo: "noul",
      instrucao: "Julgue somente a candidata. O compromisso de retornar ao cliente depende exclusivamente do assistente, sem equipe, pessoa, setor ou análise interna? Pedido para O CLIENTE avisar não é compromisso do assistente.",
      criterios: {
        true: "Existe compromisso de retorno posterior exclusivamente do assistente.",
        false: "Não há compromisso de retorno, ou depende de pessoas/análise interna.",
      },
    },
  };
}

function sinalDoVeredito(v: PromiseClassification, s: SinalDaRevisao): boolean {
  if (s === "agenda") return v.agendaCompativel === true;
  if (s === "conclusao") return v.afirmouConclusaoHumana === true;
  if (s === "repasse") return v.repasseConcluidoFiel === true;
  if (s === "comercial") return v.isPromise;
  if (s === "retorno") return v.prometeuRetornoHumano;
  return v.prometeuRetornoHumano && v.retornoSoDoAssistente;
}

/** Verificações presentes no contrato; UMA linha de custo. Não persistir candidata/evidências/histórico. */
async function gravarRevisao(
  pool: pg.Pool, ids: Ids, estado: "observando" | "decidindo",
  r: Extract<ResultadoDaDecisao, { ok: true }>, probabilidades: ProbabilidadesDaRevisao | null,
  reserva: PromiseClassification | null, cobriu: boolean, log: Logger,
): Promise<void> {
  try {
    const verificacoes = probabilidades ? SINAIS_DA_REVISAO.filter(s => probabilidades[s] !== undefined).map(s => ({
      probabilidade: probabilidades[s],
      confianca: Math.max(probabilidades[s], 1 - probabilidades[s]),
      rotulo: `${s}:${probabilidades[s] >= 0.5 ? "sim" : "nao"}`,
      atual: reserva && !(s === 'agenda' && reserva.agendaReviewIssue) && !(s === 'repasse' && reserva.humanDecisionReviewIssue)
        ? `${s}:${sinalDoVeredito(reserva, s) ? "sim" : "nao"}` : null,
    })) : [];
    await pool.query(
      `with observacoes as (
         insert into public.jev_observacoes
           (organization_id, tarefa, estado, job_id, rotulo_jev, probabilidade_jev,
            confianca_jev, rotulo_atual, modelo, latencia_ms)
         select $1, 'revisao_resposta', $2, $3, x.rotulo, x.probabilidade,
                x.confianca, x.atual, $4, $5
         from jsonb_to_recordset($6::jsonb) as x(rotulo text, probabilidade numeric, confianca numeric, atual text)
       ) insert into public.llm_calls
         (organization_id, contact_id, job_id, purpose, provider, model,
          input_tokens, output_tokens, cost_cents, latency_ms, status, origem_da_escolha)
       values ($1, $7, $3, 'promise_semantic', 'typesafe', $8, $9, $10, $11, $5, 'ok', $12)`,
      [ids.tenantId, estado, ids.jobId ?? null, r.modelo, r.latenciaMs, JSON.stringify(verificacoes),
       ids.leadId ?? null, `typesafe/${r.modelo}`, r.uso.tokensDeEntrada, r.uso.tokensDeSaida,
       costCents(r.modelo, { inputTokens: r.uso.tokensDeEntrada, outputTokens: r.uso.tokensDeSaida, cacheReadTokens: 0, cacheWriteTokens: 0 }),
       cobriu ? "reserva_do_jev" : estado === "decidindo" ? "jev" : "jev_observacao"],
    );
  } catch (erro) {
    log.warn("auditoria da revisão JEV não foi gravada", { event: "jev_review_audit_failed", erro: erro instanceof Error ? erro.name : typeof erro });
  }
}

export async function revisarRespostaComJev(
  pool: pg.Pool, cfg: LlmEdgeConfig, ids: Ids, pacote: PacoteDaRevisao,
  reserva: () => Promise<PromiseClassification>, deps: DependenciasDaRevisao,
): Promise<PromiseClassification> {
  const config = await (deps.lerConfig ?? configDaTarefaNoPool)(pool, ids.tenantId, TAREFA_DA_REVISAO_DE_RESPOSTA);
  const estado = estadoEfetivoDaTarefa(config, TAREFA_DA_REVISAO_DE_RESPOSTA);
  if ((pacote.agentContext || pacote.agendaOperation || pacote.agendaAvailability || pacote.agendaOperationReceipt || pacote.humanDecisionContext || pacote.serviceContext || pacote.sentAntecedents?.length) && config.contexto_revisao?.versao !== 2) {
    deps.log.info("reserva assume contexto ampliado", { event:"jev_review_fallback",motivo:"context_consent_version_insufficient" });
    return reserva();
  }
  if (estado === "desligada") return reserva();
  const alvo = { organizationId: ids.tenantId, tarefa: "promise_semantic" };
  if (!podeTentar(alvo)) {
    deps.log.info("reserva assume a revisão de resposta", { event: "jev_review_fallback", motivo: "disjuntor_aberto" });
    return reserva();
  }
  // O bloqueio de orçamento conserva sua exceção nativa; não contornar pela reserva.
  await deps.conferirOrcamento(pool, cfg, ids, deps.log);
  let r: ResultadoDaDecisao;
  try {
    r = await (deps.perguntar ?? decidirNoPonto)({
      organizationId: ids.tenantId, ponto: "promise_semantic", origemDoContexto: config.origem,
      capturarRevisao:(payload)=>capturarRevisao(pool,ids,'jev',payload),
      ...(pacote.agentContext || pacote.agendaOperation || pacote.agendaAvailability || pacote.agendaOperationReceipt || pacote.humanDecisionContext || pacote.serviceContext || pacote.sentAntecedents?.length ? { versaoContextoRevisao:2 as const } : {}),
      estado: pacoteParaJev(pacote), perguntas: perguntasDaRevisao(Boolean(pacote.commercialEvidence?.length), precisaRevisarConclusaoHumana(pacote), precisaRevisarAgenda(pacote), Boolean(pacote.agendaOperation)),
    });
  } catch {
    r = { ok: false, motivo: "provedor_indisponivel", exigeAcao: false, defeitoNosso: false, status: null };
  }
  if (!r.ok) {
    registrarFalha(alvo, r.motivo, Date.now(), r.retryAfterMs);
    const linhaId = await registrarFalhaQuePedeAcao(pool, { organizationId: ids.tenantId, purpose: "promise_semantic", contactId: ids.leadId, jobId: ids.jobId }, r);
    deps.log.info("reserva assume a revisão de resposta", { event: "jev_review_fallback", motivo: r.motivo });
    const v = await reserva();
    // Igual ao roteador: só marca cobertura quando a reserva efetivamente respondeu.
    if (linhaId && estado === "decidindo" && !v.agendaReviewIssue && !v.humanDecisionReviewIssue) {
      try { await pool.query("update public.llm_calls set origem_da_escolha = 'reserva_do_jev' where id = $1 and organization_id = $2", [linhaId, ids.tenantId]); } catch { /* Telemetria não veta atendimento. */ }
    }
    return v;
  }
  const calculo = decidirRevisao(r.respostas, precisaRevisarConclusaoHumana(pacote), precisaRevisarAgenda(pacote));
  const modeloValido = r.modelo === MODELO_DO_JEV;
  if (calculo.motivo === "resposta_ilegivel" || !modeloValido) registrarFalha(alvo, "resposta_ilegivel", Date.now());
  else registrarSucesso(alvo);
  const precisaReserva = estado === "observando" || calculo.motivo !== "decidiu" || !modeloValido;
  let v: PromiseClassification | null = null;
  try {
    if (precisaReserva) {
      deps.log.info("reserva assume a revisão de resposta", {
        event: "jev_review_fallback", motivo: estado === "observando" ? "observacao" : !modeloValido ? "modelo_inesperado" : calculo.motivo,
        ...(calculo.motivo !== "decidiu" ? { campo: calculo.campo } : {}),
      });
      v = await reserva();
    }
    return v ?? (calculo.motivo === "decidiu" ? calculo.veredito : (() => { throw new Error("revisão sem veredito"); })());
  } finally {
    // Também contabiliza a chamada JEV se a reserva falhou; não inventa aprovação/concordância.
    await gravarRevisao(pool, ids, estado, r, calculo.motivo !== "resposta_ilegivel" ? calculo.probabilidades : null, v, estado === "decidindo" && v !== null && !v.agendaReviewIssue && !v.humanDecisionReviewIssue, deps.log);
  }
}
