import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/v1/agenda/vinculos/route";
import { VinculoDaMarcacao } from "@/components/agenda/VinculoDaMarcacao";

const deps = vi.hoisted(() => ({ role: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: deps.from }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/contacts/NewContactDialog", () => ({ NewContactDialog: () => null }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: async (url: string) => (await GET(new Request(`http://localhost${url}`))).json(),
  },
}));

const ID = "11111111-1111-4111-8111-111111111111";
const OUTRO_ID = "22222222-2222-4222-8222-222222222222";
const contato = {
  id: ID,
  organization_id: "org-a",
  display_name: "Cíntia Nunes",
  name: null,
  phone_number: null,
  is_anonymized: false,
};
type Linha = Record<string, unknown>;
let linhas: Linha[];

// Executa os filtros recebidos pela rota sobre duas organizações. A projeção
// também é exercida: omitir display_name no select reproduz o nome invisível.
function consulta(tabela: string) {
  let dados = tabela === "contacts" ? [...linhas] : [];
  let colunas: string[] = [];
  const filtrarNome = (coluna: string, padrao: string) => {
    const termo = padrao.replace(/^%|%$/g, "").toLocaleLowerCase();
    return (linha: Linha) =>
      String(linha[coluna] ?? "")
        .toLocaleLowerCase()
        .includes(termo);
  };
  const query = {
    select: vi.fn((cols: string) => {
      colunas = cols.split(",");
      return query;
    }),
    eq: vi.fn((col: string, valor: unknown) => {
      dados = dados.filter((l) => l[col] === valor);
      return query;
    }),
    ilike: vi.fn((col: string, valor: string) => {
      dados = dados.filter(filtrarNome(col, valor));
      return query;
    }),
    or: vi.fn((filtro: string) => {
      const predicados = filtro.split(",").map((parte) => {
        const [coluna, operador, ...valor] = parte.split(".");
        if (!coluna || operador !== "ilike") throw new Error("Filtro inesperado");
        return filtrarNome(coluna, valor.join("."));
      });
      dados = dados.filter((l) => predicados.some((p) => p(l)));
      return query;
    }),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({
        data: dados.map((l) => Object.fromEntries(colunas.map((c) => [c, l[c]]))),
        error: null,
      }).then(resolve),
  };
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  linhas = [
    contato,
    { ...contato, id: OUTRO_ID, organization_id: "org-b" },
    { ...contato, id: "anonimo", is_anonymized: true },
  ];
  deps.role.mockResolvedValue({ ok: true, org: { orgId: "org-a" } });
  deps.from.mockImplementation(consulta);
});
async function buscar(params: Record<string, string> = {}) {
  const resposta = await GET(
    new Request(`http://localhost/api/v1/agenda/vinculos?${new URLSearchParams(params)}`),
  );
  expect(resposta.status).toBe(200);
  return (await resposta.json()).data;
}

describe("contatos da Agenda pelo nome exibido", () => {
  it("display_name preenchido com name nulo mantém exatamente o contrato { id, name }", async () => {
    expect(await buscar()).toEqual({
      contacts: [{ id: ID, name: "Cíntia Nunes" }],
      conversations: [],
    });
  });
  it("busca Cíntia pelo nome exibido sem expor outro tenant ou contato anonimizado", async () => {
    expect((await buscar({ q: "cíntia", organization_id: "org-b" })).contacts).toEqual([
      { id: ID, name: "Cíntia Nunes" },
    ]);
  });
  it("o ID de outro tenant não retorna contato nem consulta suas conversas", async () => {
    expect(await buscar({ contact_id: OUTRO_ID })).toEqual({ contacts: [], conversations: [] });
    expect(deps.from).not.toHaveBeenCalledWith("conversations");
  });
  it("buscar pelo ID mantém o nome canônico e o filtro de organização nas conversas", async () => {
    expect((await buscar({ contact_id: ID })).contacts).toEqual([{ id: ID, name: "Cíntia Nunes" }]);
    expect(deps.from).toHaveBeenCalledWith("conversations");
    const query = deps.from.mock.results[1]?.value;
    expect(query.eq).toHaveBeenCalledWith("organization_id", "org-a");
    expect(query.eq).toHaveBeenCalledWith("contact_id", ID);
  });
  it.each([null, "", "  "])(
    "cadastro antigo com display_name %s continua encontrável por name",
    async (display_name) => {
      linhas = [{ ...contato, display_name, name: "Maria Antiga" }];
      expect((await buscar({ q: "Maria" })).contacts).toEqual([{ id: ID, name: "Maria Antiga" }]);
    },
  );
  // A régua é a de `rotuloDoContato`: o nome que a pessoa escolheu (`name`)
  // vence o do perfil do WhatsApp (`display_name`) — issue #906, PR #907.
  it("prefere o nome do cadastro (name) quando os dois nomes estão preenchidos", async () => {
    linhas = [{ ...contato, name: "Cíntia Souza Nunes" }];
    expect((await buscar()).contacts).toEqual([{ id: ID, name: "Cíntia Souza Nunes" }]);
  });
  it("sem nomes usa o fallback compartilhado, nunca uma opção vazia", async () => {
    linhas = [{ ...contato, display_name: null }];
    expect((await buscar()).contacts).toEqual([{ id: ID, name: "Sem nome" }]);
  });
  it("delimitadores do filtro não podem inserir condições no OR", async () => {
    await buscar({ q: "Cíntia%,name.ilike._(Nunes)\\" });
    expect(deps.from.mock.results[0]?.value.or).toHaveBeenCalledWith(
      "display_name.ilike.%Cíntia name.ilike. Nunes %,name.ilike.%Cíntia name.ilike. Nunes %",
    );
  });
  it("Quem será atendido mostra Cíntia e a busca não oferece criar um contato existente", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onChange = vi.fn();
    render(
      <QueryClientProvider client={qc}>
        <VinculoDaMarcacao contactId="" conversationId="" onChange={onChange} />
      </QueryClientProvider>,
    );
    // Espera maior que o padrão de 1 s: com a máquina carregada a primeira
    // renderização da consulta passava do limite e o caso falhava sem defeito.
    const espera = { timeout: 5000 };
    expect(await screen.findByRole("option", { name: "Cíntia Nunes" }, espera)).toHaveValue(ID);
    fireEvent.change(screen.getByLabelText("Buscar cliente"), { target: { value: "Cíntia" } });
    await waitFor(
      () => expect(deps.from.mock.results.some((r) => r.value.or.mock.calls.length > 0)).toBe(true),
      espera,
    );
    await waitFor(
      () => expect(screen.queryByRole("button", { name: /Criar/ })).not.toBeInTheDocument(),
      espera,
    );
    expect(screen.getByRole("option", { name: "Cíntia Nunes" })).toHaveValue(ID);
    fireEvent.change(screen.getByLabelText("Quem será atendido"), { target: { value: ID } });
    expect(onChange).toHaveBeenLastCalledWith(ID, "");
    qc.clear();
  });
});
