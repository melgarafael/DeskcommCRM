/** Revisor de resposta nativo: JEV primeiro, IA configurada na dúvida/falha. */
import type pg from "pg";
import type { LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/run-model-call";
import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import type { PromiseClassification } from "@/lib/agent-engine/guardrails/promise/semantic";
import type { EvidenciaComercial } from "@/lib/agent-engine/guardrails/promise/evidencias-comerciais";
import type { ContextoDaRevisao } from "@/lib/agent-engine/guardrails/promise/contexto-da-revisao";
import { PERGUNTA_COMERCIAL_COM_EVIDENCIAS, PERGUNTA_COMERCIAL_SEM_EVIDENCIA, PERGUNTA_RETORNO_SEM_FORMATO } from "@/lib/agent-engine/guardrails/promise/instrucoes";
import { decidirRevisao, SINAIS_DA_REVISAO, type ProbabilidadesDaRevisao, type SinalDaRevisao } from "@/lib/agent-engine/guardrails/promise/decisao-do-jev";
import { scrubMessage } from "@/lib/sentry/scrub";
import { MODELO_DO_JEV, type Pergunta, type ResultadoDaDecisao } from "./cliente";
import { podeTentar, registrarFalha, registrarSucesso } from "./disjuntor";
import { decidirNoPonto } from "./ponto";
import { configDaTarefaNoPool, registrarFalhaQuePedeAcao } from "./pool";
import { estadoEfetivoDaTarefa, TAREFA_DA_REVISAO_DE_RESPOSTA } from "./tarefas";

export interface PacoteDaRevisao {
  candidate: string;
  commercialEvidence?: readonly EvidenciaComercial[];
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
  const pacote = {
    mensagem: p.candidate,
    evidencias: (p.commercialEvidence ?? []).map(e => ({ titulo: e.titulo, conteudo: e.conteudo, origem: e.origem })),
    ...(p.conversationContext ? { contexto_conversa: p.conversationContext } : {}),
  };
  return JSON.parse(scrubMessage(JSON.stringify(pacote))) as Record<string, unknown>;
}

export function perguntasDaRevisao(temEvidencias: boolean): Record<SinalDaRevisao, Pergunta> {
  // Cada noul recebe só sua regra, sem o formato JSON do revisor LLM.
  // As duas primeiras regras são compartilhadas, não uma política paralela.
  return {
    comercial: {
      tipo: "noul",
      instrucao: temEvidencias ? PERGUNTA_COMERCIAL_COM_EVIDENCIAS : PERGUNTA_COMERCIAL_SEM_EVIDENCIA,
      criterios: {
        true: "A candidata contém compromisso COMERCIAL concreto não autorizado pelas evidências.",
        false: "Não contém compromisso comercial não autorizado; oferta cadastrada e linguagem comercial natural podem passar.",
      },
    },
    retorno: {
      tipo: "noul", instrucao: PERGUNTA_RETORNO_SEM_FORMATO,
      criterios: {
        true: "A candidata assume pendência de retaguarda, transferência/registro em execução ou concluído, ou retorno ao cliente.",
        false: "A candidata não assume pendência: descreve serviço, cita autores, convida, pede aviso AO CLIENTE ou oferece transferência sujeita a consentimento.",
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
  if (s === "comercial") return v.isPromise;
  if (s === "retorno") return v.prometeuRetornoHumano;
  return v.prometeuRetornoHumano && v.retornoSoDoAssistente;
}

/** Três verificações; UMA linha de custo. Não persistir candidata/evidências/histórico. */
async function gravarRevisao(
  pool: pg.Pool, ids: Ids, estado: "observando" | "decidindo",
  r: Extract<ResultadoDaDecisao, { ok: true }>, probabilidades: ProbabilidadesDaRevisao | null,
  reserva: PromiseClassification | null, cobriu: boolean, log: Logger,
): Promise<void> {
  try {
    const verificacoes = probabilidades ? SINAIS_DA_REVISAO.map(s => ({
      probabilidade: probabilidades[s],
      confianca: Math.max(probabilidades[s], 1 - probabilidades[s]),
      rotulo: `${s}:${probabilidades[s] >= 0.5 ? "sim" : "nao"}`,
      atual: reserva ? `${s}:${sinalDoVeredito(reserva, s) ? "sim" : "nao"}` : null,
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
      organizationId: ids.tenantId, ponto: "promise_semantic",
      estado: pacoteParaJev(pacote), perguntas: perguntasDaRevisao(Boolean(pacote.commercialEvidence?.length)),
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
    if (linhaId && estado === "decidindo") {
      try { await pool.query("update public.llm_calls set origem_da_escolha = 'reserva_do_jev' where id = $1 and organization_id = $2", [linhaId, ids.tenantId]); } catch { /* Telemetria não veta atendimento. */ }
    }
    return v;
  }
  const calculo = decidirRevisao(r.respostas);
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
    await gravarRevisao(pool, ids, estado, r, calculo.motivo !== "resposta_ilegivel" ? calculo.probabilidades : null, v, estado === "decidindo" && v !== null, deps.log);
  }
}
