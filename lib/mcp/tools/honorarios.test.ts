import { describe, expect, it } from "vitest";

import { crmGetHonorariosContrato, crmListHonorariosParcelas } from "./honorarios";
import type { McpContext } from "../types";

const ORG_ID = "22222222-2222-4222-8222-222222222222";

function ctxDe(
  resultado: { data: unknown; error: { code?: string; message?: string } | null },
  filtrosVistos: Array<{ coluna: string; valor: unknown }> = [],
): McpContext {
  const query = {
    select: () => query,
    eq: (coluna: string, valor: unknown) => {
      filtrosVistos.push({ coluna, valor });
      return query;
    },
    order: () => Promise.resolve(resultado),
    maybeSingle: () => Promise.resolve(resultado),
  };
  return {
    organizationId: ORG_ID,
    role: "agent",
    actor: { type: "ai_agent", id: "run-1", agent_id: "agent-1" },
    apiTokenId: "33333333-3333-4333-8333-333333333333",
    requestId: "44444444-4444-4444-8444-444444444444",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from: () => query } as any,
  } as McpContext;
}

describe("crm_get_honorarios_contrato", () => {
  it("filtra por organização E pelo lead pedido, nunca só pelo lead", async () => {
    const filtros: Array<{ coluna: string; valor: unknown }> = [];
    const contrato = { id: "c1", modelo: "fixo", valor_fixo_cents: 500000 };
    const ctx = ctxDe({ data: contrato, error: null }, filtros);

    const resultado = (await crmGetHonorariosContrato.handler(
      { lead_id: "11111111-1111-4111-8111-111111111111" },
      ctx,
    )) as { contrato: unknown };

    expect(resultado.contrato).toEqual(contrato);
    expect(filtros).toEqual([
      { coluna: "organization_id", valor: ORG_ID },
      { coluna: "lead_id", valor: "11111111-1111-4111-8111-111111111111" },
    ]);
  });

  it("devolve contrato: null quando o caso não tem contrato — não é erro", async () => {
    const ctx = ctxDe({ data: null, error: null });

    const resultado = (await crmGetHonorariosContrato.handler(
      { lead_id: "11111111-1111-4111-8111-111111111111" },
      ctx,
    )) as { contrato: unknown };

    expect(resultado.contrato).toBeNull();
  });

  it("lança com uma mensagem clara quando o módulo não está instalado (42P01)", async () => {
    const ctx = ctxDe({ data: null, error: { code: "42P01", message: "relation does not exist" } });

    await expect(
      crmGetHonorariosContrato.handler(
        { lead_id: "11111111-1111-4111-8111-111111111111" },
        ctx,
      ),
    ).rejects.toThrow(/módulo de honorários não está instalado/);
  });
});

describe("crm_list_honorarios_parcelas", () => {
  it("lista as parcelas do contrato pedido, filtrando por organização", async () => {
    const filtros: Array<{ coluna: string; valor: unknown }> = [];
    const parcelas = [
      { id: "p1", numero: 1, vencimento: "2026-10-01", valor_cents: 50000, status: "pendente" },
      { id: "p2", numero: 2, vencimento: "2026-11-01", valor_cents: 50000, status: "pendente" },
    ];
    const ctx = ctxDe({ data: parcelas, error: null }, filtros);

    const resultado = (await crmListHonorariosParcelas.handler(
      { contrato_id: "c1" },
      ctx,
    )) as { parcelas: unknown[] };

    expect(resultado.parcelas).toEqual(parcelas);
    expect(filtros).toEqual([
      { coluna: "organization_id", valor: ORG_ID },
      { coluna: "contrato_id", valor: "c1" },
    ]);
  });

  it("lança com uma mensagem clara quando o módulo não está instalado (42P01)", async () => {
    const ctx = ctxDe({ data: null, error: { code: "42P01", message: "relation does not exist" } });

    await expect(
      crmListHonorariosParcelas.handler({ contrato_id: "c1" }, ctx),
    ).rejects.toThrow(/módulo de honorários não está instalado/);
  });
});
