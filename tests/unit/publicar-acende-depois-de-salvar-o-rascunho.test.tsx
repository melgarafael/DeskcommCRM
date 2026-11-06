/**
 * DEPOIS DE "SALVAR RASCUNHO", O BOTÃO PUBLICAR ACENDE — SEM RECARREGAR.
 *
 * ─── O que o relato dizia (issue #3951) ─────────────────────────────────────
 *
 * Em IA › Agentes › Editar, quem editava qualquer campo, clicava em **Salvar
 * rascunho** e ia publicar encontrava a tela dizendo "Salve o rascunho antes de
 * publicar": Publicar apagado, Salvar ainda aceso — e só recarregando a página o
 * estado voltava ao normal. Quem não sabe recarregar não publica o agente, no
 * primeiro passo do produto.
 *
 * ─── Os dois estados que a tela lia, e por que nenhum sobrevivia ────────────
 *
 * 1. **"Existe rascunho para publicar?"** era `!!props.draft` — uma prop do
 *    server component. Ela só muda quando a página é buscada de novo, então o
 *    primeiro salvamento de um agente publicava uma versão que a tela ainda não
 *    conhecia, e Publicar ficava apagado com "Sem rascunho para publicar" até o
 *    refresh chegar.
 * 2. **"Há alteração pendente?"** comparava o formulário com a MESMA prop. Pior:
 *    a comparação era feita sobre os payloads crus, e o servidor NORMALIZA o que
 *    grava (`versionShapeSchema` faz `.trim()` no prompt, e o `trigger_config`
 *    ganha `include_tags`/`exclude_tags`/`include_pipeline_ids`/
 *    `exclude_pipeline_ids` como `[]` por `.default()`). O formulário nunca tem
 *    essas chaves — quem abre um agente cujo rascunho nasceu antes delas, ou que
 *    ainda não tem rascunho nenhum, compara `{filters: {...}}` com
 *    `{filters: {..., include_tags: []}}` e conclui "há alteração pendente" para
 *    sempre. Recarregar "consertava" porque o formulário passava a ser hidratado
 *    do que estava gravado — os dois lados ficavam iguais por construção. Não
 *    era o estado que se perdia: era a conta que nunca fechava.
 *
 * ─── O que cada bloco cobra ─────────────────────────────────────────────────
 *
 * 1. O caminho do relato: salvar acende Publicar e apaga Salvar, sem props
 *    novas (é o que acontece na tela antes de qualquer refresh).
 * 2. Editar de novo apaga Publicar e acende Salvar — a régua é "tem alteração
 *    pendente", não "salvou uma vez".
 * 3. Falha no salvamento NÃO acende Publicar e NÃO limpa a marca de alteração.
 *    Mentir que salvou é o pior desfecho possível aqui.
 * 4. Recarregar com rascunho salvo já nasce com Publicar aceso.
 * 5. O rascunho que o servidor GRAVOU (com os defaults do schema) não conta
 *    como alteração pendente quando as props do refresh chegam — sem isto a
 *    correção faria o botão acender e apagar sozinho, que é o defeito com outra
 *    cara.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const ORG = "33333333-3333-4333-8333-333333333333";
const AGENTE = "44444444-4444-4444-8444-444444444444";
const CREDENCIAL = "11111111-1111-4111-8111-111111111111";
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
import { versionPatchSchema } from "@/lib/ai/agents/validation";

// `validated_at` porque a régua de publicação exige chave já validada: sem ele
// o único bloqueio medido aqui seria a credencial, e não o estado do rascunho.
const CREDENCIAIS = [
  {
    id: CREDENCIAL,
    provider: "anthropic",
    label: "chave da casa",
    is_active: true,
    validation_error: null,
    validated_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
  },
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

const PROMPT = "Você é a recepção da clínica. Atenda com educação.";

/**
 * A versão PUBLICADA (v1), com `trigger_config: null` — o estado de uma
 * instalação que criou o agente e nunca abriu o editor de gatilho, que é o do
 * relato ("instalação fresca, criar um agente, editar qualquer campo").
 */
const VERSAO_1 = {
  id: "v1",
  organization_id: ORG,
  agent_id: AGENTE,
  version_number: 1,
  status: "published",
  system_prompt: PROMPT,
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
  proposal_ai_draft_enabled: true,
  cases_enabled: false,
  split_messages: false,
  split_max_chars: 600,
  followup: { enabled: false, flow_pointer_ids: [], send_window: null, callback_enabled: true },
  voz_enabled: false,
  voz_quando: "espelhar",
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
  inbound_debounce_ms: null,
  reply_min_interval_ms: null,
};

interface Cena {
  agent?: unknown;
  draft?: unknown;
  base?: unknown;
  published?: unknown;
}

function arvore(cena: Cena) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <AgentForm
        mode="edit"
        agent={(cena.agent ?? AGENTE_ROW) as never}
        credentials={CREDENCIAIS as never}
        channelSessions={SESSOES as never}
        draft={(cena.draft ?? null) as never}
        published={(cena.published ?? VERSAO_1) as never}
        base={(cena.base ?? VERSAO_1) as never}
        draftObsoleto={null}
      />
    </QueryClientProvider>
  );
}

function abrir(cena: Cena = {}) {
  const { container, rerender } = render(arvore(cena));
  return {
    container,
    rerender: (nova: Cena) => rerender(arvore(nova)),
    // O prompt é o único textarea em fonte monoespaçada (`font-mono`); o campo
    // de descrição também é textarea, e casar por valor quebraria no segundo uso.
    prompt: () => container.querySelector<HTMLTextAreaElement>("textarea.font-mono")!,
    publicar: () => screen.getByRole("button", { name: /^Publicar/ }),
    salvar: () => screen.getByRole("button", { name: /salvar rascunho|salvando/i }),
    motivo: () => container.querySelector('[data-testid="motivo-do-publicar"]')?.textContent ?? null,
  };
}

/**
 * O que o SERVIDOR guarda quando aceita o payload que a tela mandou: o
 * `versionPatchSchema` da action (mesma régua de `saveAgentDraftAction`), com
 * trim e defaults — é a linha que a página devolve no refresh.
 */
function versaoGravada(versionNumber = 2) {
  const enviado = acoes.salvar.mock.calls.at(-1)![1] as Record<string, unknown>;
  const gravado = versionPatchSchema.parse(enviado);
  return {
    ...VERSAO_1,
    ...gravado,
    id: `v${versionNumber}`,
    version_number: versionNumber,
    status: "draft",
    published_at: null,
  };
}

async function salvarRascunho(c: ReturnType<typeof abrir>) {
  fireEvent.click(c.salvar());
  await waitFor(() => expect(acoes.salvar).toHaveBeenCalledTimes(1));
  // A promessa do `saving` termina junto com o `finally` da action.
  await waitFor(() => expect(acoes.salvar.mock.results.at(-1)?.value).toBeDefined());
}

describe("o estado de salvamento do editor de agente (#3951)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acoes.salvar.mockResolvedValue({ ok: true, data: { version_id: "v2", version_number: 2 } });
  });

  it("salvar o rascunho acende Publicar e apaga Salvar, sem recarregar", async () => {
    const c = abrir();
    expect(c.publicar(), "o caso do relato começa com Publicar apagado").toBeDisabled();

    fireEvent.change(c.prompt(), { target: { value: `${PROMPT} Seja breve.` } });
    await salvarRascunho(c);

    // Nada de props novas: é a mesma árvore que a pessoa tem na frente.
    await waitFor(() => expect(c.publicar()).toBeEnabled());
    expect(c.publicar()).toHaveTextContent("Publicar v2");
    expect(c.salvar()).toBeDisabled();
    expect(c.motivo(), "a tela continua mandando salvar o rascunho").toBeNull();
  });

  it("editar de novo apaga Publicar e acende Salvar (a régua é alteração pendente)", async () => {
    const c = abrir();
    fireEvent.change(c.prompt(), { target: { value: `${PROMPT} Seja breve.` } });
    await salvarRascunho(c);
    await waitFor(() => expect(c.publicar()).toBeEnabled());

    fireEvent.change(c.prompt(), { target: { value: `${PROMPT} Seja breve e formal.` } });

    expect(c.publicar()).toBeDisabled();
    expect(c.salvar()).toBeEnabled();
    expect(c.motivo()).toBe("Salve o rascunho antes de publicar.");
  });

  it("falha no salvamento não acende Publicar nem limpa a marca de alteração", async () => {
    acoes.salvar.mockResolvedValue({ ok: false, error: "internal_error" });
    const c = abrir();
    fireEvent.change(c.prompt(), { target: { value: `${PROMPT} Seja breve.` } });
    await salvarRascunho(c);

    await waitFor(() => expect(acoes.salvar.mock.results.at(-1)?.value).toBeDefined());
    expect(c.publicar(), "a tela mentiu que salvou").toBeDisabled();
    expect(c.salvar(), "a alteração continua pendente e precisa poder ser reenviada").toBeEnabled();
    expect(c.motivo()).not.toBeNull();
  });

  it("recarregar a página com rascunho salvo já nasce com Publicar aceso", () => {
    const gravada = {
      ...VERSAO_1,
      id: "v2",
      version_number: 2,
      status: "draft",
      system_prompt: `${PROMPT} Seja breve.`,
      published_at: null,
    };
    const c = abrir({ draft: gravada, base: gravada });
    expect(c.publicar()).toBeEnabled();
    expect(c.publicar()).toHaveTextContent("Publicar v2");
    expect(c.salvar()).toBeDisabled();
    expect(c.motivo()).toBeNull();
  });

  it("o rascunho GRAVADO (com os defaults do schema) não conta como alteração pendente", async () => {
    // Este é o defeito de fundo: `versionPatchSchema` completa o `trigger_config`
    // com quatro listas vazias e faz `.trim()` no prompt. Comparar o payload cru
    // do formulário com a linha gravada acusa alteração para sempre — é o que
    // fazia o botão acender e apagar quando o refresh chegava.
    const c = abrir();
    fireEvent.change(c.prompt(), { target: { value: `${PROMPT} Seja breve.` } });
    await salvarRascunho(c);
    await waitFor(() => expect(c.publicar()).toBeEnabled());

    const gravada = versaoGravada(2);
    c.rerender({ draft: gravada, base: gravada, agent: { ...AGENTE_ROW, name: "Recepção" } });

    expect(c.publicar(), "o refresh chegou e apagou o botão que já estava aceso").toBeEnabled();
    expect(c.salvar()).toBeDisabled();

    // E a próxima edição continua acendendo Salvar em cima do estado novo.
    fireEvent.change(c.prompt(), { target: { value: `${PROMPT} Seja breve e formal.` } });
    expect(c.salvar()).toBeEnabled();
    expect(c.publicar()).toBeDisabled();
  });

  it("editar só a descrição e só o intervalo de rajada também libera Publicar", async () => {
    const c = abrir();
    const descricao = c.container.querySelector<HTMLTextAreaElement>("#description")!;
    fireEvent.change(descricao, { target: { value: "primeiro contato da clínica" } });
    await salvarRascunho(c);
    await waitFor(() => expect(c.publicar()).toBeEnabled());

    const rajada = c.container.querySelector<HTMLInputElement>("#inbound_debounce_ms")!;
    fireEvent.change(rajada, { target: { value: "2" } });
    expect(c.publicar()).toBeDisabled();
    expect(c.salvar()).toBeEnabled();
  });
  it("depois de publicar, Publicar apaga e não oferece de novo a versão já publicada", async () => {
    acoes.publicar.mockResolvedValue({ ok: true, data: { version_id: "v2", previous_version_id: "v1" } });
    const c = abrir();
    fireEvent.change(c.prompt(), { target: { value: `${PROMPT} Seja breve.` } });
    await salvarRascunho(c);
    await waitFor(() => expect(c.publicar()).toBeEnabled());
    const gravada = versaoGravada(2);
    c.rerender({ draft: gravada, base: gravada });
    // o refresh depois do publish: v2 vira a publicada e não há mais rascunho
    const publicada = { ...gravada, status: "published", published_at: "2026-01-02T00:00:00Z" };
    c.rerender({ draft: null, base: publicada, published: publicada, agent: { ...AGENTE_ROW, published_version_id: "v2" } });
    expect(c.publicar().textContent).toBe("Publicar");
    expect(c.publicar()).toBeDisabled();
  });
});
