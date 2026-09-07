import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { ORG_ID, OUTRA_ORG, PIPE, authOk, funilRow, makeDb, negocio } from "@/tests/helpers/stages-db-double";

const OUTRO = "55555555-5555-4555-8555-555555555555";
const TERCEIRO = "66666666-6666-4666-8666-666666666666";

const ctx = (id = OUTRO) => ({ params: Promise.resolve({ id }) });

function reqPatch(body: unknown, id = OUTRO) {
  return new NextRequest(`http://localhost/api/v1/pipelines/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function reqDelete(id = OUTRO, qs = "") {
  return new NextRequest(`http://localhost/api/v1/pipelines/${id}${qs}`, { method: "DELETE" });
}

/** Dois funis ativos: o padrão e um comum — o mínimo para arquivar sem cair na regra do último. */
const doisFunis = () => [
  funilRow({ id: PIPE, name: "Pedidos", slug: "pedidos", position: 1000, is_default: true }),
  funilRow({ id: OUTRO, name: "Clínica", slug: "clinica", position: 2000 }),
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/v1/pipelines/[id]", () => {
  it("exige manager", async () => {
    authOk();
    makeDb({ pipelines: doisFunis() });
    const { PATCH } = await import("./route");
    await PATCH(reqPatch({ name: "Consultório" }), ctx());
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  it("sem auth → repassa a resposta, sem escrever", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const db = makeDb({ pipelines: doisFunis() });
    const { PATCH } = await import("./route");
    expect((await PATCH(reqPatch({ name: "X" }), ctx())).status).toBe(401);
    expect(db.escritas).toEqual([]);
  });

  it("renomeia, filtrando pela organização do JWT", async () => {
    authOk();
    const db = makeDb({ pipelines: doisFunis() });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ name: "Consultório" }), ctx());

    expect(res.status).toBe(200);
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]?.patch).toEqual({ name: "Consultório" });
    expect(db.escritas[0]?.filtros).toContainEqual(["organization_id", ORG_ID]);
  });

  it("renomear para nome já usado → 422 e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({ pipelines: doisFunis() });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ name: "Pedidos" }), ctx());
    expect(res.status).toBe(422);
    expect(db.escritas).toEqual([]);
  });

  /**
   * ⭐ `uniq_crm_pipelines_org_default` é imediato: marcar o novo antes de
   * liberar o antigo é um 23505 cru na cara de quem só queria trocar o padrão.
   */
  it("tornar padrão → LIBERA o anterior antes de marcar o novo", async () => {
    authOk();
    const db = makeDb({ pipelines: doisFunis() });
    const { PATCH } = await import("./route");
    await PATCH(reqPatch({ is_default: true }), ctx());

    expect(db.escritas.map((e) => [e.filtros.find(([c]) => c === "id")?.[1], e.patch])).toEqual([
      [PIPE, { is_default: false }],
      [OUTRO, { is_default: true }],
    ]);
    // Sequencial, não em paralelo: em paralelo o banco veria os dois padrões juntos.
    expect(db.eventos).toEqual([
      "start:crm_pipelines:0",
      "end:crm_pipelines:0",
      "start:crm_pipelines:1",
      "end:crm_pipelines:1",
    ]);
  });

  it("desmarcar o padrão → 422: o padrão se muda, não se apaga", async () => {
    authOk();
    const db = makeDb({ pipelines: doisFunis() });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ is_default: false }, PIPE), ctx(PIPE));
    expect(res.status).toBe(422);
    expect(db.escritas).toEqual([]);
  });

  it("reordenar recalcula position entre os vizinhos", async () => {
    authOk();
    const db = makeDb({
      pipelines: [...doisFunis(), funilRow({ id: TERCEIRO, name: "Obras", slug: "obras", position: 3000 })],
    });
    const { PATCH } = await import("./route");
    // "Obras" passa a ficar depois de "Pedidos" (1000), antes de "Clínica" (2000).
    const res = await PATCH(reqPatch({ depois_de: PIPE }, TERCEIRO), ctx(TERCEIRO));

    expect(res.status).toBe(200);
    const patch = db.escritas[0]?.patch as { position: number };
    expect(patch.position).toBeGreaterThan(1000);
    expect(patch.position).toBeLessThan(2000);
  });

  it("depois_de: null joga o funil para o topo da lista", async () => {
    authOk();
    const db = makeDb({ pipelines: doisFunis() });
    const { PATCH } = await import("./route");
    await PATCH(reqPatch({ depois_de: null }), ctx());
    expect((db.escritas[0]?.patch as { position: number }).position).toBeLessThan(1000);
  });

  it("vizinho que não está mais na lista → 422", async () => {
    authOk();
    const db = makeDb({ pipelines: doisFunis() });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ depois_de: "sumiu" }), ctx());
    expect(res.status).toBe(422);
    expect(db.escritas).toEqual([]);
  });

  it("funil de outra organização → 404 e NENHUMA escrita", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis().map((f) => ({ ...f, organization_id: OUTRA_ORG })),
    });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ name: "X" }), ctx());
    expect(res.status).toBe(404);
    expect(db.escritas).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("funil arquivado não se edita → 409", async () => {
    // Alcançável sem má-fé: uma aba aberta antes de o funil ser arquivado.
    authOk();
    const db = makeDb({
      pipelines: [doisFunis()[0]!, { ...doisFunis()[1]!, is_archived: true }],
    });
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ name: "X" }), ctx());
    expect(res.status).toBe(409);
    expect(db.escritas).toEqual([]);
  });

  it("corpo vazio → 422", async () => {
    authOk();
    makeDb({ pipelines: doisFunis() });
    const { PATCH } = await import("./route");
    expect((await PATCH(reqPatch({}), ctx())).status).toBe(422);
  });

  it("emite audit pipeline.updated", async () => {
    authOk();
    makeDb({ pipelines: doisFunis() });
    const { PATCH } = await import("./route");
    await PATCH(reqPatch({ name: "Consultório" }), ctx());
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "pipeline.updated", resourceId: OUTRO }),
    );
  });
});

describe("DELETE /api/v1/pipelines/[id]", () => {
  it("arquiva: marca is_archived e NÃO apaga", async () => {
    authOk();
    const db = makeDb({ pipelines: doisFunis() });
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(), ctx());

    expect(res.status).toBe(200);
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]).toMatchObject({ tipo: "update", patch: { is_archived: true } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "pipeline.archived" }));
  });

  it("arquiva funil COM negócios — o histórico continua de pé", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis(),
      leads: [negocio("l1", "e1", { pipeline_id: OUTRO })],
    });
    const { DELETE } = await import("./route");
    expect((await DELETE(reqDelete(), ctx())).status).toBe(200);
    expect(db.escritas[0]?.patch).toEqual({ is_archived: true });
  });

  it("último funil ativo → 422 e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({ pipelines: [funilRow({ id: OUTRO, name: "Clínica", is_default: true })] });
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(), ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/único/i);
    expect(db.escritas).toEqual([]);
  });

  it("funil padrão → 422 mandando eleger outro antes", async () => {
    authOk();
    const db = makeDb({ pipelines: doisFunis() });
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(PIPE), ctx(PIPE));
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/padrão/i);
    expect(db.escritas).toEqual([]);
  });

  /**
   * ⭐ `webhook_sources.default_pipeline_id` é `ON DELETE CASCADE`: sem esta
   * recusa, arrumar o quadro derrubaria o formulário público do cliente.
   */
  it("destino de fonte de webhook → 422 NOMEANDO a fonte, e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis(),
      webhookSources: [
        { id: "w1", name: "Landing page", default_pipeline_id: OUTRO, organization_id: ORG_ID },
      ],
    });
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(), ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/Landing page/);
    expect(db.escritas).toEqual([]);
  });

  /** O `pipeline_id` mora dentro de jsonb, sem FK: o banco não defende nada aqui. */
  it("alvo de automação ATIVA → 422 nomeando a regra", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis(),
      automationRules: [
        {
          id: "r1",
          name: "Lead do site",
          is_active: true,
          organization_id: ORG_ID,
          actions: [{ type: "create_or_move_lead", config: { pipeline_id: OUTRO, stage_id: "s1" } }],
        },
      ],
    });
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(), ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/Lead do site/);
    expect(db.escritas).toEqual([]);
  });

  it("automação INATIVA não impede o arquivamento — ela não move nada hoje", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis(),
      automationRules: [
        {
          id: "r1",
          name: "Desligada",
          is_active: false,
          organization_id: ORG_ID,
          actions: [{ type: "create_or_move_lead", config: { pipeline_id: OUTRO, stage_id: "s1" } }],
        },
      ],
    });
    const { DELETE } = await import("./route");
    expect((await DELETE(reqDelete(), ctx())).status).toBe(200);
    expect(db.escritas[0]?.patch).toEqual({ is_archived: true });
  });

  it("?definitivo=1 com negócios → 422 oferecendo arquivar, e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis(),
      leads: [negocio("l1", "e1", { pipeline_id: OUTRO })],
    });
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(OUTRO, "?definitivo=1"), ctx());
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/arquiv/i);
    expect(db.escritas).toEqual([]);
  });

  it("?definitivo=1 com tudo zerado → apaga de verdade e emite pipeline.deleted", async () => {
    authOk();
    const db = makeDb({ pipelines: doisFunis() });
    const { DELETE } = await import("./route");
    const res = await DELETE(reqDelete(OUTRO, "?definitivo=1"), ctx());

    expect(res.status).toBe(200);
    expect(db.escritas[0]).toMatchObject({ tipo: "delete", table: "crm_pipelines" });
    expect(db.escritas[0]?.filtros).toContainEqual(["organization_id", ORG_ID]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "pipeline.deleted" }));
  });

  it("funil de outra organização → 404 e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({
      pipelines: doisFunis().map((f) => ({ ...f, organization_id: OUTRA_ORG })),
    });
    const { DELETE } = await import("./route");
    expect((await DELETE(reqDelete(), ctx())).status).toBe(404);
    expect(db.escritas).toEqual([]);
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
