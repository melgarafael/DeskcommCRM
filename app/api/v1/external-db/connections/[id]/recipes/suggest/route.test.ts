/**
 * Rota de sugestão de campos ACF (D5).
 * Prova:
 *   - admin lê a conexão com o organization_id da sessão;
 *   - module desligado e papel abaixo de admin são barrados;
 *   - a consulta de sugestão passa pelo validador (SELECT-only, tabelas permitidas);
 *   - uma variação com `;` ou `INTO` não passa;
 *   - resposta devolve meta_keys e mapeamento sugerido.
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
  moduloDesligado: vi.fn(),
  validarConsulta: vi.fn(),
  abrirAcesso: vi.fn(),
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
vi.mock("@/lib/external-db/receitas/validador", () => ({
  validarConsultaDeReceita: deps.validarConsulta,
}));
vi.mock("@/lib/external-db/acesso", () => ({
  abrirAcesso: deps.abrirAcesso,
}));
vi.mock("../../../../_falha", () => ({
  seModuloDesligado: deps.moduloDesligado,
}));

import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

const conexaoMock = { id: ID, db_type: "mysql" };

function banco(resposta: { data: unknown; error?: unknown }) {
  const visto: { select?: string; eq: Array<[string, unknown]> } = { eq: [] };
  const cadeia: Record<string, unknown> = {};
  cadeia.select = () => cadeia;
  cadeia.eq = (c: string, v: unknown) => (visto.eq.push([c, v]), cadeia);
  cadeia.maybeSingle = async () => ({ data: resposta.data, error: resposta.error ?? null });
  return { visto, client: { from: () => cadeia } };
}

function post(corpo: unknown) {
  return new NextRequest(`http://localhost/api/v1/external-db/connections/${ID}/recipes/suggest`, {
    method: "POST",
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
  deps.admin.mockReturnValue(banco({ data: conexaoMock }).client);
  deps.validarConsulta.mockImplementation(() => undefined);
  deps.abrirAcesso.mockResolvedValue({
    ok: true,
    dialeto: {
      executarReceita: vi.fn(async () => ({
        linhas: [
          { meta_key: "preco", frequencia: 10 },
          { meta_key: "quartos", frequencia: 10 },
          { meta_key: "bairro", frequencia: 10 },
          { meta_key: "_preco", frequencia: 2 },
        ],
        truncado: false,
      })),
      schemaDasReceitas: () => "banco_teste",
      listarTabelas: vi.fn(async () => []),
      colunasDaTabela: vi.fn(async () => null),
    },
  });
});

describe("POST /connections/:id/recipes/suggest", () => {
  it("admin lê a conexão com o organization_id da sessão e devolve sugestões", async () => {
    const req = post({ receita: "acf-imoveis", prefixo: "wp_", post_type: "imovel" });
    const res = await POST(req, ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    // O mock do devolve _preco também, mas a consulta SQL já filtra com not like '\\_%%'.
    // Como estamos mockando o dialeto, filtramos aqui o que o SQL faria no banco.
    const chaves = body.data.meta_keys.filter((k: string) => !k.startsWith("_"));
    expect(chaves).toEqual(["preco", "quartos", "bairro"]);
    expect(body.data.mapeamento_sugerido.preco).toBe("preco");
    expect(body.data.mapeamento_sugerido.quartos).toBe("quartos");
    expect(body.data.mapeamento_sugerido.bairro).toBe("bairro");
    // O audit grava só contagem, nunca os meta_keys.
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "external_db_recipes.suggested",
      }),
    );
  });

  it("o organization_id vem da sessão, nunca do corpo", async () => {
    const resp = banco({ data: conexaoMock });
    deps.admin.mockReturnValue(resp.client);
    await POST(post({ receita: "acf-imoveis", prefixo: "wp_", post_type: "imovel" }), ctx);
    // .eq("organization_id", ORG) deve aparecer na vista da query.
    expect(resp.visto.eq.some(([c]) => c === "organization_id")).toBe(true);
  });

  it("rejeita papel abaixo de admin", async () => {
    deps.role.mockResolvedValue({
      ok: false,
      response: { status: 403 } as unknown as Response,
    });
    const res = await POST(
      post({ receita: "acf-imoveis", prefixo: "wp_", post_type: "imovel" }),
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("rejeita corpo sem receita acf-imoveis", async () => {
    const res = await POST(
      post({ receita: "woocommerce-produtos", prefixo: "wp_", post_type: "imovel" }),
      ctx,
    );
    expect(res.status).toBe(422);
  });

  it("a consulta de sugestão passa pelo validador", async () => {
    await POST(post({ receita: "acf-imoveis", prefixo: "wp_", post_type: "imovel" }), ctx);
    expect(deps.validarConsulta).toHaveBeenCalled();
    // O SQL passado ao validador deve ser um SELECT fixo, sem `;` nem `INTO`.
    const sqlPassado = deps.validarConsulta.mock.calls[0]![0] as string;
    expect(sqlPassado.trim()).toMatch(/^select /i);
    expect(sqlPassado).not.toContain(";");
    expect(sqlPassado.toUpperCase()).not.toContain("INTO");
  });

  it("rejeita conexão de outro motor (não mysql)", async () => {
    deps.admin.mockReturnValue(banco({ data: { id: ID, db_type: "postgres" } }).client);
    const res = await POST(
      post({ receita: "acf-imoveis", prefixo: "wp_", post_type: "imovel" }),
      ctx,
    );
    expect(res.status).toBe(422);
  });

  describe("segurança do prefixo e post_type (validação antes de tocar o banco)", () => {
    const casosInvalidos = [
      { prefixo: "wp_`x", post_type: "imovel", motivo: "crase fecha o identificador" },
      { prefixo: "wp x", post_type: "imovel", motivo: "espaço" },
      { prefixo: "wp; drop table", post_type: "imovel", motivo: "ponto-e-vírgula" },
      { prefixo: "a".repeat(21), post_type: "imovel", motivo: "mais de 20 caracteres" },
      { prefixo: "wp_", post_type: "Imovel", motivo: "maiúscula no post_type" },
      { prefixo: "wp_", post_type: "a".repeat(21), motivo: "post_type com mais de 20 caracteres" },
    ];

    for (const c of casosInvalidos) {
      it(`rejeita prefixo/${c.motivo} com 422 e não chama o banco`, async () => {
        const req = post({ receita: "acf-imoveis", prefixo: c.prefixo, post_type: c.post_type });
        const res = await POST(req, ctx);
        expect(res.status).toBe(422);
        // Não deve ter tentado abrir o banco (validação falha antes).
        expect(deps.abrirAcesso).not.toHaveBeenCalled();
      });
    }
  });

  describe("nova receita tabela-direta", () => {
    function dialetoCom(parcial: Record<string, unknown>) {
      const executarReceita = vi.fn();
      deps.abrirAcesso.mockResolvedValue({
        ok: true,
        dialeto: { executarReceita, schemaDasReceitas: () => "banco_teste", ...parcial },
      });
      return executarReceita;
    }

    it("sugere o mapeamento a partir das colunas liberadas, pelo dialeto (sem SQL de catálogo)", async () => {
      const colunasDaTabela = vi.fn(async () => new Set(["id", "modelo", "preco", "ano", "cor", "foto"]));
      const executarReceita = dialetoCom({ colunasDaTabela });
      const res = await POST(post({ receita: "tabela-direta", tabela: "carros" }), ctx);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(colunasDaTabela).toHaveBeenCalledWith("banco_teste", "carros");
      expect(executarReceita).not.toHaveBeenCalled();
      expect(body.data.colunas).toEqual(["id", "modelo", "preco", "ano", "cor", "foto"]);
      expect(body.data.mapeamento_sugerido).toEqual({
        id: "id",
        titulo: "modelo",
        preco: "preco",
        filtro_numero: "ano",
        imagem: "foto",
      });
    });

    it("tabela não liberada ou inexistente → 422 fonte_nao_liberada com mensagem legível", async () => {
      dialetoCom({ colunasDaTabela: vi.fn(async () => null) });
      const res = await POST(post({ receita: "tabela-direta", tabela: "carros" }), ctx);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("fonte_nao_liberada");
      expect(body.error.message).toContain("carros");
    });

    it("rejeita tabela inválida com 422 sem chamar o banco", async () => {
      const res = await POST(
        post({ receita: "tabela-direta", tabela: "carros`; drop table" }),
        ctx,
      );
      expect(res.status).toBe(422);
      expect(deps.abrirAcesso).not.toHaveBeenCalled();
    });
  });

  describe("nova receita jetengine-imoveis", () => {
    it("acha os CCTs pelo prefixo no catálogo liberado e sugere o mapeamento", async () => {
      const executarReceita = vi.fn();
      const col = (nome: string) => ({ nome });
      deps.abrirAcesso.mockResolvedValue({
        ok: true,
        dialeto: {
          executarReceita,
          schemaDasReceitas: () => "banco_teste",
          listarTabelas: vi.fn(async () => [
            { nome: "wp_jet_cct_imoveis", colunas: ["_ID", "titulo", "preco", "quartos", "bairro", "cidade", "area"].map(col) },
            { nome: "wp_posts", colunas: [col("ID")] },
            { nome: "outro_jet_cct_x", colunas: [col("a")] },
          ]),
        },
      });
      const res = await POST(post({ receita: "jetengine-imoveis", prefixo: "wp_" }), ctx);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(executarReceita).not.toHaveBeenCalled();
      expect(body.data.ccts).toHaveLength(1);
      expect(body.data.ccts[0].tabela).toBe("wp_jet_cct_imoveis");
      expect(body.data.ccts[0].mapeamento).toMatchObject({
        preco: "preco",
        quartos: "quartos",
        bairro: "bairro",
        cidade: "cidade",
        area: "area",
        titulo: "titulo",
      });
    });

    it("nenhuma tabela do prefixo liberada → ccts vazio", async () => {
      const res = await POST(post({ receita: "jetengine-imoveis", prefixo: "wp_" }), ctx);
      expect(res.status).toBe(200);
      expect((await res.json()).data.ccts).toEqual([]);
    });

    it("rejeita prefixo inválido com 422 sem chamar o banco", async () => {
      const res = await POST(
        post({ receita: "jetengine-imoveis", prefixo: "wp`x" }),
        ctx,
      );
      expect(res.status).toBe(422);
      expect(deps.abrirAcesso).not.toHaveBeenCalled();
    });
  });
});
