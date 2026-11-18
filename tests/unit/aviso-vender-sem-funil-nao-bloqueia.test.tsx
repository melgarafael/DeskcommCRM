/**
 * "VENDER E MOVER O FUNIL" SEM NENHUM FUNIL MARCADO — AVISO, NÃO BLOQUEIO
 * (issue #4118, critério 4, marcado pelo autor como decisão de produto).
 *
 * ─── Por que avisar, e por que NÃO bloquear ─────────────────────────────────
 *
 * A ferramenta "Mover oportunidade de etapa" sozinha não move nada: quem diz de
 * QUAIS funis o agente pode mexer é "Em que negócios ele pode mexer", na mesma
 * aba. Quem liga o pacote e não marca nenhum funil publica um agente que
 * conversa e não organiza — e só descobre ao iniciar uma campanha de Prospecção,
 * com uma recusa em OUTRA tela.
 *
 * Mas "nenhum funil" é uma configuração LEGÍTIMA (agente que só conversa). Por
 * isso o aviso não entra em `publishBlockReason` nem em `isValid`: ele informa e
 * some quando a primeira caixa é marcada. Este arquivo vigia as duas metades —
 * que o aviso apareça, e que ele não trave nada.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGENTE = "44444444-4444-4444-8444-444444444444";
const CREDENCIAL = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const FUNIL = "55555555-5555-4555-8555-555555555555";

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
const SESSOES = [{ id: CANAL, label: "WhatsApp da clínica", status: "WORKING" }];

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

/** A versão publicada: pacote "vender" ligado no operador, NENHUM funil marcado. */
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
    pipeline_ids: [],
    knowledge_source_ids: [],
    trigger_config: null,
    published_at: "2026-01-01T00:00:00Z",
    superseded_at: null,
    created_at: "2026-01-01T00:00:00Z",
    created_by: null,
    ...extra,
  };
}

const FUNIS = [{ id: FUNIL, name: "Clínicas", is_default: true }];

function abrirEditor(v: Record<string, unknown> = versao(), locale?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <IdiomaProvider locale={locale}>
      <QueryClientProvider client={qc}>
        <AgentForm
          mode="edit"
          agent={AGENTE_ROW as never}
          credentials={CREDENCIAIS as never}
          channelSessions={SESSOES as never}
          // Com rascunho vigente: sem ele o "Publicar" fica desabilitado por
          // "Sem rascunho para publicar", que não tem nada a ver com o aviso e
          // esconderia o que este arquivo quer medir.
          draft={versao({ id: "v2", version_number: 2, status: "draft" }) as never}
          published={v as never}
          base={v as never}
          draftObsoleto={null}
          funis={FUNIS as never}
        />
      </QueryClientProvider>
    </IdiomaProvider>,
  );
  // A aba onde os dois controles moram: a ferramenta ("O que ele pode mexer no
  // sistema") e o funil ("Em que negócios ele pode mexer").
  fireEvent.click(screen.getByTestId("papel-operacao"));
}

/** O estado do "Publicar": habilitado? e qual motivo a tela mostra? */
function situacaoDoPublicar() {
  const botao = screen.getByRole("button", { name: /^Publicar/ });
  const motivo = screen.queryByTestId("motivo-do-publicar");
  return { habilitado: !(botao as HTMLButtonElement).disabled, motivo: motivo?.textContent ?? null };
}

beforeEach(() => {
  vi.clearAllMocks();
  acoes.salvar.mockResolvedValue({ ok: true, data: { version_id: "v2", version_number: 2 } });
});
afterEach(cleanup);

describe("agente com 'Vender e mover o funil' e nenhum funil marcado", () => {
  it("avisa na aba 'Organiza o sistema' e nomeia o pacote", () => {
    abrirEditor();
    const aviso = screen.getByTestId("aviso-vender-sem-funil");
    expect(aviso).toBeVisible();
    expect(aviso).toHaveTextContent(/Vender e mover o funil/);
    expect(aviso).toHaveTextContent(/nenhum funil está marcado/);
    // A frase diz que NÃO é bloqueio — senão o aviso vira medo de publicar.
    expect(aviso).toHaveTextContent(/Não é bloqueio/);
  });

  it("NÃO bloqueia salvar: o rascunho vai ao servidor mesmo com o aviso na tela", async () => {
    abrirEditor();
    expect(screen.getByTestId("aviso-vender-sem-funil")).toBeVisible();

    const nome = document.querySelector("#name") as HTMLInputElement;
    fireEvent.change(nome, { target: { value: "Recepção nova" } });
    fireEvent.click(screen.getByRole("button", { name: /salvar rascunho/i }));

    await waitFor(() => expect(acoes.salvar).toHaveBeenCalled());
    expect(screen.getByTestId("aviso-vender-sem-funil")).toBeVisible();
  });

  it("NÃO bloqueia publicar: o estado do Publicar é o mesmo com e sem o aviso", () => {
    abrirEditor();
    expect(screen.getByTestId("aviso-vender-sem-funil")).toBeVisible();
    const comAviso = situacaoDoPublicar();
    cleanup();

    // A mesma versão com o pacote desligado — o aviso não aparece. Se o aviso
    // mexesse no Publicar, estes dois estados seriam diferentes.
    abrirEditor(versao({ operator_tool_ids: ["crm_get_lead"] }));
    expect(screen.queryByTestId("aviso-vender-sem-funil")).toBeNull();
    const semAviso = situacaoDoPublicar();

    expect(comAviso).toEqual(semAviso);
    // E o motivo que existir não pode ser o funil: essa é a correção do #4118,
    // não uma condição nova de publicação.
    expect(comAviso.motivo ?? "").not.toMatch(/funil/i);
  });

  it("some quando o primeiro funil é marcado", () => {
    abrirEditor();
    expect(screen.getByTestId("aviso-vender-sem-funil")).toBeVisible();

    fireEvent.click(screen.getByTestId(`funil-${FUNIL}`));

    expect(screen.queryByTestId("aviso-vender-sem-funil")).toBeNull();
  });

  it("não aparece quando o pacote não está ligado (agente que só conversa)", () => {
    abrirEditor(versao({ operator_tool_ids: ["crm_get_lead"] }));
    expect(screen.queryByTestId("aviso-vender-sem-funil")).toBeNull();
  });

  it("não aparece quando já há funil marcado", () => {
    abrirEditor(versao({ pipeline_ids: [FUNIL] }));
    expect(screen.queryByTestId("aviso-vender-sem-funil")).toBeNull();
  });

  it("em espanhol o aviso também é espanhol", () => {
    abrirEditor(versao(), "es");
    const aviso = screen.getByTestId("aviso-vender-sem-funil");
    expect(aviso).toHaveTextContent(/Vender y mover el embudo/);
    expect(aviso).toHaveTextContent(/No es un bloqueo/);
  });
});
