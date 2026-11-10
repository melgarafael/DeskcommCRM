/**
 * A condição "Etapa de destino" alcança TODOS os funis — medido no editor real.
 *
 * O seletor da condição listava só as etapas do funil padrão. Quem tinha dois
 * funis montava "quando o lead mudar de etapa / SE etapa de destino é…" e não
 * achava a etapa do segundo funil; e uma regra que já apontava para ela (criada
 * pela API ou pelo campo avançado) abria com o campo em branco.
 *
 * O motor nunca teve o defeito: compara `stage_id`, que é único entre funis
 * (`lib/automation/conditions.ts`). O teste entra pelo `RuleEditor` de
 * produção, com a mesma leitura de etapas do construtor de follow-up
 * (`/api/v1/pipelines` + `agent-mapping` por funil) dublada na borda HTTP.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// jsdom não implementa captura de ponteiro; o gatilho do Select do Radix lê
// `hasPointerCapture` antes de abrir (mesmo remédio de
// `rule-editor-preserva-config-ao-salvar.test.tsx`).
beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

const FUNIS = [
  { id: "funil-1", name: "Funil de vendas", is_default: true, settings: null },
  { id: "funil-2", name: "Pós-venda", is_default: false, settings: null },
];
const ETAPAS: Record<string, Array<{ id: string; name: string; is_lost: boolean }>> = {
  "funil-1": [
    { id: "etapa-1", name: "Novo", is_lost: false },
    { id: "etapa-2", name: "Proposta", is_lost: false },
  ],
  "funil-2": [
    { id: "etapa-20", name: "Novo", is_lost: false },
    { id: "etapa-21", name: "Onboarding", is_lost: false },
  ],
};

const h = vi.hoisted(() => ({ criar: vi.fn(), atualizar: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (url: string) => {
      if (url === "/api/v1/pipelines") return { data: FUNIS };
      const funil = /\/api\/v1\/pipelines\/([^/]+)\/agent-mapping$/.exec(url)?.[1];
      if (funil) return { data: { etapas: ETAPAS[decodeURIComponent(funil)] ?? [], mapeamento: {} } };
      throw new Error(`GET inesperado: ${url}`);
    }),
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
  usePipelines: () => ({ data: { data: FUNIS } }),
  // O seletor antigo lia daqui o funil PADRÃO; o dublê responde por funil para
  // que a sabotagem (voltar ao seletor antigo) reprove pelo motivo certo.
  usePipelineStages: (pipelineId: string | null) => ({
    data: pipelineId
      ? { data: { stages: (ETAPAS[pipelineId] ?? []).map(({ id, name }) => ({ id, name })) } }
      : undefined,
  }),
}));

import { RuleEditor } from "@/app/app/webhooks/_components/RuleEditor";
import type { AutomationRuleRow } from "@/hooks/webhooks/useAutomationRules";

function regraComEtapa(stageId: string): AutomationRuleRow {
  return {
    id: "regra-1",
    organization_id: "org-1",
    name: "Entrou no onboarding",
    trigger_event: "lead.stage_changed",
    conditions: [{ field: "event.to_stage_id", op: "eq", value: stageId }],
    actions: [{ type: "add_tag", config: { tags: ["onboarding"] } }],
    trigger_config: {},
    is_active: true,
    last_run_at: null,
    run_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_change_actor_kind: null,
    last_change_at: null,
  };
}

function montar(rule: AutomationRuleRow) {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={cliente}>
      <RuleEditor open onOpenChange={vi.fn()} rule={rule} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.criar.mockReset();
  h.atualizar.mockReset();
});

describe("condição 'Etapa de destino' com mais de um funil", () => {
  it("⭐ a regra que aponta para etapa de outro funil abre mostrando essa etapa", async () => {
    montar(regraComEtapa("etapa-21"));

    const seletor = screen.getByRole("combobox", { name: "Etapa" });
    await waitFor(() =>
      expect(
        seletor.textContent,
        "a etapa do segundo funil abriu em branco: a tela só conhece o funil padrão",
      ).toContain("Onboarding · Pós-venda"),
    );
  });

  it("⭐ escolher a etapa do segundo funil grava o id dela, distinguindo etapas homônimas", async () => {
    montar(regraComEtapa("etapa-1"));

    const seletor = screen.getByRole("combobox", { name: "Etapa" });
    await waitFor(() => expect(seletor).not.toBeDisabled());
    fireEvent.click(seletor);
    // Os dois funis têm «Novo»: o nome do funil viaja junto para não serem a mesma opção.
    fireEvent.click(await screen.findByRole("option", { name: "Novo · Pós-venda" }));

    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(h.atualizar).toHaveBeenCalledTimes(1));
    const payload = h.atualizar.mock.calls[0]![0] as {
      conditions: Array<{ field: string; op: string; value: string }>;
    };
    expect(payload.conditions).toEqual([{ field: "event.to_stage_id", op: "eq", value: "etapa-20" }]);
  });
});
