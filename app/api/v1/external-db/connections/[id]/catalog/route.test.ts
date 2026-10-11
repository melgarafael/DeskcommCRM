/**
 * Catálogo completo — rota do administrador. O que a prova precisa mostrar:
 *   - só o administrador chega ao banco de origem (com a organização DO CONTEXTO);
 *   - a leitura vai AO VIVO (chave de taxa própria) e é auditada com CONTAGENS;
 *   - conexão de outra organização é 404;
 *   - fora do ar vira 502, não exceção.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  role: vi.fn(),
  audit: vi.fn(),
  admin: vi.fn(),
  modulo: vi.fn(),
  rate: vi.fn(),
  acesso: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: deps.admin }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: deps.modulo }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: deps.rate }));
vi.mock("@/lib/external-db/acesso", () => ({ abrirAcesso: deps.acesso }));

import { GET } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const TABELA = {
  schema: "public",
  nome: "clientes",
  tipo: "tabela",
  colunas: [{ nome: "id", tipo: "uuid", nulavel: false, posicao: 1 }],
  chavePrimaria: ["id"],
  estimativaLinhas: 10,
};

const ctx = { params: Promise.resolve({ id: ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  deps.modulo.mockResolvedValue(true);
  deps.rate.mockResolvedValue({ allowed: true });
  deps.admin.mockReturnValue({});
  deps.role.mockResolvedValue({
    ok: true,
    user: { id: "u-1", idioma: "pt-BR" },
    org: { orgId: ORG, role: "admin" },
  });
});

describe("GET /connections/:id/catalog", () => {
  it("administrador, conexão ok: devolve o catálogo completo e audita contagens", async () => {
    deps.acesso.mockResolvedValue({
      ok: true,
      conexao: { id: ID },
      dialeto: { catalogoCompleto: async () => [TABELA] },
    });

    const res = await GET(new NextRequest("http://localhost/x"), ctx);

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: { tabelas: unknown[] } };
    expect(corpo.data.tabelas).toHaveLength(1);
    expect(deps.audit).toHaveBeenCalledOnce();
    const evento = deps.audit.mock.calls[0]![0] as { metadata: Record<string, unknown> };
    expect(evento.metadata).toEqual({ escopo: "catalogo_completo", tabelas: 1 });
    expect(deps.rate).toHaveBeenCalledWith(`external-db:catalog:${ORG}`, 30, 60);
  });

  it("quem não é administrador não passa (a resposta do requireRole sai direto)", async () => {
    deps.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    const res = await GET(new NextRequest("http://localhost/x"), ctx);
    expect(res.status).toBe(403);
    // O mock devolve 403 para qualquer papel: sem esta linha, trocar "admin" por
    // "viewer" na rota passava verde (sabotado na triagem do #2634).
    expect(deps.role).toHaveBeenCalledWith("admin", expect.anything());
    expect(deps.acesso).not.toHaveBeenCalled();
  });

  it("conexão de OUTRA organização: 404, com o ORG do contexto como segundo argumento", async () => {
    deps.acesso.mockResolvedValue({ ok: false, motivo: "nao_encontrada" });
    const res = await GET(new NextRequest("http://localhost/x"), ctx);
    expect(res.status).toBe(404);
    // A organização nunca vem da URL nem do corpo: é a do contexto autenticado.
    expect(deps.acesso).toHaveBeenCalledWith(expect.anything(), ORG, ID);
  });

  it("módulo desligado: 404 e o banco de origem nem é tocado", async () => {
    deps.modulo.mockResolvedValue(false);
    const res = await GET(new NextRequest("http://localhost/x"), ctx);
    expect(res.status).toBe(404);
    expect(deps.acesso).not.toHaveBeenCalled();
  });

  it("limite estourado: 429 e o banco de origem nem é tocado", async () => {
    deps.rate.mockResolvedValue({ allowed: false });
    const res = await GET(new NextRequest("http://localhost/x"), ctx);
    expect(res.status).toBe(429);
    expect(deps.acesso).not.toHaveBeenCalled();
  });

  it("banco de origem fora do ar: 502", async () => {
    deps.acesso.mockResolvedValue({
      ok: true,
      conexao: { id: ID },
      dialeto: {
        catalogoCompleto: async () => {
          throw new Error("conexão recusada");
        },
      },
    });
    const res = await GET(new NextRequest("http://localhost/x"), ctx);
    expect(res.status).toBe(502);
  });
});
