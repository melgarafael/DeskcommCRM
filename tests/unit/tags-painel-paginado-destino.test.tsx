/**
 * A TELA PAGINADA DE ETIQUETAS (#2855) E O NOME QUE ESTÁ EM OUTRA PÁGINA.
 *
 * Com 100 etiquetas por página, o destino de "juntar" é digitado, e o nome que
 * o operador digita pode existir numa página que não está na tela. Duas regras
 * dependem de saber se ele existe:
 *
 * - juntar só leva para uma etiqueta que EXISTE (senão vira um renomear sem
 *   aviso) — a tela avisa e trava o Confirmar; o servidor recusa de novo;
 * - renomear para um nome que existe junta as duas (#2801) — o aviso tem de
 *   aparecer mesmo quando a outra etiqueta está em outra página.
 *
 * A pergunta vai a `GET /api/v1/tags/vocabulario?busca=`, que aqui é o `fetch`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LinhaDeVocabulario } from "@/lib/schemas/tags";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { PainelDeTags } from "@/app/app/settings/tags/_painel";

const linha = (tag: string): LinhaDeVocabulario => ({
  tag,
  uso_em_contatos: 1,
  uso_em_leads: 0,
  uso_em_conversas: 0,
  em_regras: 0,
  cor: null,
  descricao: null,
  no_vocabulario: true,
});

/** O que existe nas OUTRAS páginas — só o servidor sabe. */
const NO_SERVIDOR = ["zeta-em-outra-pagina"];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const busca = new URL(url, "http://x").searchParams.get("busca") ?? "";
      const achadas = NO_SERVIDOR.filter((t) => t.includes(busca.toLowerCase())).map(linha);
      return new Response(JSON.stringify({ data: achadas }), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function montar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PainelDeTags tags={[linha("alfa"), linha("beta")]} idioma="pt-BR" paginado />
    </QueryClientProvider>,
  );
}

function abrir(acao: "Juntar" | "Renomear") {
  fireEvent.click(screen.getAllByRole("button", { name: acao })[0]!);
}

const AVISO_INEXISTENTE = /Essa etiqueta não existe/;
const AVISO_JUNTA = /Este nome já existe no vocabulário/;

describe("juntar na tela paginada", () => {
  it("⭐ destino que não existe em página nenhuma: avisa e trava o Confirmar", async () => {
    montar();
    abrir("Juntar");
    fireEvent.change(screen.getByLabelText("Etiqueta de destino"), { target: { value: "nao-existe" } });
    expect(await screen.findByText(AVISO_INEXISTENTE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirmar" })).toHaveProperty("disabled", true);
  });

  it("destino que existe em OUTRA página: sem aviso, Confirmar livre", async () => {
    montar();
    abrir("Juntar");
    fireEvent.change(screen.getByLabelText("Etiqueta de destino"), {
      target: { value: "Zeta-em-outra-pagina" },
    });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirmar" })).toHaveProperty("disabled", false),
    );
    expect(screen.queryByText(AVISO_INEXISTENTE)).toBeNull();
  });

  it("destino que está NESTA página: sem aviso", async () => {
    montar();
    abrir("Juntar");
    fireEvent.change(screen.getByLabelText("Etiqueta de destino"), { target: { value: "beta" } });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(AVISO_INEXISTENTE)).toBeNull();
  });
});

describe("renomear na tela paginada (#2801)", () => {
  it("⭐ o aviso de junção aparece quando o nome existe em OUTRA página", async () => {
    montar();
    abrir("Renomear");
    fireEvent.change(screen.getByLabelText("Novo nome"), { target: { value: "zeta-em-outra-pagina" } });
    expect(await screen.findByText(AVISO_JUNTA)).toBeTruthy();
  });

  it("nome novo de verdade: sem aviso", async () => {
    montar();
    abrir("Renomear");
    fireEvent.change(screen.getByLabelText("Novo nome"), { target: { value: "gama-nova" } });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(AVISO_JUNTA)).toBeNull();
  });
});
