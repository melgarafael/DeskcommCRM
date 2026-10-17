/**
 * A fila do rodízio (#2041) NO EDITOR DE REGRAS — dois defeitos que a prova
 * pela tela achou e que este arquivo guarda:
 *
 *   1. ao reabrir a regra, a fila mostrava o começo do user_id ("c405a1bb")
 *      por ~0,6–0,9 s, até `/api/v1/team/assignable` responder. Agora é um
 *      esqueleto, e o id nunca aparece enquanto a lista carrega;
 *   2. a 360px o nome dividia a linha com 4 botões de 44px e ficava com 51px
 *      ("Ana 2…") — e com 0px quando a pessoa estava pausada. Agora o item tem
 *      duas partes que quebram de linha: nome + selo numa, botões na outra.
 *
 * jsdom não faz layout, então (2) aqui é a ESTRUTURA que permite a quebra (os
 * botões fora do grupo do nome, o item com `flex-wrap`); a largura em pixels se
 * mede na tela, a 360 e a 1280, com `getBoundingClientRect`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));

import { apiClient } from "@/lib/api/client";
import { ActionConfigForm, type ActionItem } from "@/app/app/webhooks/_components/ActionConfigForm";
import type { AssignableMember } from "@/hooks/inbox/useAssignableMembers";

afterEach(() => {
  cleanup();
  vi.mocked(apiClient.get).mockReset();
});

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.scrollIntoView ??= () => undefined;
});

const ANA = "c405a1bb-0000-4000-8000-000000000001";
const BETO = "d7e2f9aa-0000-4000-8000-000000000002";
const MEMBROS: AssignableMember[] = [
  { user_id: ANA, role: "agent", full_name: "Ana Souza" },
  { user_id: BETO, role: "agent", full_name: "Beto Lima" },
];

const RODIZIO: ActionItem = {
  type: "assign_owner",
  config: {
    modo: "rodizio",
    fila: [
      { user_id: ANA, pausado: false },
      { user_id: BETO, pausado: true },
    ],
  },
};

/** A resposta de `/api/v1/team/assignable` fica nas mãos do teste. */
function membrosAte() {
  let responder: (m: AssignableMember[]) => void = () => undefined;
  vi.mocked(apiClient.get).mockImplementation(
    () =>
      new Promise((ok) => {
        responder = (m) => ok({ data: m } as never);
      }) as never,
  );
  return (m: AssignableMember[]) => responder(m);
}

function montar() {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={cliente}>
      <ActionConfigForm action={RODIZIO} onChange={() => undefined} />
    </QueryClientProvider>,
  );
}

describe("fila do rodízio no editor", () => {
  it("enquanto os membros carregam, mostra esqueleto — nunca o começo do user_id", async () => {
    const responder = membrosAte();
    montar();

    const fila = screen.getByTestId("fila-do-rodizio");
    expect(fila.getAttribute("aria-busy")).toBe("true");
    expect(fila.querySelectorAll("[data-esqueleto]")).toHaveLength(2);
    expect(fila.textContent).not.toContain(ANA.slice(0, 8));
    expect(fila.textContent).not.toContain(BETO.slice(0, 8));

    responder(MEMBROS);

    expect(await within(fila).findByText("Ana Souza")).toBeTruthy();
    expect(within(fila).getByText("Beto Lima")).toBeTruthy();
    expect(fila.querySelectorAll("[data-esqueleto]")).toHaveLength(0);
    expect(fila.getAttribute("aria-busy")).toBe("false");
  });

  it("nome e selo 'pausado' ficam num grupo próprio; os botões, fora dele, podem quebrar de linha", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: MEMBROS } as never);
    montar();

    const fila = screen.getByTestId("fila-do-rodizio");
    await within(fila).findByText("Ana Souza");
    const itens = within(fila).getAllByRole("listitem");
    expect(itens).toHaveLength(2);

    for (const item of itens) {
      expect(item.className).toContain("flex-wrap");
      const grupo = within(item).getByTestId("pessoa-da-fila");
      // os 4 botões NÃO disputam a linha do nome dentro do grupo
      expect(within(grupo).queryAllByRole("button")).toHaveLength(0);
      expect(within(item).getAllByRole("button")).toHaveLength(4);
    }

    const grupoDoBeto = within(itens[1]!).getByTestId("pessoa-da-fila");
    expect(within(grupoDoBeto).getByText("Beto Lima")).toBeTruthy();
    expect(within(grupoDoBeto).getByText("pausado")).toBeTruthy();
  });
});
