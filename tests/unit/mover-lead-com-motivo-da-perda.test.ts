/**
 * O motor repassa o motivo da perda ao `moveLeadHandler` — e não inventa um.
 *
 * Molde: `tests/unit/mover-lead-escolhe-o-negocio-do-funil-2181.test.ts` (cliente
 * falso que aplica os filtros `eq` de verdade, `moveLeadHandler` mocado).
 * Sem motivo configurado a chave `lost_reason` nem viaja (nada de padrão
 * escondido como `no_response`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseAdminClient } from "@/lib/followup/engine";

const { moveLeadHandler } = vi.hoisted(() => ({ moveLeadHandler: vi.fn(async (..._args: unknown[]) => ({})) }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ moveLeadHandler }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const ETAPA = "33333333-3333-4333-8333-333333333333";

type Linha = Record<string, unknown>;

function cliente() {
  const tabelas: Record<string, Linha[]> = {
    crm_stages: [{ id: ETAPA, organization_id: ORG, pipeline_id: "funil-a" }],
    crm_leads: [
      { id: "lead-1", organization_id: ORG, contact_id: CONTATO, pipeline_id: "funil-a", updated_at: "2026-10-03T12:00:00Z" },
    ],
  };
  return {
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      let ordem: string | null = null;
      const q = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => (filtros.push([coluna, valor]), q),
        order: (coluna: string) => ((ordem = coluna), q),
        limit: () => q,
        maybeSingle: async () => {
          const linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v));
          if (ordem) linhas.sort((a, b) => String(b[ordem!]).localeCompare(String(a[ordem!])));
          return { data: linhas[0] ?? null, error: null };
        },
      };
      return q;
    },
  };
}

function mover(config: { stage_id: string; lost_reason?: string }) {
  const admin = createSupabaseAdminClient(cliente() as never);
  return admin.moverLeadNoFunil!({
    organization_id: ORG,
    contact_id: CONTATO,
    enrollment_id: "e1",
    config,
  });
}

beforeEach(() => moveLeadHandler.mockClear());

describe("moverLeadNoFunil repassa o motivo da perda", () => {
  it("passa lost_reason ao moveLeadHandler quando o bloco tem motivo", async () => {
    await mover({ stage_id: ETAPA, lost_reason: "no_response" });
    expect(moveLeadHandler).toHaveBeenCalledTimes(1);
    expect(moveLeadHandler.mock.calls[0]).toEqual([expect.anything(), expect.anything(), "lead-1", { to_stage_id: ETAPA, lost_reason: "no_response" }]);
  });

  it("NÃO envia a chave quando o bloco não tem motivo (sem padrão escondido)", async () => {
    await mover({ stage_id: ETAPA });
    expect(moveLeadHandler).toHaveBeenCalledTimes(1);
    expect(moveLeadHandler.mock.calls[0]).toEqual([expect.anything(), expect.anything(), "lead-1", { to_stage_id: ETAPA }]);
    expect("lost_reason" in (moveLeadHandler.mock.calls[0]![3] as Record<string, unknown>)).toBe(false);
  });

  it("motivo só de espaços também não viaja", async () => {
    await mover({ stage_id: ETAPA, lost_reason: "   " });
    expect(moveLeadHandler.mock.calls[0]).toEqual([expect.anything(), expect.anything(), "lead-1", { to_stage_id: ETAPA }]);
  });
});
