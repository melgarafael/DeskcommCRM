/**
 * Pré-visualização de receitas — rota. O que a prova precisa mostrar:
 *   - requireSupportWrite e requireRole("admin") são respeitados;
 *   - a organização vem da sessão;
 *   - instância inexistente → 404;
 *   - parâmetros de busca inválidos → 422;
 *   - fonte não liberada → fonte_nao_liberada (com dialeto dublê);
 *   - auditoria só com CONTAGENS, nenhum valor de linha no metadata.
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
  acessar: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: deps.modulo }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: deps.rate }));
vi.mock("@/lib/external-db/receitas/instancias", () => ({
  lerReceitasDoBanco: deps.receitas,
}));
vi.mock("@/lib/external-db/receitas/registro", () => ({ receitaDe: deps.receitaDe }));
import type { receitaDe } from "@/lib/external-db/receitas/registro";
vi.mock("@/lib/external-db/acesso", () => ({ abrirAcesso: deps.acessar }));

import { POST } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const INSTANCIA_ID = "33333333-3333-4333-8333-333333333333";

function banco(resposta: { data: unknown; error?: unknown }) {
  const visto: { select?: string; eq: Array<[string, unknown]> } = { eq: [] };
  const cadeia: Record<string, unknown> = {};
  cadeia.select = (cols: string) => ((visto.select = cols), cadeia);
  cadeia.eq = (c: string, v: unknown) => (visto.eq.push([c, v]), cadeia);
  cadeia.maybeSingle = async () => ({ data: resposta.data, error: resposta.error ?? null });
  return { visto, client: { from: () => cadeia } };
}

function post(corpo: unknown) {
  return new NextRequest(
    `http://localhost/api/v1/external-db/connections/${ID}/recipes/preview`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
    },
  );
}
const ctx = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  deps.modulo.mockResolvedValue(true);
  deps.support.mockResolvedValue(null);
  deps.rate.mockResolvedValue({ allowed: true });
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: "u-1", idioma: "pt-BR" },
    org: { orgId: ORG, role: "admin" },
  });
  deps.receitas.mockReturnValue({
    ok: true,
    instancias: [
      { id: INSTANCIA_ID, receita: "woocommerce-produtos", rotulo: "Produtos", fixos: { prefixo: "wp_" }, ativa: true },
    ],
  });
  deps.receitaDe.mockReturnValue({
    id: "woocommerce-produtos",
    motores: ["mysql"],
    parametrosDaBusca: {
      parse: (v: unknown) => v,
    },
    tabelas: () => ["wp_posts", "wp_postmeta"],
    colunas: () => ({ "wp_posts": ["ID", "post_title"] }),
    montar: () => ({ sql: "select ...", valores: [] }),
    tetoDeItens: 5,
  } as unknown as ReturnType<typeof receitaDe>);
  deps.acessar.mockResolvedValue({
    ok: true,
    conexao: { id: ID, organizationId: ORG },
    dialeto: {
      executarReceita: vi.fn(async () => ({
        colunas: ["id", "titulo"],
        linhas: [{ id: "1", titulo: "Camisa" }],
        limite: 5,
        offset: 0,
        truncado: false,
      })),
    },
  });
});

describe("POST /connections/:id/recipes/preview", () => {
  it("requireSupportWrite e requireRole('admin') são respeitados", async () => {
    deps.support.mockResolvedValue(new Response(null, { status: 403 }));
    const res = await POST(post({ instancia_id: INSTANCIA_ID }), ctx);
    expect(res.status).toBe(403);
    expect(deps.role).not.toHaveBeenCalled();

    deps.support.mockResolvedValue(null);
    deps.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    const res2 = await POST(post({ instancia_id: INSTANCIA_ID }), ctx);
    expect(res2.status).toBe(403);
    expect(deps.support).toHaveBeenCalled();
  });

  it("a organização vem da sessão (organization_id)", async () => {
    const { visto, client } = banco({ data: { receitas: [INSTANCIA_ID], db_type: "mysql" } });
    deps.admin.mockReturnValue(client);
    await POST(post({ instancia_id: INSTANCIA_ID, busca: { termos: ["camisa"] } }), ctx);
    expect(visto.eq[0]).toEqual(["organization_id", ORG]);
    expect(visto.eq[1]).toEqual(["id", ID]);
  });

  it("instância inexistente → 404", async () => {
    deps.receitas.mockReturnValue({ ok: true, instancias: [] });
    const { client } = banco({ data: { receitas: [], db_type: "mysql" } });
    deps.admin.mockReturnValue(client);

    const res = await POST(post({ instancia_id: "00000000-0000-0000-0000-000000000000" }), ctx);

    expect(res.status).toBe(404);
    expect(deps.acessar).not.toHaveBeenCalled();
  });

  it("parâmetros de busca inválidos → 422", async () => {
    deps.receitaDe.mockReturnValue({
      id: "woocommerce-produtos",
      motores: ["mysql"],
      parametrosDaBusca: {
        parse: () => {
          throw new Error("preco_max deve ser número");
        },
      } as unknown as NonNullable<ReturnType<typeof receitaDe>>["parametrosDaBusca"],
    });

    const res = await POST(post({ instancia_id: INSTANCIA_ID, busca: { preco_max: "lixo" } }), ctx);

    expect(res.status).toBe(422);
    const texto = JSON.stringify(await res.json());
    expect(texto).toContain("validation_failed");
    expect(deps.acessar).not.toHaveBeenCalled();
  });

  it("fonte não liberada → fonte_nao_liberada (com dialeto dublê)", async () => {
    deps.acessar.mockResolvedValue({
      ok: true,
      conexao: { id: ID, organizationId: ORG },
      dialeto: {
        executarReceita: vi.fn(async () => {
          throw Object.assign(new Error("fonte_nao_liberada"), { name: "FonteNaoLiberadaError" });
        }),
      },
    });

    const res = await POST(post({ instancia_id: INSTANCIA_ID }), ctx);

    expect(res.status).toBe(422);
    const texto = JSON.stringify(await res.json());
    expect(texto).toContain("fonte_nao_liberada");
  });

  it("sucesso: auditoria só com contagens, nenhum valor de linha", async () => {
    const { client } = banco({ data: { receitas: [INSTANCIA_ID], db_type: "mysql" } });
    deps.admin.mockReturnValue(client);

    const res = await POST(post({ instancia_id: INSTANCIA_ID, busca: { termos: ["camisa"], preco_max: 60 } }), ctx);

    expect(res.status).toBe(200);
    expect(deps.acessar).toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledOnce();
    const evento = deps.audit.mock.calls[0]![0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(evento.action).toBe("external_db_recipes.previewed");
    expect(evento.metadata).toEqual({
      instancia: INSTANCIA_ID,
      receita: "woocommerce-produtos",
      linhas: 1,
      colunas: 2,
      truncado: false,
    } as Record<string, unknown>);
    const texto = JSON.stringify(evento.metadata);
    expect(texto).not.toContain("Camisa");
    expect(texto).not.toContain("camisa");
    expect(texto).not.toContain("60");
  });

  it("com dois termos, o dialeto recebe limiteMax = 2 × o limite por termo", async () => {
    let limiteMaxRecebido: number | undefined;
    const executarReceita = vi.fn(async (_opcoes: unknown, opts?: { limiteMax?: number }) => {
      limiteMaxRecebido = opts?.limiteMax;
      return {
        colunas: ["id", "titulo"],
        linhas: [{ id: "1", titulo: "Camisa" }],
        limite: 5,
        offset: 0,
        truncado: false,
      };
    });
    deps.acessar.mockResolvedValue({
      ok: true,
      conexao: { id: ID, organizationId: ORG },
      dialeto: { executarReceita },
    });
    const { client } = banco({ data: { receitas: [INSTANCIA_ID], db_type: "mysql" } });
    deps.admin.mockReturnValue(client);

    const res = await POST(
      post({ instancia_id: INSTANCIA_ID, busca: { termos: ["camiseta", "sorvete"] } }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(executarReceita).toHaveBeenCalledTimes(1);
    expect(limiteMaxRecebido).toBe(10);
  });
});
