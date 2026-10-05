/**
 * A ABA "EXECUÇÕES" TEM QUE LER O MOTOR QUE RESPONDE.
 *
 * Par de `tests/unit/execucao-do-agente-tem-dono.test.ts`: lá se guarda a
 * ESCRITA (`llm_calls.agent_id` entra no INSERT), aqui a LEITURA (a rota da aba
 * lê `llm_calls` e traduz para o shape que a tela desenha).
 *
 * ─── O defeito ─────────────────────────────────────────────────────────────
 *
 * A rota lia `ai_agent_runs`. Medido na VPS em 2026-08-30: `ai_agent_runs` com
 * **0 linhas**, `llm_calls` com **130** de `purpose='agent_turn'` na mesma org,
 * a última no mesmo dia em que a tela dizia "Nenhuma execução ainda". Os dois
 * escritores de `ai_agent_runs` no repo são o dispatcher legado — cujo cron
 * devolve `{ skipped: true, deprecated: true }` — e o runner legado.
 *
 * ─── Por que o teste é sobre a TRADUÇÃO ────────────────────────────────────
 *
 * Trocar a tabela é metade; a outra é o vocabulário. `llm_calls.status` fala
 * `'ok' | 'erro'`, e a tabela da tela (`RunsTable`, `STATUS_VARIANT`) desenha
 * `completed | failed`. Sem traduzir, o badge cai no `?? "outline"` e mostra a
 * palavra crua do banco — a tela funcionaria e mentiria de outro jeito.
 */
import { describe, expect, it } from "vitest";

import { paraLinhaDeExecucao } from "@/app/api/v1/ai/agents/[id]/runs/route";

const ORG = "22222222-2222-4222-8222-222222222222";
const AGENTE = "88888888-8888-4888-8888-888888888888";

function chamada(over: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    organization_id: ORG,
    agent_id: AGENTE,
    contact_id: null,
    purpose: "agent_turn",
    status: "ok",
    error_code: null,
    error_message: null,
    input_tokens: 22270,
    output_tokens: 115,
    cost_cents: 1.5,
    latency_ms: 14354,
    created_at: "2026-08-30T16:58:38.199Z",
    ...over,
  } as never;
}

describe("aba de Execuções — llm_calls traduzido para a tela", () => {
  it("um turno OK vira 'completed' — o vocabulário que o badge sabe desenhar", () => {
    const linha = paraLinhaDeExecucao(chamada());
    // 'ok' cru cairia no fallback do STATUS_VARIANT e apareceria como "ok" na
    // tela, fora do vocabulário que ela documenta.
    expect(linha["status"]).toBe("completed");
  });

  it("um turno com ERRO vira 'failed' e preserva o motivo", () => {
    const linha = paraLinhaDeExecucao(
      chamada({ status: "erro", error_code: "rate_limit", error_message: "429 do provedor" }),
    );
    expect(linha["status"]).toBe("failed");
    // "o agente falhou, por quê?" é a pergunta que a aba existe para responder:
    // perder o código do erro na tradução esvaziaria o conserto.
    expect(linha["error_code"]).toBe("rate_limit");
    expect(linha["error_message"]).toBe("429 do provedor");
  });

  it("os números do turno chegam à tela com os nomes que ela usa", () => {
    const linha = paraLinhaDeExecucao(chamada());
    expect(linha["tokens_in"]).toBe(22270);
    expect(linha["tokens_out"]).toBe(115);
    expect(linha["latency_ms"]).toBe(14354);
    expect(linha["cost_cents"]).toBe(1.5);
    // A tabela ordena e rotula por `started_at`; `llm_calls` só tem `created_at`.
    expect(linha["started_at"]).toBe("2026-08-30T16:58:38.199Z");
  });

  it("o que llm_calls NÃO tem sai null — nunca zero fabricado", () => {
    const linha = paraLinhaDeExecucao(chamada());
    // Um `steps_count: 0` afirmaria que o turno não deu passo nenhum, o que é
    // diferente de "esta fonte não registra passos". A tela desenha null como "—".
    expect(linha["steps_count"]).toBeNull();
    expect(linha["tool_calls"]).toBeNull();
    expect(linha["agent_version_id"]).toBeNull();
  });

  it("status desconhecido não vira 'completed' por acidente", () => {
    // Falha ABERTA na informação: um vocabulário novo no banco tem de aparecer
    // como ele é, não ser silenciosamente promovido a sucesso.
    const linha = paraLinhaDeExecucao(chamada({ status: "cancelado" }));
    expect(linha["status"]).toBe("cancelado");
  });

  it("a prévia (botão Testar) sai como dry-run; o turno de produção não", () => {
    // A fonte do marcador é `llm_calls.purpose` com `contact_id` nulo (o sandbox
    // roda sem contato), não o identificador de job.
    expect(paraLinhaDeExecucao(chamada({ purpose: "agent_preview" }))["is_dry_run"]).toBe(true);
    expect(paraLinhaDeExecucao(chamada({ purpose: "agent_turn" }))["is_dry_run"]).toBe(false);
    // A prévia NÃO ganha versão nem vínculo de run inventados: `llm_calls` não
    // guarda a versão, e `job_id` não é o `run_id` do teste.
    const previa = paraLinhaDeExecucao(chamada({ purpose: "agent_preview" }));
    expect(previa["agent_version_id"]).toBeNull();
    expect(previa["id"]).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("o rascunho do modo ASSISTIDO é execução real, não teste", () => {
    // Mesmo purpose da prévia (`agent_preview`), mas sobre um contato de verdade:
    // marcá-lo como teste diria ao operador que um atendimento real foi ensaio.
    const assistido = paraLinhaDeExecucao(chamada({ purpose: "agent_preview", contact_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }));
    expect(assistido["is_dry_run"]).toBe(false);
  });

  it("propósito ausente ou desconhecido não vira dry-run por acidente", () => {
    expect(paraLinhaDeExecucao(chamada({ purpose: null }))["is_dry_run"]).toBe(false);
    expect(paraLinhaDeExecucao(chamada({ purpose: "classify_stage" }))["is_dry_run"]).toBe(false);
  });

  it("a execução carrega o agente — é o que permite a aba filtrar", () => {
    const linha = paraLinhaDeExecucao(chamada());
    expect(linha["agent_id"]).toBe(AGENTE);
  });
});
