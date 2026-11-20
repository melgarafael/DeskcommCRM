/**
 * Capacidade com `marcavel: false` (as do administrador, como
 * `crm_save_ai_agent_draft`, e as do harness) não pode ser marcada em NENHUMA
 * lista do seletor. O bloco das críticas já olhava o campo; a lista do modo
 * avançado olhava só o teto, e a prova pela tela do #4805 marcou e salvou a
 * capacidade num rascunho por ali.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { ToolPicker } from "@/app/app/ai/agents/[id]/_components/ToolPicker";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

const base = {
  description: "x",
  category: "read",
  requires_role: "viewer",
  requires_scope: "mcp:read",
  explicacao: "x",
  o_que_toca: "x",
  risco: "seguro",
  pacotes: [],
};
const MARCAVEL = { ...base, id: "crm_search_contacts", rotulo: "Buscar contatos", marcavel: true, motivo_nao_marcavel: null };
const DO_ADMIN = {
  ...base,
  id: "crm_save_ai_agent_draft",
  rotulo: "Corrigir as instruções num rascunho",
  marcavel: false,
  motivo_nao_marcavel: "Só quem administra usa, pelo ChatGPT.",
};

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockResolvedValue({ data: { tools: [MARCAVEL, DO_ADMIN], desligadas_pela_organizacao: [] } });
});
afterEach(() => {
  cleanup();
  client.clear();
});

async function abrirAvancado(onChange: (v: string[]) => void) {
  render(
    <IdiomaProvider locale="pt-BR">
      <QueryClientProvider client={client}>
        <ToolPicker value={[]} onChange={onChange} />
      </QueryClientProvider>
    </IdiomaProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("toggle-avancado")).toBeTruthy());
  fireEvent.click(screen.getByTestId("toggle-avancado"));
  return screen.getByTestId("lista-avancada");
}

function caixa(lista: HTMLElement, nome: string) {
  const ficha = lista.querySelector(`[data-testid="capacidade-${nome}"]`);
  expect(ficha).toBeTruthy();
  return ficha!.querySelector("input[type=checkbox]") as HTMLInputElement;
}

describe("ToolPicker — modo avançado respeita marcavel", () => {
  it("a capacidade não marcável fica desabilitada e o clique não muda a seleção", async () => {
    const onChange = vi.fn();
    const lista = await abrirAvancado(onChange);
    const input = caixa(lista, "crm_save_ai_agent_draft");
    expect(input.disabled).toBe(true);
    fireEvent.click(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a marcável segue clicável (controle)", async () => {
    const onChange = vi.fn();
    const lista = await abrirAvancado(onChange);
    const input = caixa(lista, "crm_search_contacts");
    expect(input.disabled).toBe(false);
    fireEvent.click(input);
    expect(onChange).toHaveBeenCalledWith(["crm_search_contacts"]);
  });
});
