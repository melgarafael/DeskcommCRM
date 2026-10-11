/**
 * Fontes liberadas — rotas. O que a prova precisa mostrar:
 *   - a lista e o modo só mudam por administrador, na organização DO CONTEXTO;
 *   - conexão de outra organização é 404 (nada é gravado);
 *   - lista inválida (duplicada, formato errado) é 422 e não grava;
 *   - o audit guarda CONTAGENS, nunca nomes de tabela ou de coluna.
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
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: deps.modulo }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: deps.rate }));

import { GET, PUT } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const FONTE = { schema: "public", tabela: "clientes", colunas: ["id", "nome"], descricao: "Quem compra" };

function banco(resposta: { data: unknown; error?: unknown }) {
  const visto: { payload?: Record<string, unknown>; select?: string; eq: Array<[string, unknown]> } = { eq: [] };
  const cadeia: Record<string, unknown> = {};
  cadeia.update = (payload: Record<string, unknown>) => ((visto.payload = payload), cadeia);
  cadeia.select = (cols: string) => ((visto.select = cols), cadeia);
  cadeia.eq = (c: string, v: unknown) => (visto.eq.push([c, v]), cadeia);
  cadeia.maybeSingle = async () => ({ data: resposta.data, error: resposta.error ?? null });
  return { visto, client: { from: () => cadeia } };
}

function put(corpo: unknown) {
  return new NextRequest(`http://localhost/api/v1/external-db/connections/${ID}/sources`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
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
});

describe("PUT /connections/:id/sources", () => {
  it("grava modo e lista juntos, filtrando pela organização do CONTEXTO, e audita só contagens", async () => {
    const { visto, client } = banco({ data: { source_mode: "list", sources: [FONTE] } });
    deps.admin.mockReturnValue(client);

    const res = await PUT(put({ source_mode: "list", sources: [FONTE] }), ctx);

    expect(res.status).toBe(200);
    expect(visto.payload).toEqual({ source_mode: "list", sources: [FONTE] });
    expect(visto.eq).toEqual([
      ["organization_id", ORG],
      ["id", ID],
    ]);
    expect(deps.audit).toHaveBeenCalledOnce();
    const evento = deps.audit.mock.calls[0]![0] as { action: string; metadata: Record<string, unknown> };
    expect(evento.action).toBe("external_db_sources.updated");
    expect(evento.metadata).toEqual({ source_mode: "list", fontes: 1 });
    expect(JSON.stringify(evento)).not.toContain("clientes");
  });

  it("conexão de OUTRA organização (a consulta não acha): 404 e sem audit de sucesso", async () => {
    const { client } = banco({ data: null });
    deps.admin.mockReturnValue(client);
    const res = await PUT(put({ source_mode: "list", sources: [FONTE] }), ctx);
    expect(res.status).toBe(404);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("lista duplicada ou fora do formato: 422 e NADA é gravado", async () => {
    const { visto, client } = banco({ data: { source_mode: "list", sources: [] } });
    deps.admin.mockReturnValue(client);
    const duplicada = await PUT(put({ source_mode: "list", sources: [FONTE, FONTE] }), ctx);
    const feia = await PUT(put({ source_mode: "list", sources: [{ tabela: "x" }] }), ctx);
    const modoErrado = await PUT(put({ source_mode: "talvez", sources: [] }), ctx);
    expect([duplicada.status, feia.status, modoErrado.status]).toEqual([422, 422, 422]);
    expect(visto.payload).toBeUndefined();
  });

  it("corpo fora dos LIMITES: 422 e NADA é gravado", async () => {
    const { visto, client } = banco({ data: { source_mode: "list", sources: [] } });
    deps.admin.mockReturnValue(client);
    const demais = Array.from({ length: 201 }, (_, i) => ({
      schema: "public",
      tabela: `tabela_${i}`,
      colunas: null,
      descricao: "",
    }));
    const muitasFontes = await PUT(put({ source_mode: "list", sources: demais }), ctx);
    const descricaoLonga = await PUT(
      put({ source_mode: "list", sources: [{ ...FONTE, descricao: "x".repeat(301) }] }),
      ctx,
    );
    const muitasColunas = await PUT(
      put({
        source_mode: "list",
        sources: [{ ...FONTE, colunas: Array.from({ length: 201 }, (_, i) => `coluna_${i}`) }],
      }),
      ctx,
    );
    const naoEArray = await PUT(put({ source_mode: "list", sources: "lixo" }), ctx);
    expect([muitasFontes.status, descricaoLonga.status, muitasColunas.status, naoEArray.status]).toEqual([
      422, 422, 422, 422,
    ]);
    expect(visto.payload).toBeUndefined();
  });

  it("corpo com chave desconhecida: 422 (contrato estrito)", async () => {
    const { client } = banco({ data: null });
    deps.admin.mockReturnValue(client);
    const res = await PUT(put({ source_mode: "all", sources: [], organization_id: "outra" }), ctx);
    expect(res.status).toBe(422);
  });

  it("quem não é administrador não passa (a resposta do requireRole sai direto)", async () => {
    deps.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await PUT(put({ source_mode: "list", sources: [] }), ctx);
    expect(res.status).toBe(403);
    // O mock devolve 403 para qualquer papel: sem esta linha, trocar "admin" por
    // "viewer" na rota passava verde (sabotado na triagem do #2634).
    expect(deps.role).toHaveBeenCalledWith("admin", expect.anything());
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("sessão de suporte somente-leitura: a guarda de efeito barra antes de tudo", async () => {
    deps.support.mockResolvedValue(new Response(null, { status: 403 }));
    const res = await PUT(put({ source_mode: "list", sources: [] }), ctx);
    expect(res.status).toBe(403);
    expect(deps.role).not.toHaveBeenCalled();
  });

  it("módulo desligado: 404", async () => {
    deps.modulo.mockResolvedValue(false);
    deps.admin.mockReturnValue({});
    const res = await PUT(put({ source_mode: "list", sources: [] }), ctx);
    expect(res.status).toBe(404);
  });
});

describe("GET /connections/:id/sources", () => {
  it("devolve o modo e a lista da organização do contexto", async () => {
    const { visto, client } = banco({ data: { source_mode: "list", sources: [FONTE] } });
    deps.admin.mockReturnValue(client);
    const res = await GET(new NextRequest("http://localhost/x"), ctx);
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { source_mode: string; sources: unknown[] } };
    expect(corpo.data).toEqual({ source_mode: "list", sources: [FONTE] });
    expect(visto.eq[0]).toEqual(["organization_id", ORG]);
    // O GET lê só as duas colunas seguras — nunca as colunas cifradas.
    expect(visto.select).toBe("source_mode, sources");
    const texto = JSON.stringify(corpo);
    expect(texto).not.toContain("password");
    expect(texto).not.toContain("encrypted");
    expect(texto).not.toContain("password_iv");
  });

  it("lista corrompida no banco volta VAZIA (falha fechada), não o lixo", async () => {
    const { client } = banco({ data: { source_mode: "list", sources: "lixo" } });
    deps.admin.mockReturnValue(client);
    const res = await GET(new NextRequest("http://localhost/x"), ctx);
    const corpo = (await res.json()) as { data: { sources: unknown[] } };
    expect(corpo.data.sources).toEqual([]);
  });

  it("conexão que não é da organização: 404", async () => {
    const { client } = banco({ data: null });
    deps.admin.mockReturnValue(client);
    const res = await GET(new NextRequest("http://localhost/x"), ctx);
    expect(res.status).toBe(404);
  });
});
