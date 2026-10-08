import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AUTOCOMPLETE DE MENÇÃO EM NOTA INTERNA (#2372).
 *
 * O que está em disputa aqui não é "abre uma lista" — é PARA ONDE o id vai.
 * A menção antiga era texto: `@Ana` com duas Anas na organização notificava as
 * duas, e o nome trocado no cadastro deixava nota velha sem aviso. Por isso o
 * caso principal fecha com `mencao:` no CORPO que sai do campo: a pessoa foi
 * escolhida, e o que o banco recebe é o id dela — o da colega de mesmo
 * primeiro nome não aparece em lugar nenhum.
 *
 * O segundo ponto é o que a pessoa VÊ: o campo fica com `@Ana Lima`. O token
 * com o id é assunto de banco; entrar ele no meio do texto que se está
 * escrevendo seria mostrar o esqueleto de quem escreve.
 */

const { membros } = vi.hoisted(() => ({
  membros: [
    { user_id: "ana-lima-0001", role: "agent", full_name: "Ana Lima" },
    { user_id: "ana-souza-0002", role: "agent", full_name: "Ana Souza" },
    { user_id: "carlos-0003", role: "agent", full_name: "Carlos Dias" },
    // Cadastro sem nome (service role fora do ar): não pode sumir da lista.
    { user_id: "sem-nome-0004", role: "agent", full_name: null },
  ],
}));

const sendMock = vi.fn();
const createNoteMock = vi.fn();
const uploadMock = vi.fn();

vi.mock("@/hooks/inbox/useSendMessage", () => ({ useSendMessage: () => ({ mutate: sendMock, isPending: false }) }));
vi.mock("@/hooks/inbox/useCreateNote", () => ({ useCreateNote: () => ({ mutate: createNoteMock, isPending: false }) }));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: uploadMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({ useMessageTemplates: () => ({ data: [], isLoading: false }) }));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: membros, isLoading: false }),
}));

import { Composer } from "@/components/inbox/Composer";

function renderComposer() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <Composer conversationId="conv-1" />
    </QueryClientProvider>,
  );
}

function abrirModoNota() {
  renderComposer();
  fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));
  return screen.getByLabelText(/mensagem/i);
}

async function digitar(texto: string) {
  const campo = screen.getByLabelText(/mensagem/i);
  fireEvent.change(campo, { target: { value: texto } });
  return campo;
}

async function listaDeMencao() {
  return await screen.findByRole("listbox", { name: /atendentes para mencionar/i });
}

describe("Composer — menção de atendentes em nota interna", () => {
  beforeEach(() => {
    sendMock.mockClear();
    createNoteMock.mockClear();
    uploadMock.mockClear();
  });

  it("@ na nota abre a lista da org e filtra pelo que foi digitado", async () => {
    abrirModoNota();
    await digitar("fala com @an");

    const lista = await listaDeMencao();
    expect(within(lista).getByRole("option", { name: /ana lima/i })).toBeInTheDocument();
    expect(within(lista).getByRole("option", { name: /ana souza/i })).toBeInTheDocument();
    expect(within(lista).queryByRole("option", { name: /carlos/i })).not.toBeInTheDocument();

    // A query morre no espaço (`@carlos d` não é gatilho): o filtro é pelo
    // pedaço depois do `@`, e o que vem depois do espaço é frase.
    await digitar("fala com @carlos");
    const filtrada = await listaDeMencao();
    expect(within(filtrada).queryByRole("option", { name: /ana lima/i })).not.toBeInTheDocument();
    expect(within(filtrada).getByRole("option", { name: /carlos dias/i })).toBeInTheDocument();
  });

  it("quem não tem nome no cadastro continua na lista, com o id curto", async () => {
    abrirModoNota();
    await digitar("@");

    const lista = await listaDeMencao();
    expect(within(lista).getByRole("option", { name: /sem-nome/i })).toBeInTheDocument();
  });

  it("escolher grava no corpo o id da ESCOLHIDA — e o da colega de mesmo nome não", async () => {
    abrirModoNota();
    // O `@` vem NO FIM do que se digitou: é assim que o cursor chega lá na tela
    // (e é o que o teste tem de reproduzir — o gatilho é relativo ao cursor).
    const campo = await digitar("fala com @an");
    const lista = await listaDeMencao();
    fireEvent.click(within(lista).getByRole("option", { name: /ana lima/i }));

    // O campo mostra NOME, não token: quem escreve não lê `mencao:2f9c…`.
    expect(campo).toHaveValue("fala com @Ana Lima ");

    // Continua a frase depois de escolher — o `@` já não está aberto.
    fireEvent.change(campo, { target: { value: "fala com @Ana Lima sobre o orçamento" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    await waitFor(() => expect(createNoteMock).toHaveBeenCalled());
    const enviado = createNoteMock.mock.calls[0]![0] as { conversation_id: string; body: string };
    expect(enviado.conversation_id).toBe("conv-1");
    expect(enviado.body).toBe("fala com @[Ana Lima](mencao:ana-lima-0001) sobre o orçamento");
    expect(enviado.body).not.toContain("ana-souza-0002");
    // Nada sai para o cliente por conta disto.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("setas escolhem e Enter fecha a menção em vez de salvar a nota", async () => {
    abrirModoNota();
    const campo = await digitar("oi @an");
    await listaDeMencao();

    fireEvent.keyDown(campo, { key: "ArrowDown" });
    fireEvent.keyDown(campo, { key: "Enter" });

    expect(createNoteMock).not.toHaveBeenCalled();
    expect(campo).toHaveValue("oi @Ana Souza "); // primeira seta = segunda da lista
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("Esc fecha a lista e aí o Enter salva a nota de sempre", async () => {
    abrirModoNota();
    const campo = await digitar("oi @an");
    await listaDeMencao();

    fireEvent.keyDown(campo, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: /atendentes para mencionar/i })).not.toBeInTheDocument();

    fireEvent.keyDown(campo, { key: "Enter" });
    expect(createNoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: "conv-1", body: "oi @an" }),
      expect.anything(),
    );
  });

  it("em RESPOSTA o @ não abre lista nenhuma: menção é assunto de nota", () => {
    renderComposer();
    const campo = screen.getByLabelText(/mensagem/i);
    fireEvent.change(campo, { target: { value: "oi @an" } });

    expect(screen.queryByRole("listbox", { name: /atendentes para mencionar/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: "conv-1", body: "oi @an", type: "text" }),
      expect.anything(),
    );
    expect(createNoteMock).not.toHaveBeenCalled();
  });

  it("nota sem @ nenhum continua saindo igual, sem token algum", () => {
    abrirModoNota();
    fireEvent.change(screen.getByLabelText(/mensagem/i), { target: { value: "cliente ligou" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(createNoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: "conv-1", body: "cliente ligou" }),
      expect.anything(),
    );
  });
});
