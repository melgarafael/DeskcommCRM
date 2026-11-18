/**
 * O SELETOR "QUANDO O CONTATO TIVER HORÁRIO MARCADO" NO FOLLOW-UP DO AGENTE
 * (#3813) — a perna da TELA que faltava.
 *
 * ─── O buraco medido na main ────────────────────────────────────────────────
 *
 * O contrato (`lib/agenda/escolha-no-envio.ts`) e a leitura já existiam: o
 * disparo do follow-up lê `followup.quando_ha_compromisso` ao lado de
 * `send_window` (`lib/followup/janela-de-disparo.ts`) e o schema da versão já
 * aceita a chave (`lib/ai/agents/validation.ts`). A tela de AUTOMAÇÃO tinha o
 * rádio por ação (`ActionConfigForm`). O follow-up do AGENTE não tinha onde
 * escolher — `git grep quando_ha_compromisso -- app/app/ai/agents` voltava
 * vazio. Resultado: todo fluxo de follow-up adiava, sem que o operador pudesse
 * mandar mesmo assim nem pedir o pulo registrado.
 *
 * ─── Por que pela TELA e pelo PAYLOAD SALVO ─────────────────────────────────
 *
 * Um teste do seletor isolado passaria mesmo que o formulário não levasse o
 * valor até `saveAgentDraftAction` — e a chave morreria entre o `FollowupValue`
 * e o `toVersionPayload`. Aqui se clica no rádio e em "Salvar rascunho", e o
 * que se confere é o payload que a Server Action recebe, DEPOIS de
 * `versionCreateSchema` — o mesmo zod que o servidor usa e que, sendo
 * `.strict()`, recusaria (não ignoraria) a chave.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGENTE = "44444444-4444-4444-8444-444444444444";

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
import { versionCreateSchema } from "@/lib/ai/agents/validation";

const AGENTE_ROW = {
  id: AGENTE,
  organization_id: ORG,
  name: "Sofia",
  description: "assistente do consultório",
  priority: 0,
  model: "claude-sonnet-5",
  system_prompt: "x",
  is_active: true,
  is_default: false,
  config: {},
  guardrails: [],
  active_kb_version_id: null,
  kind: "mcp_agent",
  published_version_id: null,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function versao(followup: Record<string, unknown>) {
  return {
    id: "v1",
    organization_id: ORG,
    agent_id: AGENTE,
    version_number: 1,
    status: "draft",
    system_prompt: "Você é a Sofia, assistente do consultório. Atenda com acolhimento.",
    provider: "anthropic",
    model: "claude-sonnet-5",
    credential_id: null,
    tool_ids: [],
    channel_session_id: null,
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
    followup,
    operator_enabled: false,
    operator_model: null,
    operator_tool_ids: [],
    pipeline_ids: [],
    knowledge_source_ids: [],
    trigger_config: null,
    published_at: null,
    superseded_at: null,
    created_at: "2026-01-01T00:00:00Z",
    created_by: null,
  };
}

function abrirEditor(followup: Record<string, unknown>) {
  const v = versao(followup);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AgentForm
        mode="edit"
        agent={AGENTE_ROW as never}
        credentials={[] as never}
        provedoresDaInstalacao={["anthropic"]}
        channelSessions={[] as never}
        draft={v as never}
        published={null}
        base={v as never}
        draftObsoleto={null}
      />
    </QueryClientProvider>,
  );
  return {
    botaoSalvar: () => screen.getByRole("button", { name: /salvar rascunho/i }),
    botaoAdiar: () => screen.getByRole("radio", { name: /adiar e enviar depois do horário/i }),
    botaoEnviar: () => screen.getByRole("radio", { name: /enviar mesmo assim/i }),
    botaoNaoEnviar: () => screen.getByRole("radio", { name: /^não enviar/i }),
  };
}

/**
 * "Salvar rascunho" só habilita com o formulário SUJO (`!dirty && isEdit`).
 * Uma edição qualquer no prompt basta para o payload sair — e é o que estes
 * casos precisam quando o assunto é só o que a tela MANDA, sem clique no rádio.
 */
function sujarOPrompt() {
  fireEvent.change(
    screen.getByDisplayValue("Você é a Sofia, assistente do consultório. Atenda com acolhimento."),
    { target: { value: "Você é a Sofia. Convide para a avaliação." } },
  );
}

async function salvarEVerPayload() {
  fireEvent.click(screen.getByRole("button", { name: /salvar rascunho/i }));
  await waitFor(() => expect(acoes.salvar).toHaveBeenCalled());
  const enviado = acoes.salvar.mock.calls[0]?.[1] as {
    followup?: Record<string, unknown>;
  };
  return enviado;
}

const FOLLOWUP_LIGADO = { enabled: true, flow_pointer_ids: [] };

describe("follow-up do agente — quando o contato tiver horário marcado", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acoes.salvar.mockResolvedValue({ ok: true, data: { version_id: "v1", version_number: 1 } });
  });

  it("oferece as TRÊS opções, e a padrão marcada é adiar", () => {
    const { botaoAdiar, botaoEnviar, botaoNaoEnviar } = abrirEditor(FOLLOWUP_LIGADO);

    expect(botaoAdiar()).toBeChecked();
    expect(botaoEnviar()).not.toBeChecked();
    expect(botaoNaoEnviar()).not.toBeChecked();
    // O rótulo do grupo é o da issue, não o nome da chave.
    expect(screen.getByText("Quando o contato tiver horário marcado")).toBeInTheDocument();
  });

  it("escolher NÃO ENVIAR grava a chave no followup da versão salva", async () => {
    const { botaoNaoEnviar } = abrirEditor(FOLLOWUP_LIGADO);

    fireEvent.click(botaoNaoEnviar());
    const enviado = await salvarEVerPayload();

    expect(enviado.followup?.quando_ha_compromisso).toBe("nao_enviar");
    // E o zod da VERSÃO — o mesmo do servidor — não descarta a chave.
    const parsed = versionCreateSchema.safeParse(enviado);
    expect(parsed.success, "o servidor recusaria este envio").toBe(true);
    expect(parsed.success && parsed.data.followup.quando_ha_compromisso).toBe("nao_enviar");
  });

  it("round-trip: versão salva com `enviar` reabre com `enviar` marcado", async () => {
    const { botaoEnviar } = abrirEditor({ ...FOLLOWUP_LIGADO, quando_ha_compromisso: "enviar" });

    expect(botaoEnviar()).toBeChecked();
    sujarOPrompt();
    const enviado = await salvarEVerPayload();
    expect(enviado.followup?.quando_ha_compromisso).toBe("enviar");
  });

  it("retrocompatibilidade: versão antiga, SEM a chave, reabre em `adiar`", async () => {
    const { botaoAdiar } = abrirEditor(FOLLOWUP_LIGADO);

    expect(botaoAdiar()).toBeChecked();
    sujarOPrompt();
    // Quem nunca mexeu não ganha a chave no jsonb — o payload é o de sempre.
    const enviado = await salvarEVerPayload();
    expect(enviado.followup).not.toHaveProperty("quando_ha_compromisso");
  });

  it("voltar de `enviar` para `adiar` GRAVA `adiar` (o PATCH funde o followup)", async () => {
    const { botaoAdiar } = abrirEditor({ ...FOLLOWUP_LIGADO, quando_ha_compromisso: "enviar" });

    fireEvent.click(botaoAdiar());
    const enviado = await salvarEVerPayload();

    // Omitir o padrão não apagaria a escolha antiga no servidor
    // (`{...existing, ...patch}`): a pessoa ficaria presa em "enviar".
    expect(enviado.followup?.quando_ha_compromisso).toBe("adiar");
  });

  it("com o follow-up DESLIGADO o seletor fica desabilitado", () => {
    const { botaoAdiar, botaoEnviar, botaoNaoEnviar } = abrirEditor({
      enabled: false,
      flow_pointer_ids: [],
    });

    expect(botaoAdiar()).toBeDisabled();
    expect(botaoEnviar()).toBeDisabled();
    expect(botaoNaoEnviar()).toBeDisabled();
  });
});
