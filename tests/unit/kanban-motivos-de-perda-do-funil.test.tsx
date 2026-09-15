/**
 * OS MOTIVOS DE PERDA QUE O FUNIL OFERECE — a janela tem de mostrar os DELES.
 *
 * ─── O defeito que esta cerca fecha ──────────────────────────────────────
 *
 * `settings.lost_reasons` é a lista que o operador cadastra em Funis, e o
 * servidor já a respeita: `fn_validate_lost_reason_required` aceita canônico ∪
 * cadastrado. A janela de perder, sozinha, renderizava sempre o padrão do
 * produto. Medido antes de escrever, na base 54530c9f:
 *
 *     grep -n "lost_reasons" components/kanban/LoseLeadDialog.tsx   # zero
 *
 * Consequência: quem cadastrou "Sem orçamento" não via o próprio motivo na
 * tela, digitava à mão ("Outro") e descobria no clique se o funil daquele card
 * aceitava — com 22023 para o que não aceitava.
 *
 * ─── O que cada caso mede ────────────────────────────────────────────────
 *
 * O primeiro caso é o defeito: a lista não é a do produto, é a do funil. O
 * segundo prova que o motivo escolhido CHEGA no endpoint, com o texto dele. O
 * terceiro é a VALIDAÇÃO: com funil configurado, "Outro" vazio não passa e
 * texto fora da lista é recusado ANTES do clique. O quarto é a volta: sem nada
 * cadastrado, o padrão do produto e o `other` vazio continuam como sempre
 * foram — a correção não pode ter consertado um caso quebrando o outro.
 */
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoseLeadDialog } from "@/components/kanban/LoseLeadDialog";
import { CANONICAL_LOST_REASONS } from "@/lib/schemas/leads";
import { motivosDoFunil } from "@/lib/leads/motivos-de-perda-do-funil";
import type { BoardData } from "@/lib/kanban/types";

const { apiPost } = vi.hoisted(() => ({
  // `unknown[]` nos parâmetros de propósito: o mock é chamado com dois argumentos
  // (rota e corpo) e um `vi.fn()` sem parâmetro nenhum reprova o typecheck (TS2554).
  apiPost: vi.fn(async (..._args: unknown[]) => ({ data: {} })),
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    post: (...args: unknown[]) => apiPost(...(args as [string, unknown])),
    patch: vi.fn(async () => ({ data: {} })),
    get: vi.fn(async () => ({ data: {} })),
  },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/lib/kanban/local-echo", () => ({
  marcarEcoLocal: vi.fn(),
  liberarEcoLocal: vi.fn(),
  ehEcoLocal: () => false,
}));

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
}

const PIL = "funil-da-918";
const LEAD = "lead-da-918";

afterEach(() => {
  cleanup();
  apiPost.mockClear();
});

/** Um cliente novo por caso: cache compartilhada entre casos esconderia o defeito. */
function comFunil(settings: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  qc.setQueryData(["board", PIL], { pipeline: { settings } } as unknown as BoardData);
  return qc;
}

function abrir(qc: QueryClient) {
  return render(
    <QueryClientProvider client={qc}>
      <LoseLeadDialog open onOpenChange={() => {}} leadId={LEAD} pipelineId={PIL} />
    </QueryClientProvider>,
  );
}

/** Pelas VALUES, não pelos rótulos: o valor é o contrato com o servidor. */
const valuesDosMotivos = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[name="lost-reason"]')).map((r) => r.value);

const radio = (valor: string) =>
  document.querySelector<HTMLInputElement>(`input[name="lost-reason"][value="${valor}"]`)!;

const confirmar = () => screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement;

describe("motivos de perda configurados no funil", () => {
  it("oferece os CADASTRADOS no funil e some com o padrão do produto", () => {
    abrir(comFunil({ lost_reasons: ["Sem orçamento", "Fora do perfil"] }));

    expect(valuesDosMotivos()).toEqual(["Sem orçamento", "Fora do perfil", "other"]);
    // O padrão do produto não pode sobrar: motivo que o funil não tem é 22023 na cara do operador.
    expect(screen.queryByText("Falha no pagamento")).toBeNull();
  });

  it("grava o motivo do funil escolhido, com o texto dele", async () => {
    abrir(comFunil({ lost_reasons: ["Sem orçamento", "Fora do perfil"] }));

    fireEvent.click(radio("Fora do perfil"));
    fireEvent.click(confirmar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith(`/api/v1/leads/${LEAD}/lose`, {
      lost_reason: "Fora do perfil",
    });
  });

  it("com funil configurado, 'Outro' exige o detalhe e recusa o que o servidor negaria", () => {
    abrir(comFunil({ lost_reasons: ["Sem orçamento"] }));

    fireEvent.click(radio("other"));
    expect(confirmar().disabled).toBe(true); // detalhe vazio não passa
    expect(apiPost).not.toHaveBeenCalled();

    const detalhe = screen.getByLabelText(/Detalhe \(obrigatório\)/);
    fireEvent.change(detalhe, { target: { value: "Sem orçamento" } });
    expect(confirmar().disabled).toBe(false); // valor que o funil aceita

    fireEvent.change(detalhe, { target: { value: "Cliente mudou de ideia" } });
    expect(confirmar().disabled).toBe(true); // fora da lista: o trigger recusaria
    expect(screen.getByRole("alert").textContent).toBe(
      "Escolha um dos motivos cadastrados no funil.",
    );
  });

  it("sem funil configurado, o padrão do produto e o 'other' vazio continuam valendo", async () => {
    abrir(comFunil({}));
    expect(valuesDosMotivos()).toEqual([...CANONICAL_LOST_REASONS]);

    fireEvent.click(radio("other"));
    expect(confirmar().disabled).toBe(false);
    fireEvent.click(confirmar());

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith(`/api/v1/leads/${LEAD}/lose`, { lost_reason: "other" });
  });

  it("funil com lista VAZIA cai no padrão — nunca numa janela sem motivo nenhum", () => {
    abrir(comFunil({ lost_reasons: [] }));
    expect(valuesDosMotivos()).toEqual([...CANONICAL_LOST_REASONS]);
  });
});

describe("motivosDoFunil (a régua da leitura)", () => {
  it("limpa espaços, joga fora vazio e deduplica", () => {
    expect(
      motivosDoFunil({ lost_reasons: ["  Sem orçamento  ", "Sem orçamento", "", "Fora do perfil"] }),
    ).toEqual(["Sem orçamento", "Fora do perfil"]);
  });

  it("lixo no settings vira lista vazia, não motivo na tela", () => {
    expect(motivosDoFunil(null)).toEqual([]);
    expect(motivosDoFunil({})).toEqual([]);
    expect(motivosDoFunil({ lost_reasons: "Sem orçamento" })).toEqual([]);
  });
});
