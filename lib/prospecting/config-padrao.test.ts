import { describe, expect, it, vi } from "vitest";

import { configPadraoDaOrganizacao, INSTRUCAO_NEUTRA, QUALIFICACAO_NEUTRA } from "./config-padrao";

const ORG = "99999999-9999-4999-8999-999999999999";
const AGENTE = "55555555-5555-4555-8555-555555555555";
const CONFIG = {
  agent_id: AGENTE,
  channel_session_id: "66666666-6666-4666-8666-666666666666",
  pipeline_id: "77777777-7777-4777-8777-777777777777",
  stage_id: "88888888-8888-4888-8888-888888888888",
  qualified_stage_id: "99999999-9999-4999-8999-999999999998",
  instruction: "Apresente a clínica com educação.",
  qualification: "Tem interesse em agendar avaliação.",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "legítimo interesse, registro 1",
};

describe("configPadraoDaOrganizacao", () => {
  it("devolve a config completa mais recente cujo agente atende", async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ config: { instruction: "parcial" } }, { config: CONFIG }] })) };
    const r = await configPadraoDaOrganizacao(db, ORG);
    expect(r?.agenteId).toBe(AGENTE);
    // Só o AGENTE atravessa: o roteiro da campanha antiga (segmento dela) não.
    expect(r?.config.instruction).toBe(INSTRUCAO_NEUTRA);
    expect(r?.config.qualification).toBe(QUALIFICACAO_NEUTRA);
    expect(JSON.stringify(r?.config)).not.toContain("Apresente a clínica");
    expect(JSON.stringify(r?.config)).not.toContain("Tem interesse em agendar");
  });

  it("as ofertas da campanha antiga também não atravessam", async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ config: { ...CONFIG, ofertas: ["automacao_crm"] } }] })) };
    const r = await configPadraoDaOrganizacao(db, ORG);
    expect(r?.config).not.toHaveProperty("ofertas");
  });

  it("nenhuma campanha com agente: null", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    expect(await configPadraoDaOrganizacao(db, ORG)).toBeNull();
  });

  it("só config parcial ou inválida: null (nunca lança)", async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ config: { agent_id: AGENTE } }, { config: null }] })) };
    expect(await configPadraoDaOrganizacao(db, ORG)).toBeNull();
  });

  it("a consulta filtra a organização na campanha E no agente, e exige agente que atende", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    await configPadraoDaOrganizacao(db, ORG);
    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params[0]).toBe(ORG);
    expect(sql).toContain("pc.organization_id = $1");
    expect(sql).toContain("a.organization_id = pc.organization_id");
    for (const exigencia of ["published_version_id is not null", "archived_at is null", "paused_at is null", "operation_mode = 'automatic'"])
      expect(sql).toContain(exigencia);
  });
});
