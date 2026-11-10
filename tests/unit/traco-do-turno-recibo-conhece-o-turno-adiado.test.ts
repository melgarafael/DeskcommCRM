/**
 * O recibo do traço tem de dizer POR QUE o turno não falou (#2869).
 *
 * O turno adiado — cap de envio, janela horária, veto de before-send, handoff —
 * termina em `JobSettledError`, e o traço grava o `name` DESSE erro em
 * `agent_turn_traces.error_code` (`lib/agent-engine/agent/inbound-turn.ts`, o
 * `catch` que marca `status = 'aborted'`). A projeção do leitor só entrega
 * código que ela conhece; sem o literal `job_settled` na lista, todo turno
 * adiado chegava à API como `internal_error` — indistinguível de um defeito de
 * verdade.
 *
 * O par `name` do erro × literal do leitor é medido aqui pelo valor real da
 * classe, não por uma string repetida no teste: renomear o erro sem renomear o
 * leitor reprova esta guarda.
 */
import { describe, expect, it } from "vitest";

import { JobSettledError } from "@/lib/agent-engine/agent/inbound-turn";
import { reciboDoTraco } from "@/lib/agent-engine/agent/recibo-do-traco";

const ID = "b3201000-0000-4000-8000-000000000001";

function linha(campos: Record<string, unknown>) {
  return {
    id: ID,
    job_id: ID,
    preview_run_id: null,
    conversation_id: ID,
    contact_id: ID,
    agent_id: ID,
    agent_version_id: ID,
    is_dry_run: false,
    status: "aborted",
    abort_reason: null,
    error_code: null,
    provider: "openai",
    model: "gpt-4.1-mini",
    messages_sent: 0,
    historico_mensagens: null,
    tokens_in: 0,
    tokens_out: 0,
    cost_cents: 0,
    latency_ms: 0,
    skills: [],
    ferramentas: [],
    ferramentas_truncadas: false,
    kb_sources: [],
    created_at: new Date().toISOString(),
    ...campos,
  } as never;
}

describe("o recibo do traço conhece o turno adiado", () => {
  it("o código que o turno adiado grava chega ao leitor inteiro", () => {
    const erro = new JobSettledError("envio fixo vetado pelo sink (is_blocked)");
    expect(erro.name).toBe("job_settled");

    const recibo = reciboDoTraco(linha({ status: "aborted", error_code: erro.name }));
    expect(recibo.error_code).toBe("job_settled");
  });

  it("texto livre continua virando internal_error", () => {
    const recibo = reciboDoTraco(
      linha({ status: "failed", error_code: "o cliente pediu desconto e o modelo enrolou" }),
    );
    expect(recibo.error_code).toBe("internal_error");
  });
});
