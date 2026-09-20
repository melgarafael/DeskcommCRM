/**
 * A FIAÇÃO: o editor tem de ABRIR a versão que a regra escolheu.
 *
 * O teste puro (`versoes-da-tela-do-agente`) guarda a REGRA. Este guarda o call
 * site — e a diferença é exatamente o defeito relatado: a regra podia estar
 * certa e a tela continuar lendo `draft ?? published`, abrindo um rascunho de
 * 21 tokens por cima da versão publicada de 16.714 caracteres.
 *
 * Ninguém percebia porque o agente atendia normalmente no WhatsApp: quem
 * responde é a versão publicada, e só a TELA mentia.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app/ai/agents/a1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { AgentForm } from "@/app/app/ai/agents/[id]/_components/AgentForm";

const PROMPT_BOM = "# QUEM VOCÊ É\n\nVocê é a Vitória, da recepção da Clínica Vitalis.";
const PROMPT_PADRAO = "Você é um atendente. Responda de forma educada e clara, em pt-BR.";

const CREDENCIAIS = [
  { id: "11111111-1111-4111-8111-111111111111", provider: "anthropic", label: "chave", is_active: true },
];
const SESSOES = [{ id: "22222222-2222-4222-8222-222222222222", label: "WhatsApp", status: "WORKING" }];

const AGENTE = {
  id: "a1",
  organization_id: "org-1",
  name: "Vitoria",
  description: null,
  model: "claude-sonnet-5",
  system_prompt: PROMPT_BOM,
  is_active: false,
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

function versao(n: number, status: string, prompt: string) {
  return {
    id: `v${n}`,
    organization_id: "org-1",
    agent_id: "a1",
    version_number: n,
    status,
    system_prompt: prompt,
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
    cases_enabled: true,
    split_messages: true,
    split_max_chars: 600,
    followup: { enabled: false, flow_pointer_ids: [] },
    operator_enabled: false,
    operator_model: null,
    operator_tool_ids: [],
    pipeline_ids: [],
    trigger_config: null,
    published_at: null,
    superseded_at: null,
    created_at: "2026-01-01T00:00:00Z",
    created_by: null,
  };
}

type Versao = ReturnType<typeof versao>;

function textoDoPrompt(props: {
  draft: Versao | null;
  published: Versao | null;
  base: Versao | null;
  draftObsoleto: Versao | null;
}): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AgentForm
        mode="edit"
        agent={AGENTE as never}
        credentials={CREDENCIAIS as never}
        channelSessions={SESSOES as never}
        draft={props.draft as never}
        published={props.published as never}
        base={props.base as never}
        draftObsoleto={props.draftObsoleto as never}
      />
    </QueryClientProvider>,
  );
  const campo = screen
    .getAllByRole("textbox")
    .find((el) => el.tagName === "TEXTAREA" && el.className.includes("font-mono"));
  if (!campo) throw new Error("não achei o campo de instruções");
  return (campo as HTMLTextAreaElement).value;
}

describe("o editor abre a versão que a regra escolheu", () => {
  it("com rascunho OBSOLETO e publicada boa, abre a publicada", () => {
    // O caso do relato, com os papéis já resolvidos pela regra: `draft` chega
    // null (foi superado) e `base` aponta para a publicada.
    const texto = textoDoPrompt({
      draft: null,
      published: versao(7, "published", PROMPT_BOM),
      base: versao(7, "published", PROMPT_BOM),
      draftObsoleto: versao(6, "draft", PROMPT_PADRAO),
    });
    expect(texto, "a tela abriu o rascunho velho por cima da publicada").toContain("Vitória");
    expect(texto).not.toBe(PROMPT_PADRAO);
  });

  it("agente PAUSADO abre a última versão, não o texto padrão", () => {
    // Sem rascunho e sem publicada — o estado de todo agente pausado. É aqui que
    // o prompt "sumia" e um salvamento gravava o padrão por cima do trabalho.
    const texto = textoDoPrompt({
      draft: null,
      published: null,
      base: versao(5, "superseded", PROMPT_BOM),
      draftObsoleto: null,
    });
    expect(texto, "o prompt sumiu num agente pausado").toContain("Vitória");
  });

  it("com rascunho vigente, abre o rascunho", () => {
    const texto = textoDoPrompt({
      draft: versao(8, "draft", "rascunho novo em andamento"),
      published: versao(7, "published", PROMPT_BOM),
      base: versao(8, "draft", "rascunho novo em andamento"),
      draftObsoleto: null,
    });
    expect(texto).toBe("rascunho novo em andamento");
  });
});


it("recolher comportamento não perde escolhas nem o tamanho da resposta", () => {
  const version = versao(9, "draft", PROMPT_BOM);
  textoDoPrompt({ draft: version, published: null, base: version, draftObsoleto: null });
  const summary = screen.getByText(/Comportamento e repasses/);
  const details = summary.closest("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  const input = screen.getByLabelText("Tamanho máximo por bolha (80–4000)");
  fireEvent.change(input, { target: { value: "880" } });
  fireEvent.click(summary);
  expect(details.open).toBe(false);
  fireEvent.click(summary);
  expect(input).toHaveValue(880);
  expect(screen.getByRole("switch", { name: "Deixar o agente pedir uma tarefa a alguém e seguir conversando" })).toHaveAttribute("data-state", "checked");
});
