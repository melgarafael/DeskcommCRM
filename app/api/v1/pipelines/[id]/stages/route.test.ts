import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { ORG_ID, OUTRA_ORG, PIPE, authOk, comAutoria, etapa, funil, makeDb } from "@/tests/helpers/stages-db-double";

const ctx = { params: Promise.resolve({ id: PIPE }) };

function reqPost(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/stages`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/pipelines/[id]/stages", () => {
  it("sem auth → repassa a resposta do requireRole, sem escrever", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const db = makeDb({ stages: funil() });
    const { POST } = await import("./route");
    const res = await POST(reqPost({ name: "Retorno" }), ctx);
    expect(res.status).toBe(401);
    expect(db.escritas).toEqual([]);
  });

  /**
   * O teste de 401 acima mocka o `requireRole` para falhar SEMPRE — passaria
   * igual se a criação pedisse `agent` ou `viewer`. Quem prova o papel é este,
   * num caminho com auth OK.
   */
  it("exige manager", async () => {
    authOk();
    makeDb({ stages: funil() });
    const { POST } = await import("./route");
    await POST(reqPost({ name: "Retorno" }), ctx);
    expect(vi.mocked(requireRole).mock.calls[0]?.[0]).toBe("manager");
  });

  /**
   * ⭐ O funil EXISTE — só que noutra organização. Um handler que responde 404
   * depois de gravar é pior do que um que responde 200: o veredito não é o
   * status, é a lista de escritas emitidas.
   */
  it("funil de outra organização → 404 e NENHUMA escrita", async () => {
    authOk();
    const db = makeDb({
      pipelineOrg: OUTRA_ORG,
      stages: funil().map((e) => ({ ...e, organization_id: OUTRA_ORG })),
    });
    const { POST } = await import("./route");
    const res = await POST(reqPost({ name: "Retorno" }), ctx);

    expect(res.status).toBe(404);
    expect(db.escritas).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("nome já usado no funil → 422 com a mensagem da regra, e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { POST } = await import("./route");
    // "proposta" difere de «Proposta» só por caixa — o usuário lê como a mesma coluna.
    const res = await POST(reqPost({ name: "proposta" }), ctx);

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unprocessable_entity");
    expect(body.error.message).toBe(
      "Já existe uma etapa chamada «Proposta» neste funil. Escolha outro nome.",
    );
    expect(db.escritas).toEqual([]);
  });

  it("nome em branco → 422, e nenhuma escrita", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { POST } = await import("./route");
    const res = await POST(reqPost({ name: "   " }), ctx);

    expect(res.status).toBe(422);
    expect(db.escritas).toEqual([]);
  });

  it("cria no fim do funil, com slug e tenant do JWT", async () => {
    authOk();
    const db = makeDb({ stages: funil() });
    const { POST } = await import("./route");
    const res = await POST(reqPost({ name: "Pós-venda" }), ctx);

    expect(res.status).toBe(201);
    expect(db.escritas).toHaveLength(1);
    expect(db.escritas[0]?.tipo).toBe("insert");
    expect(db.escritas[0]?.patch).toEqual(
      comAutoria({
        organization_id: ORG_ID,
        pipeline_id: PIPE,
        name: "Pós-venda",
        slug: "pos-venda",
        // A última posição do funil é 4000 (a fixture chega embaralhada): a etapa
        // nova entra DEPOIS dela, não no meio.
        position: 5000,
      }),
    );

    const body = (await res.json()) as { data: { etapas: Array<{ id: string; name: string }> } };
    expect(body.data.etapas.map((e) => e.name)).toEqual([
      "Novo",
      "Proposta",
      "Pago",
      "Cancelado",
      "Pós-venda",
    ]);
  });

  it("slug ocupado por etapa ARQUIVADA ganha sufixo", async () => {
    authOk();
    // `uniq_crm_stages_pipeline_slug` NÃO é parcial: arquivada continua ocupando.
    const db = makeDb({
      stages: [
        ...funil(),
        etapa({ id: "e9", name: "Retorno antigo", slug: "retorno", position: 9000, is_archived: true }),
      ],
    });
    const { POST } = await import("./route");
    const res = await POST(reqPost({ name: "Retorno" }), ctx);

    expect(res.status).toBe(201);
    expect(db.escritas[0]?.patch).toMatchObject({ slug: "retorno-2" });
  });

  it("caminho feliz audita pipeline.stage_created", async () => {
    authOk();
    makeDb({ stages: funil() });
    const { POST } = await import("./route");
    await POST(reqPost({ name: "Retorno" }), ctx);

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pipeline.stage_created",
        organizationId: ORG_ID,
        resourceType: "crm_stage",
      }),
    );
  });

  it("23505 do índice único → 409 em português, sem texto do Postgres", async () => {
    authOk();
    makeDb({
      stages: funil(),
      writeError: () => ({
        code: "23505",
        message: 'duplicate key value violates unique constraint "uniq_crm_stages_pipeline_slug"',
      }),
    });
    const { POST } = await import("./route");
    const res = await POST(reqPost({ name: "Retorno" }), ctx);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("state_conflict");
    expect(body.error.message).toContain("Retorno");
    // Sem esta metade, um 500 devolvendo a mensagem crua do Postgres também
    // conteria o nome da etapa e passaria: é o `not.toContain` que separa
    // "mensagem escrita para o usuário" de "vazamento do banco".
    expect(body.error.message).not.toContain("unique");
    expect(body.error.message).not.toContain("constraint");
  });

  it("erro inesperado do banco → 500, sem inventar sucesso", async () => {
    authOk();
    makeDb({
      stages: funil(),
      writeError: () => ({ code: "08006", message: "connection failure" }),
    });
    const { POST } = await import("./route");
    const res = await POST(reqPost({ name: "Retorno" }), ctx);
    expect(res.status).toBe(500);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/pipelines/[id]/stages", () => {
  /**
   * ⭐ #2999 — o `select()` do GET deixou de fora `win_probability` e
   * `avisar_na_central`. O PATCH grava, o GET devolve — a tela de
   * configurações do funil mostrava os dois campos vazios logo depois de
   * salvar. O dublê projeta as colunas pedidas de verdade, então omitir o
   * campo do `.select()` faz este teste falhar na hora de ler `win_probability`
   * da resposta.
   */
  it("traz a chance de fechamento e o aviso de equipe gravados na etapa", async () => {
    authOk();
    const stages = funil().map((e) =>
      e.id === "e2"
        ? { ...e, win_probability: 40, avisar_na_central: true }
        : e.id === "e3"
          ? { ...e, win_probability: 100, avisar_na_central: false }
          : { ...e, win_probability: null, avisar_na_central: false },
    );
    makeDb({ stages });
    const { GET } = await import("./route");
    const req = new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/stages`, { method: "GET" });
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; win_probability: number | null; avisar_na_central: boolean }>;
    };
    const porId = Object.fromEntries(body.data.map((e) => [e.id, e]));
    // A etapa calibrada devolve o valor gravado — se o select omitir a coluna,
    // o campo vem undefined e o `toEqual` falha.
    expect(porId["e2"]?.win_probability).toEqual(40);
    expect(porId["e2"]?.avisar_na_central).toEqual(true);
    // Ganho vale 100 NA REGRA (não gravado aqui); o valor calibrado viaja igual.
    expect(porId["e3"]?.win_probability).toEqual(100);
    // Etapa sem calibração devolve null, não undefined — o select trouxe a coluna.
    expect(porId["e1"]?.win_probability).toEqual(null);
  });

  it("respeita o tenant do JWT (etapa de outra org não aparece)", async () => {
    authOk();
    const stages = funil().map((e) => ({
      ...e,
      organization_id: OUTRA_ORG,
      win_probability: 50,
      avisar_na_central: true,
    }));
    makeDb({ pipelineOrg: OUTRA_ORG, stages });
    const { GET } = await import("./route");
    const req = new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/stages`, { method: "GET" });
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data).toEqual([]);
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));
