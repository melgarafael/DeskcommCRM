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
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// jsdom não implementa captura de ponteiro; o gatilho do Select do Radix lê
// `hasPointerCapture` antes de abrir — sem isto, abrir morre em TypeError
// (mesmo remédio de `apply-task-plan-no-editor.test.tsx`).
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
        { id: "funil-2", name: "Pós-venda", is_default: false, settings: null },
      ],
    },
  }),
  // As etapas dependem do funil pedido — um dublê que ignorasse o id deixaria
  // passar a tela listando as etapas de OUTRO funil (#2483).
  usePipelineStages: (pipelineId: string | null) => ({
    data: pipelineId
      ? {
          data: {
            stages:
              pipelineId === "funil-2"
                ? [{ id: "etapa-20", name: "Onboarding" }]
                : [
                    { id: "etapa-2", name: "Proposta" },
                    { id: "etapa-9", name: "Fechamento" },
                  ],
          },
        }
      : undefined,
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

/** Abre um Select do Radix pelo rótulo e escolhe a opção pelo texto. */
async function escolherNoSelect(rotulo: string, opcao: string) {
  fireEvent.click(screen.getByRole("combobox", { name: rotulo }));
  fireEvent.click(await screen.findByRole("option", { name: opcao }));
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

/**
 * #2483, SEGUNDA METADE — os seletores: a tela passa a DESENHAR (e a gravar) o
 * recorte que antes só a API sabia pôr. O que se mede aqui é o gesto completo:
 * abrir a regra, escolher na lista, salvar e conferir o payload; abrir de novo e
 * ver o gravado; e limpar para "todos/qualquer".
 */
describe("a tela desenha o funil e a etapa do gatilho de tempo", () => {
  const SEM_FILTRO: AutomationRuleRow = {
    ...REGRA_DA_ETAPA,
    // Regra gravada pela API sem recorte: `null` nos dois.
    trigger_config: { dias: 7, pipeline_id: null, stage_id: null, proteger_pela_agenda: false },
  };

  it("⭐ escolher funil e etapa pela tela grava os dois no trigger_config", async () => {
    montar(SEM_FILTRO);

    await escolherNoSelect("Funil", "Funil de vendas");
    await escolherNoSelect("Etapa", "Proposta");

    const payload = await salvar();

    expect(payload.trigger_config.pipeline_id, "o funil escolhido na tela não foi salvo").toBe("funil-1");
    expect(payload.trigger_config.stage_id, "a etapa escolhida na tela não foi salva").toBe("etapa-2");
    expect(payload.trigger_config.dias).toBe(7);
  });

  it("⭐ o silêncio ganha o funil e NÃO ganha etapa (a chave nem é enviada)", async () => {
    // O `pipeline_id` existe nos dois gatilhos de tempo; a etapa só no de etapa
    // parada. Mandar `stage_id` no silêncio seria inventar configuração.
    const REGRA_SILENCIO: AutomationRuleRow = {
      ...REGRA_DA_ETAPA,
      trigger_event: "lead.silent_for",
      trigger_config: { dias: 7, direcao: "da_equipe", pipeline_id: null, proteger_pela_agenda: false },
    };
    montar(REGRA_SILENCIO);

    await escolherNoSelect("Funil", "Funil de vendas");

    const payload = await salvar();

    expect(payload.trigger_config.pipeline_id).toBe("funil-1");
    expect("stage_id" in payload.trigger_config, "o silêncio não tem etapa a configurar").toBe(false);
  });

  it("abrir uma regra com filtro MOSTRA o filtro gravado (não inventa nem esconde)", async () => {
    montar(REGRA_DA_ETAPA);

    expect(screen.getByRole("combobox", { name: "Funil" })).toHaveTextContent("Funil de vendas");
    expect(screen.getByRole("combobox", { name: "Etapa" })).toHaveTextContent("Proposta");
  });

  it("⭐ 'Todos os funis' limpa o recorte: funil e etapa voltam a `null`", async () => {
    montar(REGRA_DA_ETAPA);

    await escolherNoSelect("Funil", "Todos os funis");

    const payload = await salvar();

    expect(payload.trigger_config.pipeline_id, "limpar o funil não voltou para `null`").toBeNull();
    expect(payload.trigger_config.stage_id, "a etapa devia ser zerada junto com o funil").toBeNull();
  });

  it("⭐ trocar de funil lista só as etapas do funil novo", async () => {
    // Uma etapa de outro funil gravada junto com este funil faria o recorte
    // casar com zero leads, em silêncio. A lista acompanha o funil escolhido.
    montar(REGRA_DA_ETAPA);

    await escolherNoSelect("Funil", "Pós-venda");
    fireEvent.click(screen.getByRole("combobox", { name: "Etapa" }));
    expect(await screen.findByRole("option", { name: "Onboarding" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Proposta" }), "listou etapa de outro funil").toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Onboarding" }));

    const payload = await salvar();

    expect(payload.trigger_config.pipeline_id).toBe("funil-2");
    expect(payload.trigger_config.stage_id).toBe("etapa-20");
  });

  it("trocar de funil sem escolher etapa grava a etapa como `null`, nunca a do funil anterior", async () => {
    montar(REGRA_DA_ETAPA);

    await escolherNoSelect("Funil", "Pós-venda");

    const payload = await salvar();

    expect(payload.trigger_config.pipeline_id).toBe("funil-2");
    expect(payload.trigger_config.stage_id, "a etapa do funil anterior sobreviveu à troca").toBeNull();
  });

  it("'Qualquer etapa' com o funil mantido grava o funil e zera a etapa", async () => {
    // O par do caso acima: limpar só a etapa não pode levar o funil junto.
    montar(REGRA_DA_ETAPA);

    await escolherNoSelect("Etapa", "Qualquer etapa");

    const payload = await salvar();

    expect(payload.trigger_config.pipeline_id).toBe("funil-1");
    expect(payload.trigger_config.stage_id).toBeNull();
  });
});
