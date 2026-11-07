/**
 * #4191 — a ESCRITA da classificação, contra um cliente falso.
 *
 * O que se prova aqui é o que a issue exige e que a régua pura não alcança:
 *  - a classificação NÃO toca `status`, `lost_reason` nem `closed_at` (nada
 *    vira perda, nada vira venda);
 *  - o UPDATE é condicionado (`nao_comercial_em is null`), então duas pessoas
 *    classificando ao mesmo tempo não se sobrescrevem;
 *  - a timeline e o audit recebem a decisão, e a reversão também;
 *  - a operação repetida não escreve de novo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import {
  classificaNegocioComoNaoComercial,
  reverteClassificacaoNaoComercial,
} from "./classificacao-comercial";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({ emitLeadActivity: vi.fn() }));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const ATOR = "11111111-1111-4111-8111-111111111111";

interface Chamada {
  tabela: string;
  patch?: Record<string, unknown>;
  filtros: Array<[string, string, unknown]>;
}

/**
 * Cliente falso: registra os filtros do UPDATE e devolve a linha que o teste
 * mandar. `linhasAfetadas: 0` simula a corrida — alguém classificou entre a
 * leitura e a escrita, e o filtro `.is("nao_comercial_em", null)` não casa.
 */
function clienteFalso(
  linha: Record<string, unknown> | null,
  opts: { linhasAfetadas?: number; erroNoUpdate?: string } = {},
) {
  const chamadas: Chamada[] = [];
  const from = (tabela: string) => {
    const chamada: Chamada = { tabela, filtros: [] };
    chamadas.push(chamada);
    const leitura = {
      select: () => leitura,
      eq: (coluna: string, valor: unknown) => {
        chamada.filtros.push(["eq", coluna, valor]);
        return leitura;
      },
      maybeSingle: async () => ({ data: linha, error: null }),
    };
    const escrita = {
      update: (patch: Record<string, unknown>) => {
        chamada.patch = patch;
        return escrita;
      },
      eq: (coluna: string, valor: unknown) => {
        chamada.filtros.push(["eq", coluna, valor]);
        return escrita;
      },
      is: (coluna: string, valor: unknown) => {
        chamada.filtros.push(["is", coluna, valor]);
        return escrita;
      },
      not: (coluna: string, operador: string, valor: unknown) => {
        chamada.filtros.push(["not", coluna, `${operador}:${String(valor)}`]);
        return escrita;
      },
      select: () => escrita,
      maybeSingle: async () => {
        if (opts.erroNoUpdate) return { data: null, error: { message: opts.erroNoUpdate } };
        if ((opts.linhasAfetadas ?? 1) === 0) return { data: null, error: null };
        return { data: { ...(linha ?? {}), ...(chamada.patch ?? {}) }, error: null };
      },
    };
    return { ...leitura, ...escrita, select: leitura.select, update: escrita.update };
  };
  return { cliente: { from } as unknown as SupabaseClient, chamadas };
}

const aberto = (extra: Record<string, unknown> = {}) => ({
  id: LEAD,
  organization_id: ORG,
  contact_id: "44444444-4444-4444-8444-444444444444",
  status: "open",
  nao_comercial_em: null,
  nao_comercial_motivo: null,
  nao_comercial_por: null,
  ...extra,
});

beforeEach(() => {
  vi.mocked(emitLeadActivity).mockReset().mockResolvedValue({ ok: true } as never);
  vi.mocked(audit).mockReset().mockResolvedValue(undefined);
});

describe("#4191 — classificar como não comercial", () => {
  it("grava as três colunas e NÃO toca em desfecho", async () => {
    const { cliente, chamadas } = clienteFalso(aberto());
    const r = await classificaNegocioComoNaoComercial(cliente, {
      organizationId: ORG,
      leadId: LEAD,
      motivo: "  golpe ",
      actorUserId: ATOR,
      requestId: "req-1",
    });

    expect(r.ok).toBe(true);
    const update = chamadas.find((c) => c.patch !== undefined);
    expect(update?.patch).toMatchObject({
      nao_comercial_motivo: "golpe",
      nao_comercial_por: ATOR,
    });
    // "Não aumenta perdas nem vendas": nenhum campo de desfecho no UPDATE.
    expect(update?.patch).not.toHaveProperty("status");
    expect(update?.patch).not.toHaveProperty("lost_reason");
    expect(update?.patch).not.toHaveProperty("closed_at");
    expect(update?.patch).not.toHaveProperty("stage_id");
    // A data é a da decisão, ISO.
    expect(typeof update?.patch?.nao_comercial_em).toBe("string");
  });

  it("o UPDATE é condicionado à coluna ainda nula (trava da corrida)", async () => {
    const { cliente, chamadas } = clienteFalso(aberto());
    await classificaNegocioComoNaoComercial(cliente, {
      organizationId: ORG,
      leadId: LEAD,
      motivo: "golpe",
      actorUserId: ATOR,
      requestId: "req-1",
    });
    const update = chamadas.find((c) => c.patch !== undefined);
    expect(update?.filtros).toContainEqual(["is", "nao_comercial_em", null]);
    expect(update?.filtros).toContainEqual(["eq", "organization_id", ORG]);
    expect(update?.filtros).toContainEqual(["eq", "id", LEAD]);
  });

  it("deixa a decisão na timeline e no audit", async () => {
    const { cliente } = clienteFalso(aberto());
    await classificaNegocioComoNaoComercial(cliente, {
      organizationId: ORG,
      leadId: LEAD,
      motivo: "golpe",
      actorUserId: ATOR,
      requestId: "req-1",
    });

    expect(emitLeadActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        leadId: LEAD,
        type: "demand_classified",
        reason: "Classificado como não comercial: golpe",
        payload: { desfecho: "nao_comercial", motivo: "golpe" },
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "lead.non_commercial",
        resourceId: LEAD,
        metadata: { motivo: "golpe" },
      }),
    );
  });

  it("repetir com o mesmo motivo não escreve nem duplica timeline", async () => {
    const { cliente, chamadas } = clienteFalso(
      aberto({
        nao_comercial_em: "2026-11-06T12:00:00.000Z",
        nao_comercial_motivo: "golpe",
        nao_comercial_por: ATOR,
      }),
    );
    const r = await classificaNegocioComoNaoComercial(cliente, {
      organizationId: ORG,
      leadId: LEAD,
      motivo: "Golpe",
      actorUserId: ATOR,
      requestId: "req-2",
    });

    expect(r).toMatchObject({ ok: true, jaEstava: true });
    expect(chamadas.some((c) => c.patch !== undefined)).toBe(false);
    expect(emitLeadActivity).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("corrida perdida vira conflito (409), não sobrescrita", async () => {
    const { cliente } = clienteFalso(aberto(), { linhasAfetadas: 0 });
    const r = await classificaNegocioComoNaoComercial(cliente, {
      organizationId: ORG,
      leadId: LEAD,
      motivo: "golpe",
      actorUserId: ATOR,
      requestId: "req-3",
    });
    expect(r).toMatchObject({ ok: false, codigo: "classificacao_conflitante", httpStatus: 409 });
    expect(emitLeadActivity).not.toHaveBeenCalled();
  });

  it("negócio inexistente (ou fora da RLS) é 404", async () => {
    const { cliente } = clienteFalso(null);
    const r = await classificaNegocioComoNaoComercial(cliente, {
      organizationId: ORG,
      leadId: LEAD,
      motivo: "golpe",
      actorUserId: ATOR,
      requestId: "req-4",
    });
    expect(r).toMatchObject({ ok: false, codigo: "not_found", httpStatus: 404 });
  });

  it("negócio encerrado é recusado sem escrita", async () => {
    const { cliente, chamadas } = clienteFalso(aberto({ status: "lost", lost_reason: "preco" }));
    const r = await classificaNegocioComoNaoComercial(cliente, {
      organizationId: ORG,
      leadId: LEAD,
      motivo: "golpe",
      actorUserId: ATOR,
      requestId: "req-5",
    });
    expect(r).toMatchObject({ ok: false, codigo: "negocio_encerrado", httpStatus: 409 });
    expect(chamadas.some((c) => c.patch !== undefined)).toBe(false);
  });

  it("motivo vazio é 422 e nem lê o banco", async () => {
    const { cliente, chamadas } = clienteFalso(aberto());
    const r = await classificaNegocioComoNaoComercial(cliente, {
      organizationId: ORG,
      leadId: LEAD,
      motivo: "  ",
      actorUserId: ATOR,
      requestId: "req-6",
    });
    expect(r).toMatchObject({ ok: false, codigo: "motivo_obrigatorio", httpStatus: 422 });
    expect(chamadas).toHaveLength(0);
  });
});

describe("#4191 — reverter a classificação", () => {
  it("apaga as três colunas, com a trava do inverso, e deixa rastro", async () => {
    const { cliente, chamadas } = clienteFalso(
      aberto({
        nao_comercial_em: "2026-11-06T12:00:00.000Z",
        nao_comercial_motivo: "golpe",
        nao_comercial_por: ATOR,
      }),
    );
    const r = await reverteClassificacaoNaoComercial(cliente, {
      organizationId: ORG,
      leadId: LEAD,
      actorUserId: ATOR,
      requestId: "req-7",
    });

    expect(r).toMatchObject({ ok: true, jaEstava: false });
    const update = chamadas.find((c) => c.patch !== undefined);
    expect(update?.patch).toEqual({
      nao_comercial_em: null,
      nao_comercial_motivo: null,
      nao_comercial_por: null,
    });
    expect(update?.filtros).toContainEqual(["not", "nao_comercial_em", "is:null"]);
    expect(emitLeadActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "demand_classified",
        reason: "Voltou a ser comercial: golpe",
        payload: { desfecho: "comercial", motivo: "golpe" },
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "lead.non_commercial_reverted" }),
    );
  });

  it("reverter quem já é comercial é idempotente", async () => {
    const { cliente, chamadas } = clienteFalso(aberto());
    const r = await reverteClassificacaoNaoComercial(cliente, {
      organizationId: ORG,
      leadId: LEAD,
      actorUserId: ATOR,
      requestId: "req-8",
    });
    expect(r).toMatchObject({ ok: true, jaEstava: true });
    expect(chamadas.some((c) => c.patch !== undefined)).toBe(false);
    expect(emitLeadActivity).not.toHaveBeenCalled();
  });
});
