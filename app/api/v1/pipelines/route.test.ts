import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { ORG_ID, OUTRA_ORG, PIPE, authOk, funilRow, makeDb } from "@/tests/helpers/stages-db-double";

function reqPost(body: unknown) {
  return new NextRequest("http://localhost/api/v1/pipelines", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const umFunil = () => [funilRow({ id: PIPE, name: "Pedidos", slug: "pedidos", is_default: true })];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/pipelines", () => {
  it("sem auth → repassa a resposta do requireRole, sem escrever", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const db = makeDb({ pipelines: umFunil() });
    const { POST } = await import("./route");
    const res = await POST(reqPost({ name: "Clínica" }));
    expect(res.status).toBe(401);
    expect(db.escritas).toEqual([]);
  });

  /** O teste de 401 passaria igual se a rota pedisse `viewer`. Quem prova o papel é este. */
  it("exige manager", async () => {
    authOk();
    makeDb({ pipelines: umFunil() });
    const { POST } = await import("./route");
    await POST(reqPost({ name: "Clínica" }));
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  it("nome já usado → 422 com a mensagem da regra, e NENHUMA escrita", async () => {
    authOk();
    const db = makeDb({ pipelines: umFunil() });
    const { POST } = await import("./route");
    const res = await POST(reqPost({ name: "pedidos" }));

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Já existe um funil chamado «Pedidos». Escolha outro nome.");
    expect(db.escritas).toEqual([]);
  });

  it("cria o funil COM as quatro etapas, na mesma requisição", async () => {
    // ⚠️ Funil sem etapa é quadro morto: o board abre sem coluna nenhuma e não
    // recebe negócio. As etapas não são cortesia — são parte da criação.
    authOk();
    const db = makeDb({ pipelines: umFunil() });
    const { POST } = await import("./route");
    const res = await POST(reqPost({ name: "Clínica" }));

    expect(res.status).toBe(201);
    const pipelineInsert = db.escritas.find((e) => e.table === "crm_pipelines");
    expect(pipelineInsert?.tipo).toBe("insert");
    expect(pipelineInsert?.patch).toMatchObject({
      organization_id: ORG_ID,
      name: "Clínica",
      slug: "clinica",
    });

    const stagesInsert = db.escritas.find((e) => e.table === "crm_stages");
    const etapas = stagesInsert?.patch as Record<string, unknown>[];
    expect(etapas).toHaveLength(4);
    expect(etapas.map((e) => e.name)).toEqual(["Novo", "Em andamento", "Ganho", "Perdido"]);
    expect(etapas.filter((e) => e.is_won)).toHaveLength(1);
    expect(etapas.every((e) => e.organization_id === ORG_ID)).toBe(true);
  });

  it("as etapas entram DEPOIS do funil — antes não haveria pipeline_id para elas", async () => {
    authOk();
    const db = makeDb({ pipelines: umFunil() });
    const { POST } = await import("./route");
    await POST(reqPost({ name: "Clínica" }));
    const ordem = db.escritas.map((e) => e.table);
    expect(ordem.indexOf("crm_pipelines")).toBeLessThan(ordem.indexOf("crm_stages"));
  });

  it("o PRIMEIRO funil da organização nasce padrão", async () => {
    // Instalação onde o gatilho de seed não rodou: sem isto a org fica sem
    // funil padrão e todo lead criado sem funil escolhido some.
    authOk();
    const db = makeDb({ pipelines: [] });
    const { POST } = await import("./route");
    await POST(reqPost({ name: "Clínica" }));
    expect(db.escritas[0]?.patch).toMatchObject({ is_default: true });
  });

  it("o segundo funil NÃO rouba o padrão de quem já é", async () => {
    authOk();
    const db = makeDb({ pipelines: umFunil() });
    const { POST } = await import("./route");
    await POST(reqPost({ name: "Clínica" }));
    expect(db.escritas[0]?.patch).toMatchObject({ is_default: false });
  });

  it("slug não colide com o de funil ARQUIVADO — o índice único não é parcial", async () => {
    authOk();
    const db = makeDb({
      pipelines: [
        ...umFunil(),
        funilRow({ id: "f-velho", name: "Antiga clínica", slug: "clinica", is_archived: true }),
      ],
    });
    const { POST } = await import("./route");
    await POST(reqPost({ name: "Clínica" }));
    expect((db.escritas[0]?.patch as Record<string, unknown>).slug).not.toBe("clinica");
  });

  it("emite audit pipeline.created", async () => {
    authOk();
    makeDb({ pipelines: umFunil() });
    const { POST } = await import("./route");
    await POST(reqPost({ name: "Clínica" }));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "pipeline.created", organizationId: ORG_ID }),
    );
  });

  /**
   * ⭐ A COMPENSAÇÃO. São duas escritas sem transação: se as etapas falharem, o
   * funil não pode ficar de pé vazio — seria um quadro sem coluna, e o usuário
   * não teria como saber que aquilo nasceu quebrado.
   */
  it("etapas falham → o funil recém-criado é APAGADO e a resposta é de erro", async () => {
    authOk();
    const db = makeDb({
      pipelines: umFunil(),
      writeError: (_n, table) =>
        table === "crm_stages" ? { code: "XX000", message: "boom" } : null,
    });
    const { POST } = await import("./route");
    const res = await POST(reqPost({ name: "Clínica" }));

    expect(res.status).toBe(500);
    const compensacao = db.escritas.find((e) => e.tipo === "delete");
    expect(compensacao?.table).toBe("crm_pipelines");
    expect(compensacao?.filtros).toContainEqual(["organization_id", ORG_ID]);
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "pipeline.created" }));
  });

  it("nome em branco → 422, e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({ pipelines: umFunil() });
    const { POST } = await import("./route");
    const res = await POST(reqPost({ name: "   " }));
    expect(res.status).toBe(422);
    expect(db.escritas).toEqual([]);
  });

  it("corpo que não é JSON → 400", async () => {
    authOk();
    makeDb({ pipelines: umFunil() });
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/api/v1/pipelines", {
      method: "POST",
      body: "nao-e-json",
      headers: { "content-type": "application/json" },
    });
    expect((await POST(req)).status).toBe(400);
  });
});

/**
 * ⭐ ISOLAMENTO ENTRE ORGANIZAÇÕES NA LISTAGEM DE FUNIS.
 *
 * Achado em QA de tela, não por leitura: o manager da `e2e-test-org`, com ela
 * ativa, abriu a lista e recebeu como PRIMEIRO item um funil da segunda
 * organização de que ele também é membro. A RLS autoriza as duas (ele é membro
 * das duas); quem devia recortar para a org ATIVA era a rota, e o
 * `ctx.organization_id` chegava ao handler sem ser usado.
 *
 * O caso só existe para quem tem mais de uma organização — por isso passou: os
 * testes anteriores usavam um usuário de uma org só, e a RLS mascarava a falta
 * do filtro. É o cenário do produto multi-tenant, não um canto.
 */
describe("GET /api/v1/pipelines — org ativa", () => {
  it("não devolve funil de OUTRA organização do mesmo usuário", async () => {
    authOk();
    const db = makeDb({
      pipelines: [
        funilRow({ id: "p-minha", name: "Pedidos" }),
        funilRow({ id: "p-alheia", name: "Funil da outra empresa", organization_id: OUTRA_ORG }),
      ],
    });
    const { GET } = await import("./route");
    const res = await GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; organization_id: string }> };
    expect(body.data.map((p) => p.id)).toEqual(["p-minha"]);
    // A asserção acima passaria com a lista vazia; esta separa "filtrou certo"
    // de "não devolveu nada".
    expect(body.data).toHaveLength(1);
    expect(db.escritas).toEqual([]);
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
