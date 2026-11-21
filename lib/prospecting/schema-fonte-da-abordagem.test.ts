/**
 * O schema da FONTE DA ABORDAGEM: `config.fonte_da_abordagem` (default `estrategia`), o campo
 * opcional `fonte_da_abordagem` de `edit_briefing` (a troca com a campanha pausada) e a ação
 * `move_list`. O efeito sobre linhas (só pausada, sem tocar quem já tem contato) é dos
 * invariantes de banco; aqui mora a forma aceita.
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

describe("edit_briefing leva a fonte da abordagem", () => {
  const valido = {
    action: "edit_briefing",
    id: uuid("6"),
    instruction: CONFIG.instruction,
    qualification: CONFIG.qualification,
    ofertas: ["site"],
  };

  it("a fonte é opcional: sem ela, a edição de texto segue aceita e não mexe na fonte", () => {
    const r = prospectingInputSchema.safeParse(valido);
    expect(r.success).toBe(true);
    if (r.success && r.data.action === "edit_briefing") expect(r.data.fonte_da_abordagem).toBeUndefined();
  });

  it("aceita as duas fontes do vocabulário", () => {
    for (const fonte of FONTES_DA_ABORDAGEM) {
      const r = prospectingInputSchema.safeParse({ ...valido, fonte_da_abordagem: fonte });
      expect(r.success).toBe(true);
      if (r.success && r.data.action === "edit_briefing") expect(r.data.fonte_da_abordagem).toBe(fonte);
    }
  });

  it("recusa fonte fora do vocabulário", () => {
    for (const v of ["site", "", null, 1]) {
      expect(
        prospectingInputSchema.safeParse({ ...valido, fonte_da_abordagem: v }).success,
        `fonte_da_abordagem=${JSON.stringify(v)} não pode passar`,
      ).toBe(false);
    }
  });

  it("a ação adjust_approach não existe mais: a troca passa por edit_briefing", () => {
    expect(
      prospectingInputSchema.safeParse({ action: "adjust_approach", id: uuid("6"), fonte_da_abordagem: "agente" })
        .success,
    ).toBe(false);
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
