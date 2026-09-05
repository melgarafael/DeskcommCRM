import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * O PREÇO DO CATÁLOGO SAI NA CONVENÇÃO DA MOEDA QUE A LOJA USA.
 *
 * A tela de produtos formatava com um ajudante local de quatro linhas:
 *
 *     const v = (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
 *     return moeda === "BRL" ? `R$ ${v}` : `${moeda} ${v}`;
 *
 * Ele tem dois defeitos, e os dois só aparecem quando a loja não é brasileira:
 *
 *  1. **O número sai sempre em pt-BR.** Um preço em pesos aparecia como
 *     `MXN 249,90` — vírgula decimal, que no México é separador de MILHAR. Quem
 *     opera a loja lê um preço mil vezes maior antes de perceber o formato.
 *  2. **O símbolo vira o código ISO.** Toda moeda que não fosse BRL perdia o
 *     `$` e ganhava as três letras coladas na frente, que é como um sistema
 *     escreve, não como um comerciante lê.
 *
 * Quem responde esse preço ao cliente é o atendente de IA. Preço é o campo onde
 * errar custa caro — a mesma razão pela qual `precoParaCentavos` falha FECHADO
 * em vez de adivinhar.
 *
 * A tela passa a usar `formatCents` (`lib/money.ts`), que deriva o locale DA
 * MOEDA. Reverter para o ajudante local faz este arquivo ficar vermelho.
 */

vi.mock("@/lib/api/client", () => ({
  apiClient: { post: vi.fn(), patch: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
// A tradução não é o assunto deste arquivo: a chave em português é o texto.
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { ProdutosClient } from "@/app/app/products/_client";
import type { Produto } from "@/lib/schemas/produtos";

function produto(over: Partial<Produto> = {}): Produto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    codigo: "IP15",
    nome: "iPhone 15",
    descricao: null,
    marca: null,
    categoria: null,
    preco_cents: 24990,
    moeda: "BRL",
    custo_cents: null,
    controla_estoque: false,
    quantidade: 0,
    ativo: true,
    origem: "manual",
    imagem_url: null,
    updated_at: "2026-09-03T00:00:00.000Z",
    ...over,
  };
}

const TEXTOS = { titulo: "Produtos", subtitulo: "", vazio: "", vazioDica: "" };

function montar(itens: Produto[]) {
  render(<ProdutosClient inicial={itens} podeEditar={false} textos={TEXTOS} />);
}

/** O `Intl` emite NBSP (U+00A0) ou narrow NBSP (U+202F) entre símbolo e número. */
const semNbsp = (s: string) => s.replace(/[\u00A0\u202F]/g, " ");

function precoNaTela(codigo: string): string {
  const linha = screen.getByTestId(`produto-${codigo}`);
  const preco = linha.querySelector(".tabular-nums");
  return semNbsp(preco?.textContent ?? "");
}

describe("o preço do catálogo na moeda da loja", () => {
  it("escreve o peso mexicano como quem vende no México lê", () => {
    montar([produto({ codigo: "MX1", moeda: "MXN", preco_cents: 24990 })]);

    // Ponto decimal e cifrão — não `MXN 249,90`, que era o que a tela mostrava.
    expect(precoNaTela("MX1")).toBe("$249.90");
  });

  it("não muda o que o lojista brasileiro já via", () => {
    montar([produto({ codigo: "BR1", moeda: "BRL", preco_cents: 549900 })]);

    expect(precoNaTela("BR1")).toBe("R$ 5.499,00");
  });

  /**
   * Duas moedas na mesma lista não acontecem hoje — a organização declara uma
   * só e o servidor a copia em toda escrita. O caso está aqui porque a COLUNA
   * é por linha: um catálogo antigo, de antes da migration 0206, pode ter
   * linhas gravadas com outra moeda, e a tela não pode escrever um número na
   * convenção errada por causa da vizinha.
   */
  it("cada linha responde pela própria moeda", () => {
    montar([
      produto({ id: "a", codigo: "BR1", moeda: "BRL", preco_cents: 24990 }),
      produto({ id: "b", codigo: "MX1", moeda: "MXN", preco_cents: 24990 }),
    ]);

    expect(precoNaTela("BR1")).toBe("R$ 249,90");
    expect(precoNaTela("MX1")).toBe("$249.90");
  });
});
