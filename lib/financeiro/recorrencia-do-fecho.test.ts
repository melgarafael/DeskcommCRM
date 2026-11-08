/**
 * O CERCO DO FINANCEIRO NO FECHO (#3602, fatia 5).
 *
 * `moveARecorrenciaNoFecho` é a única cópia do "nunca derrubar o movimento":
 * as três portas que fecham negócio (arrasto, Ganhar/Perder, lote) chamam este
 * módulo, e não as funções do molde direto. Aqui se mede o cerco — qual função
 * é chamada em cada desfecho, o silêncio da etapa comum, e que NADA que o
 * financeiro faça (inclusive o admin client lançando) escapa como exceção.
 *
 * A REGRA do molde (valor, dia, conta, módulo, idempotência) continua medida em
 * `recorrencia-do-negocio.test.ts`; este arquivo não repete nenhuma dela.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Os dois dublês são tipados com a UNIÃO real de desfecho: sem isso o `mock`
// infere `{ estado: string }` e o caso de falha (`estado: "falhou", erro`) não
// compila — foi assim que o `verify-parte` pegou o TS2353 (#3602, fatia 5).
const financeiro = vi.hoisted(() => ({
  recorrenciaDoNegocio: vi.fn(
    async (): Promise<{ estado: string; erro?: string }> => ({ estado: "criado" }),
  ),
  desativaRecorrenciaDoNegocio: vi.fn(
    async (): Promise<{ estado: string; erro?: string }> => ({ estado: "desativado" }),
  ),
}));
vi.mock("@/lib/financeiro/recorrencia-do-negocio", () => financeiro);

const admin = vi.hoisted(() => ({ createAdminClient: vi.fn(() => ({ admin: true })) }));
vi.mock("@/lib/supabase/admin", () => admin);

import { moveARecorrenciaNoFecho } from "./recorrencia-do-fecho";

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const USER = "11111111-1111-4111-8111-111111111111";
const CRIADO_EM = "2026-03-05T23:30:00.000Z";

const base = {
  organizationId: ORG,
  leadId: LEAD,
  pipelineId: FUNIL,
  criadoEm: CRIADO_EM,
  userId: USER,
  origem: "teste",
  requestId: "req-3602",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("moveARecorrenciaNoFecho", () => {
  it("etapa comum não chama nada e nem cria admin client", async () => {
    await moveARecorrenciaNoFecho({ ...base, etapa: { is_won: false, is_lost: false } });

    expect(financeiro.recorrenciaDoNegocio).not.toHaveBeenCalled();
    expect(financeiro.desativaRecorrenciaDoNegocio).not.toHaveBeenCalled();
    expect(admin.createAdminClient).not.toHaveBeenCalled();
  });

  it("ganho com recorrência declarada cria o molde, com os dados do negócio", async () => {
    await moveARecorrenciaNoFecho({
      ...base,
      etapa: { is_won: true, is_lost: false },
      valorRecorrente: 50_000,
    });

    expect(financeiro.recorrenciaDoNegocio).toHaveBeenCalledTimes(1);
    expect(financeiro.recorrenciaDoNegocio).toHaveBeenCalledWith(
      { admin: true },
      {
        organizationId: ORG,
        leadId: LEAD,
        pipelineId: FUNIL,
        valorCents: 50_000,
        criadoEm: CRIADO_EM,
        userId: USER,
      },
    );
    expect(financeiro.desativaRecorrenciaDoNegocio).not.toHaveBeenCalled();
  });

  it("ganho sem valor declarado não chega ao banco (o valor único não vira molde)", async () => {
    await moveARecorrenciaNoFecho({ ...base, etapa: { is_won: true, is_lost: false } });
    await moveARecorrenciaNoFecho({
      ...base,
      etapa: { is_won: true, is_lost: false },
      valorRecorrente: null,
    });

    expect(financeiro.recorrenciaDoNegocio).not.toHaveBeenCalled();
    expect(financeiro.desativaRecorrenciaDoNegocio).not.toHaveBeenCalled();
  });

  it("perda desativa o molde DO negócio, e não cria outro", async () => {
    await moveARecorrenciaNoFecho({
      ...base,
      etapa: { is_won: false, is_lost: true },
      valorRecorrente: 50_000,
    });

    expect(financeiro.desativaRecorrenciaDoNegocio).toHaveBeenCalledTimes(1);
    expect(financeiro.desativaRecorrenciaDoNegocio).toHaveBeenCalledWith({ admin: true }, {
      organizationId: ORG,
      leadId: LEAD,
    });
    expect(financeiro.recorrenciaDoNegocio).not.toHaveBeenCalled();
  });

  it("desfecho `falhou` vira log, não exceção", async () => {
    financeiro.recorrenciaDoNegocio.mockResolvedValueOnce({ estado: "falhou", erro: "sem conta" });

    await expect(
      moveARecorrenciaNoFecho({
        ...base,
        etapa: { is_won: true, is_lost: false },
        valorRecorrente: 50_000,
      }),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("função que LANÇA não escapa para quem moveu o card", async () => {
    financeiro.desativaRecorrenciaDoNegocio.mockRejectedValueOnce(new Error("banco fora"));

    await expect(
      moveARecorrenciaNoFecho({ ...base, etapa: { is_won: false, is_lost: true } }),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("admin client indisponível (sem service role) também não escapa", async () => {
    admin.createAdminClient.mockImplementationOnce(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY ausente");
    });

    await expect(
      moveARecorrenciaNoFecho({
        ...base,
        etapa: { is_won: true, is_lost: false },
        valorRecorrente: 50_000,
      }),
    ).resolves.toBeUndefined();
    // Nem chegou a tentar: o financeiro ficou de fora e o movimento continua.
    expect(financeiro.recorrenciaDoNegocio).not.toHaveBeenCalled();
  });
});
