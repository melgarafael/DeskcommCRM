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

  /**
   * UM CASO POR FAMÍLIA — inclusive a conferência de afirmação de fato (#2231),
   * que é de onde a issue nasceu (triagem do #2959).
   *
   * O caso do ⭐ acima prova que o painel USA o mapa; estes provam que o mapa,
   * lido pela tela, devolve a frase da FAMÍLIA CERTA. Sem eles, trocar dois
   * corpos em `motivoDoVeto` passa despercebido: os 24 casos da base ficavam
   * verdes com `factual_claim_contradicted` e `..._unsupported` invertidos.
   *
   * O `naoContem` é o que separa as duas famílias vizinhas (contradição × falta
   * de apoio) e as definitivas das acionáveis: a frase do outro caso não pode
   * aparecer no lugar.
   */
  const FAMILIAS: Array<[string, string, RegExp, RegExp]> = [
    [
      "contato bloqueado (opt-out)",
      "contato_bloqueado",
      /não receber mensagens/,
      /CONTRADIZ|sem apoio/,
    ],
    ["LGPD anonimizado", "lgpd_anonymized", /anonimizado/, /CONTRADIZ|sem apoio/],
    ["janela de 24h fechada", "messaging_window_closed", /janela de 24 horas/, /CONTRADIZ/],
    ["promessa fora da tabela", "promise_out_of_table", /fora da tabela aprovada/, /CONTRADIZ/],
    [
      "#2231 afirmação CONTRADITA",
      "factual_claim_contradicted",
      /CONTRADIZ/,
      /sem apoio no material de referência/,
    ],
    [
      "#2231 afirmação SEM APOIO",
      "factual_claim_unsupported",
      /sem apoio no material de referência/,
      /CONTRADIZ/,
    ],
    ["falha de geração", "generation_failed", /A geração da sugestão falhou/, /CONTRADIZ/],
  ];

  it.each(FAMILIAS)(
    "família %s: o painel mostra a frase dela, e não a da vizinha",
    async (_familia, codigo, contem, naoContem) => {
      montar([draft({ error_code: codigo })]);

      const causa = await screen.findByText(contem);
      expect(causa.textContent).not.toMatch(naoContem);
      expect(screen.queryByText(GENERICA)).toBeNull();
    },
  );

  it("CONTROLE: rascunho que não falhou não mostra causa nenhuma", async () => {
    montar([draft({ status: "pending", original_body: "Oi", error_code: "messaging_window_closed" })]);

    expect(await screen.findByText("Sugestão para revisar")).toBeTruthy();
    expect(screen.queryByText(/janela de 24 horas/)).toBeNull();
  });
});
