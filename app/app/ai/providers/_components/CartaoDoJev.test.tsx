/**
 * O cartão do Jev tem seis estados, e cada um responde a pergunta que a pessoa
 * tem naquele momento: "o que é isto?", "por que a chave não passou?", "o que
 * acontece se eu ligar?", "ele concorda com a minha IA?", "quanto está custando?"
 * e "por que ele decide sozinho?". Os dados vêm de `GET /api/v1/ai/jev`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

import { CartaoDoJev, jevNoPonto, useDadosDoJev, type DadosDoJev } from "./CartaoDoJev";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/app/ai/credentials/_actions", () => ({ refreshCredentialsView: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

type Aninhado = "provedor" | "chave" | "config" | "numeros";
type Parcial = Partial<Omit<DadosDoJev, Aninhado>> & {
  [K in Aninhado]?: Partial<DadosDoJev[K]>;
};

function dados(extra: Parcial = {}): DadosDoJev {
  const base: DadosDoJev = {
    provedor: {
      rotulo: "Jev (TypeSafe AI)",
      quandoUsar:
        "Não conversa com o cliente: toma decisões rápidas e baratas — como perceber se o cliente está irritado — geralmente em menos de um segundo. Trabalha junto com a sua IA principal.",
      ondePegarAChave: "https://console.typesafe.ai/keys",
      prefixoDaChave: "apikey_…",
    },
    chave: {
      existe: true,
      validada: true,
      credencial_id: "cred-1",
      rotulo: "Jev",
      erro_de_validacao: null,
    },
    config: { ligado: false, modo: "observacao", aceite: null },
    tarefas: [
      {
        id: "sentiment_classify",
        rotulo: "Medir o clima da conversa",
        oQueOJevFaz:
          "Percebe, geralmente em menos de um segundo, se o cliente está irritado — e avisa para passar a conversa a uma pessoa.",
      },
    ],
    tem_ia_de_sempre: true,
    numeros: {
      dias: 7,
      decisoes: 0,
      custo_cents: 0,
      custo_incompleto: false,
      latencia_media_ms: null,
      reservas: 0,
      irritados: 0,
      observacao: { dias: 30, comparadas: 0, concordaram: 0 },
    },
    ultima_falha: null,
    pode_editar: true,
  };
  return {
    ...base,
    ...extra,
    provedor: { ...base.provedor, ...extra.provedor },
    chave: { ...base.chave, ...extra.chave },
    config: { ...base.config, ...extra.config },
    numeros: { ...base.numeros, ...extra.numeros },
  };
}

const recarregar = vi.fn(async () => {});
let chamadas: Array<{ url: string; metodo: string; corpo: unknown }> = [];

beforeEach(() => {
  chamadas = [];
  recarregar.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      chamadas.push({
        url,
        metodo: init?.method ?? "GET",
        corpo: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ data: { validated_at: "2026-09-23T00:00:00Z" } }), {
        status: 200,
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function montar(d: DadosDoJev | null, opcoes: { erro?: string; idioma?: string } = {}) {
  return render(
    <IdiomaProvider locale={opcoes.idioma ?? "pt-BR"}>
      <QueryClientProvider client={new QueryClient()}>
        <CartaoDoJev dados={d} erro={opcoes.erro ?? null} recarregar={recarregar} />
      </QueryClientProvider>
    </IdiomaProvider>,
  );
}

const cartao = () => screen.getByTestId("cartao-do-jev");

describe("CartaoDoJev — (1) sem chave", () => {
  const semChave = () =>
    dados({ chave: { existe: false, validada: false, credencial_id: null, rotulo: null } });

  it("diz o que é e leva a quem pega e a quem cola a chave", () => {
    montar(semChave());
    expect(cartao()).toHaveAttribute("data-estado", "sem_chave");
    expect(screen.getByText(/toma decisões rápidas e baratas/)).toBeInTheDocument();
    const pegar = screen.getByRole("link", { name: /Pegar a chave na TypeSafe/ });
    expect(pegar).toHaveAttribute("href", "https://console.typesafe.ai/keys");
    expect(pegar).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("button", { name: "Colar a chave" })).toBeInTheDocument();
    // O Jev é pago à parte: a pessoa sabe antes de ir à TypeSafe.
    expect(screen.getByTestId("jev-como-pegar-a-chave")).toHaveTextContent(/põe crédito/);
  });

  it("'Colar a chave' abre o cadastro já no Jev, e não na Anthropic", () => {
    montar(semChave());
    fireEvent.click(screen.getByRole("button", { name: "Colar a chave" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Chave")).toHaveAttribute("placeholder", "apikey_…");
    expect(screen.getByRole("link", { name: "Onde pegar a chave" })).toHaveAttribute(
      "href",
      "https://console.typesafe.ai/keys",
    );
    // O caminho do leigo passa por este diálogo: sem o jargão que o cartão evita.
    expect(screen.getByRole("dialog")).not.toHaveTextContent(/API key|AES|token|prompt/i);
  });

  it("quem não administra não vê o botão de colar, e sabe por quê", () => {
    montar({ ...semChave(), pode_editar: false });
    expect(screen.queryByRole("button", { name: "Colar a chave" })).toBeNull();
    expect(screen.getByText(/Só quem administra a empresa/)).toBeInTheDocument();
  });
});

describe("CartaoDoJev — (2) chave que não passou no teste", () => {
  it("diz o motivo em português de gente e testa de novo pela rota de revalidar", async () => {
    montar(dados({ chave: { validada: false, erro_de_validacao: "auth_failed_401" } }));
    expect(cartao()).toHaveAttribute("data-estado", "chave_nao_validada");
    expect(screen.getByText(/A TypeSafe recusou a chave/)).toBeInTheDocument();
    // "Gere uma nova" com o caminho para gerar.
    expect(screen.getByRole("link", { name: "Pegar uma chave nova na TypeSafe" })).toHaveAttribute(
      "href",
      "https://console.typesafe.ai/keys",
    );

    fireEvent.click(screen.getByRole("button", { name: "Testar de novo" }));
    await waitFor(() => expect(recarregar).toHaveBeenCalled());
    expect(chamadas).toEqual([
      { url: "/api/v1/ai/credentials/cred-1/revalidate", metodo: "POST", corpo: {} },
    ]);
  });

  it("chave recém-colada, sem resultado ainda, não é tratada como recusada", () => {
    montar(dados({ chave: { validada: false, erro_de_validacao: null } }));
    // A frase não promete que se resolve sozinha: aponta o botão.
    expect(screen.getByText(/A chave está sendo testada\. .*Testar de novo/)).toBeInTheDocument();
    expect(screen.queryByText(/recusou/)).toBeNull();
  });

  it("código sem tradução não vai para a frase: fica só no title", () => {
    montar(dados({ chave: { validada: false, erro_de_validacao: "SyntaxError" } }));
    const caixa = screen.getByTestId("jev-chave");
    expect(caixa).not.toHaveTextContent("SyntaxError");
    expect(screen.getByText("Não consegui testar a chave. Tente de novo em instantes.")).toHaveAttribute(
      "title",
      "SyntaxError",
    );
  });
});

describe("CartaoDoJev — (3) pronto para ligar", () => {
  it("lista o que o Jev vai fazer e só liga depois do aceite marcado", async () => {
    montar(dados());
    expect(cartao()).toHaveAttribute("data-estado", "pronto");
    expect(screen.getByText("Medir o clima da conversa")).toBeInTheDocument();
    expect(
      screen.getByText(/cada mensagem que o cliente manda .* uma de cada vez e sem o resto da conversa/),
    ).toBeInTheDocument();

    const ligar = screen.getByRole("button", { name: "Ligar o Jev" });
    expect(ligar).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: /Concordo com o envio/ }));
    expect(ligar).toBeEnabled();
    fireEvent.click(ligar);

    await waitFor(() => expect(recarregar).toHaveBeenCalled());
    expect(chamadas).toEqual([
      { url: "/api/v1/ai/jev", metodo: "PATCH", corpo: { ligado: true, aceite_lgpd: true } },
    ]);
  });

  it("religar depois do aceite gravado não pede a caixa de novo", async () => {
    montar(
      dados({
        config: { modo: "decide", aceite: { em: "2026-09-20T12:00:00Z", por: "u1" } },
      }),
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ligar o Jev" }));
    await waitFor(() => expect(recarregar).toHaveBeenCalled());
    expect(chamadas[0]?.corpo).toEqual({ ligado: true });
  });

  it("sem a IA de sempre, explica que ele começa decidindo sozinho", () => {
    // A falta da IA principal é avisada no topo da página, não aqui (ver o bloco
    // "sem a IA de sempre, em qualquer estado").
    montar(dados({ tem_ia_de_sempre: false }));
    expect(screen.getByText(/já começa decidindo sozinho/)).toBeInTheDocument();
  });
});

describe("CartaoDoJev — (4) ligado, observando", () => {
  it("mostra a concordância e oferece deixar o Jev decidir", async () => {
    montar(
      dados({
        config: { ligado: true, modo: "observacao" },
        numeros: { observacao: { dias: 30, comparadas: 4, concordaram: 3 } },
      }),
    );
    expect(cartao()).toHaveAttribute("data-estado", "observando");
    expect(screen.getByTestId("jev-concordancia")).toHaveTextContent(/3 de 4/);

    fireEvent.click(screen.getByRole("button", { name: "Deixar o Jev decidir" }));
    await waitFor(() => expect(recarregar).toHaveBeenCalled());
    expect(chamadas[0]).toEqual({ url: "/api/v1/ai/jev", metodo: "PATCH", corpo: { modo: "decide" } });
  });

  it("sem nada comparado ainda, não inventa porcentagem", () => {
    montar(dados({ config: { ligado: true, modo: "observacao" } }));
    expect(screen.getByTestId("jev-concordancia")).toHaveTextContent(
      /Ainda não há mensagens medidas pelos dois/,
    );
  });
});

describe("CartaoDoJev — (5) ligado, decidindo", () => {
  const decidindo = () =>
    dados({
      config: { ligado: true, modo: "decide" },
      numeros: { decisoes: 1200, custo_cents: 0.21, latencia_media_ms: 361, reservas: 2, irritados: 7 },
    });

  /** O valor que acompanha o rótulo na grade de números. */
  const numero = (rotulo: string) => screen.getByText(rotulo).nextElementSibling?.textContent;

  it("mostra os números da semana, com o custo em casas que não viram zero", () => {
    montar(decidindo());
    expect(cartao()).toHaveAttribute("data-estado", "decidindo");
    const numeros = screen.getByTestId("jev-numeros");
    expect(numeros).toHaveTextContent(/1\.200/);
    // 0,21 centavo de dólar = US$ 0,0021 — com 2 casas seria "US$ 0,00".
    expect(numeros).toHaveTextContent(/US\$\s?0,0021/);
    expect(numeros).toHaveTextContent(/0,4\s?s/);
    expect(numero("Vezes que a IA de sempre cobriu o Jev")).toBe("2");
    // O número que mostra o valor do Jev: quantos clientes irritados ele percebeu.
    expect(numero("Clientes irritados percebidos")).toBe("7");
    // "Mensagens medidas" segue o primeiro: é o que a spec do e2e lê.
    expect(numeros.querySelector("dt")).toHaveTextContent("Mensagens medidas");
  });

  it("a chave que passou no teste se diz conferida, em palavras", () => {
    montar(decidindo());
    expect(screen.getByTestId("jev-chave-conferida")).toHaveTextContent("Chave conferida com a TypeSafe");
  });

  it("controle: chave recusada não se diz conferida", () => {
    montar({ ...decidindo(), chave: { ...decidindo().chave, validada: false, erro_de_validacao: "auth_failed_401" } });
    expect(screen.queryByTestId("jev-chave-conferida")).toBeNull();
  });

  it("o link para as decisões tem alvo de toque maior que o texto", () => {
    montar(decidindo());
    expect(screen.getByRole("link", { name: /Ver as decisões do Jev/ }).className).toMatch(/\binline-block\b.*\bpy-1\b/);
  });

  it("a grade de números acompanha a largura do cartão, não a da tela", () => {
    // A 375 px, duas colunas punham "US$ 0,000049" fora do cartão; num tablet
    // com a barra lateral aberta, três colunas de 117 px o partiam em duas
    // linhas. Colunas por breakpoint de TELA erram nos dois casos; jsdom não
    // mede layout, então a garantia aqui é a classe e a medida é da prova em tela.
    montar(decidindo());
    const classes = screen.getByTestId("jev-numeros").className.split(/\s+/);
    expect(classes.filter((c) => /grid-cols-/.test(c))).toEqual([
      "grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]",
    ]);
  });

  it("leva às decisões do Jev em Execuções, já filtradas", () => {
    montar(decidindo());
    expect(screen.getByRole("link", { name: /Ver as decisões do Jev/ })).toHaveAttribute(
      "href",
      "/app/ai/runs?provider=typesafe",
    );
  });

  it("desliga, e volta a só observar", async () => {
    montar(decidindo());
    fireEvent.click(screen.getByRole("button", { name: "Desligar" }));
    await waitFor(() => expect(recarregar).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Voltar a só observar" }));
    await waitFor(() => expect(recarregar).toHaveBeenCalledTimes(2));
    expect(chamadas.map((c) => c.corpo)).toEqual([{ ligado: false }, { modo: "observacao" }]);
  });

  it("a última falha sai com o que fazer, não com o código", () => {
    montar({
      ...decidindo(),
      ultima_falha: { motivo: "jev_sem_credito", em: "2026-09-22T10:00:00Z" },
    });
    expect(screen.getByTestId("jev-ultima-falha")).toHaveTextContent(/crédito esgotado/);
    expect(screen.getByTestId("jev-ultima-falha")).not.toHaveTextContent("jev_sem_credito");
  });

  it("chave que deixou de valer com o Jev ligado aparece, com o teste à mão", () => {
    montar({ ...decidindo(), chave: { ...decidindo().chave, validada: false } });
    expect(screen.getByRole("button", { name: "Testar de novo" })).toBeInTheDocument();
  });

  it("ligado com a chave recusada: selo 'Parado', nunca 'Decidindo'", () => {
    // O worker só usa chave validada: com esta, o Jev não mede nada.
    montar({
      ...decidindo(),
      chave: { ...decidindo().chave, validada: false, erro_de_validacao: "auth_failed_401" },
    });
    expect(cartao()).toHaveAttribute("data-estado", "parado");
    expect(screen.getByText("Parado")).toBeInTheDocument();
    expect(screen.queryByText("Decidindo")).toBeNull();
    expect(screen.queryByText(/o Jev mede primeiro/)).toBeNull();
    expect(screen.getByText(/Ligado, mas parado/)).toBeInTheDocument();
  });

  it("custo sem preço conhecido: traço, e o aviso de conta parcial", () => {
    montar({
      ...decidindo(),
      numeros: { ...decidindo().numeros, custo_cents: null, custo_incompleto: true },
    });
    expect(screen.getByTestId("jev-numeros")).not.toHaveTextContent(/US\$\s?0,00/);
    expect(screen.getByTestId("jev-custo-parcial")).toBeInTheDocument();
  });

  it("ligado sem chave ativa (desativada em Credenciais) não finge que mede", () => {
    montar({
      ...decidindo(),
      chave: { existe: false, validada: false, credencial_id: null, rotulo: null, erro_de_validacao: null },
    });
    expect(screen.getByTestId("jev-chave")).toHaveTextContent(/sem chave ativa/);
    expect(screen.queryByRole("button", { name: "Testar de novo" })).toBeNull();
  });
});

describe("CartaoDoJev — (6) sem a IA de sempre", () => {
  it("explica que o Jev decide sozinho e não oferece modo", () => {
    montar(dados({ config: { ligado: true, modo: "observacao" }, tem_ia_de_sempre: false }));
    expect(cartao()).toHaveAttribute("data-estado", "sozinho");
    expect(screen.getByText(/sem reserva/)).toBeInTheDocument();
    // O topo da página já avisa que falta a IA principal; repetido aqui, com o
    // Jev funcionando, lia-se como erro dele (medido em campo).
    expect(cartao()).not.toHaveTextContent(/falta a chave da sua IA principal/);
    expect(screen.queryByRole("button", { name: "Deixar o Jev decidir" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Voltar a só observar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Desligar" })).toBeInTheDocument();
  });
});

describe("CartaoDoJev — sem a IA de sempre, em qualquer estado", () => {
  it.each([
    ["pronto", dados({ tem_ia_de_sempre: false })],
    [
      "parado",
      dados({
        config: { ligado: true, modo: "decide" },
        tem_ia_de_sempre: false,
        chave: { validada: false, erro_de_validacao: "auth_failed_401" },
      }),
    ],
    ["sozinho", dados({ config: { ligado: true, modo: "decide" }, tem_ia_de_sempre: false })],
  ])("%s: nem o aviso repetido, nem o zero de reserva que nunca muda", (estado, d) => {
    montar(d);
    expect(cartao()).toHaveAttribute("data-estado", estado);
    expect(cartao()).not.toHaveTextContent(/falta a chave da sua IA principal/);
    expect(screen.queryByText("Vezes que a IA de sempre cobriu o Jev")).toBeNull();
  });
});

describe("CartaoDoJev — leitura e idioma", () => {
  it("quem não administra vê o estado, sem os botões de mudar", () => {
    montar({ ...dados({ config: { ligado: true, modo: "decide" } }), pode_editar: false });
    expect(screen.queryByRole("button", { name: "Desligar" })).toBeNull();
    expect(screen.getByTestId("jev-numeros")).toBeInTheDocument();
  });

  it("falha ao carregar vira aviso com 'Tentar de novo', e não some", () => {
    montar(null, { erro: "sem permissão" });
    expect(screen.getByText("sem permissão")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(recarregar).toHaveBeenCalled();
  });

  it("fala espanhol com quem escolheu espanhol", () => {
    montar(dados({ config: { ligado: true, modo: "decide" } }), { idioma: "es" });
    expect(screen.getByRole("heading", { name: "Jev: decisiones rápidas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desactivar" })).toBeInTheDocument();
  });
});

describe("jevNoPonto — a linha do cartão do ponto", () => {
  it("só aparece no ponto que o Jev atende, e com ele ligado", () => {
    expect(jevNoPonto(dados(), "sentiment_classify")).toBeNull();
    expect(jevNoPonto(null, "sentiment_classify")).toBeNull();
    const ligado = dados({ config: { ligado: true } });
    expect(jevNoPonto(ligado, "stage_classify")).toBeNull();
    expect(jevNoPonto(ligado, "sentiment_classify")).toBe("observacao");
    expect(jevNoPonto(dados({ config: { ligado: true, modo: "decide" } }), "sentiment_classify")).toBe(
      "decide",
    );
    expect(
      jevNoPonto(dados({ config: { ligado: true }, tem_ia_de_sempre: false }), "sentiment_classify"),
    ).toBe("sozinho");
    // Parado (chave sem passar no teste): o ponto não diz que o Jev mede.
    expect(jevNoPonto(dados({ config: { ligado: true }, chave: { validada: false } }), "sentiment_classify")).toBeNull();
  });
});

describe("useDadosDoJev — falha de rede", () => {
  it("vira frase em português, não o inglês do navegador", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const { result } = renderHook(() => useDadosDoJev(), {
      wrapper: ({ children }) => <IdiomaProvider locale="pt-BR">{children}</IdiomaProvider>,
    });
    await waitFor(() => expect(result.current.erro).not.toBeNull());
    expect(result.current.erro).toBe("Não consegui falar com o servidor. Confira a internet e tente de novo.");
  });
});
