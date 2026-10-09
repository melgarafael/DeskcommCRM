/**
 * A TELA DA CHAVE POR ASSUNTO JURÍDICO: SEGUNDO INTERRUPTOR, ABAIXO DO PRIMEIRO,
 * DESABILITADO QUANDO O DE CIMA ESTÁ DESLIGADO.
 *
 * Seção 3 do desenho do mantenedor (comentário 5999897516 no PR #2156). O cartão
 * "Passar para uma pessoa" ganha um segundo interruptor — `handoff_legal_enabled`
 * — com três amarras:
 *
 * 1. ele só existe embaixo do "Deixar o agente chamar uma pessoa...": sem a
 *    ferramenta não há descrição nenhuma para trocar, então o de baixo fica
 *    DESABILITADO quando o de cima está desligado;
 * 2. o texto diz o que acontece nos DOIS lados (rótulo + ajuda) e as duas
 *    strings têm de estar no dicionário (pt é a chave; es e en os lados);
 * 3. o valor VIAJA: é campo de `FormState` e sai em `toVersionPayload` — sem
 *    isso a pessoa liga e desliga, vê "Rascunho salvo." e nada muda (o mesmo
 *    defeito de classe que `editor-de-agente-salva-o-cadastro` vigia).
 *
 * O requerido aqui é só a parte da tela; a classe (campo em todo payload) já é
 * coberta pela cerca daquele arquivo e cai junto quando este campo sai do envio.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGENTE = "44444444-4444-4444-8444-444444444444";
const CREDENCIAL = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

const CREDENCIAIS = [
  { id: CREDENCIAL, provider: "anthropic", label: "chave da casa", is_active: true },
];

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

const VERSAO = {
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
  handoff_legal_enabled: true,
  cases_enabled: false,
  split_messages: false,
  split_max_chars: 600,
  followup: { enabled: false, flow_pointer_ids: [] },
  operator_enabled: false,
  operator_model: null,
  operator_tool_ids: [],
  pipeline_ids: [],
  knowledge_source_ids: [],
  trigger_config: null,
  published_at: "2026-01-01T00:00:00Z",
  superseded_at: null,
  created_at: "2026-01-01T00:00:00Z",
  created_by: null,
};

function abrirEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AgentForm
        mode="edit"
        agent={AGENTE_ROW as never}
        credentials={CREDENCIAIS as never}
        channelSessions={[{ id: CANAL, label: "WhatsApp da clínica", status: "WORKING" }] as never}
        draft={null}
        published={VERSAO as never}
        base={VERSAO as never}
        draftObsoleto={null}
      />
    </QueryClientProvider>,
  );
  const interruptor = (id: string) => {
    const el = document.querySelector(`#${id}`);
    if (!el) throw new Error(`interruptor #${id} não existe na tela`);
    return el as HTMLButtonElement;
  };
  return { interruptor };
}

async function salvarRascunho() {
  acoes.salvar.mockClear();
  acoes.salvar.mockResolvedValue({ ok: true, data: { version_id: "v2", version_number: 2 } });
  fireEvent.click(screen.getByRole("button", { name: /salvar rascunho/i }));
  await vi.waitFor(() => expect(acoes.salvar).toHaveBeenCalled());
  // saveAgentDraftAction(agentId, toVersionPayload, cadastro) — a CHAVE vai no 2º.
  return acoes.salvar.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
}

describe("o interruptor de assunto jurídico na tela", () => {
  it("existe embaixo do interruptor da ferramenta, LIGADO por padrão", () => {
    const { interruptor } = abrirEditor();
    const ferramenta = interruptor("handoff_tool_enabled");
    const juridico = interruptor("handoff_legal_enabled");
    expect(ferramenta).toBeChecked();
    expect(juridico).toBeChecked();
    // Embaixo: a ordem no DOM é a do cartão.
    expect(
      juridico.compareDocumentPosition(ferramenta) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    expect(juridico).toBeEnabled();
  });

  it("fica DESABILITADO quando o interruptor de cima está desligado", () => {
    const { interruptor } = abrirEditor();
    const ferramenta = interruptor("handoff_tool_enabled");
    const juridico = interruptor("handoff_legal_enabled");

    fireEvent.click(ferramenta);
    expect(ferramenta).not.toBeChecked();
    expect(juridico, "sem a ferramenta não há descrição para trocar").toBeDisabled();

    fireEvent.click(ferramenta);
    expect(ferramenta).toBeChecked();
    expect(juridico).toBeEnabled();
  });

  it("desliga e salva: o valor novo viaja no payload da versão", async () => {
    const { interruptor } = abrirEditor();
    fireEvent.click(interruptor("handoff_legal_enabled"));
    expect(interruptor("handoff_legal_enabled")).not.toBeChecked();
    const cadastro = await salvarRascunho();
    expect(cadastro, "o envio não levou a chave — a tela muda e o banco não").toHaveProperty(
      "handoff_legal_enabled",
      false,
    );
  });

  it("o texto diz o que acontece nos dois lados", () => {
    abrirEditor();
    expect(
      screen.getByText(/Passar para uma pessoa quando o cliente falar de assunto jurídico/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Desligue se assunto jurídico é o trabalho normal deste agente/i),
    ).toBeInTheDocument();
    // Os dois lados: quando passa (rótulo) e o que o desligado faz + a condição 4.
    expect(
      screen.getByText(/Quem pede para falar com uma pessoa continua sendo passado/i),
    ).toBeInTheDocument();
  });

  it("as duas strings têm tradução nos DOIS catálogos", () => {
    const rotulo = "Passar para uma pessoa quando o cliente falar de assunto jurídico (Procon, advogado, processo)";
    const ajuda =
      "Desligue se assunto jurídico é o trabalho normal deste agente. Quem pede para falar com uma pessoa continua sendo passado.";

    const dicionario = readFileSync(join(process.cwd(), "lib/i18n/dicionario.ts"), "utf8");
    for (const chave of [rotulo, ajuda]) {
      const linha = new RegExp(`"${chave.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*\\{\\s*es:\\s*"[^"]+"`, "s");
      expect(linha.test(dicionario), `sem espanhol no dicionário: ${chave}`).toBe(true);
    }

    const en = JSON.parse(
      readFileSync(join(process.cwd(), "lib/i18n/traducoes/en.json"), "utf8"),
    ) as Record<string, string>;
    expect(en[rotulo], "sem inglês em en.json").toBeTruthy();
    expect(en[ajuda], "sem inglês em en.json").toBeTruthy();
  });
});
