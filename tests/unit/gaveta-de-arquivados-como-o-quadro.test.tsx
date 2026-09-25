/**
 * A GAVETA DE ARQUIVADOS CONFIRMA COMO O QUADRO — E TEM NOME PRÓPRIO.
 *
 * A gaveta pedia a exclusão de um funil num `Card` inline: o aviso aparecia, mas
 * o foco continuava solto na página e o leitor de tela seguia lendo a lista
 * atrás da pergunta. A exclusão de card do quadro — mesma classe de ação
 * irreversível — já usava `AlertDialog`; o padrão mais fraco era justamente o
 * que apaga um funil inteiro com as etapas dele (issue #1298, item 2). O botão
 * da gaveta declarava `aria-expanded` sem `aria-controls`: anunciava "expandido"
 * sem dizer o quê (item 3). E o erro de linha usava `erro-${funil.id}` nos dois
 * lados do arquivo — hoje as listas são disjuntas, mas um locator por id
 * resolveria para dois elementos no dia em que um funil aparecesse nos dois
 * (item 4).
 *
 * Cada `it` abaixo cai se a mudança dele for revertida.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FunisClient, type FunilDaLista } from "@/app/app/kanban/_client";

/** As mutações do arquivo, para escolher se a rota aceita ou recusa. */
const mocks = vi.hoisted(() => ({
  criar: vi.fn(),
  editar: vi.fn(),
  arquivar: vi.fn(),
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({
    orgId: "org-1",
    name: "Clínica",
    role: "admin",
    cliente_pela_agenda: false,
  }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/hooks/pipelines/usePipelines", () => ({
  useCriarFunil: () => ({ isPending: false, mutate: mocks.criar }),
  useEditarFunil: () => ({ isPending: false, mutate: mocks.editar }),
  useArquivarFunil: () => ({ isPending: false, mutate: mocks.arquivar }),
}));
vi.mock("@/app/app/kanban/_components/ImportarLeads", () => ({ ImportarLeads: () => null }));

const ARQUIVADO: FunilDaLista = {
  id: "funil-velho",
  name: "Comercial 2025",
  slug: "comercial-2025",
  description: null,
  position: 1,
  is_default: false,
};

/** A recusa que a rota escreve — a frase que explica POR QUE não dá. */
const RECUSA = "Este funil tem 3 negócios: excluir levaria as etapas junto.";

function comQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a confirmação da exclusão da gaveta", () => {
  it("é um `alertdialog` que prende o foco, e não um aviso solto na página", async () => {
    const user = userEvent.setup();
    render(
      comQuery(<FunisClient funis={[]} arquivados={[ARQUIVADO]} podeGerenciar podeImportar />),
    );

    await user.click(screen.getByTestId("arquivados-abrir"));
    await user.click(screen.getByTestId(`excluir-arquivado-${ARQUIVADO.id}`));

    // O papel que o leitor de tela lê como pergunta modal. Com o `Card` de
    // antes, esta linha não achava nada: a pergunta não tinha papel nenhum.
    const dialogo = screen.getByRole("alertdialog");
    expect(dialogo).toHaveTextContent("Isso não tem volta");

    // O foco entra no diálogo...
    expect(dialogo.contains(document.activeElement)).toBe(true);
    // ...e NÃO sai: oito Tabs seguidos continuam dentro dele. Sem a prisão de
    // foco (o `Card`), o terceiro Tab já estava no resto da tela.
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(dialogo.contains(document.activeElement)).toBe(true);
    }

    // E nada foi excluído por abrir a pergunta.
    expect(mocks.arquivar).not.toHaveBeenCalled();
    expect(mocks.editar).not.toHaveBeenCalled();
  });

  it("só exclui depois do clique em «Excluir de vez», e recusa sem fechar", async () => {
    const user = userEvent.setup();
    mocks.arquivar.mockImplementation((_vars: unknown, opcoes: { onError: (e: unknown) => void }) =>
      opcoes.onError(new Error(RECUSA)),
    );

    render(
      comQuery(<FunisClient funis={[]} arquivados={[ARQUIVADO]} podeGerenciar podeImportar />),
    );

    await user.click(screen.getByTestId("arquivados-abrir"));
    await user.click(screen.getByTestId(`excluir-arquivado-${ARQUIVADO.id}`));
    await user.click(screen.getByTestId(`excluir-confirmar-${ARQUIVADO.id}`));

    expect(mocks.arquivar).toHaveBeenCalledTimes(1);
    // A recusa da rota aparece INTEIRA, dentro da pergunta — que segue aberta
    // para quem quiser tentar de outro jeito.
    expect(await screen.findByTestId(`excluir-erro-${ARQUIVADO.id}`)).toHaveTextContent(RECUSA);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});

describe("o botão da gaveta", () => {
  it("diz QUAL lista ele controla, com `aria-controls` apontando para o `ul`", async () => {
    const user = userEvent.setup();
    render(
      comQuery(<FunisClient funis={[]} arquivados={[ARQUIVADO]} podeGerenciar podeImportar />),
    );

    const botao = screen.getByTestId("arquivados-abrir");
    await user.click(botao);

    const id = botao.getAttribute("aria-controls");
    expect(id).toBeTruthy();

    const lista = document.getElementById(id as string);
    expect(lista?.tagName).toBe("UL");
    // É A lista: a linha do funil arquivado mora dentro dela.
    expect(lista).toContainElement(screen.getByTestId(`arquivado-${ARQUIVADO.id}`));
    // E o `aria-expanded` continua contando o estado, agora com o alvo junto.
    expect(botao).toHaveAttribute("aria-expanded", "true");
  });
});

describe("o erro da linha", () => {
  it("não usa o mesmo testid dos dois lados da tela quando o funil está nos dois", async () => {
    const user = userEvent.setup();
    mocks.editar.mockImplementation((_vars: unknown, opcoes: { onError: (e: unknown) => void }) =>
      opcoes.onError(new Error(RECUSA)),
    );

    /*
      O dia que a issue previu: o MESMO funil aparecendo na lista viva e na
      gaveta. Com um `erro-${funil.id}` só para os dois lados, `getByTestId`
      acha dois elementos e o teste não sabe qual erro está lendo. Aqui o
      arquivo força esse dia para cobrar os nomes separados.
    */
    render(
      comQuery(
        <FunisClient funis={[ARQUIVADO]} arquivados={[ARQUIVADO]} podeGerenciar podeImportar />,
      ),
    );

    await user.click(screen.getByTestId("arquivados-abrir"));
    // Falha a ação da gaveta: o estado de erro da tela é um só, então as duas
    // linhas com esse id desenham o erro.
    await user.click(screen.getByTestId(`desarquivar-${ARQUIVADO.id}`));

    // O lado vivo continua sendo `erro-<id>` — e resolve para UM elemento só.
    expect(await screen.findByTestId(`erro-${ARQUIVADO.id}`)).toHaveTextContent(RECUSA);
    // O lado da gaveta tem nome próprio.
    const daGaveta = screen.getByTestId(`erro-arquivado-${ARQUIVADO.id}`);
    expect(daGaveta).toHaveTextContent(RECUSA);
    expect(daGaveta).not.toBe(screen.getByTestId(`erro-${ARQUIVADO.id}`));
  });
});
