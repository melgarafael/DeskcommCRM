import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";

vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: vi.fn(async (_admin: unknown, _ctx: unknown, input: Record<string, unknown>) => ({
    id: "card-novo",
    ...input,
  })),
}));

import { createLeadHandler } from "@/app/api/v1/leads/_handler";

import { abreCardAdicionalNoFunil } from "./abre-card-adicional";
import type { OrigemParaClonar } from "./clonar-para-funil";

const criar = vi.mocked(createLeadHandler);

const handlerCtx: HandlerCtx = {
  organization_id: "org-1",
  actor: { type: "ai_agent", id: "job-1", role: "ai_operator" },
  requestId: "job-1",
};

const etapa = (id: string, position: number, extra: Record<string, unknown> = {}) => ({
  id,
  pipeline_id: "pipe-destino",
  position,
  is_won: false,
  is_lost: false,
  is_archived: false,
  ...extra,
});

function admin(etapas: unknown[], error: { message: string } | null = null) {
  const cadeia: Record<string, unknown> = {};
  cadeia.select = () => cadeia;
  cadeia.eq = () => cadeia;
  cadeia.order = async () => ({ data: etapas, error });
  return { from: () => cadeia } as never;
}

const origem = {
  id: "lead-con",
  pipeline_id: "pipe-origem",
  status: "open",
  title: "Maria",
  description: "interessada em carta contemplada",
  contact_id: "c1",
  value_cents: 30000000,
  currency: "BRL",
  owner_user_id: "consultor-consorcio",
  owner_agent_id: null,
  expected_close_date: "2026-12-01",
  tags: ["lance", "fgts"],
  source: "whatsapp",
  custom_fields: { valor_da_carta: 300000 },
  source_metadata: { utm_source: "anuncio" },
} as unknown as OrigemParaClonar;

describe("abreCardAdicionalNoFunil", () => {
  beforeEach(() => criar.mockClear());

  it("cria o card no funil de destino, na etapa pedida, levando só a identidade", async () => {
    const r = await abreCardAdicionalNoFunil(
      admin([etapa("e1", 1000), etapa("e2", 2000)]),
      "org-1",
      handlerCtx,
      origem,
      "pipe-destino",
      "e2",
    );

    expect(r.ok).toBe(true);
    const payload = criar.mock.calls[0]![2] as unknown as Record<string, unknown>;
    expect(payload).toMatchObject({
      pipeline_id: "pipe-destino",
      stage_id: "e2",
      title: "Maria",
      contact_id: "c1",
      source: "whatsapp",
      source_metadata: { aberto_ao_lado_de: { lead_id: "lead-con", pipeline_id: "pipe-origem" } },
    });
    // O que pertence ao OUTRO produto não atravessa: etiquetas, campos, valor, dono.
    expect(payload.tags).toEqual([]);
    for (const campo of ["custom_fields", "value_cents", "owner_user_id", "owner_agent_id", "description"]) {
      expect(payload).not.toHaveProperty(campo);
    }
    // O rastro do canal de origem também não é copiado para o card do outro produto.
    expect(payload.source_metadata).not.toHaveProperty("utm_source");
  });

  it("sem etapa declarada → a primeira etapa aberta do funil", async () => {
    await abreCardAdicionalNoFunil(
      admin([etapa("ganho", 100, { is_won: true }), etapa("e2", 2000), etapa("e1", 1000)]),
      "org-1",
      handlerCtx,
      origem,
      "pipe-destino",
      null,
    );

    expect((criar.mock.calls[0]![2] as unknown as Record<string, unknown>).stage_id).toBe("e1");
  });

  it("etapa de outro funil → recusa com o código, sem criar nada", async () => {
    const r = await abreCardAdicionalNoFunil(
      admin([etapa("e1", 1000)]),
      "org-1",
      handlerCtx,
      origem,
      "pipe-destino",
      "etapa-de-outro-funil",
    );

    expect(r).toEqual({ ok: false, error: "stage_pipeline_mismatch" });
    expect(criar).not.toHaveBeenCalled();
  });

  it("etapa de fechamento como destino → recusa", async () => {
    const r = await abreCardAdicionalNoFunil(
      admin([etapa("perdido", 9000, { is_lost: true })]),
      "org-1",
      handlerCtx,
      origem,
      "pipe-destino",
      "perdido",
    );

    expect(r).toEqual({ ok: false, error: "stage_destino_terminal" });
    expect(criar).not.toHaveBeenCalled();
  });

  it("falha ao ler as etapas → devolve o erro, não lança", async () => {
    const r = await abreCardAdicionalNoFunil(admin([], { message: "banco fora" }), "org-1", handlerCtx, origem, "pipe-destino", null);

    expect(r).toEqual({ ok: false, error: "banco fora" });
    expect(criar).not.toHaveBeenCalled();
  });

  it("a régua de campos obrigatórios (422 do createLeadHandler) sobe intacta para o chamador", async () => {
    criar.mockRejectedValueOnce(Object.assign(new Error("faltam campos"), { code: "required_fields_missing" }));

    await expect(
      abreCardAdicionalNoFunil(admin([etapa("e1", 1000)]), "org-1", handlerCtx, origem, "pipe-destino", null),
    ).rejects.toMatchObject({ code: "required_fields_missing" });
  });
});
