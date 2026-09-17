import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const AGENTE = "44444444-4444-4444-8444-444444444444";
const CREDENCIAL = "11111111-1111-4111-8111-111111111111";
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

import { AgentForm } from "@/app/app/ai/agents/[id]/_components/AgentForm";
import type { ModelOption } from "@/app/app/ai/agents/[id]/_components/ModelPicker";

const CATALOGO: ModelOption[] = [
  {
    provider: "anthropic",
    model_id: "claude-sonnet-4-6",
    display_name: "Claude Sonnet 4.6",
    context_window: 200000,
    is_default_for_provider: false,
  },
  {
    provider: "anthropic",
    model_id: "claude-sonnet-5",
    display_name: "Claude Sonnet 5",
    context_window: 200000,
    is_default_for_provider: true,
  },
];

const CREDENCIAIS = [
  {
    id: CREDENCIAL,
    provider: "anthropic",
    label: "Chave do onboarding",
    is_active: true,
    validated_at: "2026-09-13T12:00:00.000Z",
    validation_error: null,
    api_key_last4: "fQAA",
    created_at: "2026-09-01T00:00:00Z",
  },
];

const AGENTE_ROW = {
  id: AGENTE,
  organization_id: "33333333-3333-4333-8333-333333333333",
  name: "Assistente Sigilium",
  description: null,
  priority: 0,
  model: "anthropic/claude-sonnet-4-6",
  system_prompt: "x",
  is_active: true,
  is_default: true,
  config: {},
  guardrails: [],
  active_kb_version_id: null,
  kind: "mcp_agent",
  published_version_id: null,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function abrir() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AgentForm
        mode="edit"
        agent={AGENTE_ROW as never}
        credentials={CREDENCIAIS as never}
        catalogo={CATALOGO}
        channelSessions={[]}
        draft={null}
        published={null}
        base={null}
        draftObsoleto={null}
      />
    </QueryClientProvider>,
  );
}

describe("editor sem canal e sem versão", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acoes.salvar.mockResolvedValue({ ok: true, data: { version_id: "v1", version_number: 1 } });
  });

  it("hidrata o modelo, permite salvar o rascunho e bloqueia publicar", async () => {
    abrir();
    expect(
      screen.getAllByText("Você pode testar este agente aqui. Para atender clientes, conecte um canal.")
        .length,
    ).toBeGreaterThan(0);
    const salvar = screen.getByRole("button", { name: /salvar rascunho/i });
    expect(salvar).toBeEnabled();
    expect(screen.getByRole("button", { name: /^publicar$/i })).toBeDisabled();

    fireEvent.click(salvar);
    await waitFor(() => expect(acoes.salvar).toHaveBeenCalled());
    const versao = acoes.salvar.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(versao.model).toBe("claude-sonnet-4-6");
    expect(versao.channel_session_id).toBeNull();
    expect(versao.credential_id).toBe(CREDENCIAL);
    expect(JSON.stringify(acoes.salvar.mock.calls)).not.toMatch(/sk-ant-|encrypted|ciphertext/);
  });
});
