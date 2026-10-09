/**
 * A ação `apply_task_plan` NO EDITOR DE REGRAS (#1752) — o ponto 2 da CR.
 *
 * O que este arquivo prova:
 *
 *   1. `labels.ts` nomeia a ação (sem isso, uma regra criada pela API aparece
 *      no RuleEditor com o título em branco — o defeito apontado na revisão);
 *   2. `ActionConfigForm` TEM o caso e o seletor dos planos CADASTRADOS, que
 *      busca na mesma rota que a tela Tarefas › Planos grava (a chamada é
 *      observável em `apiClient.get`);
 *   3. escolher um plano entrega o `plano_id` à regra;
 *   4. a ação registrada CHAMA o motor com aquele `plano_id` — é a perna que
 *      conecta o editor ao `aplicarPlanoDeTarefas` de `lib/tarefas/plano.ts`.
 *
 * A perna 4 já passava antes destas mudanças (o motor e a ação vieram na
 * primeira rodada do PR): é o controle que mostra que o editor novo aponta
 * para o MESMO caminho, não para uma cópia.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));
vi.mock("@/lib/tarefas/plano", () => ({
  aplicarPlanoDeTarefas: vi.fn(async () => ({ ok: true, ja_aplicado: false, tarefa_ids: ["t1"] })),
}));

import { aplicarPlanoDeTarefas, type PedidoDeAplicacao } from "@/lib/tarefas/plano";
import { apiClient } from "@/lib/api/client";
import { getAction } from "@/lib/automation/actions";
import type { ActionCtx } from "@/lib/automation/types";
import { ACTION_LABELS, type ActionType } from "@/app/app/webhooks/_components/labels";
import {
  ActionConfigForm,
  defaultActionConfig,
  type ActionItem,
} from "@/app/app/webhooks/_components/ActionConfigForm";

import "@/lib/automation/actions/apply-task-plan";

const PLANO = {
  id: "proposta-enviada",
  nome: "Proposta enviada",
  descricao: null,
  passos: [
    {
      ordem: 1,
      titulo: "Ligar em 2 dias",
      descricao: null,
      vence_em_dias: 2,
      prioridade: "medium" as const,
      atribuir_a: "dono_do_lead" as const,
    },
  ],
};

afterEach(() => cleanup());

afterAll(() => {
  vi.restoreAllMocks();
});

// jsdom não implementa captura de ponteiro; o gatilho do Select do Radix lê
// `hasPointerCapture` antes de abrir — sem isto, abrir morre em TypeError.
beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

function montar(action: ActionItem, onChange = vi.fn()) {
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={cliente}>
      <ActionConfigForm action={action} onChange={onChange} />
    </QueryClientProvider>,
  );
  return { ...utils, onChange };
}

function ctx(): ActionCtx {
  return {
    admin: {} as ActionCtx["admin"],
    organizationId: "org-1",
    ruleId: "rule-1",
    ruleName: "Regra",
    requestId: "evt-1",
    event: {
      id: "evt-1",
      organization_id: "org-1",
      event_type: "lead.stage_changed",
      entity_kind: "crm_lead",
      entity_id: "lead-1",
      payload: {},
      metadata: {},
      consumed_by: [],
      attempts: 0,
    },
    context: { lead: { id: "lead-1" } },
  } as ActionCtx;
}

describe("labels.ts nomeia apply_task_plan", () => {
  it("está no ACTION_LABELS e no ActionType, com frase própria", () => {
    const tipos = Object.keys(ACTION_LABELS) as ActionType[];
    expect(tipos).toContain("apply_task_plan");
    expect(ACTION_LABELS.apply_task_plan).toMatch(/plano de tarefas/i);
  });
});

describe("ActionConfigForm: o seletor dos planos cadastrados", () => {
  beforeEach(() => {
    vi.mocked(apiClient.get).mockReset();
  });

  it("defaultActionConfig nasce com plano_id vazio — mesma forma que o schema exige", () => {
    expect(defaultActionConfig("apply_task_plan")).toEqual({
      type: "apply_task_plan",
      config: { plano_id: "" },
    });
  });

  it("renderiza o formulário e busca os planos na MESMA rota que a tela grava", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { planos: [PLANO] } } as never);

    const { container } = montar({ type: "apply_task_plan", config: { plano_id: "" } });

    expect(screen.getByText("Plano de tarefa")).toBeInTheDocument();
    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith("/api/v1/settings/task-plans"),
    );
    expect(container.querySelector("button")).not.toBeNull();
  });

  it("escolher um plano entrega o plano_id à regra", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { planos: [PLANO] } } as never);

    const { container, onChange } = montar({ type: "apply_task_plan", config: { plano_id: "" } });

    // Espera a lista CHEGAR: enquanto carrega, o Select fica `disabled` e o
    // gatilho não abre — clicar antes mediria o carregamento, não o seletor.
    await screen.findByText(
      "Cada aplicação cria as tarefas do plano na ordem e não duplica — a marca da aplicação é a prova.",
    );
    const gatilho = container.querySelector("button");
    expect(gatilho, "o seletor não renderizou gatilho").not.toBeNull();
    // O gatilho abre pelo caminho de toque do Radix (pointerType inicial é
    // "touch"), e o item seleciona no MESMO caminho — é o par de eventos que o
    // jsdom consegue produzir sem mouse de verdade.
    fireEvent.click(gatilho!);

    const opcao = await screen.findByText("Proposta enviada");
    fireEvent.click(opcao);

    expect(onChange).toHaveBeenCalledWith({
      type: "apply_task_plan",
      config: { plano_id: "proposta-enviada" },
    });
  });

  it("sem plano cadastrado, diz onde cadastrá-lo em vez de deixar a lista muda", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { planos: [] } } as never);

    montar({ type: "apply_task_plan", config: { plano_id: "" } });

    expect(
      await screen.findByText("Nenhum plano cadastrado ainda. Cadastre em Tarefas › Planos."),
    ).toBeInTheDocument();
  });
});

describe("apply_task_plan aplica o plano", () => {
  beforeEach(() => vi.mocked(aplicarPlanoDeTarefas).mockClear());

  it("a ação registrada chama o motor com o plano escolhido e devolve o resultado", async () => {
    const acao = getAction("apply_task_plan");
    expect(acao, "ação apply_task_plan não registrada").toBeDefined();

    const resultado = await acao!.execute(ctx(), { plano_id: "proposta-enviada" });

    expect(aplicarPlanoDeTarefas).toHaveBeenCalledTimes(1);
    const pedido = vi.mocked(aplicarPlanoDeTarefas).mock.calls[0]![1] as PedidoDeAplicacao;
    expect(pedido).toMatchObject({
      organizationId: "org-1",
      leadId: "lead-1",
      planoId: "proposta-enviada",
      origem: "automation:rule-1",
    });
    expect(resultado).toEqual({
      type: "apply_task_plan",
      status: "success",
      detail: { plano_id: "proposta-enviada", ja_aplicado: false, tarefas: 1, task_ids: ["t1"] },
    });
  });
});
