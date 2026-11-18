import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChecklistDoCard } from "./ChecklistDoCard";

/**
 * O CHECKLIST NO PAINEL DO CARD (#4717, FASE 1) — caso (d).
 *
 * O que este arquivo vigia: o painel mostra OS MESMOS itens, na mesma ordem, e
 * o MESMO progresso que o card (o servidor) tem. E depois de marcar, mostra o
 * estado que o servidor devolveu — não o que o clique achou que gravou.
 *
 * Só o `fetch` é dublê: o resto (a seção, o progresso, o item) é o componente
 * de verdade. A sabotagem que derruba este caso é o painel desenhar estado
 * local em vez do estado do card.
 */

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

const INICIAL = {
  negocio_id: "l1",
  planos: ["Pré-viagem"],
  concluidos: 1,
  total: 3,
  itens: [
    {
      tarefa_id: "t1",
      ordem: 1,
      titulo: "Conferir documentos",
      status: "done",
      concluido: true,
      prazo: null,
      plano_id: "plano-pre-viagem",
      plano_nome: "Pré-viagem",
      marcado_por: "u1",
      marcado_por_nome: "Ana",
      marcado_em: "2026-11-10T12:00:00.000Z",
    },
    {
      tarefa_id: "t2",
      ordem: 2,
      titulo: "Emitir e anexar vouchers",
      status: "pending",
      concluido: false,
      prazo: null,
      plano_id: "plano-pre-viagem",
      plano_nome: "Pré-viagem",
      marcado_por: null,
      marcado_por_nome: null,
      marcado_em: null,
    },
    {
      tarefa_id: "t3",
      ordem: 3,
      titulo: "Enviar o roteiro",
      status: "pending",
      concluido: false,
      prazo: null,
      plano_id: "plano-pre-viagem",
      plano_nome: "Pré-viagem",
      marcado_por: null,
      marcado_por_nome: null,
      marcado_em: null,
    },
  ],
};

/** O que o SERVIDOR responde depois que o item 2 foi marcado. */
const DEPOIS = {
  ...INICIAL,
  concluidos: 2,
  itens: INICIAL.itens.map((item) =>
    item.tarefa_id === "t2"
      ? {
          ...item,
          status: "done",
          concluido: true,
          marcado_por: "u1",
          marcado_por_nome: "Ana",
          marcado_em: "2026-11-11T09:30:00.000Z",
        }
      : item,
  ),
};

const fetchEspiao = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === "POST") {
    return new Response(JSON.stringify({ data: { checklist: DEPOIS } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ data: { checklist: INICIAL } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

beforeEach(() => {
  fetchEspiao.mockClear();
  vi.stubGlobal("fetch", fetchEspiao);
});
afterEach(() => vi.unstubAllGlobals());

describe("ChecklistDoCard", () => {
  it("mostra no painel do card os mesmos itens e o mesmo progresso do card", async () => {
    render(<ChecklistDoCard leadId="l1" podeEditar />);

    const lista = await screen.findByTestId("inbox-checklist-itens");
    const itens = within(lista).getAllByRole("listitem");

    // Os MESMOS itens, na MESMA ordem do plano que o card devolveu.
    expect(itens.map((li) => li.textContent)).toEqual([
      expect.stringContaining("Conferir documentos"),
      expect.stringContaining("Emitir e anexar vouchers"),
      expect.stringContaining("Enviar o roteiro"),
    ]);

    // O MESMO progresso — "1 de 3 concluídas", composto a partir do payload.
    expect(screen.getByTestId("inbox-checklist-progresso").textContent).toBe("1 de 3 concluídas");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");

    // O ✔ e o autor de quem marcou o item concluído.
    const caixas = within(lista).getAllByRole("checkbox");
    expect(caixas[0]!.getAttribute("aria-checked")).toBe("true");
    expect(caixas[1]!.getAttribute("aria-checked")).toBe("false");
    expect(within(lista).getByText(/Ana/)).toBeTruthy();
    expect(within(lista).getByText(/10\/11/)).toBeTruthy();
  });

  it("marcar no painel mostra na hora o estado que o CARD gravou, sem recarregar", async () => {
    render(<ChecklistDoCard leadId="l1" podeEditar />);
    const lista = await screen.findByTestId("inbox-checklist-itens");

    await userEvent.click(within(lista).getAllByRole("checkbox")[1]!);

    // A requisição levou o id do item e o alvo — a rota é a do card.
    await waitFor(() =>
      expect(fetchEspiao).toHaveBeenCalledWith(
        "/api/v1/leads/l1/checklist/t2",
        expect.objectContaining({ method: "POST" }),
      ),
    );

    // O que aparece é o estado do SERVIDOR (2 de 3), não "1 + 1" local.
    await waitFor(() =>
      expect(screen.getByTestId("inbox-checklist-progresso").textContent).toBe("2 de 3 concluídas"),
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("2");
    const caixas = within(screen.getByTestId("inbox-checklist-itens")).getAllByRole("checkbox");
    expect(caixas[1]!.getAttribute("aria-checked")).toBe("true");
  });

  it("sem permissão de escrita o item não é clicável", async () => {
    render(<ChecklistDoCard leadId="l1" podeEditar={false} />);
    const lista = await screen.findByTestId("inbox-checklist-itens");
    expect(within(lista).getAllByRole("checkbox")[1]!.hasAttribute("disabled")).toBe(true);
  });
});
