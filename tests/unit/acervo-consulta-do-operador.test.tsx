import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import type { ReactNode } from "react";

/**
 * A CONSULTA AO ACERVO DO OPERADOR (#1869, fatia B1).
 *
 * A busca existe desde a F1 (`POST /api/v1/ai/knowledge/busca`), mas o
 * resultado chegava à tela sem o que faz dele uma CONSULTA e não um oráculo:
 *
 *  - o trecho saía só com o NOME do material. O operador lia "Política de
 *    troca" e não tinha por onde abrir o documento de onde a frase veio. O
 *    `knowledge_source_id` já vinha na resposta — faltava a tela usá-lo;
 *  - e o motivo do erro só passava para 409/429. A rota traduz TODO estado em
 *    frase para quem está na tela (403 de papel, 500 de leitura do acervo); o
 *    resto caía em "Não consegui consultar o acervo.", que é o mesmo que dizer
 *    nada. Pior: o genérico é indistinguível de "a base não tem" para quem lê
 *    rápido — as duas coisas pedem ações opostas.
 *
 * O LINK tem régua de papel e ela NÃO é a daqui: CONSULTAR é `agent`+, ABRIR a
 * biblioteca é `manager`+ (`/app/ai/knowledge/sources` manda o resto para /403,
 * e o GET do conteúdo cobra o mesmo). Por isso o painel decide e passa
 * `podeAbrirFonte`; este teste prende os dois lados — com e sem link — porque
 * link que termina em 403 é a promessa-e-desmentido que a tela evita.
 */

const h = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/lib/api/client", () => ({ apiClient: { post: h.post } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
// O Link real exige contexto de roteador para prefetch; aqui interessa o
// destino gravado no href, não a navegação.
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    className,
    ...resto
  }: { children: ReactNode; href: string; className?: string } & Record<string, unknown>) => (
    <a href={href} className={className} {...resto}>
      {children}
    </a>
  ),
}));

import { AcervoSearch } from "@/components/inbox/AcervoSearch";

const TRECHO = {
  chunk_id: "chunk-1",
  knowledge_source_id: "fonte-1",
  source_name: "Política de troca",
  content: "Trocas em até 30 dias com a nota fiscal.",
  similarity: 0.87,
};

const RESPOSTA = {
  data: {
    trechos: [TRECHO],
    melhorSimilaridade: 0.87,
    motivo: null,
    acervo: { fontes: 3, limiar: 0.4 },
  },
};

const VAZIO = {
  data: {
    trechos: [],
    melhorSimilaridade: null,
    motivo: "A base não tem essa informação.",
    acervo: { fontes: 3, limiar: 0.4 },
  },
};

function perguntar(): void {
  fireEvent.change(screen.getByTestId("acervo-pergunta"), {
    target: { value: "posso trocar depois de 20 dias?" },
  });
  fireEvent.click(screen.getByTestId("acervo-buscar"));
}

afterEach(() => {
  h.post.mockReset();
});

describe("consulta ao acervo pelo operador", () => {
  it("pergunta pela rota que já existe e devolve o trecho com a fonte", async () => {
    h.post.mockResolvedValue(RESPOSTA);

    render(<AcervoSearch podeAbrirFonte />);
    perguntar();

    await waitFor(() => expect(screen.getByTestId("acervo-trechos")).toBeInTheDocument());
    expect(screen.getByText(TRECHO.content)).toBeInTheDocument();
    expect(screen.getByText(TRECHO.source_name)).toBeInTheDocument();
    // A rota é a MESMA da IA e a organização NUNCA sai do corpo: quem a resolve
    // é a sessão, no servidor. Mandar `organization_id` daqui seria abrir o
    // acervo de outra empresa por um campo que o cliente controla.
    expect(h.post).toHaveBeenCalledWith("/api/v1/ai/knowledge/busca", {
      pergunta: "posso trocar depois de 20 dias?",
    });
  });

  it("quem pode abrir a biblioteca chega ao material pelo trecho", async () => {
    h.post.mockResolvedValue(RESPOSTA);

    render(<AcervoSearch podeAbrirFonte />);
    perguntar();

    const link = await screen.findByTestId("acervo-fonte-link");
    expect(link).toHaveAttribute("href", "/app/ai/knowledge/sources/fonte-1");
  });

  it("quem só consulta vê o nome da fonte e NÃO um link que dá 403", async () => {
    h.post.mockResolvedValue(RESPOSTA);

    render(<AcervoSearch />);
    perguntar();

    await screen.findByTestId("acervo-trechos");
    expect(screen.getByTestId("acervo-fonte")).toHaveTextContent(TRECHO.source_name);
    expect(screen.queryByTestId("acervo-fonte-link")).toBeNull();
  });

  it("vazio diz que a base não tem — não diz que deu erro", async () => {
    h.post.mockResolvedValue(VAZIO);

    render(<AcervoSearch podeAbrirFonte />);
    perguntar();

    expect(await screen.findByTestId("acervo-motivo")).toHaveTextContent(
      "A base não tem essa informação.",
    );
    expect(screen.queryByTestId("acervo-erro")).toBeNull();
  });

  it("erro de leitura mostra o motivo que a rota deu, não um genérico", async () => {
    h.post.mockRejectedValue(
      new ApiError(500, "internal_error", undefined, "req-1", "Não foi possível ler o acervo."),
    );

    render(<AcervoSearch podeAbrirFonte />);
    perguntar();

    const erro = await screen.findByTestId("acervo-erro");
    expect(erro).toHaveTextContent("Não foi possível ler o acervo.");
    // E sem resultado ao lado: "vazio" e "falhou" não podem chegar juntos.
    expect(screen.queryByTestId("acervo-motivo")).toBeNull();
  });

  it("envelope sem frase (só o código) não vaza código cru para a tela", async () => {
    h.post.mockRejectedValue(new ApiError(503, "unavailable", undefined, "req-2"));

    render(<AcervoSearch podeAbrirFonte />);
    perguntar();

    const erro = await screen.findByTestId("acervo-erro");
    expect(erro).toHaveTextContent("Não consegui consultar o acervo.");
    expect(erro).not.toHaveTextContent("unavailable");
  });

  it("resposta sem envelope (proxy, HTML de erro) não mostra o corpo cru nem o status", async () => {
    // É assim que `lib/api/client.ts` monta o erro quando o corpo não é o
    // envelope da casa: `message` vira o corpo ou `HTTP <status>`.
    h.post.mockRejectedValue(
      new ApiError(502, "internal_error", undefined, "req-3", "HTTP 502", true),
    );

    render(<AcervoSearch podeAbrirFonte />);
    perguntar();

    const erro = await screen.findByTestId("acervo-erro");
    expect(erro).toHaveTextContent("Não consegui consultar o acervo.");
    expect(erro).not.toHaveTextContent("HTTP 502");
  });
});
