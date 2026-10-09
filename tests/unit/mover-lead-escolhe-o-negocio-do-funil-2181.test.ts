/**
 * #2181 — a caixa "mover lead no funil" escolhe o negócio do contato NO FUNIL
 * da etapa de destino.
 *
 * Antes, o adaptador pegava o negócio mais recente de QUALQUER funil. Com o
 * contato em dois funis, às vezes era o do outro: o `moveLeadHandler` recusa
 * troca de funil, a recusa virava só um aviso de log e o fluxo seguia como se
 * o card tivesse andado.
 *
 * Roda sem Postgres: o cliente falso aplica de verdade os filtros `eq` e a
 * ordem que o adaptador pede, então um filtro esquecido muda a linha devolvida.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseAdminClient } from "@/lib/followup/engine";

const { moveLeadHandler } = vi.hoisted(() => ({ moveLeadHandler: vi.fn(async (..._args: unknown[]) => ({})) }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ moveLeadHandler }));

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const ETAPA_B = "33333333-3333-4333-8333-333333333333";
const ETAPA_DE_OUTRA_ORG = "44444444-4444-4444-8444-444444444444";

type Linha = Record<string, unknown>;

function cliente(tabelas: Record<string, Linha[]>) {
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

const tabelas: Record<string, Linha[]> = {
  crm_stages: [
    { id: ETAPA_B, organization_id: ORG, pipeline_id: "funil-b" },
    { id: ETAPA_DE_OUTRA_ORG, organization_id: OUTRA_ORG, pipeline_id: "funil-x" },
  ],
  crm_leads: [
    // O mais recente do contato está no OUTRO funil — é ele que a versão antiga escolhia.
    { id: "lead-a", organization_id: ORG, contact_id: CONTATO, pipeline_id: "funil-a", updated_at: "2026-10-03T12:00:00Z" },
    { id: "lead-b", organization_id: ORG, contact_id: CONTATO, pipeline_id: "funil-b", updated_at: "2026-10-01T12:00:00Z" },
  ],
};

function mover(stage_id: string) {
  const admin = createSupabaseAdminClient(cliente(tabelas) as never);
  return admin.moverLeadNoFunil!({
    organization_id: ORG,
    contact_id: CONTATO,
    enrollment_id: "e1",
    config: { stage_id },
  });
}

beforeEach(() => moveLeadHandler.mockClear());

describe("mover lead no funil escolhe o negócio do funil de destino (#2181)", () => {
  it("move o negócio do funil da etapa, não o mais recente de outro funil", async () => {
    await mover(ETAPA_B);
    expect(moveLeadHandler).toHaveBeenCalledTimes(1);
    expect(moveLeadHandler.mock.calls[0]).toEqual([expect.anything(), expect.anything(), "lead-b", { to_stage_id: ETAPA_B }]);
  });

  it("etapa de outra organização não resolve funil nenhum e não move nada", async () => {
    await expect(mover(ETAPA_DE_OUTRA_ORG)).rejects.toThrow("etapa_destino_inexistente");
    expect(moveLeadHandler).not.toHaveBeenCalled();
  });
});
