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

/**
 * O query builder do supabase é "thenable": `await` numa cadeia sem terminal
 * resolve o resultado. O dublê imita isso — sem o `then`, quem espera a cadeia
 * recebe o próprio objeto e o teste mede a mentira do dublê.
 */
function cadeia(resultado: unknown, filtros?: Array<[string, unknown]>) {
  const c = {
    select: () => c,
    eq: (col: string, v: unknown) => (filtros?.push([col, v]), c),
    in: () => c,
    order: () => c,
    limit: async () => resultado,
    maybeSingle: async () => resultado,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resultado).then(res, rej),
  };
  return c;
}

function cliente(
  dados: {
    contato?: unknown;
    roteiros?: unknown[];
    eventos?: unknown[];
    leads?: unknown[];
  },
  filtros?: Array<[string, unknown]>,
) {
  return {
    from: (tabela: string) => {
      if (tabela === "contacts") return cadeia({ data: dados.contato, error: null }, filtros);
      if (tabela === "followup_enrollments")
        return cadeia({ data: dados.roteiros ?? [], error: null }, filtros);
      if (tabela === "followup_enrollment_events")
        return cadeia({ data: dados.eventos ?? [], error: null }, filtros);
      if (tabela === "crm_leads") return cadeia({ data: dados.leads ?? [], error: null }, filtros);
      return cadeia({ data: [], error: null }, filtros);
    },
  };
}

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
    deps.client.mockResolvedValue(
      cliente(
        {
          contato: { id: ID, custom_fields: { nome_completo: "Lia Mendes" } },
          roteiros: [
            {
              id: "e1",
              status: "completed",
              started_at: "2026-09-24T10:00:00Z",
              completed_at: "2026-09-24T10:05:00Z",
              followup_flow_pointers: { name: "Cadastro", surface: "atendimento" },
              followup_flow_versions: { graph: grafo },
            },
          ],
        },
        filtros,
      ),
    );
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

/**
 * #3363 — o que a ficha recebe para PEDIR a escolha. A decisão de produto é
 * explícita: com 2+ cards abertos não há default; com um só, ele é o vínculo e
 * não se pergunta.
 */
describe("GET /api/v1/contacts/:id/roteiros — negócio da execução (#3363)", () => {
  const grafoNoNegocio = {
    nodes: [
      { id: "t", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
      {
        id: "c1",
        type: "collect",
        label: "Destino",
        position: { x: 0, y: 0 },
        config: {
          key: "destino_viagem",
          label: "Destino",
          type: "text",
          required: true,
          permite_correcao: true,
          destino: "negocio",
        },
      },
      { id: "e", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "converted" } },
    ],
    edges: [
      { id: "a", source: "t", target: "c1", priority: 0, condition: { type: "always" } },
      { id: "b", source: "c1", target: "e", priority: 0, condition: { type: "always" } },
    ],
  };
  const roteiro = (status: string) => ({
    id: "e1",
    status,
    started_at: "2026-09-24T10:00:00Z",
    completed_at: null,
    followup_flow_pointers: { name: "Qualificação", surface: "atendimento" },
    followup_flow_versions: { graph: grafoNoNegocio },
  });

  it("⭐ dois cards abertos e nada fixado: `escolha_pendente`, sem default", async () => {
    deps.modulo.mockResolvedValue(true);
    deps.client.mockResolvedValue(
      cliente({
        contato: { id: ID, custom_fields: {} },
        roteiros: [roteiro("coletando")],
        eventos: [],
        leads: [
          { id: "l1", title: "Viagem Chile", custom_fields: {} },
          { id: "l2", title: "Viagem Bahia", custom_fields: {} },
        ],
      }),
    );
    const res = await GET(req(), ctx);
    const corpo = (await res.json()) as {
      data: Array<{
        negocio?: { vinculo: unknown; candidatos: unknown[]; escolha_pendente: boolean };
        campos: Array<{ valor: string | null }>;
      }>;
    };
    expect(corpo.data[0]!.negocio).toEqual({
      vinculo: null,
      candidatos: [
        { id: "l1", titulo: "Viagem Chile" },
        { id: "l2", titulo: "Viagem Bahia" },
      ],
      escolha_pendente: true,
    });
    // Nada de "o mais recente" aparecendo como se fosse o destino.
    expect(corpo.data[0]!.campos[0]!.valor).toBeNull();
  });

  it("⭐ vínculo fixado: a ficha nomeia o card e lê o valor DELE", async () => {
    deps.modulo.mockResolvedValue(true);
    deps.client.mockResolvedValue(
      cliente({
        contato: { id: ID, custom_fields: {} },
        roteiros: [roteiro("coletando")],
        eventos: [
          { enrollment_id: "e1", payload: { lead_id: "l2" } },
          // Um segundo evento (não deveria existir) não troca o destino.
          { enrollment_id: "e1", payload: { lead_id: "l1" } },
        ],
        leads: [
          { id: "l1", title: "Viagem Chile", custom_fields: { destino_viagem: "Chile" } },
          { id: "l2", title: "Viagem Bahia", custom_fields: { destino_viagem: "Bahia" } },
        ],
      }),
    );
    const res = await GET(req(), ctx);
    const corpo = (await res.json()) as {
      data: Array<{
        negocio?: { vinculo: { id: string } | null; escolha_pendente: boolean };
        campos: Array<{ valor: string | null }>;
      }>;
    };
    expect(corpo.data[0]!.negocio?.vinculo).toEqual({ id: "l2", titulo: "Viagem Bahia" });
    expect(corpo.data[0]!.negocio?.escolha_pendente).toBe(false);
    expect(corpo.data[0]!.campos[0]!.valor).toBe("Bahia");
  });

  it("roteiro concluído não pede escolha: execução nova resolve de novo", async () => {
    deps.modulo.mockResolvedValue(true);
    deps.client.mockResolvedValue(
      cliente({
        contato: { id: ID, custom_fields: {} },
        roteiros: [roteiro("completed")],
        eventos: [],
        leads: [
          { id: "l1", title: "Viagem Chile", custom_fields: {} },
          { id: "l2", title: "Viagem Bahia", custom_fields: {} },
        ],
      }),
    );
    const res = await GET(req(), ctx);
    const corpo = (await res.json()) as { data: Array<{ negocio?: unknown }> };
    expect(corpo.data[0]!.negocio).toBeUndefined();
  });
});
