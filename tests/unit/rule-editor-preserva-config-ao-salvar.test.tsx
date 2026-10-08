/**
 * O GESTO QUE PERDIA O FILTRO — medido no editor DE VERDADE (issue #2483).
 *
 * A regra criada pela API com `trigger_config: { dias, pipeline_id, stage_id }`
 * era aberta na tela (Canais › Webhooks › Automações) e salva sem mudar nada:
 * `pipeline_id` e `stage_id` sumiam. Sem eles, a varredura `lead-time-triggers`
 * passa a valer para todos os funis — a regra dispara onde ninguém pediu, e
 * nada fica vermelho, porque a tela não desenha essas chaves.
 *
 * ⚠️ ENTRA PELO EDITOR REAL, não pela função pura: monta o `RuleEditor` com a
 * regra que a API gravou, clica em "Salvar alterações" e confere o payload que
 * a mutação recebe — depois do `createAutomationRuleSchema`, que é o que o
 * `onSubmit` entrega. O irmão `lib/automation/config-ao-salvar.test.ts` cobre
 * as bordas da função; um teste de função que passasse com o editor chamando
 * outra coisa não provaria nada.
 *
 * Os ganchos de dados são dublados (não há servidor aqui); o resto é o
 * componente de produção, incluindo o schema e o Radix do Sheet.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ criar: vi.fn(), atualizar: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));
vi.mock("@/hooks/webhooks/useAutomationRules", () => ({
  useCreateAutomationRule: () => ({ isPending: false, mutateAsync: h.criar }),
  useUpdateAutomationRule: () => ({ isPending: false, mutateAsync: h.atualizar }),
}));
vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  useWebhookSources: () => ({ data: { data: [] } }),
  usePipelines: () => ({
    data: {
      data: [
        { id: "funil-1", name: "Funil de vendas", is_default: true, settings: null },
      ],
    },
  }),
  usePipelineStages: () => ({
    data: {
      data: {
        stages: [
          { id: "etapa-2", name: "Proposta" },
          { id: "etapa-9", name: "Fechamento" },
        ],
      },
    },
  }),
}));

import { RuleEditor } from "@/app/app/webhooks/_components/RuleEditor";
import type { AutomationRuleRow } from "@/hooks/webhooks/useAutomationRules";

/**
 * A regra como a API a gravou: o filtro mora em `trigger_config`, e a tela não
 * tem campo para ele ainda — é exatamente por isso que ele não pode ser
 * destruído ao salvar.
 */
const REGRA_DA_ETAPA: AutomationRuleRow = {
  id: "regra-1",
  organization_id: "org-1",
  name: "Card parado há 45 dias",
  trigger_event: "lead.stage_stale",
  conditions: [],
  actions: [{ type: "add_tag", config: { tags: ["parado"] } }],
  trigger_config: {
    dias: 45,
    pipeline_id: "funil-1",
    stage_id: "etapa-2",
    proteger_pela_agenda: false,
  },
  is_active: true,
  last_run_at: null,
  run_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_change_actor_kind: null,
  last_change_at: null,
};

function montar(rule: AutomationRuleRow) {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={cliente}>
      <RuleEditor open onOpenChange={vi.fn()} rule={rule} />
    </QueryClientProvider>,
  );
}

async function salvar() {
  fireEvent.click(await screen.findByRole("button", { name: "Salvar alterações" }));
  await waitFor(() => expect(h.atualizar).toHaveBeenCalledTimes(1));
  return h.atualizar.mock.calls[0]![0] as { id: string; trigger_config: Record<string, unknown> };
}

beforeEach(() => {
  h.criar.mockReset();
  h.atualizar.mockReset();
});

describe("salvar a regra de etapa parada não perde o filtro", () => {
  it("⭐ abrir e salvar sem mudar nada preserva `pipeline_id` e `stage_id`", async () => {
    montar(REGRA_DA_ETAPA);

    const payload = await salvar();

    expect(payload.id).toBe("regra-1");
    expect(
      payload.trigger_config.pipeline_id,
      "o funil sumiu no salvar: a regra passa a valer para todos os funis, em silêncio",
    ).toBe("funil-1");
    expect(
      payload.trigger_config.stage_id,
      "a etapa sumiu no salvar: a regra passa a valer para todo card parado",
    ).toBe("etapa-2");
    expect(payload.trigger_config.dias).toBe(45);
  });

  it("o que a tela edita continua mandando (par de vacuidade)", async () => {
    // Sem este caso, um payload que ignorasse o formulário e devolvesse a
    // configuração guardada inteira passaria no caso acima.
    montar(REGRA_DA_ETAPA);
    fireEvent.change(screen.getByLabelText("Depois de N dias"), { target: { value: "30" } });

    const payload = await salvar();

    expect(payload.trigger_config.dias, "a tela não conseguiu mudar o N").toBe(30);
    expect(payload.trigger_config.pipeline_id).toBe("funil-1");
    expect(payload.trigger_config.stage_id).toBe("etapa-2");
  });
});
