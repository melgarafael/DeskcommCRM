import { describe, expect, it, vi, beforeEach } from "vitest";
import type pg from "pg";

vi.mock("../edge/llm/run-model-call", () => ({ runModelCall: vi.fn() }));

import { runModelCall } from "../edge/llm/run-model-call";
import {
  limparResumo,
  montarMensagemDoResumo,
  createFlowSummaryHandler,
  type FluxoParaResumir,
} from "./flow-summary";

const runModelCallMock = vi.mocked(runModelCall);

const GRAFO = {
  nodes: [
    { id: "t", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
    {
      id: "c1",
      type: "collect",
      label: "Cidade",
      position: { x: 1, y: 0 },
      config: { key: "cidade", label: "Cidade", type: "text", required: true, permite_correcao: true },
    },
    { id: "e", type: "end", label: "Fim", position: { x: 2, y: 0 }, config: { outcome: "converted" } },
  ],
  edges: [
    { id: "a", source: "t", target: "c1", priority: 0, condition: { type: "always" } },
    { id: "b", source: "c1", target: "e", priority: 0, condition: { type: "always" } },
  ],
};

describe("montarMensagemDoResumo", () => {
  const dados: FluxoParaResumir = {
    nomeDoFluxo: "Qualificação",
    campos: [
      { label: "Cidade", key: "cidade", valor: "Campinas" },
      { label: "CNH", key: "cnh", valor: null },
    ],
    eventos: [
      { kind: "resposta", field_key: "cidade" },
      { kind: "fora_do_fluxo", field_key: "cnh" },
      { kind: "esgotado", field_key: "cnh" },
    ],
  };

  it("traz o fluxo, as respostas na ordem e marca o não respondido", () => {
    const msg = montarMensagemDoResumo(dados);
    expect(msg).toContain("Qualificação");
    expect(msg).toContain("- Cidade: Campinas");
    expect(msg).toContain("- CNH: (não respondido)");
    expect(msg.indexOf("- Cidade:")).toBeLessThan(msg.indexOf("- CNH:"));
  });

  it("resume os sinais (desvios e perguntas esgotadas)", () => {
    const msg = montarMensagemDoResumo(dados);
    expect(msg).toContain("desvios do roteiro (cliente falou de outro assunto): 1");
    expect(msg).toContain("perguntas esgotadas sem resposta: 1");
  });
});

describe("limparResumo", () => {
  it("tira cerca de código e colapsa espaço", () => {
    expect(limparResumo("```\nCliente de Campinas.\n```")).toBe("Cliente de Campinas.");
    expect(limparResumo("  duas   linhas\njuntas  ")).toBe("duas linhas juntas");
  });

  it("vazio vira null (o chamador re-tenta pela fila)", () => {
    expect(limparResumo("   \n  ")).toBeNull();
    expect(limparResumo("```\n```")).toBeNull();
  });

  it("corta no teto da coluna", () => {
    expect(limparResumo("a".repeat(5000))?.length).toBe(2000);
  });
});

describe("createFlowSummaryHandler", () => {
  beforeEach(() => runModelCallMock.mockReset());

  function poolFake(status = "completed") {
    const sqls: string[] = [];
    const params: unknown[][] = [];
    const query = async (sql: string, values: unknown[] = []) => {
      sqls.push(sql);
      params.push(values);
      if (/from followup_enrollments e/.test(sql)) {
        return { rows: [{ pointer_id: "p1", status, nome: "Qualificação", graph: GRAFO }] };
      }
      if (/from contact_flow_data/.test(sql)) {
        return { rows: [{ field_key: "cidade", value: "Campinas" }] };
      }
      if (/from contact_flow_events/.test(sql)) {
        return { rows: [{ kind: "resposta", field_key: "cidade" }] };
      }
      return { rows: [] };
    };
    return { pool: { query } as unknown as pg.Pool, sqls, params };
  }

  const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never;
  const deps = { llmCfg: {} as never, log: logger };

  it("grava a síntese do modelo no completion_note", async () => {
    runModelCallMock.mockResolvedValue({ result: { text: "  Cliente de Campinas.  " } } as never);
    const { pool, sqls, params } = poolFake();
    await createFlowSummaryHandler(deps)(
      {
        id: "job1",
        organization_id: "org",
        contact_id: "ct",
        payload: { enrollment_id: "enr" },
      } as never,
      pool,
    );
    const upd = sqls.findIndex((s) => /update followup_enrollments/.test(s));
    expect(upd).toBeGreaterThanOrEqual(0);
    expect(params[upd]).toContain("Cliente de Campinas.");
    // A chamada passou pelo ponto registrado.
    expect(runModelCallMock.mock.calls[0]?.[2]).toMatchObject({ purpose: "flow_summary" });
  });

  it("não resume enrollment que não concluiu (nem chama o modelo)", async () => {
    const { pool, sqls } = poolFake("active");
    await createFlowSummaryHandler(deps)(
      {
        id: "job1",
        organization_id: "org",
        contact_id: "ct",
        payload: { enrollment_id: "enr" },
      } as never,
      pool,
    );
    expect(runModelCallMock).not.toHaveBeenCalled();
    expect(sqls.some((s) => /update followup_enrollments/.test(s))).toBe(false);
  });

  it("sem enrollment_id no payload, lança (job re-tentado/observado)", async () => {
    const { pool } = poolFake();
    await expect(
      createFlowSummaryHandler(deps)(
        { id: "job1", organization_id: "org", contact_id: "ct", payload: {} } as never,
        pool,
      ),
    ).rejects.toThrow(/enrollment_id/);
  });
});
