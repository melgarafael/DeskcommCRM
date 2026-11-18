/**
 * O "DESPAUSAR" DO MENU DA LISTA NÃO PODE DEPENDER DO `kind` (issue #1141).
 *
 * ─── O que o relato dizia ───────────────────────────────────────────────────
 *
 * Em `AgentRowMenu`, o item "Despausar" nascia com
 * `disabled={isArchived || agent.kind === "mcp_agent"}` enquanto o "Pausar" logo
 * abaixo só tinha `disabled={isArchived}`. A assimetria deixa o dono pausar um
 * `mcp_agent` e ficar SEM saída pela lista: o item fica desabilitado sem aviso,
 * sem tooltip e sem explicação. E `mcp_agent` é o kind padrão dos agentes-molde
 * (`createDefaultAgent.ts` grava `kind: "mcp_agent"`) — é o caminho comum.
 *
 * ─── Por que a trava é o defeito, e não intenção de produto ─────────────────
 *
 *   1. `unpauseAgentAction` (`app/app/ai/agents/_actions.ts`) SELECIONA `kind` e
 *      nunca decide por ele: recusa só `archived_at` (`state_conflict`) e agente
 *      sem versão publicada (`publish_required`, com mensagem própria). Para um
 *      `mcp_agent` com versão publicada a ação despausa — a lista é que não
 *      deixava chegar nela.
 *   2. A página de detalhe ("Retomar automático", `AgentOperation.tsx`) não olha
 *      `kind` em momento nenhum; desabilita por `readOnly || busy ||
 *      !published_version_id`. Menu e detalhe ofereciam coisas diferentes para o
 *      MESMO agente.
 *   3. `estadoDoAgente` (`lib/ai/agents/no-ar.ts`) — a régua de status que o
 *      próprio menu usa — não lê `kind`: com versão publicada é "no_ar", com
 *      `paused_at` é "parado". Nada no domínio sustenta a condição.
 *   4. A trava entrou junto com a PRIMEIRA versão da lista (commit `3eb57cf45`,
 *      "UI Lista agentes + Credentials [wave 10]"), e a evidência mais direta
 *      está no repositório: `AgentStatusBadge.test.ts` descreve exatamente este
 *      estado como sintoma do defeito — "não oferecia saída: 'Despausar' fica
 *      disabled para mcp_agent".
 *
 * ─── Por que este teste fica vermelho sozinho ───────────────────────────────
 *
 * O caso ⭐ clica no item e cobra o EFEITO (`unpauseAgentAction` chamado com o id
 * do agente). Com a trava de kind, o Radix não dispara `onSelect` de item
 * bloqueado e a ação nunca é chamada: o caso cai sem depender de alguém conferir
 * um atributo. Os dois CONTROLES — um `rag_bot` pausado (mesmo estado, kind
 * legado) e o item bloqueado do agente ARQUIVADO — provam que o teste consegue
 * ver o item habilitado e que ele sabe reconhecer um item bloqueado; sem eles,
 * "clicou e chamou" poderia passar por acidente e "está desabilitado" poderia
 * estar medindo o nada.
 *
 * `isArchived` fica: `estadoDoAgente` faz `arquivado` vencer `paused_at`, então
 * um agente arquivado nunca alcança o ramo do "Despausar" — a condição segue no
 * código como defesa, e o menu do arquivado (que mostra "Pausar") continua
 * bloqueado, é o que o caso CONTROLE mede.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const pausar = vi.hoisted(() => vi.fn());
const despausar = vi.hoisted(() => vi.fn());
const arquivar = vi.hoisted(() => vi.fn());
const renomear = vi.hoisted(() => vi.fn());
const duplicar = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/app/ai/agents",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));
vi.mock("@/app/app/ai/agents/_actions", () => ({
  pauseAgentAction: pausar,
  unpauseAgentAction: despausar,
  archiveAgentAction: arquivar,
  renameAgentAction: renomear,
  duplicateAgentAction: duplicar,
}));

import { toast } from "sonner";

import { AgentRowMenu } from "@/app/app/ai/agents/_components/AgentRowMenu";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { AgentRow } from "@/hooks/ai/useAgent";

const ID = "11111111-1111-4111-8111-111111111111";

const AGENTE = {
  id: ID,
  organization_id: "org-1",
  name: "Atendimento",
  description: null,
  model: "anthropic/claude-sonnet-4-6",
  system_prompt: "oi",
  is_active: true,
  is_default: true,
  kind: "mcp_agent",
  priority: 0,
  published_version_id: "v7",
  paused_at: null,
  archived_at: null,
  config: {},
  guardrails: {},
  active_kb_version_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as unknown as AgentRow;

/**
 * Item bloqueado aos olhos do Radix: `data-disabled` + `aria-disabled="true"`.
 * Booleano explícito (e não `toBeDisabled`) porque o item é um `div[role=menuitem]`
 * — a regra que importa é a que o PRÓPRIO Radix lê antes de disparar `onSelect`.
 */
function estaBloqueado(item: HTMLElement): boolean {
  return item.hasAttribute("data-disabled") || item.getAttribute("aria-disabled") === "true";
}

async function abrirMenu(over: Partial<AgentRow>) {
  const user = userEvent.setup();
  render(
    // O menu recarrega a lista de agentes pelo React Query depois da ação.
    <QueryClientProvider client={new QueryClient()}>
      <IdiomaProvider locale="pt-BR">
        <AgentRowMenu agent={{ ...AGENTE, ...over } as AgentRow} />
      </IdiomaProvider>
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Menu de ações" }));
  return user;
}

beforeEach(() => {
  pausar.mockReset();
  despausar.mockReset();
  arquivar.mockReset();
  renomear.mockReset();
  duplicar.mockReset();
  pausar.mockResolvedValue({ ok: true });
  despausar.mockResolvedValue({ ok: true });
  (toast.error as ReturnType<typeof vi.fn>).mockReset();
  (toast.success as ReturnType<typeof vi.fn>).mockReset();
});

describe("menu do agente — Despausar na lista (issue #1141)", () => {
  it('⭐ mcp_agent pausado, com versão publicada: "Despausar" está habilitado e despausa', async () => {
    const user = await abrirMenu({
      kind: "mcp_agent",
      published_version_id: "v7",
      paused_at: "2026-09-10T12:00:00Z",
    });

    const item = await screen.findByRole("menuitem", { name: "Despausar" });
    expect(estaBloqueado(item)).toBe(false);

    await user.click(item);
    await waitFor(() => expect(despausar).toHaveBeenCalledWith(ID));
    expect(pausar).not.toHaveBeenCalled();
  });

  it('⭐ mcp_agent pausado, sem versão publicada: segue clicável e o motivo da recusa chega na tela', async () => {
    // O item não pode virar uma porta fechada: quem recusa é a ação, com uma
    // frase que o usuário lê (`run` mostra `res.message`), não a lista em silêncio.
    despausar.mockResolvedValue({
      ok: false,
      error: "publish_required",
      message: "Conclua a configuração e publique uma versão.",
    });

    const user = await abrirMenu({
      kind: "mcp_agent",
      published_version_id: null,
      paused_at: "2026-09-10T12:00:00Z",
    });

    const item = await screen.findByRole("menuitem", { name: "Despausar" });
    expect(estaBloqueado(item)).toBe(false);

    await user.click(item);
    await waitFor(() => expect(despausar).toHaveBeenCalledWith(ID));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Conclua a configuração e publique uma versão."),
    );
  });

  it("CONTROLE: rag_bot pausado já despausava pela lista — e continua despausando", async () => {
    // Sem este controle, o ⭐ passaria também se o menu nunca desabilitasse nada.
    const user = await abrirMenu({
      kind: "rag_bot",
      published_version_id: "v7",
      paused_at: "2026-09-10T12:00:00Z",
    });

    const item = await screen.findByRole("menuitem", { name: "Despausar" });
    expect(estaBloqueado(item)).toBe(false);

    await user.click(item);
    await waitFor(() => expect(despausar).toHaveBeenCalledWith(ID));
  });

  it("CONTROLE: o menu do agente ARQUIVADO continua bloqueado (isArchived preservado)", async () => {
    // Também é o controle que prova que `estaBloqueado` reconhece um item
    // bloqueado de verdade: sem ele, "não está bloqueado" poderia estar medindo o nada.
    const user = await abrirMenu({ archived_at: "2026-09-01T00:00:00Z" });

    const pausarItem = await screen.findByRole("menuitem", { name: "Pausar" });
    const arquivarItem = await screen.findByRole("menuitem", { name: "Arquivar" });
    expect(estaBloqueado(pausarItem)).toBe(true);
    expect(estaBloqueado(arquivarItem)).toBe(true);

    await user.click(pausarItem);
    await new Promise((r) => setTimeout(r, 0));
    expect(pausar).not.toHaveBeenCalled();
  });

  it("CONTROLE: mcp_agent ativo pausa pela lista — o par Pausar/Despausar ficou simétrico", async () => {
    const user = await abrirMenu({ kind: "mcp_agent", published_version_id: "v7", paused_at: null });

    const item = await screen.findByRole("menuitem", { name: "Pausar" });
    expect(estaBloqueado(item)).toBe(false);

    await user.click(item);
    await waitFor(() => expect(pausar).toHaveBeenCalledWith(ID));
  });
});
