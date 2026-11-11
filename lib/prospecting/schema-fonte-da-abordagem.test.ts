/**
 * O schema da FONTE DA ABORDAGEM: `config.fonte_da_abordagem` (default `estrategia`) e as
 * ações `adjust_approach` e `move_list`. O efeito sobre linhas (só pausada, sem tocar quem
 * já tem contato) é dos invariantes de banco; aqui mora a forma aceita.
 */
import { describe, expect, it } from "vitest";

import { FONTES_DA_ABORDAGEM, campaignConfigSchema, prospectingInputSchema } from "./schema";

const uuid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const CONFIG = {
  agent_id: uuid("1"),
  channel_session_id: uuid("2"),
  pipeline_id: uuid("3"),
  stage_id: uuid("4"),
  qualified_stage_id: uuid("5"),
  instruction: "Apresente a clínica com educação.",
  qualification: "Tem interesse em agendar avaliação.",
  legal_basis_ref: "legítimo interesse, registro 1",
};

describe("config.fonte_da_abordagem", () => {
  it("o vocabulário é estratégia e agente", () => {
    expect([...FONTES_DA_ABORDAGEM]).toEqual(["estrategia", "agente"]);
  });

  it("ausente vira `estrategia`: configuração gravada antes da chave segue igual", () => {
    expect(campaignConfigSchema.parse(CONFIG).fonte_da_abordagem).toBe("estrategia");
  });

  it("aceita `agente` e `estrategia` explícitos", () => {
    expect(campaignConfigSchema.parse({ ...CONFIG, fonte_da_abordagem: "agente" }).fonte_da_abordagem).toBe("agente");
    expect(campaignConfigSchema.parse({ ...CONFIG, fonte_da_abordagem: "estrategia" }).fonte_da_abordagem).toBe(
      "estrategia",
    );
  });

  it("recusa valor fora do vocabulário", () => {
    for (const v of ["site", "AGENTE", "", null, 1, true]) {
      expect(
        campaignConfigSchema.safeParse({ ...CONFIG, fonte_da_abordagem: v }).success,
        `fonte_da_abordagem=${JSON.stringify(v)} não pode passar`,
      ).toBe(false);
    }
  });

  it("a ação `start` leva a fonte junto com a config", () => {
    const r = prospectingInputSchema.safeParse({
      action: "start",
      id: uuid("6"),
      config: { ...CONFIG, fonte_da_abordagem: "agente" },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.action === "start") expect(r.data.config.fonte_da_abordagem).toBe("agente");
  });
});

describe("a ação adjust_approach", () => {
  const valido = { action: "adjust_approach", id: uuid("6"), fonte_da_abordagem: "agente" };

  it("aceita o mínimo: id + fonte (a instrução é opcional)", () => {
    expect(prospectingInputSchema.safeParse(valido).success).toBe(true);
    expect(prospectingInputSchema.safeParse({ ...valido, fonte_da_abordagem: "estrategia" }).success).toBe(true);
  });

  it("aceita uma instrução nova de 10 a 2000 caracteres, aparada", () => {
    const r = prospectingInputSchema.safeParse({ ...valido, instruction: "  Fale como a clínica fala.  " });
    expect(r.success).toBe(true);
    if (r.success && r.data.action === "adjust_approach") {
      expect(r.data.instruction).toBe("Fale como a clínica fala.");
    }
    expect(prospectingInputSchema.safeParse({ ...valido, instruction: "x".repeat(2000) }).success).toBe(true);
  });

  it("recusa instrução curta demais, longa demais ou só espaços", () => {
    expect(prospectingInputSchema.safeParse({ ...valido, instruction: "curta" }).success).toBe(false);
    expect(prospectingInputSchema.safeParse({ ...valido, instruction: "x".repeat(2001) }).success).toBe(false);
    expect(prospectingInputSchema.safeParse({ ...valido, instruction: "           " }).success).toBe(false);
  });

  it("exige a fonte, e ela precisa estar no vocabulário", () => {
    expect(prospectingInputSchema.safeParse({ action: "adjust_approach", id: uuid("6") }).success).toBe(false);
    expect(prospectingInputSchema.safeParse({ ...valido, fonte_da_abordagem: "site" }).success).toBe(false);
  });

  it("exige id uuid", () => {
    expect(prospectingInputSchema.safeParse({ ...valido, id: "nao-e-uuid" }).success).toBe(false);
    expect(
      prospectingInputSchema.safeParse({ action: "adjust_approach", fonte_da_abordagem: "agente" }).success,
    ).toBe(false);
  });

  it("recusa qualquer campo além dos três — conexão, agente, funil e base legal ficam fechados", () => {
    for (const campo of [
      "qualification",
      "agent_id",
      "channel_session_id",
      "pipeline_id",
      "stage_id",
      "qualified_stage_id",
      "legal_basis_ref",
      "daily_limit",
      "organization_id",
    ]) {
      expect(
        prospectingInputSchema.safeParse({ ...valido, [campo]: "x" }).success,
        `o campo ${campo} não pode passar por adjust_approach`,
      ).toBe(false);
    }
  });
});

describe("a ação move_list", () => {
  const valido = { action: "move_list", id: uuid("6"), request_id: uuid("7") };

  it("aceita o mínimo: id da campanha + request_id", () => {
    expect(prospectingInputSchema.safeParse(valido).success).toBe(true);
  });

  it("exige o request_id (a idempotência) e os dois precisam ser uuid", () => {
    expect(prospectingInputSchema.safeParse({ action: "move_list", id: uuid("6") }).success).toBe(false);
    expect(prospectingInputSchema.safeParse({ ...valido, request_id: "abc" }).success).toBe(false);
    expect(prospectingInputSchema.safeParse({ ...valido, id: "abc" }).success).toBe(false);
  });

  it("recusa campo a mais: a campanha nova nasce em rascunho, sem escolher nada pela porta", () => {
    for (const campo of ["config", "target_id", "organization_id", "candidate_ids", "status"]) {
      expect(
        prospectingInputSchema.safeParse({ ...valido, [campo]: "x" }).success,
        `o campo ${campo} não pode passar por move_list`,
      ).toBe(false);
    }
  });
});
