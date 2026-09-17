/**
 * O AGENTE SE CONFIGURA ANTES DE HAVER WHATSAPP — e publica com a chave do `.env`.
 *
 * ─── Os dois defeitos, medidos numa VPS de cliente ──────────────────────────
 *
 * Instalação de uma clínica, recém-instalada pelo kit: `channel_sessions` com
 * ZERO linhas (o aparelho seria pareado no dia seguinte), `ai_provider_credentials`
 * com ZERO linhas (a chave da Anthropic está no `.env`, como o instalador pede).
 * O dono escreveu 4.000 caracteres de prompt para a atendente do consultório e
 * não conseguiu guardar UM. Resultado no banco: `ai_agents` com o nome e o
 * prompt antigos, `ai_agent_versions` vazia.
 *
 * **1. Sem número, não salvava.** `channel_session_id` era exigido pela régua de
 * campo do formulário — a mesma que habilita "Salvar rascunho" —, e o seletor de
 * número abria vazio, porque não existe número nenhum numa instalação nova.
 * Escolher por onde o agente atende é requisito para ATENDER; rascunhar quem ele
 * é não depende de aparelho pareado. (Coluna anulável: migration 0239.)
 *
 * **2. Com a chave da instalação, não publicava.** A régua do botão "Publicar"
 * pedia uma LINHA em `ai_provider_credentials`, e "a chave desta instalação" não
 * é linha: é `credential_id: null`. O botão ficava desabilitado para sempre,
 * pedindo para escolher a chave que a pessoa tinha acabado de escolher — no caso
 * mais comum do produto, que é justamente quem cola a chave no `.env`.
 *
 * ─── Por que pela TELA, e não só pela função pura ───────────────────────────
 *
 * Porque os dois defeitos eram da tela: o servidor aceitava os dois casos. A
 * régua de publicação tem teste próprio em
 * `lib/ai/agents/bloqueio-de-publicacao.test.ts`; aqui se cobra o que a pessoa
 * VÊ — botão clicável, aviso que ensina, e o que sai no envio.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGENTE = "44444444-4444-4444-8444-444444444444";
const CANAL = "22222222-2222-4222-8222-222222222222";

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

/**
 * O rascunho de quem ainda não tem número: `channel_session_id` nulo e
 * `credential_id` nulo (= a chave da instalação). É o estado que o produto
 * produz numa instalação fresca, e o que esta suíte existe para exercitar.
 */
const RASCUNHO = {
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
  followup: { enabled: false, flow_pointer_ids: [] },
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

function abrirEditor(
  opcoes: { canais?: Array<Record<string, unknown>>; versao?: Record<string, unknown> } = {},
) {
  const versao = opcoes.versao ?? RASCUNHO;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <AgentForm
        mode="edit"
        agent={AGENTE_ROW as never}
        // Instalação fresca: NENHUMA credencial cadastrada na tela de IA, e a
        // chave da Anthropic vindo do ambiente.
        credentials={[] as never}
        provedoresDaInstalacao={["anthropic"]}
        channelSessions={(opcoes.canais ?? []) as never}
        draft={versao as never}
        published={null}
        base={versao as never}
        draftObsoleto={null}
      />
    </QueryClientProvider>,
  );
  const botaoSalvar = () => screen.getByRole("button", { name: /salvar rascunho/i });
  const botaoPublicar = () => screen.getByRole("button", { name: /publicar/i });
  return { botaoSalvar, botaoPublicar, container };
}

describe("editor do agente sem número conectado", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acoes.salvar.mockResolvedValue({ ok: true, data: { version_id: "v1", version_number: 1 } });
  });

  it("deixa SALVAR o rascunho mesmo sem nenhum número conectado", async () => {
    const { botaoSalvar } = abrirEditor();
    // A pessoa mexe no prompt — é o que ela veio fazer. O campo é localizado
    // pelo conteúdo porque a Textarea do prompt não tem `id` (ver o comentário
    // do `maxLength` em AgentForm.tsx).
    fireEvent.change(screen.getByDisplayValue(RASCUNHO.system_prompt), {
      target: { value: "Você é a Sofia. Nunca fale de preço; convide para a avaliação." },
    });

    expect(
      botaoSalvar(),
      "o botão de salvar está desabilitado sem número: o dono escreve o prompt inteiro e não consegue guardar nada",
    ).toBeEnabled();

    fireEvent.click(botaoSalvar());
    await waitFor(() => expect(acoes.salvar).toHaveBeenCalled());

    const enviado = acoes.salvar.mock.calls[0]?.[1] as Record<string, unknown>;
    // "" na tela é `null` no contrato da versão — e `null` é o que o Zod aceita
    // desde a 0239. String vazia seria recusada e o salvamento voltaria como
    // "Validação falhou.".
    expect(enviado).toHaveProperty("channel_session_id", null);
    expect(versionCreateSchema.safeParse(enviado).success, "o servidor recusaria este envio").toBe(
      true,
    );
  });

  it("explica o que falta sem acusar erro, e aponta onde conectar", () => {
    abrirEditor();
    expect(screen.getByText(/nenhum número conectado ainda/i)).toBeInTheDocument();
    const atalho = screen.getByRole("link", { name: /conectar whatsapp/i });
    expect(atalho).toHaveAttribute("href", "/app/connections");
  });

  it("NÃO deixa publicar sem número, e a dica diz que o rascunho está salvo", () => {
    const { botaoPublicar } = abrirEditor();
    expect(botaoPublicar()).toBeDisabled();
    const dica = botaoPublicar().closest("span")?.getAttribute("title") ?? "";
    expect(dica).toMatch(/número de WhatsApp/i);
    expect(dica, "a dica não diz que o trabalho está guardado").toMatch(/rascunho está salvo/i);
  });

  // ─── O defeito 2 ─────────────────────────────────────────────────────────
  it("PUBLICA com a chave da instalação, sem nenhuma credencial cadastrada", () => {
    const { botaoPublicar } = abrirEditor({
      canais: [{ id: CANAL, display_name: "WhatsApp da clínica", status: "WORKING" }],
      versao: { ...RASCUNHO, channel_session_id: CANAL },
    });
    const dica = botaoPublicar().closest("span")?.getAttribute("title") ?? "";
    expect(
      botaoPublicar(),
      `o botão de publicar está travado para quem usa a chave do .env — dica: "${dica}"`,
    ).toBeEnabled();
    expect(dica).toBe("");
  });

  it("continua barrando número que existe mas não está conectado", () => {
    const { botaoPublicar } = abrirEditor({
      canais: [{ id: CANAL, display_name: "WhatsApp da clínica", status: "SCAN_QR_CODE" }],
      versao: { ...RASCUNHO, channel_session_id: CANAL },
    });
    expect(botaoPublicar()).toBeDisabled();
    expect(botaoPublicar().closest("span")?.getAttribute("title") ?? "").toMatch(/SCAN_QR_CODE/);
  });
});

describe("versionCreateSchema — o número é opcional, o resto não", () => {
  const base = {
    system_prompt: RASCUNHO.system_prompt,
    provider: "anthropic",
    model: "claude-sonnet-5",
    credential_id: null,
  };

  it("aceita channel_session_id nulo", () => {
    expect(versionCreateSchema.safeParse({ ...base, channel_session_id: null }).success).toBe(true);
  });

  it("continua aceitando um uuid", () => {
    expect(versionCreateSchema.safeParse({ ...base, channel_session_id: CANAL }).success).toBe(
      true,
    );
  });

  it("recusa string vazia — nulo é a única forma de 'ainda não escolhi'", () => {
    expect(versionCreateSchema.safeParse({ ...base, channel_session_id: "" }).success).toBe(false);
  });

  it("recusa a ausência do campo — omitir não é decidir", () => {
    expect(versionCreateSchema.safeParse(base).success).toBe(false);
  });
});
