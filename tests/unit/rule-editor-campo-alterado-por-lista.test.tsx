/**
 * A condição "foi alterado" (#1749) escolhe o campo numa LISTA — medido no
 * editor real.
 *
 * Antes, a linha abria uma caixa de texto livre e quem montava a regra tinha de
 * saber escrever `expected_close_date`; um nome errado era salvo e a regra
 * nunca disparava. O teste entra pelo `RuleEditor` de produção.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// jsdom não implementa captura de ponteiro (mesmo remédio dos irmãos).
beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

const h = vi.hoisted(() => ({ criar: vi.fn(), atualizar: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
  },
}));
vi.mock("@/hooks/webhooks/useAutomationRules", () => ({
  useCreateAutomationRule: () => ({ isPending: false, mutateAsync: h.criar }),
  useUpdateAutomationRule: () => ({ isPending: false, mutateAsync: h.atualizar }),
}));
vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  useWebhookSources: () => ({ data: { data: [] } }),
  usePipelines: () => ({ data: { data: [] } }),
  usePipelineStages: () => ({ data: undefined }),
}));

import { RuleEditor } from "@/app/app/webhooks/_components/RuleEditor";
import type { AutomationRuleRow } from "@/hooks/webhooks/useAutomationRules";

const regra: AutomationRuleRow = {
  id: "regra-1",
  organization_id: "org-1",
  name: "Data prevista mudou",
  trigger_event: "lead.updated",
  conditions: [{ field: "event.fields", op: "campo_alterado", value: "expected_close_date" }],
  actions: [{ type: "add_tag", config: { tags: ["data"] } }],
  trigger_config: {},
  is_active: true,
  last_run_at: null,
  run_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_change_actor_kind: null,
  last_change_at: null,
};

beforeEach(() => {
  h.criar.mockReset();
  h.atualizar.mockReset();
});

describe("condição 'foi alterado' no editor (#1749)", () => {
  it("⭐ o campo é escolhido numa lista com nome legível, e a escolha grava o nome da coluna", async () => {
    const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={cliente}>
        <RuleEditor open onOpenChange={vi.fn()} rule={regra} />
      </QueryClientProvider>,
    );

    const seletor = screen.getByRole("combobox", { name: "Campo do negócio" });
    expect(seletor.textContent, "a linha abriu sem o seletor de campo").toContain("Data prevista de fechamento");
    expect(screen.queryByPlaceholderText("Valor"), "voltou a caixa de texto livre").toBeNull();

    fireEvent.click(seletor);
    fireEvent.click(await screen.findByRole("option", { name: "Valor" }));

    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(h.atualizar).toHaveBeenCalledTimes(1));
    const payload = h.atualizar.mock.calls[0]![0] as { conditions: unknown };
    expect(payload.conditions).toEqual([{ field: "event.fields", op: "campo_alterado", value: "value_cents" }]);
  });

  it("o operador 'foi alterado' só é oferecido na linha do campo alterado", async () => {
    const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={cliente}>
        <RuleEditor
          open
          onOpenChange={vi.fn()}
          rule={{ ...regra, conditions: [{ field: "lead.title", op: "eq", value: "x" }] }}
        />
      </QueryClientProvider>,
    );

    const operadores = screen.getAllByRole("combobox").find((c) => c.textContent?.trim() === "é");
    expect(operadores, "não achei o seletor de operador").toBeTruthy();
    fireEvent.click(operadores!);
    const lista = await screen.findByRole("listbox");
    expect(within(lista).queryByRole("option", { name: "foi alterado" })).toBeNull();
    expect(within(lista).getByRole("option", { name: "contém" })).toBeTruthy();
  });
});
