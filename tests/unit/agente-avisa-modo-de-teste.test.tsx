/**
 * A TELA DO AGENTE DIZ POR QUE A IA PUBLICADA NÃO RESPONDE (#3976).
 *
 * ─── O defeito, do jeito que a pessoa vive ──────────────────────────────────
 *
 * Ela configura o agente, escolhe o número, publica e manda mensagem do próprio
 * celular. Nada volta. Abre a tela do agente — a mesma onde acabou de publicar —
 * e ali está tudo certo: o número, o telefone, a conexão "Conectado". A causa
 * (o canal nasceu em modo de teste com a lista de números vazia) só aparecia no
 * cartão do canal, em Conexões, que é a tela que ninguém abre com esse sintoma.
 *
 * ─── Por que pela TELA, e não só pela regra ─────────────────────────────────
 *
 * A regra tem teste próprio (`tests/unit/aviso-do-modo-de-teste.test.ts`). Aqui
 * se cobra o que a pessoa VÊ — e os quatro lados opostos, porque aviso demais é
 * o defeito espelhado:
 *
 *  1. modo de teste, lista vazia → diz o estado, o motivo e ONDE resolver;
 *  2. canal aberto ao público   → nenhum aviso;
 *  3. modo de teste COM número  → nenhum aviso (não se manda cadastrar o que já
 *     está lá);
 *  4. sem permissão de editar   → o motivo, SEM link que termine em 403 (o
 *     painel de acesso exige administrador);
 *  5. estado não medido         → nenhum aviso: indefinido não acusa (#3975).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGENTE = "44444444-4444-4444-8444-444444444444";
const CANAL = "22222222-2222-4222-8222-222222222222";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => `/app/ai/agents/${AGENTE}`,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/app/app/ai/agents/[id]/_actions", () => ({
  saveAgentDraftAction: vi.fn(),
  publishAgentAction: vi.fn(),
  createMcpAgentAction: vi.fn(),
}));

import { AgentForm } from "@/app/app/ai/agents/[id]/_components/AgentForm";

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

/** O canal como `listSelectableChannels` o entrega: com o resumo do acesso da IA. */
function canal(acessoDaAi: Record<string, unknown> | null) {
  return {
    id: CANAL,
    display_name: "WhatsApp da clínica",
    status: "WORKING",
    phone_number: "+551133334444",
    aceitaMensagemLivre: true,
    acessoDaAi,
  };
}

function abrirEditor(opcoes: {
  canal?: ReturnType<typeof canal>;
  readOnly?: boolean;
} = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AgentForm
        mode="edit"
        agent={AGENTE_ROW as never}
        credentials={[] as never}
        provedoresDaInstalacao={["anthropic"]}
        channelSessions={[opcoes.canal ?? canal({ mode: "pre_go_live", testNumbersCount: 0 })] as never}
        draft={RASCUNHO as never}
        published={null}
        base={RASCUNHO as never}
        draftObsoleto={null}
        readOnly={opcoes.readOnly}
      />
    </QueryClientProvider>,
  );
}

describe("editor do agente — o canal em modo de teste", () => {
  it("com a lista de teste VAZIA, diz que a IA não responde ninguém e onde resolver", () => {
    abrirEditor();

    const aviso = screen.getByTestId("aviso-modo-de-teste");
    expect(aviso).toHaveTextContent(/modo de teste/i);
    expect(aviso).toHaveTextContent(/nenhum número autorizado neste canal/i);

    // O destino é o cartão do canal em Conexões, onde o painel de acesso mora
    // (`components/connections/ChannelAiAccess.tsx`), e não uma tela nova.
    const link = screen.getByRole("link", { name: /configurar acesso da ia/i });
    expect(link).toHaveAttribute("href", "/app/connections");
  });

  it("canal aberto ao público: nenhum aviso", () => {
    abrirEditor({ canal: canal({ mode: "open", testNumbersCount: 0 }) });
    expect(screen.queryByTestId("aviso-modo-de-teste")).toBeNull();
  });

  it("modo de teste COM número autorizado: nenhum aviso", () => {
    // "não mande cadastrar o que já está lá": com a lista preenchida, o cartão
    // do agente não tem o que ensinar.
    abrirEditor({ canal: canal({ mode: "pre_go_live", testNumbersCount: 2 }) });
    expect(screen.queryByTestId("aviso-modo-de-teste")).toBeNull();
  });

  it("sem permissão de editar, o motivo aparece sem link que dê 403", () => {
    abrirEditor({
      canal: canal({ mode: "pre_go_live", testNumbersCount: 0 }),
      readOnly: true,
    });

    const aviso = screen.getByTestId("aviso-modo-de-teste");
    expect(aviso).toHaveTextContent(/nenhum número autorizado neste canal/i);
    // O painel de acesso exige administrador (`GET /api/v1/channel-sessions/
    // [id]/ai-access` → 403 abaixo disso): quem não pode editar recebe o
    // caminho por escrito, não um link que quebra.
    expect(screen.queryByRole("link", { name: /configurar acesso da ia/i })).toBeNull();
    expect(aviso).toHaveTextContent(/peça a um administrador/i);
  });

  it("leitura do canal não medida: não acusa modo de teste", () => {
    abrirEditor({ canal: canal({ mode: null, testNumbersCount: null }) });
    expect(screen.queryByTestId("aviso-modo-de-teste")).toBeNull();
  });
});
