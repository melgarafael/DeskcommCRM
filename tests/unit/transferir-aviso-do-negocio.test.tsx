/**
 * #4312 — O DIÁLOGO DE TRANSFERIR DIZ O QUE ACONTECE COM O NEGÓCIO ABERTO.
 *
 * O defeito central da issue é um silêncio duplo: quando quem transfere NÃO é o
 * dono do negócio aberto do contato, `fn_conversation_assign` não move o card
 * (e não deve mover — card de colega não se toma emprestado), mas o diálogo não
 * dizia nada. Quem transferia achava que o negócio ia junto e a colega não
 * achava o negócio no filtro "Responsável".
 *
 * O caminho do dono também aparece: ele entrega o próprio negócio, e a tela diz
 * que o card foi junto — a equipe não fica na dúvida em nenhum dos dois sentidos.
 *
 * A regra é a da própria transferência, servida pela mesma prévia
 * (`fn_previa_do_negocio_na_transferencia`): aqui se prova a TELA; a regra tem
 * prova de banco em `tests/invariants/transferencia-leva-o-negocio-e-volta-ao-numero.test.ts`.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { previa } = vi.hoisted(() => ({ previa: { valor: null as unknown } }));

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
vi.mock("@/hooks/inbox/usePreviaDaTransferencia", () => ({
  usePreviaDaTransferencia: () => previa.valor,
}));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({ data: [] }),
  channelLabel: () => "canal",
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

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

function comNegocio(leva: boolean, dono: string | null) {
  previa.valor = {
    data: { numero: null, negocio: { leva, dono_user_id: dono } },
    isSuccess: true,
  };
}

beforeEach(() => {
  previa.valor = { data: { numero: null, negocio: null }, isSuccess: true };
});

describe("#4312 — o aviso do negócio aberto no diálogo de Transferir", () => {
  it("⭐ quem NÃO é dono: o diálogo avisa com QUEM o negócio continua", async () => {
    comNegocio(false, "ana-lima-0001");
    abrirDialogo();
    await escolherAna();

    const aviso = await screen.findByTestId("aviso-negocio-fica");
    expect(aviso).toHaveTextContent("O negócio aberto deste contato continua com Ana Lima");
    expect(aviso).toHaveTextContent("a conversa vai sem ele");
    // O outro aviso do negócio não aparece: uma resposta só.
    expect(screen.queryByTestId("aviso-negocio-acompanha")).toBeNull();
  });

  it("quem não é dono e o dono é a própria pessoa: o aviso fala em 'você' (o caso da conversa devolvida)", async () => {
    comNegocio(false, "eu-mesmo-0000");
    abrirDialogo();
    await escolherAna();

    const aviso = await screen.findByTestId("aviso-negocio-fica");
    expect(aviso).toHaveTextContent("continua com você");
  });

  it("o caminho do dono: o diálogo diz que o negócio VAI JUNTO", async () => {
    comNegocio(true, "eu-mesmo-0000");
    abrirDialogo();
    await escolherAna();

    const aviso = await screen.findByTestId("aviso-negocio-acompanha");
    expect(aviso).toHaveTextContent("O negócio aberto deste contato vai junto com a conversa.");
    expect(screen.queryByTestId("aviso-negocio-fica")).toBeNull();
  });

  it("contato sem negócio aberto (ou com mais de um): nenhum aviso — não há o que dizer", async () => {
    previa.valor = { data: { numero: null, negocio: null }, isSuccess: true };
    abrirDialogo();
    await escolherAna();

    expect(screen.queryByTestId("aviso-negocio-fica")).toBeNull();
    expect(screen.queryByTestId("aviso-negocio-acompanha")).toBeNull();
  });

  it("CONTROLE: enquanto a prévia CARREGA, nenhum aviso de negócio", async () => {
    previa.valor = { data: undefined, isSuccess: false };
    abrirDialogo();
    await escolherAna();

    expect(screen.queryByTestId("aviso-negocio-fica")).toBeNull();
    expect(screen.queryByTestId("aviso-negocio-acompanha")).toBeNull();
  });
});
