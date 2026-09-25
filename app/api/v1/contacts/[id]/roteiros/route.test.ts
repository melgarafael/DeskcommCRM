/**
 * A ficha e o painel da conversa leem o que os roteiros coletaram por aqui.
 * Módulo desligado = a rota não existe (404) e o banco nem é consultado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({ role: vi.fn(), client: vi.fn(), modulo: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: deps.modulo }));

import { GET } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id: ID }) };
const req = () => new NextRequest(`http://localhost/api/v1/contacts/${ID}/roteiros`);

beforeEach(() => {
  vi.clearAllMocks();
  deps.role.mockResolvedValue({ ok: true, user: { id: "eu", idioma: "pt-BR" }, org: { orgId: "org", role: "viewer" } });
});

describe("GET /api/v1/contacts/:id/roteiros", () => {
  it("módulo desligado: 404, sem consulta", async () => {
    deps.modulo.mockResolvedValue(false);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(deps.client).not.toHaveBeenCalled();
  });

  it("ligado: devolve rótulo e valor dos campos, só de roteiros", async () => {
    deps.modulo.mockResolvedValue(true);
    const grafo = {
      nodes: [
        { id: "t", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        {
          id: "c1",
          type: "collect",
          label: "Nome",
          position: { x: 0, y: 0 },
          config: { key: "nome_completo", label: "Nome completo", type: "text", required: true, permite_correcao: true },
        },
        { id: "e", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
      ],
      edges: [
        { id: "a", source: "t", target: "c1", priority: 0, condition: { type: "always" } },
        { id: "b", source: "c1", target: "e", priority: 0, condition: { type: "always" } },
      ],
    };
    const filtros: Array<[string, unknown]> = [];
    const cadeia = (resultado: unknown) => {
      const c = {
        select: () => c,
        eq: (col: string, v: unknown) => (filtros.push([col, v]), c),
        order: () => c,
        limit: async () => resultado,
        maybeSingle: async () => resultado,
      };
      return c;
    };
    deps.client.mockResolvedValue({
      from: (tabela: string) =>
        tabela === "contacts"
          ? cadeia({ data: { id: ID, custom_fields: { nome_completo: "Lia Mendes" } }, error: null })
          : cadeia({
              data: [
                {
                  id: "e1",
                  status: "completed",
                  started_at: "2026-09-24T10:00:00Z",
                  completed_at: "2026-09-24T10:05:00Z",
                  followup_flow_pointers: { name: "Cadastro", surface: "atendimento" },
                  followup_flow_versions: { graph: grafo },
                },
              ],
              error: null,
            }),
    });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Array<{ nome: string; campos: unknown[] }> };
    expect(corpo.data).toHaveLength(1);
    expect(corpo.data[0]!.campos).toEqual([{ key: "nome_completo", label: "Nome completo", valor: "Lia Mendes" }]);
    expect(filtros).toContainEqual(["followup_flow_pointers.surface", "atendimento"]);
    expect(filtros).toContainEqual(["organization_id", "org"]);
  });

  it("⭐ contato anonimizado: lista vazia, e os roteiros nem são consultados", async () => {
    deps.modulo.mockResolvedValue(true);
    const tabelas: string[] = [];
    const cadeia = {
      select: () => cadeia,
      eq: () => cadeia,
      maybeSingle: async () => ({ data: { id: ID, custom_fields: {}, is_anonymized: true }, error: null }),
    };
    deps.client.mockResolvedValue({ from: (t: string) => (tabelas.push(t), cadeia) });
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
    expect(tabelas).toEqual(["contacts"]);
  });
});
