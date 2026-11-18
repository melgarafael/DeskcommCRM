/**
 * GET /api/v1/contacts/compare — duas fichas lado a lado (Spec 31, PR A).
 *
 * Três coisas são provadas aqui: a forma do pedido (exatamente dois ids), o que a
 * sessão enxerga (1 ficha visível → 404), e o escopo da leitura da prospecção, que usa
 * o cliente administrador e por isso precisa do filtro de organização e dos ids lidos
 * pela sessão.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ orgAtivaDaApi: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Linha = Record<string, unknown>;

function ficha(id: string, parcial: Linha = {}): Linha {
  return {
    id,
    organization_id: ORG_ID,
    name: `Ficha ${id.slice(0, 2)}`,
    display_name: null,
    address_book_name: null,
    email: null,
    phone_number: "+5531999990000",
    source: "prospecting",
    source_metadata: { maps_url: "https://maps.example.com/x" },
    custom_fields: { link_site: "https://empresa.example.com/", outro_campo: "não sai" },
    created_at: "2026-01-01T00:00:00.000Z",
    last_activity_at: null,
    is_merged_into: null,
    is_anonymized: false,
    ...parcial,
  };
}

/**
 * Dublê do PostgREST para as tabelas da rota: `eq` e `in` são APLICADOS, e `count`
 * vale quando pedido com `head`. Registra cada consulta para as asserções de escopo.
 */
function fakeSupabase(dados: Record<string, Linha[]>, contagens: Record<string, number> = {}) {
  const consultas: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];
  const client = {
    from(tabela: string) {
      const registro = { tabela, filtros: [] as Array<[string, unknown]> };
      consultas.push(registro);
      const predicados: Array<(l: Linha) => boolean> = [];
      const builder: Record<string, unknown> = {};
      let head = false;
      builder.select = (_c: string, opcoes?: { head?: boolean }) => {
        head = opcoes?.head === true;
        return builder;
      };
      builder.eq = (coluna: string, valor: unknown) => {
        registro.filtros.push([coluna, valor]);
        predicados.push((l) => l[coluna] === valor);
        return builder;
      };
      builder.in = (coluna: string, valores: unknown[]) => {
        registro.filtros.push([coluna, valores]);
        predicados.push((l) => valores.includes(l[coluna]));
        return builder;
      };
      const resolver = () => {
        const linhas = (dados[tabela] ?? []).filter((l) => predicados.every((p) => p(l)));
        if (head) return Promise.resolve({ data: null, error: null, count: contagens[tabela] ?? 0 });
        return Promise.resolve({ data: linhas, error: null, count: null });
      };
      builder.then = (cb: (v: unknown) => unknown) => resolver().then(cb);
      return builder;
    },
  };
  return { consultas, client };
}

beforeEach(() => {
  vi.mocked(loadAuthUser).mockResolvedValue({
    id: USER_ID,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "viewer" }],
  } as never);
  vi.mocked(orgAtivaDaApi).mockResolvedValue({ ok: true, org: { orgId: ORG_ID, name: "Org" } } as never);
});

function pedido(ids: string | null): NextRequest {
  const qs = ids === null ? "" : `?ids=${encodeURIComponent(ids)}`;
  return new NextRequest(`http://localhost/api/v1/contacts/compare${qs}`);
}

async function chamar(ids: string | null): Promise<Response> {
  const { GET } = await import("./route");
  return GET(pedido(ids));
}

describe("GET /contacts/compare: a forma do pedido", () => {
  it("um id só → 422, e nem consulta o banco", async () => {
    const { client } = fakeSupabase({ contacts: [ficha(A)] });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar(A);

    expect(res.status).toBe(422);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("o mesmo id duas vezes → 422", async () => {
    const res = await chamar(`${A},${A}`);
    expect(res.status).toBe(422);
  });
});

describe("GET /contacts/compare: o que a sessão enxerga", () => {
  it("a sessão só enxerga uma das duas → 404", async () => {
    // A RLS deixa a sessão ver só A; B pode ser de outra organização ou não existir.
    const { client } = fakeSupabase({ contacts: [ficha(A)] });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar(`${A},${B}`);

    expect(res.status).toBe(404);
  });

  it("ficha mesclada conta como não encontrada → 404", async () => {
    // Sabotagem: não filtrar `is_merged_into` deixa a lápide aparecer na comparação.
    const { client } = fakeSupabase({
      contacts: [ficha(A), ficha(B, { is_merged_into: A })],
    });
    vi.mocked(createClient).mockResolvedValue(client as never);

    const res = await chamar(`${A},${B}`);

    expect(res.status).toBe(404);
  });
});

describe("GET /contacts/compare: o escopo da leitura da prospecção", () => {
  it("consulta a prospecção pela organização da SESSÃO e só pelos ids que a sessão leu", async () => {
    // Sabotagem: ler a prospecção pelos ids do pedido (sem a leitura da sessão) ou sem
    // `eq("organization_id")` deixa este caso vermelho.
    const { client } = fakeSupabase({ contacts: [ficha(A), ficha(B)] }, { conversations: 0 });
    vi.mocked(createClient).mockResolvedValue(client as never);
    const prospeccao = fakeSupabase({
      prospecting_candidates: [
        { contact_id: A, organization_id: ORG_ID, data: { category: "Odontologia", website: "https://a.example.com" } },
        { contact_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", organization_id: ORG_ID, data: { category: "Outra" } },
      ],
    });
    vi.mocked(createAdminClient).mockReturnValue(prospeccao.client as never);

    const res = await chamar(`${A},${B}`);
    const json = (await res.json()) as { data: { contatos: Array<{ id: string; prospeccao: { categorias: string[]; sites: string[] } }> } };

    expect(res.status).toBe(200);
    const consultaProspeccao = prospeccao.consultas.find((c) => c.tabela === "prospecting_candidates");
    expect(consultaProspeccao?.filtros).toContainEqual(["organization_id", ORG_ID]);
    const idsPedidos = consultaProspeccao?.filtros.find(([coluna]) => coluna === "contact_id")?.[1] as string[];
    expect(idsPedidos.slice().sort()).toEqual([A, B].sort());
    // O candidato de outra ficha não vaza para a resposta.
    const contatoA = json.data.contatos.find((c) => c.id === A)!;
    expect(contatoA.prospeccao.categorias).toEqual(["Odontologia"]);
    expect(contatoA.prospeccao.sites).toEqual(["https://a.example.com"]);
  });

  it("a resposta não devolve custom_fields inteiro nem source_metadata inteiro", async () => {
    const { client } = fakeSupabase({ contacts: [ficha(A), ficha(B)] });
    vi.mocked(createClient).mockResolvedValue(client as never);
    vi.mocked(createAdminClient).mockReturnValue(fakeSupabase({}).client as never);

    const json = (await (await chamar(`${A},${B}`)).json()) as { data: { contatos: Array<Record<string, unknown>> } };

    const contato = json.data.contatos[0]!;
    expect(contato).not.toHaveProperty("custom_fields");
    expect(contato).not.toHaveProperty("source_metadata");
    expect(contato.maps_url).toBe("https://maps.example.com/x");
    // Só o link exibível passa, e o campo que não é link fica de fora.
    expect(contato.links).toEqual([{ tipo: "site", href: "https://empresa.example.com/" }]);
  });
});
