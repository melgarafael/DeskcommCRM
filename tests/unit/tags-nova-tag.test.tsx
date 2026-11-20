/**
 * "NOVA TAG" — criar a etiqueta com nome e cor antes do primeiro uso (#5012, T1).
 *
 * O que cada caso prende:
 *  1. Criar manda a operação que JÁ acrescenta ao vocabulário (`definir_cor`),
 *     com o nome digitado e a cor escolhida — sem rota nova.
 *  2. Nome que já existe (em qualquer caixa, em qualquer página) NÃO repinta
 *     calado: a tela avisa e nenhuma escrita sai.
 *  3. Sem nome, não cria.
 *  4. A recusa do servidor vira a frase que diz o que fazer.
 *  5. O teto é o da etiqueta de conversa (40), não o do vocabulário (60).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import {
  COR_PADRAO_DA_NOVA_TAG,
  NovaTag,
  TAMANHO_MAXIMO_DA_NOVA_TAG,
} from "@/app/app/settings/tags/_nova-tag";

type Resposta = { status: number; corpo: unknown };

/** `fetch` dublado: a BUSCA (GET) e a ESCRITA (POST) respondem cada uma o seu. */
function servidor({ achadas = [] as Array<{ tag: string }>, escrita = { status: 200, corpo: { data: { alterou: true } } } as Resposta } = {}) {
  const chamada = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (!init?.method || init.method === "GET") {
      return new Response(JSON.stringify({ data: achadas }), { status: 200 });
    }
    return new Response(JSON.stringify(escrita.corpo), { status: escrita.status });
  });
  vi.stubGlobal("fetch", chamada);
  return chamada;
}

function escritas(fetchMock: ReturnType<typeof servidor>) {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as { method?: string } | undefined)?.method === "POST")
    .map(([, init]) => JSON.parse((init as { body: string }).body) as Record<string, unknown>);
}

function montar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NovaTag idioma="pt-BR" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByTestId("nova-tag-abrir"));
}

function digitar(nome: string) {
  fireEvent.change(screen.getByLabelText("Nome da tag"), { target: { value: nome } });
}

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  refresh.mockReset();
});

describe("Nova tag", () => {
  it("cria pela operação que já acrescenta ao vocabulário, com o nome e a cor escolhidos", async () => {
    const fetchMock = servidor();
    montar();
    digitar("  Atacado ");
    fireEvent.click(screen.getByRole("button", { name: "Roxo" }));
    fireEvent.click(screen.getByTestId("nova-tag-criar"));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(escritas(fetchMock)).toEqual([{ acao: "definir_cor", tag: "Atacado", cor: "#ab4aba" }]);
    expect(refresh).toHaveBeenCalled();
    // Depois de criar, o formulário fecha e o botão volta.
    expect(screen.getByTestId("nova-tag-abrir")).toBeTruthy();
  });

  it("sem escolher, a cor é a padrão (azul)", async () => {
    const fetchMock = servidor();
    montar();
    digitar("Cliente base");
    fireEvent.click(screen.getByTestId("nova-tag-criar"));

    await waitFor(() => expect(escritas(fetchMock)).toHaveLength(1));
    expect(escritas(fetchMock)[0]).toMatchObject({ tag: "Cliente base", cor: COR_PADRAO_DA_NOVA_TAG });
  });

  it("nome que já existe, em outra caixa: avisa e NÃO escreve nada", async () => {
    const fetchMock = servidor({ achadas: [{ tag: "atacado" }, { tag: "atacado varejo" }] });
    montar();
    digitar("ATACADO");
    fireEvent.click(screen.getByTestId("nova-tag-criar"));

    await waitFor(() => expect(screen.getByTestId("nova-tag-ja-existe")).toBeTruthy());
    expect(escritas(fetchMock)).toEqual([]);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("um nome PARECIDO não conta como existente", async () => {
    const fetchMock = servidor({ achadas: [{ tag: "atacado varejo" }] });
    montar();
    digitar("Atacado");
    fireEvent.click(screen.getByTestId("nova-tag-criar"));

    await waitFor(() => expect(escritas(fetchMock)).toHaveLength(1));
  });

  it("sem nome, o botão não cria", () => {
    servidor();
    montar();
    digitar("   ");

    expect((screen.getByTestId("nova-tag-criar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a recusa do servidor vira a frase que diz o que fazer", async () => {
    servidor({ escrita: { status: 403, corpo: { error: { code: "forbidden" } } } });
    montar();
    digitar("Atacado");
    fireEvent.click(screen.getByTestId("nova-tag-criar"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Só um gerente ou administrador da organização pode mudar as etiquetas.",
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("o campo aceita no máximo 40 caracteres, o teto da etiqueta de conversa", () => {
    servidor();
    montar();

    expect(TAMANHO_MAXIMO_DA_NOVA_TAG).toBe(40);
    expect(screen.getByLabelText("Nome da tag").getAttribute("maxLength")).toBe("40");
  });
});
