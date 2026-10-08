import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FunisClient, vizinhoAoMover, type FunilDaLista } from "./_client";

// #979 — os mocks precisam existir ANTES do import de `_client` (o `vi.hoisted`
// garante isso mesmo com o hoisting do vitest).
const { editar, arquivar } = vi.hoisted(() => ({ editar: vi.fn(), arquivar: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ cliente_pela_agenda: false }),
  useAuth: () => ({ user: { id: "u1", idioma: "pt-BR" } }),
  usePermission: () => true,
}));
vi.mock("@/hooks/pipelines/usePipelines", () => ({
  useCriarFunil: () => ({ mutate: vi.fn(), isPending: false }),
  useEditarFunil: () => ({ mutate: editar, isPending: false }),
  useArquivarFunil: () => ({ mutate: arquivar, isPending: false }),
}));

const funil = (id: string): FunilDaLista => ({
  id,
  name: id,
  slug: id,
  description: null,
  position: 1000,
  is_default: false,
});

/**
 * A conta do `i - 2` é a única lógica não-óbvia da tela, e ela erra em silêncio:
 * um funil que "sobe" e não sai do lugar parece lentidão, não bug.
 */
describe("vizinhoAoMover", () => {
  const lista = [funil("a"), funil("b"), funil("c"), funil("d")];

  it("subir troca com quem está acima — o novo vizinho de cima é quem estava DUAS casas acima", () => {
    expect(vizinhoAoMover(lista, 2, "subir")).toBe("a");
  });

  it("subir da segunda posição leva ao topo (sem vizinho de cima)", () => {
    expect(vizinhoAoMover(lista, 1, "subir")).toBeNull();
  });

  it("descer põe o funil logo abaixo do vizinho de baixo", () => {
    expect(vizinhoAoMover(lista, 0, "descer")).toBe("b");
  });

  it("descer do penúltimo aponta para o último", () => {
    expect(vizinhoAoMover(lista, 2, "descer")).toBe("d");
  });

  it("não inventa vizinho fora da lista", () => {
    // A tela desabilita as setas nas pontas; se um dia deixar de desabilitar,
    // isto vira `depois_de: null` (topo) em vez de um id inexistente que a rota
    // recusaria com 422.
    expect(vizinhoAoMover(lista, 0, "subir")).toBeNull();
    expect(vizinhoAoMover(lista, 3, "descer")).toBeNull();
  });
});

/**
 * #979 — a gaveta do arquivo: as DUAS saídas de um funil arquivado, alcançáveis
 * pela tela. Arquivar era via de mão única; o que se mede aqui é que a porta de
 * volta e a exclusão definitiva (o `?definitivo=1` que a rota já aceitava) estão
 * ao alcance do clique, na ordem certa — nada dispara sem confirmação.
 */
describe("gaveta do arquivo (#979)", () => {
  const vivo: FunilDaLista = {
    id: "f-vivo",
    name: "Pedidos",
    slug: "pedidos",
    description: null,
    position: 1000,
    is_default: true,
    is_client_pipeline: false,
  };
  const arquivado: FunilDaLista = {
    id: "f-arq",
    name: "Vendas",
    slug: "vendas",
    description: null,
    position: 2000,
    is_default: false,
    is_client_pipeline: false,
  };

  beforeEach(() => {
    editar.mockReset();
    arquivar.mockReset();
  });

  function tela(opts: { arquivados?: FunilDaLista[]; podeGerenciar?: boolean } = {}) {
    return render(
      <FunisClient
        funis={[vivo]}
        arquivados={opts.arquivados ?? [arquivado]}
        podeGerenciar={opts.podeGerenciar ?? true}
        podeImportar={false}
      />,
    );
  }

  it("começa FECHADA e, ao abrir, mostra as duas saídas do funil arquivado", async () => {
    const user = userEvent.setup();
    tela();

    expect(screen.getByTestId("arquivados-abrir")).toBeInTheDocument();
    // Fechada por padrão: o arquivo é o passado da operação, não a lista.
    expect(screen.queryByTestId("desarquivar-f-arq")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("arquivados-abrir"));

    expect(screen.getByTestId("arquivado-f-arq")).toBeInTheDocument();
    expect(screen.getByTestId("desarquivar-f-arq")).toBeInTheDocument();
    expect(screen.getByTestId("excluir-arquivado-f-arq")).toBeInTheDocument();
  });

  it("«Tirar do arquivo» manda SÓ { is_archived: false } — o único pedido que o PATCH aceita", async () => {
    const user = userEvent.setup();
    tela();
    await user.click(screen.getByTestId("arquivados-abrir"));
    await user.click(screen.getByTestId("desarquivar-f-arq"));

    expect(editar).toHaveBeenCalledTimes(1);
    expect(editar).toHaveBeenCalledWith(
      { id: "f-arq", patch: { is_archived: false } },
      expect.anything(),
    );
    expect(arquivar).not.toHaveBeenCalled();
  });

  it("«Excluir de vez» pede confirmação e só então manda definitivo: true", async () => {
    const user = userEvent.setup();
    tela();
    await user.click(screen.getByTestId("arquivados-abrir"));
    await user.click(screen.getByTestId("excluir-arquivado-f-arq"));

    // O clique ABRE a pergunta; a ação destrutiva só sai de dentro dela
    // (docs/doctrine/destrutivo-pede-confirmacao.md).
    expect(screen.getByTestId("excluir-painel-f-arq")).toBeInTheDocument();
    expect(arquivar).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("excluir-confirmar-f-arq"));
    expect(arquivar).toHaveBeenCalledWith({ id: "f-arq", definitivo: true }, expect.anything());
  });

  it("sem nada arquivado não há gaveta — gaveta vazia é ruído permanente", () => {
    tela({ arquivados: [] });
    expect(screen.queryByTestId("arquivados")).not.toBeInTheDocument();
  });

  it("quem não gerencia não vê a gaveta — tirar do arquivo e excluir são manager+", () => {
    tela({ podeGerenciar: false });
    expect(screen.queryByTestId("arquivados")).not.toBeInTheDocument();
  });
});
