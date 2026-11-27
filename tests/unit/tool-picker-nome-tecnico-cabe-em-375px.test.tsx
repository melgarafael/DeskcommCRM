/**
 * O nome técnico de uma capacidade (`crm_propose_lead_fields_from_document`) é
 * uma palavra só, sem ponto de quebra. Na lista do modo avançado ele empurrava
 * a ficha para fora da lista num celular de 375px (#5067: `scrollWidth` 307
 * contra `clientWidth` 259), porque a coluna de texto da ficha não encolhe
 * abaixo da palavra mais longa que contém.
 *
 * O jsdom não calcula layout, então este teste prende a classe que deixa o
 * nome quebrar. A medida em 375px está na descrição do PR que o criou.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { ToolPicker } from "@/app/app/ai/agents/[id]/_components/ToolPicker";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));

const NOME_LONGO = "crm_propose_lead_fields_from_document";
const CAPACIDADE = {
  id: NOME_LONGO,
  description: "x",
  category: "write",
  requires_role: "agent",
  requires_scope: "mcp:write",
  rotulo: "Propor dados de um documento para o card",
  explicacao: "x",
  o_que_toca: "Funil de vendas",
  risco: "atencao",
  pacotes: [],
  marcavel: true,
  motivo_nao_marcavel: null,
};

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockResolvedValue({ data: { tools: [CAPACIDADE], desligadas_pela_organizacao: [] } });
});
afterEach(() => {
  cleanup();
  client.clear();
});

describe("ToolPicker — nome técnico no modo avançado", () => {
  it("o nome técnico quebra linha em vez de alargar a ficha", async () => {
    render(
      <IdiomaProvider locale="pt-BR">
        <QueryClientProvider client={client}>
          <ToolPicker value={[]} onChange={() => {}} />
        </QueryClientProvider>
      </IdiomaProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("toggle-avancado")).toBeTruthy());
    fireEvent.click(screen.getByTestId("toggle-avancado"));

    const ficha = screen
      .getByTestId("lista-avancada")
      .querySelector(`[data-testid="capacidade-${NOME_LONGO}"]`);
    const nome = Array.from(ficha?.querySelectorAll("code") ?? []).find(
      (el) => el.textContent === NOME_LONGO,
    );
    expect(nome).toBeTruthy();
    expect(nome!.classList.contains("break-all")).toBe(true);
  });
});
