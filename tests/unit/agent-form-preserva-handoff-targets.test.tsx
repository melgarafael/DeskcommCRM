/**
 * Achado 3a da investigação de 20/09/2026: `AgentForm` não conhecia
 * `handoff_targets` — o formulário lia a versão sem o campo e `toVersionPayload`
 * não o devolvia. `versionCreateSchema` tem `.default([])` para o campo, então
 * TODO save pela tela zerava os alvos de handoff entre agentes, mesmo sem a
 * pessoa tocar em nada relacionado a isso. Os 3 agentes de produção perderam os
 * alvos assim quando o provider foi trocado em 11/09.
 *
 * Este teste guarda o round-trip: abrir um agente cuja versão-base tem
 * `handoff_targets` preenchido e salvar o rascunho (sem tocar no campo, que não
 * tem UI própria) não pode mandar `[]` para o servidor.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app/ai/agents/a1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

const saveAgentDraftAction = vi.fn(async (..._args: [string, unknown]) => ({
  ok: true,
  data: { version_id: "v9", version_number: 9 },
}));
vi.mock("@/app/app/ai/agents/[id]/_actions", () => ({
  saveAgentDraftAction: (...args: [string, unknown]) => saveAgentDraftAction(...args),
  publishAgentAction: vi.fn(),
  createMcpAgentAction: vi.fn(),
}));

import { AgentForm } from "@/app/app/ai/agents/[id]/_components/AgentForm";

const CREDENCIAIS = [
  { id: "11111111-1111-4111-8111-111111111111", provider: "anthropic", label: "chave", is_active: true },
];
const SESSOES = [{ id: "22222222-2222-4222-8222-222222222222", label: "WhatsApp", status: "WORKING" }];
const ALVOS_DE_HANDOFF = ["33333333-3333-4333-8333-333333333333"];

const AGENTE = {
  id: "a1",
  organization_id: "org-1",
  name: "Concierge de Compras",
  description: null,
  model: "claude-sonnet-5",
  system_prompt: "Você é o concierge de compras.",
  is_active: true,
  is_default: false,
  config: {},
  guardrails: [],
  active_kb_version_id: null,
  kind: "mcp_agent",
  published_version_id: "v7",
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const VERSAO_PUBLICADA = {
  id: "v7",
  organization_id: "org-1",
  agent_id: "a1",
  version_number: 7,
  status: "published",
  system_prompt: "Você é o concierge de compras.",
  provider: "anthropic",
  model: "claude-sonnet-5",
  credential_id: CREDENCIAIS[0]!.id,
  tool_ids: [],
  channel_session_id: SESSOES[0]!.id,
  max_steps: 10,
  token_budget: 50000,
  cost_budget_cents: 50,
  history_message_window: 20,
  history_token_window: 8000,
  handoff_keywords: [],
  handoff_tool_enabled: true,
  handoff_targets: ALVOS_DE_HANDOFF,
  cases_enabled: false,
  split_messages: false,
  split_max_chars: 600,
  followup: { enabled: false, flow_pointer_ids: [] },
  operator_enabled: false,
  operator_model: null,
  operator_tool_ids: [],
  pipeline_ids: [],
  trigger_config: null,
  published_at: "2026-01-01T00:00:00Z",
  superseded_at: null,
  created_at: "2026-01-01T00:00:00Z",
  created_by: null,
};

describe("AgentForm preserva handoff_targets ao salvar", () => {
  it("salvar um rascunho a partir da publicada não zera handoff_targets", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AgentForm
          mode="edit"
          agent={AGENTE as never}
          credentials={CREDENCIAIS as never}
          channelSessions={SESSOES as never}
          draft={null}
          published={VERSAO_PUBLICADA as never}
          base={VERSAO_PUBLICADA as never}
          draftObsoleto={null}
        />
      </QueryClientProvider>,
    );

    // Muda um campo qualquer sem UI para handoff_targets, para simular o save
    // "normal" que o dono faz — não uma edição deliberada do campo oculto.
    fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: "atualizando a descrição" } });
    fireEvent.click(screen.getByRole("button", { name: /Salvar rascunho/i }));

    await waitFor(() => expect(saveAgentDraftAction).toHaveBeenCalledTimes(1));
    const chamada = saveAgentDraftAction.mock.calls[0];
    if (!chamada) throw new Error("saveAgentDraftAction não foi chamado");
    const [, payload] = chamada as unknown as [string, { handoff_targets: string[] }];
    expect(payload.handoff_targets).toEqual(ALVOS_DE_HANDOFF);
  });
});
