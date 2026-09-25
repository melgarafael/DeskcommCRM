import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GruposSheet } from "./GruposSheet";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
const resposta = (data: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status }),
  );

describe("GruposSheet", () => {
  it("lista os grupos com o estado de cada um", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([
        { chatId: "1@g.us", subject: "Cliente A", enabled: true, enabledAt: "2026-09-23T00:00:00Z", presente: true },
        { chatId: "2@g.us", subject: "Família", enabled: false, enabledAt: null, presente: true },
      ]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    expect(await screen.findByText("Cliente A")).toBeInTheDocument();
    expect(screen.getByText("Família")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Cliente A/ })).toBeChecked();
    expect(screen.getByRole("switch", { name: /Família/ })).not.toBeChecked();
  });

  it("ao ligar o primeiro grupo, avisa sobre o volume antes de enviar", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([{ chatId: "2@g.us", subject: "Família", enabled: false, enabledAt: null, presente: true }]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("switch", { name: /Família/ }));
    expect(await screen.findByText(/passa a enviar mensagens de todos os grupos/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falha do WhatsApp mantém a chave desligada e mostra o erro", async () => {
    fetchMock
      .mockReturnValueOnce(
        resposta([
          { chatId: "1@g.us", subject: "A", enabled: false, enabledAt: null, presente: true },
          { chatId: "2@g.us", subject: "B", enabled: true, enabledAt: "x", presente: true },
        ]),
      )
      .mockReturnValueOnce(resposta({ code: "filtro_nao_confirmado", message: "x" }, 502));
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    const chave = await screen.findByRole("switch", { name: /^A/ });
    fireEvent.click(chave);
    await waitFor(() => expect(screen.getByText(/não confirmou/i)).toBeInTheDocument());
    expect(chave).not.toBeChecked();
  });

  it("grupo que o número não integra mais aparece com aviso para desligar", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([
        { chatId: "3@g.us", subject: "Grupo Antigo", enabled: true, enabledAt: "x", presente: false },
      ]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    expect(await screen.findByText("Grupo Antigo")).toBeInTheDocument();
    expect(screen.getByText(/o número saiu deste grupo/i)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Grupo Antigo/ })).toBeChecked();
  });

  it("a lista rola dentro do próprio container, não a folha inteira", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([{ chatId: "1@g.us", subject: "Cliente A", enabled: true, enabledAt: "x", presente: true }]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    const item = await screen.findByText("Cliente A");
    const container = item.closest("ul")?.parentElement;
    expect(container).not.toBeNull();
    expect(container).toHaveClass("overflow-y-auto");
  });

  it("busca filtra a lista por assunto, ignorando maiúsculas e acentos", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([
        { chatId: "1@g.us", subject: "Grupo São Paulo", enabled: false, enabledAt: null, presente: true },
        { chatId: "2@g.us", subject: "Família", enabled: false, enabledAt: null, presente: true },
      ]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    await screen.findByText("Grupo São Paulo");
    const campo = screen.getByPlaceholderText("Buscar grupo");
    fireEvent.change(campo, { target: { value: "grupo sao" } });
    expect(screen.getByText("Grupo São Paulo")).toBeInTheDocument();
    expect(screen.queryByText("Família")).not.toBeInTheDocument();
  });

  it("busca sem correspondência mostra 'Nenhum grupo encontrado'", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([
        { chatId: "1@g.us", subject: "Cliente A", enabled: false, enabledAt: null, presente: true },
      ]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    await screen.findByText("Cliente A");
    fireEvent.change(screen.getByPlaceholderText("Buscar grupo"), {
      target: { value: "não existe" },
    });
    expect(await screen.findByText("Nenhum grupo encontrado")).toBeInTheDocument();
  });

  it("mostra o contador de grupos ligados", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([
        { chatId: "1@g.us", subject: "A", enabled: true, enabledAt: "x", presente: true },
        { chatId: "2@g.us", subject: "B", enabled: false, enabledAt: null, presente: true },
        { chatId: "3@g.us", subject: "C", enabled: true, enabledAt: "x", presente: true },
      ]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    expect(await screen.findByText("2 de 3 ligados")).toBeInTheDocument();
  });

  it("'Desligar todos' fica oculto sem nenhum grupo ligado", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([{ chatId: "1@g.us", subject: "A", enabled: false, enabledAt: null, presente: true }]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    await screen.findByText("A");
    expect(screen.queryByRole("button", { name: "Desligar todos" })).not.toBeInTheDocument();
  });

  it("'Desligar todos' confirma e envia um PUT por grupo, sequencialmente", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([
        { chatId: "1@g.us", subject: "A", enabled: true, enabledAt: "x", presente: true },
        { chatId: "2@g.us", subject: "B", enabled: true, enabledAt: "x", presente: true },
        { chatId: "3@g.us", subject: "C", enabled: false, enabledAt: null, presente: true },
      ]),
    );

    const ordem: string[] = [];
    const estado: { resolver: (() => void) | null } = { resolver: null };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { group_chat_id: string };
        return new Promise((resolve) => {
          estado.resolver = () => {
            ordem.push(body.group_chat_id);
            resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }));
          };
        });
      }
      return resposta([]);
    });

    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    await screen.findByText("A");

    fireEvent.click(screen.getByRole("button", { name: "Desligar todos" }));
    expect(
      await screen.findByText(/vão parar de aparecer no chat/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Desligar todos mesmo assim" }));

    // Só o primeiro PUT deve ter disparado até aqui — a prova de sequencial.
    await waitFor(() => expect(estado.resolver).not.toBeNull());
    const primeiraResolucao = estado.resolver;
    expect(ordem).toEqual([]);

    primeiraResolucao?.();
    await waitFor(() => expect(ordem).toEqual(["1@g.us"]));

    // O segundo PUT só é disparado DEPOIS do primeiro resolver.
    await waitFor(() => expect(estado.resolver).not.toBe(primeiraResolucao));
    fetchMock.mockReturnValueOnce(resposta([]));
    estado.resolver?.();
    await waitFor(() => expect(ordem).toEqual(["1@g.us", "2@g.us"]));
  });

  it("'Ligar todos' fica oculto quando nenhum grupo visível está desligado", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([{ chatId: "1@g.us", subject: "A", enabled: true, enabledAt: "x", presente: true }]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    await screen.findByText("A");
    expect(screen.queryByRole("button", { name: "Ligar todos" })).not.toBeInTheDocument();
  });

  it("o rótulo muda para 'Ligar os N do filtro' quando a busca está ativa", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([
        { chatId: "1@g.us", subject: "Cliente A", enabled: false, enabledAt: null, presente: true },
        { chatId: "2@g.us", subject: "Família", enabled: false, enabledAt: null, presente: true },
      ]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    await screen.findByText("Cliente A");
    expect(screen.getByRole("button", { name: "Ligar todos" })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Buscar grupo"), {
      target: { value: "cliente" },
    });
    expect(screen.queryByRole("button", { name: "Ligar todos" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ligar os 1 do filtro" })).toBeInTheDocument();
  });

  it("'Ligar todos' age só sobre os visíveis desligados — já ligado e filtrado fora ficam de fora", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([
        { chatId: "1@g.us", subject: "Cliente A", enabled: false, enabledAt: null, presente: true },
        { chatId: "2@g.us", subject: "Cliente B", enabled: true, enabledAt: "x", presente: true },
        { chatId: "3@g.us", subject: "Família", enabled: false, enabledAt: null, presente: true },
      ]),
    );
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return resposta({});
      return resposta([
        { chatId: "1@g.us", subject: "Cliente A", enabled: true, enabledAt: "x", presente: true },
        { chatId: "2@g.us", subject: "Cliente B", enabled: true, enabledAt: "x", presente: true },
        { chatId: "3@g.us", subject: "Família", enabled: false, enabledAt: null, presente: true },
      ]);
    });

    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    await screen.findByText("Cliente A");
    fireEvent.change(screen.getByPlaceholderText("Buscar grupo"), {
      target: { value: "cliente" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Ligar os 1 do filtro" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ligar todos mesmo assim" }));

    await waitFor(() => expect(screen.getByText("2 de 3 ligados")).toBeInTheDocument());

    const putsDeLigar = fetchMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === "PUT",
    );
    expect(putsDeLigar).toHaveLength(1);
    const corpo = JSON.parse(
      String((putsDeLigar[0]?.[1] as RequestInit | undefined)?.body),
    ) as { group_chat_id: string };
    expect(corpo.group_chat_id).toBe("1@g.us");
  });

  it("confirmação de 'Ligar todos' mostra a contagem e, sem nenhum ligado, também o aviso de volume", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([
        { chatId: "1@g.us", subject: "A", enabled: false, enabledAt: null, presente: true },
        { chatId: "2@g.us", subject: "B", enabled: false, enabledAt: null, presente: true },
      ]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    await screen.findByText("A");
    fireEvent.click(screen.getByRole("button", { name: "Ligar todos" }));

    expect(await screen.findByText(/2 grupos vão ligar e aparecer no chat/i)).toBeInTheDocument();
    expect(
      screen.getByText(/grupos pessoais e de família desta lista também vão aparecer/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/passa a enviar mensagens de todos os grupos/i),
    ).toBeInTheDocument();
  });

  it("confirmação de 'Ligar todos' NÃO repete o aviso de volume quando já há grupo ligado", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([
        { chatId: "1@g.us", subject: "A", enabled: false, enabledAt: null, presente: true },
        { chatId: "2@g.us", subject: "B", enabled: true, enabledAt: "x", presente: true },
      ]),
    );
    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    await screen.findByText("A");
    fireEvent.click(screen.getByRole("button", { name: "Ligar todos" }));

    expect(await screen.findByText(/1 grupos vão ligar e aparecer no chat/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/passa a enviar mensagens de todos os grupos/i),
    ).not.toBeInTheDocument();
  });

  it("'Ligar todos' confirma e envia um PUT por grupo, sequencialmente", async () => {
    fetchMock.mockReturnValueOnce(
      resposta([
        { chatId: "1@g.us", subject: "A", enabled: false, enabledAt: null, presente: true },
        { chatId: "2@g.us", subject: "B", enabled: false, enabledAt: null, presente: true },
      ]),
    );

    const ordem: string[] = [];
    const estado: { resolver: (() => void) | null } = { resolver: null };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { group_chat_id: string };
        return new Promise((resolve) => {
          estado.resolver = () => {
            ordem.push(body.group_chat_id);
            resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }));
          };
        });
      }
      return resposta([]);
    });

    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    await screen.findByText("A");

    fireEvent.click(screen.getByRole("button", { name: "Ligar todos" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ligar todos mesmo assim" }));

    // Só o primeiro PUT deve ter disparado até aqui — a prova de sequencial.
    await waitFor(() => expect(estado.resolver).not.toBeNull());
    const primeiraResolucao = estado.resolver;
    expect(ordem).toEqual([]);

    primeiraResolucao?.();
    await waitFor(() => expect(ordem).toEqual(["1@g.us"]));

    // O segundo PUT só é disparado DEPOIS do primeiro resolver.
    await waitFor(() => expect(estado.resolver).not.toBe(primeiraResolucao));
    fetchMock.mockReturnValueOnce(resposta([]));
    estado.resolver?.();
    await waitFor(() => expect(ordem).toEqual(["1@g.us", "2@g.us"]));
  });

  it("'Ligar todos' para no primeiro erro e reporta qual grupo falhou", async () => {
    fetchMock
      .mockReturnValueOnce(
        resposta([
          { chatId: "1@g.us", subject: "A", enabled: false, enabledAt: null, presente: true },
          { chatId: "2@g.us", subject: "B", enabled: false, enabledAt: null, presente: true },
        ]),
      )
      .mockReturnValueOnce(resposta({ code: "filtro_nao_confirmado", message: "x" }, 502))
      .mockReturnValueOnce(
        resposta([
          { chatId: "1@g.us", subject: "A", enabled: false, enabledAt: null, presente: true },
          { chatId: "2@g.us", subject: "B", enabled: false, enabledAt: null, presente: true },
        ]),
      );

    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    await screen.findByText("A");
    fireEvent.click(screen.getByRole("button", { name: "Ligar todos" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ligar todos mesmo assim" }));

    await waitFor(() =>
      expect(screen.getByText(/Falhou em "A" depois de ligar 0/i)).toBeInTheDocument(),
    );
  });

  it("desligar todos para no primeiro erro e reporta qual grupo falhou", async () => {
    fetchMock
      .mockReturnValueOnce(
        resposta([
          { chatId: "1@g.us", subject: "A", enabled: true, enabledAt: "x", presente: true },
          { chatId: "2@g.us", subject: "B", enabled: true, enabledAt: "x", presente: true },
        ]),
      )
      .mockReturnValueOnce(resposta({ code: "filtro_nao_confirmado", message: "x" }, 502))
      .mockReturnValueOnce(
        resposta([
          { chatId: "1@g.us", subject: "A", enabled: false, enabledAt: null, presente: true },
          { chatId: "2@g.us", subject: "B", enabled: true, enabledAt: "x", presente: true },
        ]),
      );

    render(<GruposSheet channelId="s1" onClose={() => {}} />);
    await screen.findByText("A");
    fireEvent.click(screen.getByRole("button", { name: "Desligar todos" }));
    fireEvent.click(await screen.findByRole("button", { name: "Desligar todos mesmo assim" }));

    await waitFor(() =>
      expect(screen.getByText(/Falhou em "A" depois de desligar 0/i)).toBeInTheDocument(),
    );
  });
});
