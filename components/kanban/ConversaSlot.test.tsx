import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ação "Abrir conversa" no card do funil (issue #1993).
 *
 * ─── O que os três casos prendem ────────────────────────────────────────────
 *
 * 1. Conversa JÁ vinculada ao contato: o clique leva para ELA — o endpoint
 *    `open-with-contact` não é chamado, porque chamá-lo reabriria (ou pior,
 *    recriaria) uma conversa que já existe. Quem decide é o `href`.
 * 2. Lead sem conversa (o caso do webhook): o clique chama a MESMA rota que a
 *    tabela de contatos já usa, navega para a conversa que ela devolve, e fica
 *    desabilitado enquanto a rota não responde — sem ele, um duplo clique
 *    abriria duas conversas.
 * 3. Lead sem telefone: nenhum pedido sai do navegador, e o motivo fica visível
 *    na própria linha. Um botão que falha em silêncio é pior que nenhum botão.
 */
const push = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }));

import { ConversaSlot } from "./ConversaSlot";

const fetchMock = vi.fn();

const conversa = {
  id: "conv-1",
  preview: "Quero saber o preço",
  last_message_at: "2026-10-01T12:00:00Z",
  unread: 0,
};

function montar(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  toastError.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Abrir conversa no card do funil (#1993)", () => {
  it("com conversa já vinculada, o clique leva para ELA — nenhuma chamada de API", async () => {
    montar(
      <ConversaSlot conversa={conversa} contactId="contato-1" phone="+5581999999999" />,
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/app/inbox?id=conv-1");

    // O gesto completo: nem a rota de abrir conversa nem a navegação programada
    // entram — o destino é o elo que já existia.
    fireEvent.click(link);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("sem conversa, o clique abre pela rota existente, espera a resposta e navega", async () => {
    const user = userEvent.setup();
    let liberar: (r: unknown) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise((res) => {
        liberar = res;
      }),
    );

    montar(
      <ConversaSlot conversa={null} contactId="contato-1" phone="+5581999999999" />,
    );

    await user.click(screen.getByRole("button", { name: /Abrir conversa/ }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/conversations/open-with-contact",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const corpo = JSON.parse(String(init?.body ?? ""));
    expect(corpo).toEqual({ contact_id: "contato-1", phone_number: "+5581999999999" });

    // Enquanto a rota não responde o botão está carregando — e DESABILITADO,
    // senão um segundo clique pediria uma segunda conversa.
    const durante = screen.getByRole("button", { name: /Abrindo/ });
    expect(durante).toBeDisabled();

    liberar({ ok: true, json: async () => ({ data: { conversation_id: "conv-nova" } }) });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/inbox?id=conv-nova"));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("sem telefone, não chama a API e explica o motivo na linha", async () => {
    montar(<ConversaSlot conversa={null} contactId="contato-1" phone={null} />);

    const botao = screen.getByRole("button", { name: /Abrir conversa/ });
    expect(botao).toBeDisabled();
    expect(screen.getByText(/sem telefone/)).toBeInTheDocument();
    expect(String(botao.getAttribute("title"))).toMatch(/telefone/i);

    // Nem o clique que o jsdom ainda entrega num botão desabilitado pode pôr a
    // mão no telefone: a guarda é do handler, não só do atributo.
    fireEvent.click(botao);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("sem conversa e sem contato nenhum, a linha continua vazia (card não cresce à toa)", () => {
    const { container } = render(<ConversaSlot conversa={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

/**
 * A HORA da última mensagem (fatia 1 do #3945).
 *
 * O `last_message_at` chegava no payload do quadro e o card não o desenhava: a
 * prévia dizia O QUE a pessoa falou e não QUANDO. Estes casos prendem a hora no
 * card; a régua em si (hoje = hora, semana = distância, resto = data) é medida
 * em `lib/i18n/hora-curta.test.ts`, para o card não ter um segundo relógio.
 */
describe("a hora da última mensagem no card (#3945)", () => {
  it("mostra o quando ao lado da prévia, com a data completa no title", () => {
    const { container } = render(<ConversaSlot conversa={conversa} contactId="contato-1" />);

    const hora = container.querySelector("[data-hora-da-mensagem]");
    expect(hora).toBeTruthy();
    // 01/10 porque a conversa de exemplo tem mais de uma semana: o rótulo curto
    // vira DATA. O caso não depende do relógio da máquina para isso.
    expect(hora).toHaveTextContent("01/10");
    // O curto omite o dia de propósito; o `title` guarda o detalhe.
    expect(hora).toHaveAttribute("title", expect.stringMatching(/01\/10\/2026/));
    // E a prévia continua ali: a hora ACRESCENTA, não substitui.
    expect(screen.getByText("Quero saber o preço")).toBeInTheDocument();
  });

  it("sem `last_message_at`, nenhuma hora é inventada", () => {
    const { container } = render(
      <ConversaSlot conversa={{ ...conversa, last_message_at: null }} contactId="contato-1" />,
    );
    expect(container.querySelector("[data-hora-da-mensagem]")).toBeNull();
    expect(screen.getByText("Quero saber o preço")).toBeInTheDocument();
  });

  it("hora e contador de não lidas convivem na mesma linha", () => {
    const { container } = render(
      <ConversaSlot conversa={{ ...conversa, unread: 3 }} contactId="contato-1" />,
    );
    expect(container.querySelector("[data-hora-da-mensagem]")).toHaveTextContent("01/10");
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByLabelText(/3 sem ler/)).toBeInTheDocument();
  });
});
