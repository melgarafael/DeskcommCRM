/**
 * #3813 — O FOLLOW-UP DO AGENTE ESCOLHE O QUE FAZER COM QUEM TEM HORÁRIO MARCADO.
 *
 * ─── O defeito que este arquivo existe para pegar ──────────────────────────
 *
 * O motor já sabia ler `followup.quando_ha_compromisso` na configuração
 * publicada (`lib/followup/janela-de-disparo.ts`), e a tela de automação já
 * tinha o seletor por AÇÃO. No editor do agente não havia ONDE escolher: o
 * `FollowupValue` só conhecia `enabled`, `flow_pointer_ids`,
 * `callback_enabled` e `send_window`. O dado era lido no disparo e não era
 * gravável em lugar nenhum do follow-up — quem publicava "enviar mesmo assim"
 * pela API não conseguia ver, nem corrigir, a escolha na tela, e todo fluxo
 * continuava adiando.
 *
 * ─── O que cada caso cobra ─────────────────────────────────────────────────
 *
 *  1. o seletor aparece com as TRÊS opções (e não duas, e não uma lista de
 *     valores internos);
 *  2. escolher "Não enviar" e salvar grava
 *     `followup.quando_ha_compromisso = "nao_enviar"` NO PAYLOAD da versão —
 *     é o caminho que a rota PATCH e a Server Action validam;
 *  3. voltar para "Adiar" grava `adiar` EXPLÍCITO: o PATCH da versão troca o
 *     `followup` inteiro, então omitir a chave ao voltar para o padrão
 *     deixaria o valor antigo vivo no banco (a armadilha que o teste 3 pega);
 *  4. agente salvo com `enviar` reabre com "Enviar mesmo assim" marcado
 *     (ida e volta);
 *  5. agente antigo, SEM a chave, reabre em "Adiar" — retrocompatibilidade,
 *     o mesmo padrão que `lerEscolhaNoEnvio` garante no disparo;
 *  6. com o follow-up desligado o seletor fica desabilitado: um campo ativo
 *     numa seção desligada gravaria preferência que o motor não lê;
 *  7. o schema da versão NÃO descarta a chave em silêncio (`versionPatchSchema`
 *     é `.strict()`) — a prova de persistência do lado do servidor, que é onde
 *     um zod esquecido faria a tela salvar e o banco perder o dado.
 *
 * O que NÃO se prova aqui: o efeito no disparo. Esse já está medido na main, em
 * `tests/unit/agenda-desfecho-do-pulo-no-worker-3813.test.ts` (fluxo em
 * `nao_enviar` + compromisso vivo pula com motivo) e em
 * `tests/unit/agenda-escolha-na-acao-3813.test.ts`. Duplicar aqui só criaria
 * duas réguas para o mesmo comportamento.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { salvar } = vi.hoisted(() => ({ salvar: vi.fn() }));

// A tela inteira busca duas listas (modelos do provedor e fluxos de follow-up)
// e o cartão de passagens busca a equipe. Nenhuma delas é o alvo: o dublê
// devolve lista vazia em vez de rede.
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async (url: string) => {
      if (url.includes("/models")) return { data: { models: [] } };
      return { data: [] };
    }),
    patch: vi.fn(),
    post: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// `t` devolve a chave: o texto lido aqui é o português que a tela mostra.
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/app/app/ai/agents/[id]/_actions", () => ({
  saveAgentDraftAction: salvar,
  publishAgentAction: vi.fn(),
  createMcpAgentAction: vi.fn(),
}));

import { AgentForm } from "@/app/app/ai/agents/[id]/_components/AgentForm";
import { versionPatchSchema } from "@/lib/ai/agents/validation";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

const AGENTE = {
  id: "11111111-1111-1111-1111-111111111111",
  organization_id: "22222222-2222-2222-2222-222222222222",
  name: "Agente do follow-up",
  description: null,
  model: "claude-sonnet-4",
  system_prompt: "Atenda com atenção.",
  is_active: true,
  is_default: false,
  config: {},
  guardrails: null,
  active_kb_version_id: null,
  kind: "mcp_agent",
  priority: 0,
  published_version_id: null,
} as unknown as AgentRow;

/** Uma versão válida o bastante para a tela abrir; o foco é o follow-up. */
function versao(followup: Record<string, unknown>): AgentVersionRow {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    organization_id: AGENTE.organization_id,
    agent_id: AGENTE.id,
    version_number: 1,
    system_prompt: "Atenda com atenção.",
    provider: "anthropic",
    model: "claude-sonnet-4",
    credential_id: null,
    tool_ids: [],
    trigger_config: {
      events: ["message"],
      filters: {
        ignore_groups: true,
        ignore_self: true,
        keyword_regex: null,
        business_hours: null,
      },
      concurrency: "one_per_conversation",
    },
    channel_session_id: null,
    max_steps: 5,
    token_budget: 2000,
    cost_budget_cents: 50,
    history_message_window: 20,
    history_token_window: 8000,
    handoff_keywords: [],
    handoff_tool_enabled: true,
    handoff_legal_enabled: true,
    proposal_ai_draft_enabled: true,
    cases_enabled: false,
    operator_enabled: false,
    operator_model: null,
    operator_tool_ids: [],
    pipeline_ids: [],
    knowledge_source_ids: [],
    split_messages: false,
    split_max_chars: 600,
    inbound_debounce_ms: null,
    max_sends_per_turn: null,
    handoff_target_user_id: null,
    followup: { enabled: true, flow_pointer_ids: [], callback_enabled: true, ...followup },
    voz_enabled: false,
    voz_quando: "espelhar",
    status: "draft",
    published_at: null,
    superseded_at: null,
    created_at: "2026-11-06T00:00:00.000Z",
    created_by: null,
  } as unknown as AgentVersionRow;
}

function montar(versaoDaTela: AgentVersionRow) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AgentForm
        mode="edit"
        agent={AGENTE}
        draft={versaoDaTela}
        published={null}
        base={versaoDaTela}
        credentials={[]}
        channelSessions={[]}
        // A chave vem do `.env` da instalação: sem esta prop a validação da tela
        // desabilita "Salvar rascunho" e o teste não exercitaria o caminho real.
        provedoresDaInstalacao={["anthropic"]}
      />
    </QueryClientProvider>,
  );
}

function radio(nome: RegExp): HTMLInputElement {
  return screen.getByRole("radio", { name: nome }) as HTMLInputElement;
}

beforeEach(() => {
  salvar.mockResolvedValue({ ok: true, data: { version_id: "v", version_number: 2 } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("o seletor da agenda no follow-up do agente (#3813)", () => {
  it("mostra as três opções e salva `nao_enviar` no payload da versão", async () => {
    const user = userEvent.setup();
    montar(versao({}));

    expect(screen.getByText("Quando o contato tiver horário marcado")).toBeTruthy();
    const opcoes = screen.getAllByRole("radio");
    // A contagem impressa é o que o log da prova mostra; a asserção é a régua.
    console.log(`[#3813] opções do seletor no follow-up: ${opcoes.length}`);
    expect(opcoes).toHaveLength(3);

    await user.click(radio(/^Não enviar/));
    await user.click(screen.getByRole("button", { name: "Salvar rascunho" }));

    await waitFor(() => expect(salvar).toHaveBeenCalledTimes(1));
    const payload = salvar.mock.calls[0][1] as {
      followup: Record<string, unknown>;
    };
    expect(payload.followup.quando_ha_compromisso).toBe("nao_enviar");
    // A escolha não pode apagar o resto do follow-up que estava na tela.
    expect(payload.followup.enabled).toBe(true);
  });

  it("voltar para «adiar» grava a chave explícita — o PATCH substitui o followup inteiro", async () => {
    const user = userEvent.setup();
    montar(versao({ quando_ha_compromisso: "enviar" }));

    // A tela abre com o valor do banco, não com o padrão.
    expect(radio(/^Enviar mesmo assim/).checked).toBe(true);

    await user.click(radio(/^Adiar e enviar depois do horário/));
    await user.click(screen.getByRole("button", { name: "Salvar rascunho" }));

    await waitFor(() => expect(salvar).toHaveBeenCalledTimes(1));
    const payload = salvar.mock.calls[0][1] as {
      followup: Record<string, unknown>;
    };
    // Omitir `adiar` aqui faria a rota PATCH preservar o `enviar` antigo: o
    // operador voltaria ao padrão na tela e o disparo continuaria enviando.
    expect(payload.followup.quando_ha_compromisso).toBe("adiar");
  });

  it("agente salvo com `enviar` reabre com «Enviar mesmo assim» marcado", () => {
    montar(versao({ quando_ha_compromisso: "enviar" }));
    expect(radio(/^Enviar mesmo assim/).checked).toBe(true);
    expect(radio(/^Adiar e enviar depois do horário/).checked).toBe(false);
    expect(radio(/^Não enviar/).checked).toBe(false);
  });

  it("versão antiga, sem a chave, reabre em «adiar» (retrocompatibilidade)", () => {
    montar(versao({}));
    expect(radio(/^Adiar e enviar depois do horário/).checked).toBe(true);
  });

  it("com o follow-up desligado o seletor fica desabilitado", () => {
    montar(versao({ enabled: false }));
    for (const opcao of screen.getAllByRole("radio")) {
      // `fieldset disabled` desabilita de VERDADE (`:disabled`), sem escrever
      // o atributo no input: por isso `toBeDisabled()`, que consulta a regra.
      expect(opcao).toBeDisabled();
    }
    expect(
      screen.getByText(
        "Ligue o follow-up para escolher o que fazer com quem tem horário marcado.",
      ),
    ).toBeTruthy();
  });
});

describe("a persistência não descarta a chave (#3813)", () => {
  it("`versionPatchSchema` preserva `followup.quando_ha_compromisso`", () => {
    const parsed = versionPatchSchema.safeParse({
      followup: {
        enabled: true,
        flow_pointer_ids: [],
        callback_enabled: true,
        quando_ha_compromisso: "nao_enviar",
      },
    });
    // Sem esta linha no schema, o `.strict()` recusaria o campo — e a tela
    // salvaria sem a escolha, em silêncio.
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.followup?.quando_ha_compromisso).toBe("nao_enviar");
    expect(parsed.data.followup?.enabled).toBe(true);
  });
});
