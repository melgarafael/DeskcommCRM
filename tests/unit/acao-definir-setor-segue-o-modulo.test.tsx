/**
 * A ação "Definir o setor da conversa" (#3881) segue o módulo opcional Setores,
 * como a opção "Atendimento" do Iniciar fluxo segue o dela
 * (`acao-iniciar-fluxo-segue-o-modulo.test.tsx`): desligado na instalação — o
 * padrão, doc 213 —, nem o seletor "Adicionar ação" nem a paleta do canvas a
 * oferecem. Numa regra que JÁ a grava, a caixa continua na tela: o que está
 * salvo não some.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({ modulos: [] as string[] }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(async () => ({ data: [] })), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useModulosLigados: () => h.modulos,
  useCapacidadesLigadas: () => [],
  useAuth: () => ({ activeOrg: { modulos_ligados: h.modulos } }),
}));
vi.mock("@/hooks/team/useSectors", () => ({ useSectors: () => ({ data: { data: [] }, isError: false }) }));
vi.mock("@/hooks/webhooks/useAutomationRules", () => ({
  useCreateAutomationRule: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useUpdateAutomationRule: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  useWebhookSources: () => ({ data: { data: [] } }),
  usePipelines: () => ({ data: { data: [] } }),
  usePipelineStages: () => ({ data: undefined }),
}));

import { RuleEditor } from "@/app/app/webhooks/_components/RuleEditor";
import { PaletaDaAutomacao } from "@/app/app/webhooks/automacoes/[id]/_components/PaletaDaAutomacao";
import type { AutomationRuleRow } from "@/hooks/webhooks/useAutomationRules";

const ROTULO = "Definir o setor da conversa";

afterEach(() => cleanup());

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

function regra(actions: AutomationRuleRow["actions"]): AutomationRuleRow {
  return {
    id: "regra-1",
    organization_id: "org-1",
    name: "Boleto vai para o Financeiro",
    trigger_event: "message.received",
    conditions: [],
    actions,
    trigger_config: {},
    is_active: false,
    last_run_at: null,
    run_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_change_actor_kind: null,
    last_change_at: null,
  };
}

function montarEditor(modulos: string[], actions: AutomationRuleRow["actions"]) {
  h.modulos = modulos;
  const cliente = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={cliente}>
      <RuleEditor open onOpenChange={vi.fn()} rule={regra(actions)} />
    </QueryClientProvider>,
  );
}

async function abrirAdicionarAcao() {
  const gatilho = (await screen.findByText("Adicionar ação")).closest("button");
  fireEvent.click(gatilho!);
  // A lista abriu: uma ação de núcleo aparece sempre.
  await screen.findByRole("option", { name: "Adicionar tag" });
}

describe("Definir o setor da conversa segue o módulo Setores", () => {
  it("módulo ligado: o seletor 'Adicionar ação' oferece", async () => {
    montarEditor(["setores"], [{ type: "add_tag", config: { tags: ["x"] } }]);
    await abrirAdicionarAcao();
    expect(screen.getByRole("option", { name: ROTULO })).toBeInTheDocument();
  });

  it("módulo desligado: o seletor 'Adicionar ação' não oferece", async () => {
    montarEditor([], [{ type: "add_tag", config: { tags: ["x"] } }]);
    await abrirAdicionarAcao();
    expect(screen.queryByRole("option", { name: ROTULO })).toBeNull();
  });

  it("módulo desligado numa regra que já grava a ação: a caixa salva continua na tela", async () => {
    montarEditor([], [{ type: "define_sector", config: { sector_id: "" } }]);
    expect(await screen.findByText(ROTULO)).toBeInTheDocument();
  });

  it("paleta do canvas: oferece com o módulo ligado e esconde com ele desligado", () => {
    h.modulos = ["setores"];
    render(<PaletaDaAutomacao evento="message.received" temCondicoes={false} onAdd={() => {}} />);
    expect(screen.getByTestId("paleta-define_sector")).toBeInTheDocument();
    cleanup();

    h.modulos = [];
    render(<PaletaDaAutomacao evento="message.received" temCondicoes={false} onAdd={() => {}} />);
    expect(screen.queryByTestId("paleta-define_sector")).toBeNull();
    // Guarda de vacuidade: a paleta renderizou as ações de núcleo.
    expect(screen.getByTestId("paleta-add_tag")).toBeInTheDocument();
  });
});
