/**
 * #3732 — O DIÁLOGO DE TRANSFERIR DIZ O QUE VAI ACONTECER COM O NÚMERO.
 *
 * O #3642 passou a avisar quando a conversa VAI trocar de número ("A conversa
 * vai continuar pelo número de {nome} ({numero})."). Quando o destino não tem
 * número conectado do mesmo canal — ou o contato já tem conversa no número dele
 * —, a prévia responde `null` e o diálogo ficava MUDO: quem transferia não
 * sabia que a conversa continua no número atual.
 *
 * O `null` da prévia tem duas leituras e o diálogo separa as duas pelo estado da
 * consulta: enquanto ela carrega não é resposta (nenhum aviso), e depois de
 * responder `null` é a resposta "continua onde está".
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { numeroDaTransferencia } = vi.hoisted(() => ({
  numeroDaTransferencia: { valor: null as unknown },
}));

const membros = [
  { user_id: "ana-lima-0001", role: "agent", full_name: "Ana Lima" },
  { user_id: "eu-mesmo-0000", role: "agent", full_name: "Eu Mesmo" },
];

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { id: "eu-mesmo-0000" } }),
  usePaisDaOrgAtiva: () => null,
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: membros, isLoading: false }),
}));
vi.mock("@/hooks/inbox/useTransferConversation", () => ({
  useTransferConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useContinuarPorOutroNumero", () => ({
  useContinuarPorOutroNumero: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useNumeroDaTransferencia", () => ({
  useNumeroDaTransferencia: () => numeroDaTransferencia.valor,
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
  channelLabel: () => "canal",
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

// O Radix (Dialog e Select) exige recursos que o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import { ReassignDialog } from "@/components/inbox/ReassignDialog";

function abrirDialogo() {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <ReassignDialog conversationId="conv-1" open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

/** Escolhe a atendente "Ana Lima" no seletor do diálogo. */
async function escolherAna() {
  const gatilho = document.getElementById("reassign-target");
  expect(gatilho).not.toBeNull();
  fireEvent.click(gatilho as HTMLElement);
  const lista = await screen.findByRole("listbox");
  const opcao = Array.from(lista.querySelectorAll("[role='option']")).find((o) =>
    (o.textContent ?? "").includes("Ana Lima"),
  );
  expect(opcao).toBeTruthy();
  fireEvent.click(opcao as HTMLElement);
}

beforeEach(() => {
  numeroDaTransferencia.valor = { data: null, isSuccess: true };
});

describe("#3732 — o aviso do número no diálogo de Transferir", () => {
  it("⭐ destino sem número conectado: o diálogo avisa que a conversa continua onde está", async () => {
    abrirDialogo();
    await escolherAna();

    const aviso = await screen.findByTestId("aviso-numero-atual-da-transferencia");
    expect(aviso).toHaveTextContent("A conversa continua no número em que está");
    // E não promete uma troca que não vai acontecer.
    expect(screen.queryByTestId("aviso-numero-da-transferencia")).toBeNull();
  });

  it("CONTROLE: com número no destino, o aviso é o da troca (e o outro não aparece)", async () => {
    numeroDaTransferencia.valor = {
      data: { channel_session_id: "sessao-b", display_name: "Vendas B", phone_number: "+5511999997777" },
      isSuccess: true,
    };
    abrirDialogo();
    await escolherAna();

    const aviso = await screen.findByTestId("aviso-numero-da-transferencia");
    expect(aviso).toHaveTextContent("Ana Lima");
    expect(screen.queryByTestId("aviso-numero-atual-da-transferencia")).toBeNull();
  });

  it("CONTROLE: enquanto a prévia CARREGA não há aviso nenhum (o `null` do 'ainda não sei' não é resposta)", async () => {
    numeroDaTransferencia.valor = { data: undefined, isSuccess: false };
    abrirDialogo();
    await escolherAna();

    expect(screen.queryByTestId("aviso-numero-atual-da-transferencia")).toBeNull();
    expect(screen.queryByTestId("aviso-numero-da-transferencia")).toBeNull();
  });
});
