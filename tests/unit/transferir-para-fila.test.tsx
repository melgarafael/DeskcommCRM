/**
 * #4950 — TRANSFERIR PARA A FILA, NO MESMO DIÁLOGO.
 *
 * O diálogo de transferência só sabia apontar para uma PESSOA. O caso que
 * originou a fatia: a Secretaria atendeu, o pai pediu a Pedagogia — e o único
 * gesto era escolher uma pedagoga pelo nome (se ela está em aula, a conversa
 * para ali). A aba "Fila" move a conversa para o setor e, opcionalmente, solta o
 * responsável para que qualquer membro assuma.
 *
 * O que se mede aqui é o CONTRATO da tela:
 *  - sem `podeTransferirParaFila`, a aba não existe (é a resposta que a rota daria);
 *  - com ela, escolher a fila e confirmar chama o setor e DEPOIS o release —
 *    nessa ordem, porque a redistribuição do release respeita a fila.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { moverParaFila, liberar } = vi.hoisted(() => ({
  moverParaFila: vi.fn(),
  liberar: vi.fn(),
}));

const setores = [
  { id: "setor-secretaria", name: "Secretaria", description: null, created_at: "", updated_at: "", member_count: 5, color: "#10c423", schedule: {} },
  { id: "setor-pedagogia", name: "Pedagogia", description: null, created_at: "", updated_at: "", member_count: 4, color: "#ecaeea", schedule: {} },
];

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "eu-mesmo-0000", is_platform_admin: false },
    activeOrg: { role: "agent", modulos_ligados: ["setores"] },
  }),
  usePaisDaOrgAtiva: () => null,
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/inbox/useTransferConversation", () => ({
  useTransferConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useContinuarPorOutroNumero", () => ({
  useContinuarPorOutroNumero: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/usePreviaDaTransferencia", () => ({
  usePreviaDaTransferencia: () => ({ data: null, isSuccess: false }),
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
  channelLabel: () => "canal",
}));
vi.mock("@/hooks/team/useSectors", () => ({
  useSectors: () => ({ data: { data: setores } }),
}));
vi.mock("@/hooks/inbox/useDefinirFilaDaConversa", () => ({
  useDefinirFilaDaConversa: () => ({ mutateAsync: moverParaFila, isPending: false }),
}));
vi.mock("@/hooks/inbox/useReleaseConversation", () => ({
  useReleaseConversation: () => ({ mutateAsync: liberar, isPending: false }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

// O Radix (Dialog e Select) exige recursos que o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import { ReassignDialog } from "@/components/inbox/ReassignDialog";

function abrir(
  props: {
    podeTransferirParaFila?: boolean;
    conversaEhMinha?: boolean;
    abaInicial?: "atendente" | "fila";
  } = {},
) {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <ReassignDialog conversationId="conv-1" open onOpenChange={() => {}} {...props} />
    </QueryClientProvider>,
  );
}

async function escolherPedagogia() {
  const gatilho = document.getElementById("transferir-fila");
  expect(gatilho).not.toBeNull();
  fireEvent.click(gatilho as HTMLElement);
  const lista = await screen.findByRole("listbox");
  const opcao = Array.from(lista.querySelectorAll("[role='option']")).find((o) =>
    (o.textContent ?? "").includes("Pedagogia"),
  );
  expect(opcao).toBeTruthy();
  fireEvent.click(opcao as HTMLElement);
}

describe("transferir para fila (#4950)", () => {
  beforeEach(() => {
    moverParaFila.mockReset().mockResolvedValue({});
    liberar.mockReset().mockResolvedValue({});
  });

  it("não oferece a aba Fila quando a conversa não aceita mudar de fila", () => {
    abrir();
    expect(screen.queryByTestId("aba-transferir-fila")).toBeNull();
  });

  it("oferece a aba Fila e move para a fila escolhida", async () => {
    // `abaInicial` em vez de simular o clique na aba: o Radix ativa a aba por
    // `mousedown`, não por `click`, e o que este teste mede é o contrato da
    // tela, não o do Radix. A presença da aba é medida na linha abaixo.
    abrir({ podeTransferirParaFila: true, conversaEhMinha: true, abaInicial: "fila" });
    expect(screen.getByTestId("aba-transferir-fila")).toBeTruthy();
    await escolherPedagogia();

    const botao = await screen.findByTestId("btn-transferir-para-fila");
    await waitFor(() => expect((botao as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(botao);

    await waitFor(() => expect(moverParaFila).toHaveBeenCalledTimes(1));
    expect(moverParaFila.mock.calls[0][0]).toEqual({
      conversationId: "conv-1",
      sectorId: "setor-pedagogia",
    });
    // A ordem é o contrato: setor antes do release.
    await waitFor(() => expect(liberar).toHaveBeenCalledTimes(1));
    expect(liberar.mock.calls[0][0]).toEqual({ conversation_id: "conv-1" });
    expect(moverParaFila.mock.invocationCallOrder[0]).toBeLessThan(
      liberar.mock.invocationCallOrder[0],
    );
  });

  it("com o interruptor de soltar o responsável desligado, só move a fila", async () => {
    abrir({ podeTransferirParaFila: true, conversaEhMinha: true, abaInicial: "fila" });
    await escolherPedagogia();

    const interruptor = screen.getByTestId("switch-liberar-responsavel");
    fireEvent.click(interruptor);

    fireEvent.click(await screen.findByTestId("btn-transferir-para-fila"));

    await waitFor(() => expect(moverParaFila).toHaveBeenCalledTimes(1));
    expect(liberar).not.toHaveBeenCalled();
  });

  it("sem ser a dona da conversa, o interruptor não aparece e o release não é chamado", async () => {
    // `POST /release` só aceita o `assigned_to_user_id` atual: para os outros o
    // `fn_conversation_assign` sai sem linha e a rota responde 409. Oferecer o
    // interruptor aqui prometeria o que a rota recusa — e a conversa sem dono já
    // volta para a distribuição no próprio `PUT /sector` (`redistribuiu`).
    abrir({ podeTransferirParaFila: true, abaInicial: "fila" });
    expect(screen.queryByTestId("switch-liberar-responsavel")).toBeNull();

    await escolherPedagogia();
    fireEvent.click(await screen.findByTestId("btn-transferir-para-fila"));

    await waitFor(() => expect(moverParaFila).toHaveBeenCalledTimes(1));
    expect(liberar).not.toHaveBeenCalled();
  });

  it("quando o release recusa, a mensagem diz que a fila MUDOU", async () => {
    // O defeito que este caso prende: o 409 do release acontece DEPOIS de o
    // setor já ter sido gravado, e a tela antiga anunciava "não foi possível
    // mover a conversa de fila" para uma conversa que já tinha mudado.
    liberar.mockRejectedValueOnce(new Error("Você não está atribuído a essa conversa."));
    abrir({ podeTransferirParaFila: true, conversaEhMinha: true, abaInicial: "fila" });
    await escolherPedagogia();

    fireEvent.click(await screen.findByTestId("btn-transferir-para-fila"));

    const erro = await screen.findByTestId("erro-da-fila");
    expect(erro.textContent).toContain("foi para a fila");
    expect(erro.textContent).toContain("não pôde ser liberado");
    expect(moverParaFila).toHaveBeenCalledTimes(1);
  });
});
