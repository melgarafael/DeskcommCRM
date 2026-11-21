/**
 * #4940 — O AVISO DO FUNIL DE ENTRADA OLHA O NÚMERO DESTE AGENTE.
 *
 * Desde o #4921 cada número escolhe o funil onde a conversa nova vira negócio.
 * A página entrega o mapa número → funil de entrada; o formulário escolhe os
 * números DESTE agente (o do seletor e o do roteador) e o aviso nomeia o número
 * que manda as conversas para um funil que ele não pode mexer.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGENTE = "44444444-4444-4444-8444-444444444444";
const CREDENCIAL = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const PADRAO = "55555555-5555-4555-8555-555555555555";
const ATACADO = "66666666-6666-4666-8666-666666666666";
const ROTEADOR_CANAL = "77777777-7777-4777-8777-777777777777";

const acoes = vi.hoisted(() => ({ salvar: vi.fn(), publicar: vi.fn(), criar: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => `/app/ai/agents/${AGENTE}`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/app/app/ai/agents/[id]/_actions", () => ({
  saveAgentDraftAction: acoes.salvar,
  publishAgentAction: acoes.publicar,
  createMcpAgentAction: acoes.criar,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({ id: "user-1", email: "u@example.com" })),
  resolveActiveOrg: vi.fn(async () => ({ orgId: ORG, name: "Org", role: "admin" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ai/agents/escopo", () => ({
  validarEscopoDaVersao: vi.fn(async () => ({ ok: true })),
  mensagemDoEscopo: () => "Escopo inválido.",
  codigoDoEscopo: () => "validation_failed",
}));

import { AgentForm } from "@/app/app/ai/agents/[id]/_components/AgentForm";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const CREDENCIAIS = [
  { id: CREDENCIAL, provider: "anthropic", label: "chave da casa", is_active: true },
];
const SESSOES = [
  { id: CANAL, display_name: "WhatsApp do atacado", phone_number: null, status: "WORKING" },
  { id: ROTEADOR_CANAL, display_name: "WhatsApp geral", phone_number: null, status: "WORKING" },
];

const AGENTE_ROW = {
  id: AGENTE,
  organization_id: ORG,
  name: "Recepção",
  description: "atende quem chega",
  priority: 3,
  model: "claude-sonnet-5",
  system_prompt: "x",
  is_active: true,
  is_default: false,
  config: {},
  guardrails: [],
  active_kb_version_id: null,
  kind: "mcp_agent",
  published_version_id: "v1",
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

/** A versão publicada: operador ligado, só o funil padrão marcado. */
function versao(extra: Record<string, unknown> = {}) {
  return {
    id: "v1",
    organization_id: ORG,
    agent_id: AGENTE,
    version_number: 1,
    status: "published",
    system_prompt: "Você é a recepção da clínica. Atenda com educação.",
    provider: "anthropic",
    model: "claude-sonnet-5",
    credential_id: CREDENCIAL,
    tool_ids: [],
    channel_session_id: CANAL,
    max_steps: 10,
    token_budget: 50000,
    cost_budget_cents: 50,
    history_message_window: 20,
    history_token_window: 8000,
    handoff_keywords: [],
    handoff_tool_enabled: true,
    cases_enabled: false,
    split_messages: false,
    split_max_chars: 600,
    followup: { enabled: false, flow_pointer_ids: [] },
    operator_enabled: true,
    operator_model: null,
    operator_tool_ids: ["crm_move_lead_stage"],
    pipeline_ids: [PADRAO],
    knowledge_source_ids: [],
    trigger_config: null,
    published_at: "2026-01-01T00:00:00Z",
    superseded_at: null,
    created_at: "2026-01-01T00:00:00Z",
    created_by: null,
    ...extra,
  };
}

const FUNIS = [
  { id: PADRAO, name: "Clínicas", is_default: true },
  { id: ATACADO, name: "Pedidos de atacado", is_default: false },
];

function abrirEditor(extra: Record<string, unknown> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const v = versao();
  render(
    <IdiomaProvider locale={undefined}>
      <QueryClientProvider client={qc}>
        <AgentForm
          mode="edit"
          agent={AGENTE_ROW as never}
          credentials={CREDENCIAIS as never}
          channelSessions={SESSOES as never}
          draft={versao({ id: "v2", version_number: 2, status: "draft" }) as never}
          published={v as never}
          base={v as never}
          draftObsoleto={null}
          funis={FUNIS as never}
          {...extra}
        />
      </QueryClientProvider>
    </IdiomaProvider>,
  );
  fireEvent.click(screen.getByTestId("papel-operacao"));
}

afterEach(() => cleanup());

describe("aviso do funil de entrada pelo número do agente (#4940)", () => {
  it("nomeia o número do agente que manda as conversas para um funil não marcado", () => {
    abrirEditor({ funilDeEntradaPorNumero: { [CANAL]: ATACADO } });
    const aviso = screen.getByTestId("agente-entrada-de-fora");
    expect(aviso.textContent).toContain("WhatsApp do atacado");
    expect(aviso.textContent).toContain("Pedidos de atacado");
  });

  it("sem o mapa (consulta falhou), fica na régua antiga: padrão marcado, sem aviso", () => {
    abrirEditor();
    expect(screen.queryByTestId("agente-entrada-de-fora")).toBeNull();
  });

  it("número sem escolha cai no padrão, que está marcado: sem aviso", () => {
    abrirEditor({ funilDeEntradaPorNumero: { [CANAL]: null } });
    expect(screen.queryByTestId("agente-entrada-de-fora")).toBeNull();
  });

  it("conta também os números dos roteadores que levam conversa a ele", () => {
    abrirEditor({
      funilDeEntradaPorNumero: { [CANAL]: null, [ROTEADOR_CANAL]: ATACADO },
      numerosDoRoteador: [ROTEADOR_CANAL],
    });
    const aviso = screen.getByTestId("agente-entrada-de-fora");
    expect(aviso.textContent).toContain("WhatsApp geral");
    expect(aviso.textContent).toContain("Pedidos de atacado");
  });

  it("ignora número que não está mais na lista viva (arquivado)", () => {
    abrirEditor({
      funilDeEntradaPorNumero: { [CANAL]: null, "88888888-8888-4888-8888-888888888888": ATACADO },
      numerosDoRoteador: ["88888888-8888-4888-8888-888888888888"],
    });
    expect(screen.queryByTestId("agente-entrada-de-fora")).toBeNull();
  });
});
