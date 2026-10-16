import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { estado, salvarMock, invalidar, definirDados } = vi.hoisted(() => ({
  estado: {
    salvas: { data: undefined as unknown, isLoading: false, isError: false },
    catalogo: {
      data: undefined as unknown,
      isLoading: false,
      isError: false,
      isSuccess: true,
      refetch: vi.fn(),
    },
  },
  salvarMock: vi.fn(),
  invalidar: vi.fn(),
  definirDados: vi.fn(),
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidar, setQueryData: definirDados }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/external-db/useConexoesExternas", () => ({ conexoesExternasQueryKey: ["lista"] }));
vi.mock("@/hooks/external-db/useCatalogoExterno", () => ({ catalogoExternoQueryKey: (id: string) => ["schemas", id] }));
vi.mock("@/hooks/external-db/useFontesDaConexao", () => ({
  fontesQueryKey: (id: string) => ["sources", id],
  salvarFontes: salvarMock,
  useFontesDaConexao: () => estado.salvas,
}));
const useCatalogoCompletoMock = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/external-db/useCatalogoCompleto", () => ({
  useCatalogoCompleto: useCatalogoCompletoMock,
}));

import { PainelDeFontes } from "./PainelDeFontes";

function tabela(nome: string, colunas: string[], tipo: "tabela" | "view" = "tabela") {
  return {
    schema: "public",
    nome,
    tipo,
    colunas: colunas.map((c, i) => ({ nome: c, tipo: "text", nulavel: true, posicao: i + 1 })),
    chavePrimaria: ["id"],
    estimativaLinhas: 10,
  };
}

const CATALOGO = [tabela("pedidos", ["id", "telefone", "total"]), tabela("wp_users", ["id", "user_pass"])];

function preparar(opts: {
  modo?: "all" | "list";
  fontes?: unknown[];
  catalogo?: unknown[];
  catalogoErro?: boolean;
}) {
  estado.salvas = { data: { source_mode: opts.modo ?? "list", sources: opts.fontes ?? [] }, isLoading: false, isError: false };
  estado.catalogo = {
    data: opts.catalogoErro ? undefined : (opts.catalogo ?? CATALOGO),
    isLoading: false,
    isError: opts.catalogoErro === true,
    isSuccess: opts.catalogoErro !== true,
    refetch: vi.fn(),
  };
}

function montar(props: Partial<{ canWrite: boolean; colunaDoCliente: string | null }> = {}) {
  return render(
    <PainelDeFontes connectionId="conn-1" canWrite={props.canWrite ?? true} colunaDoCliente={props.colunaDoCliente ?? null} abertoInicial />,
  );
}

beforeEach(() => {
  salvarMock.mockReset();
  invalidar.mockReset();
  definirDados.mockReset();
  useCatalogoCompletoMock.mockReset();
  useCatalogoCompletoMock.mockImplementation(() => estado.catalogo);
});

describe("PainelDeFontes", () => {
  it("1. quem só lê vê a lista, sem caixas nem Salvar, e NEM chama o catálogo", () => {
    preparar({ fontes: [{ schema: "public", tabela: "pedidos", colunas: ["id"], descricao: "pedidos dos clientes" }] });
    montar({ canWrite: false });
    expect(screen.getByText("public.pedidos")).toBeTruthy();
    expect(screen.getByText(/pedidos dos clientes/)).toBeTruthy();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
    expect(useCatalogoCompletoMock).toHaveBeenCalledWith("conn-1", { enabled: false });
  });

  it("2. modo lista sem nenhuma fonte avisa que o assistente não enxerga nada", () => {
    preparar({ fontes: [] });
    montar();
    expect(screen.getByText("Falta escolher o que o assistente pode ler. Até lá, ele não enxerga nada deste banco.")).toBeTruthy();
  });

  it("3. marcar uma tabela e salvar manda as colunas EXPLÍCITAS", async () => {
    preparar({ fontes: [] });
    salvarMock.mockResolvedValue({ source_mode: "list", sources: [] });
    montar();
    const salvar = screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement;
    expect(salvar.disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "Liberar public.pedidos" }));
    expect(salvar.disabled).toBe(false);
    await userEvent.click(salvar);
    expect(salvarMock).toHaveBeenCalledWith("conn-1", {
      source_mode: "list",
      sources: [{ schema: "public", tabela: "pedidos", colunas: ["id", "telefone", "total"], descricao: "" }],
    });
  });

  it("4. a coluna do cliente fica marcada e travada", async () => {
    preparar({ fontes: [] });
    montar({ colunaDoCliente: "telefone" });
    await userEvent.click(screen.getByRole("checkbox", { name: "Liberar public.pedidos" }));
    await userEvent.click(screen.getByRole("button", { name: "Detalhes" }));
    const coluna = screen.getByRole("checkbox", { name: "telefone" }) as HTMLInputElement;
    expect(coluna.checked).toBe(true);
    expect(coluna.disabled).toBe(true);
  });

  it("5. 'todas, inclusive as futuras' mostra o aviso e grava null", async () => {
    preparar({ fontes: [{ schema: "public", tabela: "pedidos", colunas: ["id", "telefone", "total"], descricao: "" }] });
    salvarMock.mockResolvedValue({ source_mode: "list", sources: [] });
    montar();
    await userEvent.click(screen.getByRole("button", { name: "Detalhes" }));
    await userEvent.click(screen.getByLabelText("Todas, inclusive as que forem criadas depois"));
    expect(screen.getByText("Uma coluna nova (por exemplo, uma senha) passaria a ser lida sem ninguém marcar.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(salvarMock).toHaveBeenCalledWith("conn-1", {
      source_mode: "list",
      sources: [{ schema: "public", tabela: "pedidos", colunas: null, descricao: "" }],
    });
  });

  it("6. fonte que sumiu do banco aparece como não encontrada e pode ser removida", async () => {
    preparar({ fontes: [{ schema: "public", tabela: "apagada", colunas: ["id"], descricao: "" }] });
    montar();
    expect(screen.getByText("Marcadas, mas não encontradas no banco")).toBeTruthy();
    expect(screen.getByText("public.apagada")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remover da lista" }));
    expect(screen.queryByText("public.apagada")).toBeNull();
  });

  it("7. modo 'tudo' mostra o aviso forte e esconde a árvore", () => {
    preparar({ modo: "all" });
    montar();
    expect(screen.getByText(/O assistente enxerga todas as tabelas que o usuário do banco enxerga/)).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Liberar public.pedidos" })).toBeNull();
  });

  it("8. sem alteração o Salvar fica desligado, e Descartar volta ao salvo", async () => {
    preparar({ fontes: [] });
    montar();
    await userEvent.click(screen.getByRole("checkbox", { name: "Liberar public.pedidos" }));
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Descartar alterações" }));
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Liberar public.pedidos" }) as HTMLInputElement).checked).toBe(false);
  });

  it("9. catálogo fora do ar: mensagem + Tentar de novo, e a lista salva continua visível", async () => {
    preparar({ fontes: [{ schema: "public", tabela: "pedidos", colunas: ["id"], descricao: "" }], catalogoErro: true });
    montar();
    expect(screen.getByText("Não foi possível ler o catálogo do banco agora. Confira a conexão e tente de novo.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(estado.catalogo.refetch).toHaveBeenCalled();
    expect(screen.getByText("1 tabela liberada")).toBeTruthy();
  });

  it("10. tabela sem a coluna do cliente mostra aviso, não bloqueio", async () => {
    preparar({ fontes: [] });
    montar({ colunaDoCliente: "telefone" });
    await userEvent.click(screen.getByRole("checkbox", { name: "Liberar public.wp_users" }));
    await userEvent.click(screen.getByRole("button", { name: "Detalhes" }));
    expect(screen.getByText(/Esta tabela não tem a coluna que identifica o cliente:/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
