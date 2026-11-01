/**
 * O DESTINO DINÂMICO (#3804) NO EDITOR DE REGRAS — a tela do modo novo da ação
 * "Atribuir a um atendente".
 *
 * O que este arquivo prova, e só isso:
 *
 *   1. a regra gravada com `{ modo: "destino", destinos, fallback }` ABRE na
 *      tela certa — os dois destinos na ordem da tentativa, o ligado marcado e o
 *      desligado não;
 *   2. o fallback em RODÍZIO usa o mesmo editor da fila do #2041 (mesmo
 *      `data-testid`, mesmo esqueleto enquanto os membros carregam) — uma fila
 *      só, um editor só;
 *   3. a caixa da automação descreve o destino pelo nome ("Responsável do
 *      negócio · Dono da carteira do contato") em vez de "Escolha o atendente",
 *      que era o que aparecia para quem abria o modo novo antes desta entrega.
 *
 * O que ele NÃO prova: que o executor escolhe a pessoa certa (isso é
 * `lib/automation/actions/assign-owner-destino.test.ts`), nem que o banco aceita
 * a configuração (é o schema + o invariante). jsdom não faz layout: largura de
 * tela se mede na tela.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));

import { apiClient } from "@/lib/api/client";
import { traduzir } from "@/lib/i18n/dicionario";
import { ActionConfigForm, type ActionItem } from "@/app/app/webhooks/_components/ActionConfigForm";
import { DescricaoDoAtendente } from "@/app/app/webhooks/automacoes/[id]/_components/CaixaDaAutomacao";
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

const COM_FALLBACK_FIXO: ActionItem = {
  type: "assign_owner",
  config: {
    modo: "destino",
    destinos: ["responsavel_do_negocio", "dono_da_carteira"],
    fallback: { modo: "fixo", user_id: ANA },
  },
};

const COM_FALLBACK_RODIZIO: ActionItem = {
  type: "assign_owner",
  config: {
    modo: "destino",
    destinos: ["dono_da_carteira"],
    fallback: {
      modo: "rodizio",
      fila: [
        { user_id: ANA, pausado: false },
        { user_id: BETO, pausado: true },
      ],
    },
  },
};

function montar(action: ActionItem) {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={cliente}>
      <ActionConfigForm action={action} onChange={() => undefined} />
    </QueryClientProvider>,
  );
}

describe("destino dinâmico no editor", () => {
  it("os dois destinos aparecem na ordem da tentativa, e só os ligados ficam marcados", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: MEMBROS } as never);
    montar(COM_FALLBACK_FIXO);

    const lista = screen.getByTestId("destinos-do-atribuir");
    const destinos = within(lista).getAllByTestId("destino-do-atribuir");
    expect(destinos).toHaveLength(2);
    // A ORDEM é a da cadeia: o responsável do negócio é tentado primeiro.
    expect(destinos[0]!.textContent).toContain("Responsável do negócio");
    expect(destinos[1]!.textContent).toContain("Dono da carteira do contato");

    const marcas = destinos.map((d) => within(d).getByRole("switch").getAttribute("aria-checked"));
    expect(marcas).toEqual(["true", "true"]);

    // O fallback fixo mostra a pessoa escolhida, pelo nome — nunca o uuid.
    expect(await screen.findByText("Ana Souza")).toBeTruthy();
  });

  it("a ajuda promete só o que a Atividade mostra: qual destino decidiu, em pt e es", () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: MEMBROS } as never);
    montar(COM_FALLBACK_FIXO);

    const ajuda =
      "Quem não puder receber (saiu da equipe ou é só leitor) é pulado, e a regra segue para o próximo. A Atividade mostra qual destino decidiu.";
    expect(screen.getByText(ajuda)).toBeTruthy();
    // A Atividade não lista os descartes: a ajuda não pode prometer o porquê.
    expect(document.body.textContent).not.toContain("por que os outros");
    expect(traduzir(ajuda, "es")).toBe(
      "Quien no pueda recibir (salió del equipo o solo puede leer) se salta, y la regla pasa al siguiente. La Actividad muestra qué destino decidió.",
    );
  });

  it("com um destino só, ele não pode ser desligado: a regra ficaria sem o que tentar", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: MEMBROS } as never);
    montar(COM_FALLBACK_RODIZIO);

    const destinos = within(screen.getByTestId("destinos-do-atribuir")).getAllByTestId("destino-do-atribuir");
    const responsavel = within(destinos[0]!).getByRole("switch");
    const carteira = within(destinos[1]!).getByRole("switch");
    expect(responsavel.getAttribute("aria-checked")).toBe("false");
    expect(responsavel.hasAttribute("disabled")).toBe(false);
    expect(carteira.getAttribute("aria-checked")).toBe("true");
    expect(carteira.hasAttribute("disabled")).toBe(true);
  });

  it("o fallback em rodízio usa o MESMO editor da fila, com o título dizendo de onde ele é", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: MEMBROS } as never);
    montar(COM_FALLBACK_RODIZIO);

    const fila = screen.getByTestId("fila-do-rodizio");
    expect(await within(fila).findByText("Ana Souza")).toBeTruthy();
    expect(within(fila).getByText("Beto Lima")).toBeTruthy();
    expect(screen.getByText("Fila do rodízio do fallback")).toBeTruthy();
    // Duas pessoas, dois itens: a fila do fallback é a mesma estrutura do #2041.
    expect(within(fila).getAllByRole("listitem")).toHaveLength(2);
  });
});

describe("a caixa da automação descreve o destino", () => {
  it("diz quais destinos e com quem a regra conta no fallback", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: MEMBROS } as never);
    const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={cliente}>
        <DescricaoDoAtendente config={COM_FALLBACK_FIXO.config as unknown as Record<string, unknown>} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/Responsável do negócio · Dono da carteira do contato/)).toBeTruthy();
    // O nome do fallback chega depois da lista de membros; a frase é a MESMA.
    expect(await screen.findByText(/Ana Souza/)).toBeTruthy();
  });
});
