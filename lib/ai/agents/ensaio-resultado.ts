/**
 * Contrato JSON do ensaio: gera a resposta e autoriza a entrega em campos
 * separados. Não envia WhatsApp.
 */
import {
  textoGeradoDoPreview,
  type PreviewResult,
} from "@/lib/agent-engine/agent/preview";
import {
  AVISO_CHECKPOINT_OMITIDO_ENSAIO,
  MOTIVO_CHECKPOINT_OMITIDO_ENSAIO,
} from "@/lib/agent-engine/agent/fechamento-do-ensaio";
import type { StatusDeEntregaDoEnsaio } from "@/lib/agent-engine/guardrails/classificacao-de-impedimento";
import { avaliarRespostaDeTeste } from "@/lib/ai/agents/avaliar-resposta-de-teste";

export const AVISO_RESPOSTA_NAO_ENVIADA =
  "Resposta gerada, mas não seria enviada agora.";

/** Quatro casas: evita `1.3674000000000002` da soma IEEE. */
export function formatarCentavos(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}

export function statusHttpDoEnsaio(entrega: StatusDeEntregaDoEnsaio): "ok" | "blocked" {
  return entrega === "allowed" ? "ok" : "blocked";
}

export function montarPayloadDoEnsaio(
  runId: string,
  result: PreviewResult,
  opts: { stub: boolean; wallMs: number },
): Record<string, unknown> {
  const generated_response = textoGeradoDoPreview(result);
  const delivery_status = result.delivery_status;
  const tools_offered = result.tools_offered ?? [];
  const tools_called = result.tools_called ?? [];
  const llm_purposes = result.llm_purposes ?? [];
  const steps = result.steps ?? [];
  return {
    run_id: runId,
    status: statusHttpDoEnsaio(delivery_status),
    generated_response,
    delivery_status,
    delivery_impediments: result.delivery_impediments ?? [],
    proposed_actions: result.proposals ?? [],
    tokens_in: result.tokens_in ?? 0,
    tokens_out: result.tokens_out ?? 0,
    cost_cents: formatarCentavos(result.cost_cents ?? 0),
    /** Relógio do ensaio (início → fim). Não é a soma das `llm_calls`. */
    latency_ms: opts.wallMs,
    /** Soma das latency_ms das chamadas. Pode superar o relógio quando há sobreposição. */
    llm_latency_ms: result.llm_latency_ms ?? 0,
    llm_purposes,
    steps_count: typeof result.steps_count === "number" ? result.steps_count : 0,
    tools_offered,
    tools_called,
    steps,
    checkpoint_generated: result.checkpoint_omitted !== true,
    checkpoint_omitted_reason:
      result.checkpoint_omitted === true ? (result.checkpoint_omitted_reason ?? MOTIVO_CHECKPOINT_OMITIDO_ENSAIO) : null,
    checkpoint_notice: result.checkpoint_omitted === true ? AVISO_CHECKPOINT_OMITIDO_ENSAIO : null,
    final_text: generated_response,
    tool_calls: {
      offered: tools_offered,
      called: tools_called,
    },
    candidates: result.candidates,
    proposals: result.proposals,
    impediments: result.impediments,
    security_impediments: result.security_impediments,
    restrictions: result.restrictions,
    stub: opts.stub,
    notice: delivery_status === "blocked" && generated_response ? AVISO_RESPOSTA_NAO_ENVIADA : null,
    guardrails: generated_response ? avaliarRespostaDeTeste(generated_response) : undefined,
  };
}
