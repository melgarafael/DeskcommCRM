/**
 * O PAINEL DIZ QUAL VETO BARROU A SUGESTÃO (issue #2975).
 *
 * O rascunho assistido guarda só o CÓDIGO do primeiro impedimento da prévia
 * (`ai_reply_drafts.error_code`); a frase que o veto carregava morre no
 * servidor. Antes, o estado `failed` mostrava a MESMA frase genérica para
 * todos os vetos — de "o contato está descadastrado" a "a janela de 24h
 * fechou" —, e quem atende não tinha como saber o caso nem o que fazer.
 *
 * Os casos cobrem as três pontas: código conhecido mostra a causa; código
 * ausente ou desconhecido mantém o genérico (que continua verdadeiro); e o
 * CONTROLE garante que a causa não vaza para um rascunho que não falhou.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api/client", () => ({ apiClient: { get: deps.get, post: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import { ReplyReviewPanel } from "./ReplyReviewPanel";

const GENERICA = "Confira a configuração do agente e tente gerar novamente.";

const draft = (extra: Record<string, unknown> = {}) => ({
  id: "d1",
  revision: "1",
  status: "failed",
  original_body: null,
  edited_body: null,
  error_code: null,
  proposals: [],
  ...extra,
});

function montar(drafts: unknown[]) {
  deps.get.mockResolvedValue({ data: { drafts } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReplyReviewPanel conversationId="c1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("o painel diz QUAL veto barrou a sugestão (issue #2975)", () => {
  it("⭐ failed com código conhecido mostra a causa, não a frase genérica", async () => {
    montar([draft({ error_code: "messaging_window_closed" })]);

    expect(await screen.findByText(/janela de 24 horas/)).toBeTruthy();
    expect(screen.queryByText(GENERICA)).toBeNull();
  });

  it("failed SEM código mantém o texto de sempre", async () => {
    montar([draft({ error_code: null })]);

    expect(await screen.findByText(GENERICA)).toBeTruthy();
  });

  it("failed com código DESCONHECIDO também cai no texto de sempre", async () => {
    montar([draft({ error_code: "veto_novo_sem_par" })]);

    expect(await screen.findByText(GENERICA)).toBeTruthy();
  });

  it("CONTROLE: rascunho que não falhou não mostra causa nenhuma", async () => {
    montar([draft({ status: "pending", original_body: "Oi", error_code: "messaging_window_closed" })]);

    expect(await screen.findByText("Sugestão para revisar")).toBeTruthy();
    expect(screen.queryByText(/janela de 24 horas/)).toBeNull();
  });
});
