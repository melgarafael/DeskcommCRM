/**
 * Receitas de banco externo — rotas. O que a prova precisa mostrar:
 *   - a leitura (GET) e a gravação (PUT) filtram pela organização DO CONTEXTO;
 *   - conexão de outra organização é 404;
 *   - módulo desligado e papel abaixo do mínimo são barrados antes de qualquer leitura;
 *   - o audit grava só CONTAGENS (número de instâncias, quantas ativas), nunca os
 *     parâmetros de fixos (prefixo, rótulo, descrição — podem conter dado do cliente).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  admin: vi.fn(),
  modulo: vi.fn(),
  rate: vi.fn(),
  receitas: vi.fn(),
  receitaDe: vi.fn(),
  validarFixos: vi.fn(),
  validarDestino: vi.fn(),
  moduloDesligado: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: deps.admin,
}));
vi.mock("@/lib/instalacao/modulos", () => ({
  moduloLigado: deps.modulo,
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: deps.rate,
}));
vi.mock("@/lib/external-db/receitas/instancias", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("@/lib/external-db/receitas/instancias");
  return {
    lerReceitasDoBanco: deps.receitas,
    validarFixosDaReceita: deps.validarFixos,
    validarDestinoDaInstancia: deps.validarDestino,
    atualizarReceitasSchema: actual.atualizarReceitasSchema,
  };
});
vi.mock("@/lib/external-db/receitas/registro", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("@/lib/external-db/receitas/registro");
  return {
    ...actual,
    receitaDe: deps.receitaDe,
  };
});
vi.mock("../../../_falha", () => ({
  seModuloDesligado: deps.moduloDesligado,
}));

import { GET, PUT } from "./route";
import type { receitaDe } from "@/lib/external-db/receitas/registro";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

const INSTANCIA = {
  id: "33333333-3333-4333-8333-333333333333",
  receita: "woocommerce-produtos",
  rotulo: "Produtos da loja",
  descricao: "Produtos publicados do WooCommerce",
  fixos: { prefixo: "wp_" },
  ativa: true,
};

function banco(resposta: { data: unknown; error?: unknown }) {
  const visto: { payload?: Record<string, unknown>; select?: string; eq: Array<[string, unknown]> } = {
    eq: [],
  };
  const cadeia: Record<string, unknown> = {};
  cadeia.update = (payload: Record<string, unknown>) => ((visto.payload = payload), cadeia);
  cadeia.select = (cols: string) => ((visto.select = cols), cadeia);
  cadeia.eq = (c: string, v: unknown) => (visto.eq.push([c, v]), cadeia);
  cadeia.maybeSingle = async () => ({ data: resposta.data, error: resposta.error ?? null });
  return { visto, client: { from: () => cadeia } };
}

function put(corpo: unknown) {
  return new NextRequest(`http://localhost/api/v1/external-db/connections/${ID}/recipes`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}
const ctx = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  deps.modulo.mockResolvedValue(true);
  deps.moduloDesligado.mockResolvedValue(null);
  deps.support.mockResolvedValue(null);
  deps.rate.mockResolvedValue({ allowed: true });
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: "u-1", idioma: "pt-BR" },
    org: { orgId: ORG, role: "admin" },
  });
  deps.receitas.mockReturnValue({ ok: true, instancias: [INSTANCIA] });
  deps.receitaDe.mockReturnValue({
    id: "woocommerce-produtos",
    motores: ["mysql"],
  } as unknown as ReturnType<typeof receitaDe>);
  deps.validarFixos.mockImplementation(() => undefined);
  deps.validarDestino.mockResolvedValue({ ok: true });
});

describe("GET /connections/:id/recipes", () => {
  it("lê com o organization_id da sessão e devolve as receitas", async () => {
    const { visto, client } = banco({ data: { receitas: [INSTANCIA] } });
    deps.admin.mockReturnValue(client);
    deps.role.mockResolvedValue({
      ok: true,
      user: { id: "u-1", idioma: "pt-BR" },
      org: { orgId: ORG, role: "viewer" },
    });

    const res = await GET(new NextRequest("http://localhost/x"), ctx);

    expect(res.status).toBe(200);
    expect(visto.eq[0]).toEqual(["organization_id", ORG]);
    expect(visto.eq[1]).toEqual(["id", ID]);
    const corpo = (await res.json()) as { data: { receitas: unknown[] } };
    expect(corpo.data.receitas).toEqual([INSTANCIA]);
  });

  it("conexão de OUTRA organização: 404 e sem receitas", async () => {
    const { client } = banco({ data: null });
    deps.admin.mockReturnValue(client);

    const res = await GET(new NextRequest("http://localhost/x"), ctx);

    expect(res.status).toBe(404);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("módulo desligado: resposta do seModuloDesligado", async () => {
    deps.moduloDesligado.mockResolvedValue(new Response(null, { status: 404 }));

    const res = await GET(new NextRequest("http://localhost/x"), ctx);

    expect(res.status).toBe(404);
    expect(deps.admin).not.toHaveBeenCalled();
  });

  it("papel abaixo de viewer: 403", async () => {
    deps.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });

    const res = await GET(new NextRequest("http://localhost/x"), ctx);

    expect(res.status).toBe(403);
    expect(deps.admin).not.toHaveBeenCalled();
  });

  it("receitas inválidas no banco: receitas [] (falha fechada)", async () => {
    const { client } = banco({ data: { receitas: "lixo" } });
    deps.admin.mockReturnValue(client);
    deps.receitas.mockReturnValue({ ok: false });

    const res = await GET(new NextRequest("http://localhost/x"), ctx);

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { receitas: unknown[] } };
    expect(corpo.data.receitas).toEqual([]);
  });
});

describe("PUT /connections/:id/recipes", () => {
  it("sessão de suporte somente-leitura: recusa ANTES de qualquer leitura", async () => {
    deps.support.mockResolvedValue(new Response(null, { status: 403 }));
    const { visto, client } = banco({ data: { receitas: [] } });
    deps.admin.mockReturnValue(client);

    const res = await PUT(put({ receitas: [INSTANCIA] }), ctx);

    expect(res.status).toBe(403);
    expect(visto.select).toBeUndefined();
    expect(deps.role).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("não-admin: 403", async () => {
    deps.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });

    const res = await PUT(put({ receitas: [INSTANCIA] }), ctx);

    expect(res.status).toBe(403);
    expect(deps.support).toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("corpo inválido (Zod): 422", async () => {
    const res = await PUT(put({ receitas: "lixo" }), ctx);

    expect(res.status).toBe(422);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("a organização vem da sessão (organization_id no corpo é ignorado)", async () => {
    const { visto, client } = banco({
      data: { receitas: [INSTANCIA], db_type: "mysql" },
    });
    deps.admin.mockReturnValue(client);

    const res = await PUT(put({ receitas: [INSTANCIA] }), ctx);

    expect(res.status).toBe(200);
    expect(visto.eq[0]).toEqual(["organization_id", ORG]);
    expect(visto.eq[1]).toEqual(["id", ID]);
  });

  it("conexão postgres com receita só-mysql: 422 receita_incompatível_com_o_motor", async () => {
    const { visto, client } = banco({ data: { receitas: [], db_type: "postgres" } });
    deps.admin.mockReturnValue(client);
    deps.role.mockResolvedValue({
      ok: true,
      user: { id: "u-1", idioma: "pt-BR" },
      org: { orgId: ORG, role: "admin" },
    });
    // conexão com db_type "postgres" (não mysql), receita só aceita mysql
    deps.receitaDe.mockReturnValue({
      id: "woocommerce-produtos",
      motores: ["mysql"],
    } as unknown as ReturnType<typeof receitaDe>);

    const res = await PUT(put({ receitas: [INSTANCIA] }), ctx);

    expect(res.status).toBe(422);
    const texto = JSON.stringify(await res.json());
    expect(texto).toContain("receita_incompativel_com_o_motor");
    expect(visto.payload).toBeUndefined();
  });

  it("sucesso: grava receitas e audita só CONTAGENS (nunca os parâmetros de fixos)", async () => {
    const { visto, client } = banco({
      data: { receitas: [INSTANCIA], db_type: "mysql" },
    });
    deps.admin.mockReturnValue(client);

    const res = await PUT(put({ receitas: [INSTANCIA] }), ctx);

    expect(res.status).toBe(200);
    expect(visto.payload).toEqual({ receitas: [INSTANCIA] });
    expect(deps.audit).toHaveBeenCalledOnce();
    const evento = deps.audit.mock.calls[0]![0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(evento.action).toBe("external_db_recipes.updated");
    expect(evento.metadata).toEqual({ receitas: 1, ativas: 1, com_destino: 0 } as Record<string, unknown>);
    const texto = JSON.stringify(evento);
    expect(texto).not.toContain("prefixo");
    expect(texto).not.toContain("Produtos da loja");
    expect(texto).not.toContain("Produtos publicados do WooCommerce");
  });
});

describe("PUT /connections/:id/recipes — destino do lead de interesse (R5)", () => {
  const DESTINO = {
    pipeline_id: "66666666-6666-4666-8666-666666666666",
    stage_id: "77777777-7777-4777-8777-777777777777",
  };

  it("destino válido: confere contra a organização DA SESSÃO e grava", async () => {
    const { visto, client } = banco({ data: { db_type: "mysql", receitas: [{ ...INSTANCIA, destino: DESTINO }] } });
    deps.admin.mockReturnValue(client);

    const res = await PUT(put({ receitas: [{ ...INSTANCIA, destino: DESTINO }] }), ctx);

    expect(res.status).toBe(200);
    expect(deps.validarDestino).toHaveBeenCalledWith(client, ORG, DESTINO);
    expect(visto.payload).toEqual({ receitas: [{ ...INSTANCIA, destino: DESTINO }] });
    expect(deps.audit.mock.calls[0]![0].metadata).toMatchObject({ com_destino: 1 });
  });

  it("funil ou etapa de OUTRA organização: 422 destino_invalido e nada é gravado", async () => {
    const { visto, client } = banco({ data: { db_type: "mysql", receitas: [] } });
    deps.admin.mockReturnValue(client);
    deps.validarDestino.mockResolvedValue({ ok: false, motivo: "funil_inexistente" });

    const res = await PUT(put({ receitas: [{ ...INSTANCIA, destino: DESTINO }] }), ctx);

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("destino_invalido");
    expect(visto.payload).toBeUndefined();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("etapa de outro funil: 422 com a mensagem da etapa", async () => {
    const { visto, client } = banco({ data: { db_type: "mysql", receitas: [] } });
    deps.admin.mockReturnValue(client);
    deps.validarDestino.mockResolvedValue({ ok: false, motivo: "etapa_de_outro_funil" });

    const res = await PUT(put({ receitas: [{ ...INSTANCIA, destino: DESTINO }] }), ctx);

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { message: string } };
    expect(corpo.error.message).toMatch(/etapa/i);
    expect(visto.payload).toBeUndefined();
  });

  it("destino com chave estranha ou uuid inválido: 422 pelo Zod strict, sem consultar o banco", async () => {
    const res = await PUT(put({ receitas: [{ ...INSTANCIA, destino: { ...DESTINO, organization_id: ORG } }] }), ctx);
    expect(res.status).toBe(422);
    const res2 = await PUT(put({ receitas: [{ ...INSTANCIA, destino: { pipeline_id: "x", stage_id: "y" } }] }), ctx);
    expect(res2.status).toBe(422);
    expect(deps.validarDestino).not.toHaveBeenCalled();
  });

  it("sem destino: não consulta funil nenhum (instância antiga continua gravável)", async () => {
    const { client } = banco({ data: { db_type: "mysql", receitas: [INSTANCIA] } });
    deps.admin.mockReturnValue(client);
    const res = await PUT(put({ receitas: [INSTANCIA] }), ctx);
    expect(res.status).toBe(200);
    expect(deps.validarDestino).not.toHaveBeenCalled();
  });

  it("fixos que a receita recusa (tabela \"carros pro\"): 422 validation_failed com o motivo, nunca 500", async () => {
    // A função REAL: é ela quem lança, e a rota é quem tem de transformar em 422.
    const real = await vi.importActual<typeof import("@/lib/external-db/receitas/instancias")>(
      "@/lib/external-db/receitas/instancias",
    );
    const registro = await vi.importActual<typeof import("@/lib/external-db/receitas/registro")>(
      "@/lib/external-db/receitas/registro",
    );
    deps.validarFixos.mockImplementation(real.validarFixosDaReceita);
    deps.receitaDe.mockImplementation(registro.receitaDe);
    const { visto, client } = banco({ data: { receitas: [], db_type: "mysql" } });
    deps.admin.mockReturnValue(client);
    const instancia = {
      ...INSTANCIA,
      receita: "tabela-direta",
      fixos: {
        tabela: "carros pro",
        colunas: { id: "id", titulo: "modelo", filtros_texto: [], exibir: [] },
      },
    };

    const res = await PUT(put({ receitas: [instancia] }), ctx);

    expect(res.status).toBe(422);
    const corpo = JSON.stringify(await res.json());
    expect(corpo).toContain("validation_failed");
    expect(corpo).toContain("Use apenas letras, números e underline no nome da tabela.");
    expect(visto.payload).toBeUndefined();
    expect(deps.audit).not.toHaveBeenCalled();
  });
});
