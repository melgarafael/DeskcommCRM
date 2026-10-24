import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type * as UseCasesModule from "@/hooks/ai/useCases";

const useCaseMock = vi.fn();
vi.mock("@/hooks/ai/useCases", async () => {
  const actual = await vi.importActual<typeof UseCasesModule>("@/hooks/ai/useCases");
  return { ...actual, useCase: (...args: unknown[]) => useCaseMock(...args) };
});

/**
 * O chat do caso é mocado no NÍVEL DO HOOK, e o painel é renderizado de VERDADE.
 *
 * Mocar o componente esconderia a peça do único teste que monta esta árvore — e
 * é justamente aqui que mora a prova da ORDEM no DOM (abaixo). Mocar só os
 * hooks evita o `fetch` no jsdom sem apagar o que se quer medir.
 */
vi.mock("@/hooks/ai/useCaseChat", () => ({
  useCaseChat: () => ({
    data: {
      mensagens: [],
      persona: { fonte: "agente_do_caso", nome: "Ana", motivo: null },
      estado: {
        caso_obsoleto: false,
        contato_bloqueado: false,
        contato_anonimizado: false,
        status: "awaiting_human",
        ia_configurada: true,
      },
    },
    isLoading: false,
    error: null,
  }),
  useAskCase: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

import { CaseDetail } from "@/app/app/ai/cases/_components/CaseDetail";

function wrap(ui: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
}

const BASE_CASE = {
  id: "case-1",
  title: "Cliente pede desconto acima do permitido",
  summary: "Quer 30% de desconto num pedido de R$500",
  blocker: "Desconto fora da política (máximo 10%)",
  status: "awaiting_human" as const,
  source: "agent" as const,
  opened_at: "2026-07-20T10:00:00.000Z",
  closed_at: null,
  conversation_id: "conv-1",
  contact_name: "Maria Silva",
  contact_phone: "+5511999990000",
  events: [
    {
      id: "ev-1",
      kind: "opened" as const,
      actor_kind: "agent" as const,
      actor_user_id: null,
      human_action: null,
      body: null,
      created_at: "2026-07-20T10:00:00.000Z",
    },
    {
      id: "ev-2",
      kind: "lead_asked" as const,
      actor_kind: "human" as const,
      actor_user_id: "u-1",
      human_action: "need_lead_info" as const,
      body: "Qual seu CPF?",
      created_at: "2026-07-20T10:05:00.000Z",
    },
  ],
};

describe("CaseDetail", () => {
  it("estado vazio quando nenhum caso selecionado", () => {
    useCaseMock.mockReturnValue({ isLoading: false, data: undefined });
    render(wrap(<CaseDetail caseId={null} />));
    expect(screen.getByText("Selecione um caso à esquerda")).toBeInTheDocument();
  });

  it("linka para a conversa completa no inbox", () => {
    useCaseMock.mockReturnValue({ isLoading: false, data: BASE_CASE });
    render(wrap(<CaseDetail caseId="case-1" />));

    expect(screen.getByRole("link", { name: "Ver conversa" })).toHaveAttribute("href", "/app/inbox/conv-1");
  });

  it("o link da conversa declara a área de toque de 44px (16px + 2×14px); a geometria é da spec", () => {
    useCaseMock.mockReturnValue({ isLoading: false, data: BASE_CASE });
    render(wrap(<CaseDetail caseId="case-1" />));
    const classes = screen.getByRole("link", { name: "Ver conversa" }).className.split(/\s+/);

    // `inline-block` dá ao link a caixa da linha (16px do text-xs), que é de onde
    // o `::before` absoluto mede; num `inline` a caixa é a da fonte, menor.
    // Isto confere só a CLASSE escrita; o toque a 21px (e o controle a 24px) é
    // medido em `tests/e2e/ia-no-celular.spec.ts`, passo 8.
    expect(classes).toEqual(
      expect.arrayContaining([
        "relative",
        "pointer-coarse:inline-block",
        "pointer-coarse:before:absolute",
        "pointer-coarse:before:-inset-3.5",
      ]),
    );
  });

  it("mostra summary/blocker rotulados e traduz pelo menos 2 kinds da timeline pra pt-br", () => {
    useCaseMock.mockReturnValue({ isLoading: false, data: BASE_CASE });
    render(wrap(<CaseDetail caseId="case-1" />));

    expect(screen.getByText("O que o cliente precisa")).toBeInTheDocument();
    expect(screen.getByText(BASE_CASE.summary)).toBeInTheDocument();
    expect(screen.getByText("Por que a IA travou")).toBeInTheDocument();
    expect(screen.getByText(BASE_CASE.blocker)).toBeInTheDocument();

    // 'opened' traduzido — nunca o enum cru.
    expect(screen.getByText("A IA abriu o caso")).toBeInTheDocument();
    // 'lead_asked' traduzido.
    expect(screen.getByText("A IA perguntou ao cliente")).toBeInTheDocument();
    expect(screen.queryByText("opened")).not.toBeInTheDocument();
    expect(screen.queryByText("lead_asked")).not.toBeInTheDocument();
  });

  it("sinaliza discretamente quando o caso veio do guardrail automático", () => {
    useCaseMock.mockReturnValue({
      isLoading: false,
      data: { ...BASE_CASE, source: "guardrail_autofallback" as const },
    });
    render(wrap(<CaseDetail caseId="case-1" />));
    expect(screen.getByText("Aberto automaticamente")).toBeInTheDocument();
  });

  it("monta o painel de conversar com a IA sobre o caso", () => {
    // Sem esta asserção, o mock dos hooks acima viraria um esconderijo: o painel
    // poderia ser removido do `CaseDetail` e todo o resto seguiria verde.
    useCaseMock.mockReturnValue({ isLoading: false, data: BASE_CASE });
    render(wrap(<CaseDetail caseId="case-1" />));

    expect(screen.getByTestId("case-chat")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Perguntar" })).toBeInTheDocument();
  });

  it("a ORDEM no DOM é contrato: a decisão vem antes da conversa com a IA", () => {
    /**
     * Dois e2e obrigatórios acham o painel de decisão por localizador frouxo:
     * `page.locator("textarea").first()` (escalacao-ciclo.spec.ts:194) e
     * `getByRole("button", { name: "Enviar", exact: true })`
     * (encerramento-atendimento.spec.ts:226,249).
     *
     * Se o chat subir no DOM, o `.first()` passa a pegar o campo do chat e a
     * decisão do atendente é digitada no lugar errado — com os dois e2e
     * vermelhos por um sintoma que não aponta para cá. Este caso é a mesma
     * regra, medida sem browser: primeiro textarea = o da decisão, e existe
     * exatamente UM botão "Enviar" na árvore.
     */
    useCaseMock.mockReturnValue({ isLoading: false, data: BASE_CASE });
    const { container } = render(wrap(<CaseDetail caseId="case-1" />));

    const campos = container.querySelectorAll("textarea");
    expect(campos.length).toBeGreaterThanOrEqual(2);
    expect(campos[0]).toHaveAttribute("placeholder", "Escreva sua resposta para a IA...");
    expect(campos[1]).toHaveAttribute("placeholder", "Pergunte à IA sobre este caso…");

    expect(screen.getAllByRole("button", { name: "Enviar" })).toHaveLength(1);
  });
});
