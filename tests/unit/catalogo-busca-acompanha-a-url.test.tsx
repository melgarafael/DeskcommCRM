import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CAIXA DE BUSCA ACOMPANHA A URL (revisão do PR #2138).
 *
 * A busca vai à URL depois de 350 ms. A página não remonta quando só as
 * searchParams mudam, então, ao apertar Voltar, a URL mudava e a caixa não:
 * o debounce via a diferença e mandava de volta para a busca antiga.
 */

const replace = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn(), patch: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { ProdutosClient } from "@/app/app/products/_client";

const TEXTOS = { titulo: "Produtos", subtitulo: "", vazio: "", vazioDica: "" };

function tela(buscaInicial: string) {
  return (
    <ProdutosClient
      inicial={[]}
      total={0}
      pagina={1}
      porPagina={50}
      buscaInicial={buscaInicial}
      urlsDasFotos={{}}
      podeEditar={false}
      textos={TEXTOS}
    />
  );
}

const caixa = () => screen.getByTestId("busca-produto") as HTMLInputElement;

beforeEach(() => {
  vi.useFakeTimers();
  replace.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("a caixa de busca e a URL", () => {
  it("Voltar (a URL muda por fora): a caixa acompanha e nada é reenviado", () => {
    const { rerender } = render(tela("g17"));
    rerender(tela("pistola")); // o navegador voltou para ?busca=pistola
    expect(caixa().value).toBe("pistola");
    act(() => vi.advanceTimersByTime(1000));
    expect(replace).not.toHaveBeenCalled();
  });

  it("a URL que a própria caixa pediu não tira o espaço que a pessoa digitou", () => {
    const { rerender } = render(tela(""));
    fireEvent.change(caixa(), { target: { value: "glock " } });
    act(() => vi.advanceTimersByTime(400));
    expect(replace).toHaveBeenCalledWith("?busca=glock", { scroll: false });
    rerender(tela("glock")); // a URL respondeu ao pedido da caixa
    expect(caixa().value).toBe("glock ");
  });
});
