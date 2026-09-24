import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UpdatePanel } from "./UpdatePanel";
import type { SystemVersion } from "@/hooks/system/useSystemVersion";

/**
 * O botão "Atualizar agora" morava DEPOIS do "O que muda" — com várias versões
 * acumuladas (o changelog "cumprida", medido pelo dono numa instalação
 * atrasada), quem só queria clicar precisava rolar a tela inteira antes de
 * achar o botão. Ele subiu para antes do changelog; os avisos que pesam na
 * decisão (`off_release`, `requires_attention` e o de histórico incompleto)
 * continuam antes DELE.
 */

const dadosVersao = vi.hoisted(() => ({ atual: null as SystemVersion | null }));

vi.mock("@/hooks/system/useSystemVersion", () => ({
  useSystemVersion: () => ({ data: dadosVersao.atual, isError: false }),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn(), get: vi.fn() } }));

function renderTela(dados: SystemVersion) {
  dadosVersao.atual = dados;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UpdatePanel />
    </QueryClientProvider>,
  );
}

const CHANGELOG_LONGO: SystemVersion = {
  current_version: "1.0.0",
  is_owner: true,
  latest_version: "1.5.0",
  update_available: true,
  agent_online: true,
  notes: {
    requires_attention: [],
    complete: true,
    sections: Array.from({ length: 8 }, (_, i) => ({
      version: `1.${5 - i}.0`,
      body: `Corpo bem longo da versão 1.${5 - i}.0. `.repeat(20),
    })),
  },
  run: null,
};

describe("tela de atualização — o botão não fica atrás do changelog", () => {
  it("'Atualizar agora' aparece ANTES de 'O que muda', mesmo com changelog extenso", () => {
    renderTela(CHANGELOG_LONGO);

    const botao = screen.getByRole("button", { name: "Atualizar agora" });
    const changelog = screen.getByText("O que muda");

    expect(
      Boolean(
        botao.compareDocumentPosition(changelog) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  it("o aviso 'Requer atenção' continua ANTES do botão — ele pesa na decisão de clicar", () => {
    renderTela({
      ...CHANGELOG_LONGO,
      notes: {
        ...CHANGELOG_LONGO.notes!,
        requires_attention: [{ version: "1.4.0", texto: "Rode o comando de migração antes." }],
      },
    });

    const aviso = screen.getByText("Requer atenção", { exact: false });
    const botao = screen.getByRole("button", { name: "Atualizar agora" });

    expect(
      Boolean(aviso.compareDocumentPosition(botao) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("o aviso de histórico incompleto continua ANTES do botão — com ele, o 'Requer atenção' pode estar faltando itens", () => {
    renderTela({
      ...CHANGELOG_LONGO,
      notes: { ...CHANGELOG_LONGO.notes!, complete: false },
    });

    const aviso = screen.getByText("Este histórico começa na versão", { exact: false });
    const botao = screen.getByRole("button", { name: "Atualizar agora" });

    expect(
      Boolean(aviso.compareDocumentPosition(botao) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });
});
