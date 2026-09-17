/**
 * O MOTIVO DO "PUBLICAR" DESABILITADO TEM DE ESTAR NA TELA.
 *
 * ─── O que o relato dizia ───────────────────────────────────────────────────
 *
 * No editor do agente, quando "Publicar" está desabilitado, o motivo existia só
 * no `title` do span que envolve o botão: aparecia com o ponteiro parado em
 * cima. Em tela de toque não existe hover — o motivo simplesmente não aparecia
 * —, e um botão desabilitado nem entra na ordem do Tab, então quem navega de
 * teclado também ficava sem saber o que falta para o agente entrar no ar.
 *
 * ─── Por que este teste fica vermelho sozinho ───────────────────────────────
 *
 * `getByText` casa TEXTO renderizado; atributo não conta. Se o motivo voltar a
 * morar só no `title`, estas asserções não acham nada e o teste cai — sem
 * depender de alguém lembrar de conferir a tela.
 *
 * A segunda asserção de cada caso é a mais dura: o texto NA TELA tem de ser o
 * MESMO que o componente calculou para o `title`. Assim o teste não fixa uma
 * redação por motivo (o dia em que a frase melhorar, ele continua valendo) e
 * ainda reprova uma tela que invente um motivo genérico e deixe o verdadeiro
 * escondido no hover.
 *
 * A régua de QUAL motivo bloqueia é de `lib/ai/agents/bloqueio-de-publicacao.ts`
 * (com teste puro próprio); aqui só se prova que a frase CHEGA à tela e que o
 * botão aponta para ela.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app/ai/agents/a1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { AgentForm } from "@/app/app/ai/agents/[id]/_components/AgentForm";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const PROMPT = "# QUEM VOCÊ É\n\nVocê é a Vitória, da recepção da Clínica Vitalis.";

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
  system_prompt: PROMPT,
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

function versao(n: number, status: string) {
  return {
    id: `v${n}`,
    organization_id: "org-1",
    agent_id: "a1",
    version_number: n,
    status,
    system_prompt: PROMPT,
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

/**
 * O estado do relato: agente com versão publicada e NENHUM rascunho — o botão
 * fica desabilitado com "Sem rascunho para publicar.".
 */
function renderizarEditorComPublicacaoBloqueada(locale?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const editor = (
    <QueryClientProvider client={qc}>
      <AgentForm
        mode="edit"
        agent={AGENTE as never}
        credentials={CREDENCIAIS as never}
        channelSessions={SESSOES as never}
        draft={null}
        published={versao(7, "published") as never}
        base={versao(7, "published") as never}
        draftObsoleto={null}
      />
    </QueryClientProvider>
  );
  render(locale ? <IdiomaProvider locale={locale}>{editor}</IdiomaProvider> : editor);

  const botao = screen.getByRole("button", { name: /^Publicar/ });
  expect(botao, "o caso do relato exige o botão Publicar desabilitado").toBeDisabled();
  return botao;
}

/** O motivo que o componente calculou — a fonte que ANTES só existia no hover. */
function motivoDoTitulo(botao: HTMLElement): string {
  const comTitulo = botao.closest("span[title]");
  const titulo = comTitulo?.getAttribute("title") ?? "";
  expect(titulo, "o editor parou de calcular o motivo do bloqueio").not.toBe("");
  return titulo;
}

describe("o motivo do Publicar bloqueado fica na tela", () => {
  it("em português, o motivo é TEXTO da tela — não só o title do hover", () => {
    const botao = renderizarEditorComPublicacaoBloqueada();
    const motivo = motivoDoTitulo(botao);

    // `getByText` só enxerga nós de texto: com o motivo de volta no `title`,
    // esta linha lança "Unable to find an element with the text" — é o vermelho
    // que o relato pede.
    const naTela = screen.getByText(motivo);
    expect(naTela).toBeVisible();
    expect(motivo).toBe("Sem rascunho para publicar.");
  });

  it("o botão aponta para o motivo, para quem chega de teclado ou leitor de tela", () => {
    const botao = renderizarEditorComPublicacaoBloqueada();
    const alvo = botao.getAttribute("aria-describedby");
    expect(alvo, "botão desabilitado sem nada que o descreva").toBeTruthy();
    const descrito = document.getElementById(alvo!);
    expect(descrito, "o aria-describedby aponta para um id que não existe").not.toBeNull();
    expect(descrito!.textContent).toBe(motivoDoTitulo(botao));
  });

  it("em espanhol, o mesmo motivo sai traduzido na tela", () => {
    const botao = renderizarEditorComPublicacaoBloqueada("es");
    expect(motivoDoTitulo(botao)).toBe("No hay borrador para publicar.");
    expect(screen.getByText("No hay borrador para publicar.")).toBeVisible();
  });
});
