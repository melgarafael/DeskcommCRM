import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ParticipantesDaConversa } from "./ParticipantesDaConversa";
import { ApiError } from "@/lib/api/types";
import { apiClient } from "@/lib/api/client";

/**
 * A TELA DO ATENDIMENTO CONJUNTO (#2542, fatia 4) — lista e convite.
 *
 * Este arquivo mede o DOM pelo caminho REAL da tela: os hooks NÃO são
 * moqueados, porque é neles que mora a regra (a URL, o corpo e a invalidação
 * que faz a lista recarregar). O que se dubla é a BORDA — o `apiClient`, que
 * faria rede. Sem essa escolha, "o convite chama a API e a lista atualiza"
 * viraria uma asserção sobre o mock, não sobre a tela: o `post` seria chamado
 * pelo teste, não pelo componente, e a lista nunca dependeria do refetch.
 */

const estado = vi.hoisted(() => ({
  participantes: [] as {
    id: string;
    user_id: string;
    invited_by: string | null;
    joined_at: string;
  }[],
  membros: [] as { user_id: string; role: string; full_name: string | null }[],
  erro: null as Error | null,
  /**
   * O gate de CLIENTE do hook — `inbox.participantes.view`. É a permissão que um
   * `viewer` NÃO tem e um `agent` (inclusive o participante convidado) tem.
   */
  podeVerParticipantes: true,
  canais: new Map<string, () => void>(),
}));

vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (opts: { name: string; onChange: () => void }) => {
    estado.canais.set(opts.name, opts.onChange);
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: (acao: string) =>
    acao === "inbox.participantes.view" ? estado.podeVerParticipantes : false,
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (url: string) => {
      if (url.includes("/participants")) return { data: { participantes: estado.participantes } };
      if (url === "/api/v1/team/assignable") return { data: estado.membros };
      throw new Error(`url inesperada no teste: ${url}`);
    }),
    // O POST grava no estado em memória: é o que faz o GET seguinte (disparado
    // pela invalidação do hook) devolver a lista JÁ com o convidado. Um `post`
    // que só resolvesse vazio provaria o clique, não a atualização da lista.
    post: vi.fn(async (_url: string, corpo: { user_id: string }) => {
      if (estado.erro) throw estado.erro;
      estado.participantes = [
        ...estado.participantes,
        {
          id: `p-${corpo.user_id}`,
          user_id: corpo.user_id,
          invited_by: "u1",
          joined_at: new Date().toISOString(),
        },
      ];
      return {};
    }),
    delete: vi.fn(async (_url: string, corpo: { user_id: string }) => {
      if (estado.erro) throw estado.erro;
      estado.participantes = estado.participantes.filter((p) => p.user_id !== corpo.user_id);
      return { data: { removidos: 1 } };
    }),
  },
}));

function membro(userId: string, nome: string) {
  return { user_id: userId, role: "agent", full_name: nome };
}

function participar(userId: string) {
  return { id: `p-${userId}`, user_id: userId, invited_by: "u1", joined_at: "2026-10-21T12:00:00Z" };
}

function renderTela(podeConvidar = true, atendenteId = "u1", somenteLeitura = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ParticipantesDaConversa conversationId="conv-1" podeConvidar={podeConvidar} atendenteId={atendenteId} somenteLeitura={somenteLeitura} />
    </QueryClientProvider>,
  );
}

/** O gatilho do Select abre por TECLADO: o jsdom não implementa PointerEvent. */
function abrirSeletor() {
  const gatilho = screen.getByTestId("select-colega");
  gatilho.focus();
  fireEvent.keyDown(gatilho, { key: "Enter" });
}

function escolherColega(nome: string) {
  abrirSeletor();
  fireEvent.click(screen.getByRole("option", { name: nome }));
}

beforeEach(() => {
  estado.participantes = [];
  estado.membros = [membro("u2", "Bruno"), membro("u3", "Carla")];
  estado.erro = null;
  estado.podeVerParticipantes = true;
  estado.canais.clear();
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("ParticipantesDaConversa — a lista no cabeçalho", () => {
  it("uma mudança em outra aba recarrega os avatares sem reabrir a conversa", async () => {
    estado.participantes = [participar("u2")];
    renderTela();
    await screen.findByTestId("participante-u2");
    estado.participantes = [participar("u2"), participar("u3")];
    estado.canais.get("participantes-da-conversa-conv-1")!();
    expect(await screen.findByTestId("participante-u3")).toBeInTheDocument();
  });
  it("mostra quem participa, com o nome cruzado pelo diretório da organização", async () => {
    estado.participantes = [participar("u2"), participar("u3")];
    renderTela();

    await screen.findByTestId("participantes-do-atendimento");
    // O nome chega pela consulta do diretório, que é uma segunda query: esperar
    // o testid da lista não garante que ela já resolveu.
    await waitFor(() =>
      expect(screen.getByTestId("participante-u2").getAttribute("title")).toBe("Bruno"),
    );
    expect(screen.getByTestId("participante-u3").getAttribute("title")).toBe("Carla");
  });

  it("sem participante e sem permissão de convidar, não desenha nada", async () => {
    renderTela(false);
    expect(screen.queryByTestId("participantes-do-atendimento")).toBeNull();
    expect(screen.queryByTestId("convidar-participante")).toBeNull();
  });

  /**
   * O CASO DE CLIENTE (a tela não pede a lista a quem a rota recusa): um `viewer`
   * não tem `inbox.participantes.view`, então a consulta nem sai — o mesmo padrão
   * dos hooks irmãos (`useConversationNotes`, `usePassagensDaConversa`). Sem isto,
   * ele pedia `GET /participants` em TODA abertura de conversa.
   */
  it("um viewer (sem inbox.participantes.view) NÃO pede a lista à rota", async () => {
    estado.podeVerParticipantes = false;
    renderTela(false);

    // Deixa o ciclo de efeitos rodar: se a query estivesse habilitada, o `get` já
    // teria saído. Nada é buscado — nem a lista, nem o diretório.
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(apiClient.get)).not.toHaveBeenCalled();
    expect(screen.queryByTestId("participantes-do-atendimento")).toBeNull();
  });

  /**
   * A prova de que o gate NÃO é `podeConvidar`: o participante convidado não pode
   * convidar, mas é `agent`+ e CONTINUA lendo a lista.
   */
  it("o convidado (podeConvidar=false) CONTINUA pedindo a lista — o gate é a permissão", async () => {
    estado.participantes = [participar("u2")];
    renderTela(false);

    await screen.findByTestId("participantes-do-atendimento");
    expect(vi.mocked(apiClient.get)).toHaveBeenCalledWith(
      "/api/v1/conversations/conv-1/participants",
    );
  });
});

describe("ParticipantesDaConversa — remoção e saída", () => {
  it("o responsável remove pela tela e o avatar sai após reler o servidor", async () => {
    estado.participantes = [participar("u2")];
    renderTela();
    const gatilho = await screen.findByRole("button", { name: /Quem participa desta conversa: Bruno/ });
    fireEvent.keyDown(gatilho, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remover participante" }));
    await waitFor(() => expect(screen.queryByTestId("participante-u2")).toBeNull());
    expect(apiClient.delete).toHaveBeenCalledWith("/api/v1/conversations/conv-1/participants", { user_id: "u2" });
  });

  it("a convidada pode sair, mas não recebe remoção de outra colega", async () => {
    estado.participantes = [participar("u2"), participar("u3")];
    renderTela(false, "u2");
    const gatilho = await screen.findByRole("button", { name: /Quem participa desta conversa: Bruno/ });
    expect(screen.queryByRole("button", { name: /Quem participa desta conversa: Carla/ })).toBeNull();
    fireEvent.keyDown(gatilho, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sair do atendimento" }));
    await waitFor(() => expect(screen.queryByTestId("participante-u2")).toBeNull());
  });

  it("suporte somente leitura vê os nomes sem botão de convite ou remoção", async () => {
    estado.participantes = [participar("u2")];
    renderTela(true, "u1", true);
    await screen.findByTestId("participante-u2");
    expect(screen.queryByTestId("convidar-participante")).toBeNull();
    expect(screen.queryByRole("button", { name: /Quem participa desta conversa:/ })).toBeNull();
  });
});

describe("ParticipantesDaConversa — o convite", () => {
  it("o convite chama a API e a LISTA ATUALIZA com o convidado", async () => {
    const user = userEvent.setup();
    estado.participantes = [participar("u2")];
    renderTela();

    await user.click(screen.getByTestId("convidar-participante"));
    // Quem já participa não é alvo de novo convite: a opção fica desabilitada.
    abrirSeletor();
    expect(screen.getByRole("option", { name: /Bruno/ })).toHaveAttribute("aria-disabled", "true");

    escolherColega("Carla");
    await user.click(screen.getByTestId("confirmar-convite"));

    expect(vi.mocked(apiClient.post)).toHaveBeenCalledWith(
      "/api/v1/conversations/conv-1/participants",
      { user_id: "u3" },
    );
    // A lista do cabeçalho passa a incluir a convidada: prova a invalidação.
    expect((await screen.findByTestId("participante-u3")).getAttribute("title")).toBe("Carla");
  });

  it("o erro da API aparece na tela, no texto que o servidor traduziu", async () => {
    const user = userEvent.setup();
    estado.erro = new ApiError(
      403,
      "forbidden_role",
      undefined,
      "req-1",
      "Solo el responsable de la conversación o un gestor puede invitar a colegas.",
    );
    renderTela();

    await user.click(screen.getByTestId("convidar-participante"));
    escolherColega("Carla");
    await user.click(screen.getByTestId("confirmar-convite"));

    expect(
      await screen.findByText(
        "Solo el responsable de la conversación o un gestor puede invitar a colegas.",
      ),
    ).toBeTruthy();
  });

  it("quem já participa aparece marcado no seletor (a resposta que o GET já dá)", async () => {
    const user = userEvent.setup();
    estado.participantes = [participar("u3")];
    renderTela();

    await user.click(screen.getByTestId("convidar-participante"));
    abrirSeletor();
    // O `SelectItem` desabilitado do Radix é um `div[aria-disabled]` — não um
    // `<option disabled>`, então quem responde é o atributo ARIA, e o rótulo
    // diz POR QUE está fora.
    const jaParticipa = screen.getByRole("option", { name: /Carla/ });
    expect(jaParticipa).toHaveAttribute("aria-disabled", "true");
    expect(jaParticipa.textContent).toContain("Já participa");
    expect(screen.getByRole("option", { name: /Bruno/ })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
