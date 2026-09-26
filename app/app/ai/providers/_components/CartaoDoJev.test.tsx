/**
 * O cartão do Jev tem seis estados, e cada um responde a pergunta que a pessoa
 * tem naquele momento: "o que é isto?", "por que a chave não passou?", "o que
 * acontece se eu ligar?", "ele concorda com a minha IA?", "quanto está custando?"
 * e "por que ele decide sozinho?". Os dados vêm de `GET /api/v1/ai/jev`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TAREFA_DA_MANIPULACAO,
  TAREFA_DO_CLIMA,
  TAREFA_DO_PEDIDO_DE_HUMANO,
  TAREFA_DO_PEDIDO_PARA_PARAR,
  TAREFA_DO_ROTEADOR,
} from "@/lib/ai/decisao/tarefas";
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

/**
 * "Deixar o Jev decidir" pede confirmação: o clique no cartão abre o diálogo, e
 * só o do diálogo muda alguma coisa. Devolve o diálogo, já confirmado.
 */
async function confirmarDecidir(botao: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(botao);
  const dialogo = await screen.findByRole("alertdialog");
  // Antes de confirmar, nada foi enviado.
  expect(chamadas.filter((c) => c.metodo === "PATCH")).toEqual([]);
  fireEvent.click(within(dialogo).getByRole("button", { name: "Deixar o Jev decidir" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  return dialogo;
}

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

  /**
   * O clima desligado guarda o `modo` de antes. Lido pelo `modo`, o cartão
   * prometia "volta decidindo" (ou, sem IA, "decidindo sozinho") e, ligado,
   * caía em pausa sem medir nada.
   */
  it.each([
    ["com a IA de sempre", true],
    ["sem a IA de sempre", false],
  ])("clima desligado (%s): diz que ele volta desligado, e não o que o `modo` diria", (_c, ia) => {
    montar(
      dados({
        config: { modo: "decide", aceite: { em: "2026-09-20T12:00:00Z", por: "u1" } },
        tem_ia_de_sempre: ia,
        por_tarefa: [
          {
            id: "clima",
            ponto: "sentiment_classify",
            rotulo: "Medir o clima da conversa",
            oQueFaz: "Percebe se o cliente está irritado.",
            estado: "desligada",
            ao_ligar: "desligada",
            novo: false,
          },
        ],
      }),
    );
    expect(cartao()).toHaveAttribute("data-estado", "pronto");
    expect(screen.getByTestId("jev-ao-ligar-clima")).toHaveTextContent("(Pausada)");
    expect(screen.getByTestId("jev-ao-ligar")).toHaveTextContent(/tarefas pausadas continuam assim/);
    // Sem a IA de sempre, religar o clima é deixá-lo decidir sozinho: o aviso
    // vem ANTES de ligar, e só nesse caso.
    if (ia) expect(cartao()).not.toHaveTextContent(/decidindo sozinho/);
    else expect(screen.getByTestId("jev-ao-ligar")).toHaveTextContent(/clima religado volta decidindo sozinho/);
  });

  /**
   * A frase de baixo falava do clima como se fosse o Jev inteiro: "Ele começa
   * só observando" com o roteador voltando a decidir (o estado dele ficou
   * gravado), e "Ele volta decidindo" com as tarefas novas só observando.
   */
  it("cada tarefa diz como volta, e a frase de baixo não fala por todas", () => {
    montar(
      dados({
        config: { modo: "observacao", aceite: { em: "2026-09-20T12:00:00Z", por: "u1" } },
        por_tarefa: [
          { id: "clima", ponto: "sentiment_classify", rotulo: "Medir o clima da conversa", oQueFaz: "Mede.", estado: "desligada", ao_ligar: "observando", novo: false },
          { id: "roteador", ponto: "intent_router", rotulo: "Escolher qual agente atende", oQueFaz: "Escolhe.", estado: "desligada", ao_ligar: "decidindo", novo: false },
        ],
      }),
    );
    expect(screen.getByTestId("jev-ao-ligar-clima")).toHaveTextContent("(Só observa)");
    expect(screen.getByTestId("jev-ao-ligar-roteador")).toHaveTextContent("(Decide)");
    expect(screen.getByTestId("jev-ao-ligar")).toHaveTextContent(/Onde ele decide, vale a escolha que você fez/);
    expect(screen.getByTestId("jev-ao-ligar")).not.toHaveTextContent(/^Ele /);
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

    const dialogo = await confirmarDecidir(screen.getByRole("button", { name: "Deixar o Jev decidir" }));
    // O efeito concreto daquela tarefa, e a volta.
    expect(dialogo).toHaveTextContent(TAREFA_DO_CLIMA.aoConfirmarDecidir);
    expect(dialogo).toHaveTextContent("Dá para voltar a só observar quando quiser.");
    await waitFor(() => expect(recarregar).toHaveBeenCalled());
    expect(chamadas[0]).toEqual({ url: "/api/v1/ai/jev", metodo: "PATCH", corpo: { modo: "decide" } });
  });

  it("cancelar o diálogo não muda nada", async () => {
    montar(dados({ config: { ligado: true, modo: "observacao" } }));
    fireEvent.click(screen.getByRole("button", { name: "Deixar o Jev decidir" }));
    const dialogo = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialogo).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(chamadas).toEqual([]);
    expect(recarregar).not.toHaveBeenCalled();
  });

  /**
   * Os números da concordância no meio da frase: na fonte mono cada espaço tinha
   * a largura de um algarismo, e a frase lia "5  de  7". jsdom não carrega o CSS
   * do Tailwind, então o que se mede aqui é a classe; a fonte calculada é da
   * prova em tela.
   */
  it("os números da concordância usam a fonte do texto, com algarismos de largura igual", () => {
    montar(
      dados({
        config: { ligado: true, modo: "observacao" },
        numeros: { observacao: { dias: 30, comparadas: 7, concordaram: 5 } },
      }),
    );
    const numeros = screen.getByTestId("jev-concordancia-numeros-clima");
    expect(numeros).toHaveTextContent("5 de 7");
    expect(numeros).toHaveClass("tabular-nums");
    expect(numeros).not.toHaveClass("font-mono");
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
    // "Respostas do Jev" segue o primeiro: é o que a spec do e2e lê.
    expect(numeros.querySelector("dt")).toHaveTextContent("Respostas do Jev");
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

  it("a última falha diz de qual tarefa: o disjuntor da pergunta recusada é por tarefa", () => {
    montar({
      ...decidindo(),
      ultima_falha: { motivo: "jev_contrato_invalido", em: "2026-09-22T10:00:00Z", tarefa: "Escolher qual agente atende" },
    });
    expect(screen.getByTestId("jev-ultima-falha")).toHaveTextContent(/Última falha — Escolher qual agente atende/);
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
    expect(jevNoPonto(dados({ config: { ligado: true, modo: "decide" } }), "sentiment_classify")).toEqual({
      decide: TAREFA_DO_CLIMA.aoDecidirNoPonto,
    });
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

describe("CartaoDoJev — por tarefa", () => {
  const CLIMA = {
    id: "clima",
    ponto: "sentiment_classify",
    rotulo: "Medir o clima da conversa",
    oQueFaz: "Percebe se o cliente está irritado.",
    novo: false,
  } as const;
  /** Uma tarefa que a rota ainda não devolve: o cartão desenha o que vier. */
  const NOVA = {
    id: "manipulacao",
    ponto: "jailbreak_detect",
    rotulo: "Perceber manipulação",
    oQueFaz: "Percebe quem tenta enganar o agente.",
    estado: "observando",
    novo: true,
  } as const;

  it("resposta sem `por_tarefa` (a imagem anterior): o clima numa linha, pelo `modo`", () => {
    montar(dados({ config: { ligado: true, modo: "decide" } }));
    expect(cartao()).toHaveAttribute("data-estado", "decidindo");
    expect(screen.getByTestId("jev-tarefa-clima")).toHaveAttribute("data-estado", "decidindo");
  });

  it("cada tarefa na sua linha, com o seu estado, o selo Novo e o seu botão", async () => {
    montar(
      dados({
        config: { ligado: true, modo: "decide" },
        por_tarefa: [{ ...CLIMA, estado: "decidindo" }, NOVA],
      }),
    );
    expect(cartao()).toHaveAttribute("data-estado", "decidindo");
    const nova = screen.getByTestId("jev-tarefa-manipulacao");
    expect(nova).toHaveAttribute("data-estado", "observando");
    expect(nova).toHaveTextContent("Nova");
    // O selo diz o que quer dizer, e não é mais ruído permanente.
    expect(screen.getByTestId("jev-nova-manipulacao")).toHaveTextContent(/nada muda para o cliente/);
    expect(screen.getByTestId("jev-tarefa-clima")).not.toHaveTextContent("Nova");

    // Deixar decidir a tarefa nova não é deixar decidir o clima (que já decide).
    await confirmarDecidir(screen.getByRole("button", { name: "Deixar o Jev decidir" }));
    await waitFor(() => expect(recarregar).toHaveBeenCalledTimes(1));
    // Voltar a só observar não pede confirmação: tira o Jev do caminho do cliente.
    fireEvent.click(screen.getByRole("button", { name: "Voltar a só observar" }));
    await waitFor(() => expect(recarregar).toHaveBeenCalledTimes(2));
    expect(chamadas.map((c) => c.corpo)).toEqual([
      { tarefa: "manipulacao", estado: "decidindo" },
      // O clima segue pelo `modo`, o nome que a imagem anterior também entende.
      { modo: "observacao" },
    ]);
  });

  /** Cada tarefa diz no diálogo o que muda NELA — decidir o clima não é decidir o roteador. */
  it.each([
    [TAREFA_DO_CLIMA, { modo: "decide" }],
    [TAREFA_DA_MANIPULACAO, { tarefa: "manipulacao", estado: "decidindo" }],
    [TAREFA_DO_ROTEADOR, { tarefa: "roteador", estado: "decidindo" }],
  ])("o diálogo de $id diz o efeito dela antes de mudar", async (tarefa, corpo) => {
    montar(
      dados({
        config: { ligado: true, modo: "observacao" },
        por_tarefa: [
          { id: tarefa.id, ponto: tarefa.ponto, rotulo: tarefa.rotulo, oQueFaz: tarefa.oQueFaz, estado: "observando", novo: false },
        ],
      }),
    );
    const dialogo = await confirmarDecidir(screen.getByRole("button", { name: "Deixar o Jev decidir" }));
    expect(dialogo).toHaveAttribute("data-tarefa", tarefa.id);
    expect(dialogo).toHaveTextContent(tarefa.rotulo);
    expect(dialogo).toHaveTextContent(tarefa.aoConfirmarDecidir);
    await waitFor(() => expect(recarregar).toHaveBeenCalledTimes(1));
    expect(chamadas.map((c) => c.corpo)).toEqual([corpo]);
  });

  it("'Manter só observando' grava o estado que já vale — e o selo 'Nova' sai sem mudar nada", async () => {
    montar(dados({ config: { ligado: true, modo: "observacao" }, por_tarefa: [{ ...CLIMA, estado: "observando" }, NOVA] }));
    fireEvent.click(within(screen.getByTestId("jev-tarefa-manipulacao")).getByRole("button", { name: "Manter só observando" }));
    await waitFor(() => expect(recarregar).toHaveBeenCalledTimes(1));
    expect(chamadas.map((c) => c.corpo)).toEqual([{ tarefa: "manipulacao", estado: "observando" }]);
    // Só a tarefa nova tem o botão.
    expect(within(screen.getByTestId("jev-tarefa-clima")).queryByRole("button", { name: "Manter só observando" })).toBeNull();
  });

  /**
   * O clima desligado sozinho guarda o `modo` de antes. O cartão dizia
   * "Observando — a sua IA de sempre ainda decide" (ou, sem IA, "Decidindo
   * sozinho") para um Jev que não mede nada, e não havia botão de volta.
   */
  it.each([
    ["com a IA de sempre", true],
    ["sem a IA de sempre", false],
  ])("tarefa desligada (%s): o cartão diz em pausa, sem concordância, e oferece religar observando", async (_c, ia) => {
    montar(
      dados({
        config: { ligado: true, modo: "decide" },
        tem_ia_de_sempre: ia,
        por_tarefa: [{ ...CLIMA, estado: "desligada" }],
      }),
    );
    expect(cartao()).toHaveAttribute("data-estado", "em_pausa");
    // "pausadas", o verbo que cada linha já usa ("Pausada").
    expect(cartao()).toHaveTextContent("Ligado, mas com todas as tarefas pausadas");
    expect(screen.getByTestId("jev-tarefa-clima")).toHaveAttribute("data-estado", "desligada");
    expect(screen.queryByRole("button", { name: "Deixar o Jev decidir" })).toBeNull();
    expect(screen.queryByTestId("jev-concordancia")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Religar" }));
    await waitFor(() => expect(recarregar).toHaveBeenCalledTimes(1));
    expect(chamadas.map((c) => c.corpo)).toEqual([{ modo: "observacao" }]);
  });

  it("uma tarefa desligada não apaga o estado geral das que rodam", () => {
    montar(
      dados({
        config: { ligado: true, modo: "observacao" },
        por_tarefa: [{ ...CLIMA, estado: "desligada" }, NOVA],
      }),
    );
    expect(cartao()).toHaveAttribute("data-estado", "observando");
    expect(screen.getByTestId("jev-tarefa-manipulacao")).toHaveAttribute("data-estado", "observando");
  });

  it("o selo de cada tarefa sai em espanhol", () => {
    montar(dados({ config: { ligado: true, modo: "observacao" }, por_tarefa: [{ ...CLIMA, estado: "observando" }] }), {
      idioma: "es",
    });
    expect(screen.getByTestId("jev-tarefa-clima")).toHaveTextContent("Solo observa");
  });

  it("jevNoPonto segue o estado da tarefa daquele ponto", () => {
    const d = (estado: "observando" | "decidindo" | "desligada") =>
      dados({ config: { ligado: true, modo: "decide" }, por_tarefa: [{ ...CLIMA, estado }] });
    expect(jevNoPonto(d("desligada"), "sentiment_classify")).toBeNull();
    expect(jevNoPonto(d("observando"), "sentiment_classify")).toBe("observacao");
    expect(jevNoPonto(d("decidindo"), "sentiment_classify")).toEqual({ decide: TAREFA_DO_CLIMA.aoDecidirNoPonto });
    // Só o clima decide sem a IA de sempre (DEC-012 #5); a tarefa nova, não.
    const semIa = dados({ config: { ligado: true }, tem_ia_de_sempre: false, por_tarefa: [NOVA] });
    expect(jevNoPonto(semIa, "jailbreak_detect")).toBe("observacao");
  });

  it("jevNoPonto: a manipulação decidindo SOMA — o modelo do ponto segue decidindo, não vira reserva", () => {
    const d = dados({ config: { ligado: true }, por_tarefa: [{ ...NOVA, estado: "decidindo" }] });
    expect(jevNoPonto(d, "jailbreak_detect")).toEqual({ decide: TAREFA_DA_MANIPULACAO.aoDecidirNoPonto });
    expect(TAREFA_DA_MANIPULACAO.aoDecidirNoPonto).not.toMatch(/reserva/);
  });

  /**
   * O roteador decidindo herdava a frase do clima ("o Jev mede primeiro; a sua
   * IA de sempre só entra se ele não responder"). Falsa: no roteador os dois
   * são perguntados a cada mensagem, e sem a IA de sempre a escolha do Jev não
   * vale (R2). Quem acreditasse tiraria a IA de sempre — e o roteamento voltaria
   * ao agente de antes com o cartão dizendo que o Jev decide.
   */
  it("o roteador decidindo diz que a IA de sempre segue sendo perguntada, e que sem ela o Jev não escolhe", () => {
    const ROTEADOR = {
      id: "roteador",
      ponto: "intent_router",
      rotulo: "Escolher qual agente atende",
      oQueFaz: "Escolhe o agente.",
      estado: "decidindo",
      novo: false,
    } as const;
    const d = dados({ config: { ligado: true, modo: "decide" }, por_tarefa: [{ ...CLIMA, estado: "decidindo" }, ROTEADOR] });
    montar(d);
    const linha = screen.getByTestId("jev-decide-roteador");
    expect(linha).not.toHaveTextContent(/mede primeiro|só entra se ele não responder/);
    expect(linha).toHaveTextContent(/a cada mensagem/);
    expect(linha).toHaveTextContent(/nunca só o Jev/);
    expect(jevNoPonto(d, "intent_router")).toEqual({ decide: TAREFA_DO_ROTEADOR.aoDecidirNoPonto });
    expect(TAREFA_DO_ROTEADOR.aoDecidirNoPonto).not.toMatch(/mede primeiro/);
  });

  it("a tarefa nova mostra a concordância dela (de jev_observacoes), e o clima a dele", () => {
    montar(
      dados({
        config: { ligado: true, modo: "observacao" },
        numeros: { observacao: { dias: 30, comparadas: 10, concordaram: 9 } },
        por_tarefa: [
          { ...CLIMA, estado: "observando", observacao: { dias: 30, comparadas: 10, concordaram: 9 } },
          { ...NOVA, observacao: { dias: 30, comparadas: 4, concordaram: 3 } },
        ],
      }),
    );
    expect(screen.getByTestId("jev-concordancia")).toHaveTextContent(/9 de 10/);
    const daNova = screen.getByTestId("jev-concordancia-manipulacao");
    // Diz EM QUE os dois concordaram — o nível do alerta.
    expect(daNova).toHaveTextContent(/deram o mesmo alerta \(nenhum, leve ou forte\) em 3 de 4 mensagens/);
    // A frase da passagem para humano é do clima, e só dele.
    expect(daNova).not.toHaveTextContent(/chamariam/);
  });

  it("o clima que bateu no teto da amostra diz que a conta usa só as mais recentes", () => {
    montar(
      dados({
        config: { ligado: true, modo: "observacao" },
        por_tarefa: [{ ...CLIMA, estado: "observando", observacao: { dias: 30, comparadas: 500, concordaram: 480, teto_da_amostra: 500 } }],
      }),
    );
    expect(screen.getByTestId("jev-concordancia")).toHaveTextContent(/480 de 500 .* A conta usa só as 500 mensagens mais recentes do período/);
  });

  it("a manipulação mostra quantas vezes só o Jev daria o alerta forte — o que decidir muda nela", () => {
    montar(
      dados({
        config: { ligado: true, modo: "observacao" },
        por_tarefa: [{ ...NOVA, observacao: { dias: 30, comparadas: 40, concordaram: 39, so_o_jev_alto: 1 } }],
      }),
    );
    expect(screen.getByTestId("jev-concordancia-manipulacao")).toHaveTextContent(/Só o Jev daria o alerta forte em 1 delas/);
  });

  /**
   * As tarefas em cascata não concordam com nada — o Jev só é perguntado onde a
   * regra de hoje disse não —: contam as MENSAGENS em que ele percebeu o pedido
   * que a regra não reconheceu, com as conversas. A unidade é a mensagem: o
   * worker pergunta antes da janela do turno, e a rajada com duas frases
   * naturais conta duas. O `decidindo` delas é "Avisar a equipe": um aviso na
   * Central, nunca "Deixar o Jev decidir".
   */
  describe("as tarefas em cascata", () => {
    const HUMANO = {
      id: "humano",
      ponto: null,
      rotulo: TAREFA_DO_PEDIDO_DE_HUMANO.rotulo,
      oQueFaz: TAREFA_DO_PEDIDO_DE_HUMANO.oQueFaz,
      estado: "observando",
      novo: true,
      observacao: null,
    } as const;
    const conversa = (n: number) => ({ href: `/app/inbox/c-${n}`, em: `2026-09-2${n}T14:3${n}:00.000Z` });

    it("uma mensagem: singular, com o link para a conversa — e nenhuma concordância", () => {
      montar(
        dados({
          config: { ligado: true, modo: "observacao" },
          por_tarefa: [{ ...HUMANO, percebidos: { dias: 30, mensagens: 1, conversas: [conversa(1)] } }],
        }),
      );
      const frase = screen.getByTestId("jev-percebidos-humano");
      expect(frase).toHaveTextContent(
        "Nos últimos 30 dias, o Jev percebeu 1 mensagem pedindo para falar com uma pessoa em que a regra de hoje não reconheceu o pedido.",
      );
      const links = within(screen.getByTestId("jev-percebidos-conversas-humano")).getAllByRole("link");
      expect(links.map((l) => l.getAttribute("href"))).toEqual(["/app/inbox/c-1"]);
      expect(links[0]).toHaveAccessibleName(/^Abrir a conversa do pedido de /);
      expect(screen.queryByTestId("jev-concordancia-humano")).toBeNull();
    });

    it("várias mensagens: plural, e um link por conversa; nenhuma: frase própria, sem número e sem links", () => {
      const { unmount } = montar(
        dados({
          config: { ligado: true, modo: "observacao" },
          por_tarefa: [
            { ...HUMANO, percebidos: { dias: 30, mensagens: 7, conversas: [conversa(1), conversa(2), conversa(3)] } },
            {
              ...HUMANO,
              id: "opt_out",
              rotulo: TAREFA_DO_PEDIDO_PARA_PARAR.rotulo,
              oQueFaz: TAREFA_DO_PEDIDO_PARA_PARAR.oQueFaz,
              percebidos: { dias: 30, mensagens: 0, conversas: [] },
            },
          ],
        }),
      );
      expect(screen.getByTestId("jev-percebidos-humano")).toHaveTextContent(
        "Nos últimos 30 dias, o Jev percebeu 7 mensagens pedindo para falar com uma pessoa em que a regra de hoje não reconheceu o pedido.",
      );
      expect(within(screen.getByTestId("jev-percebidos-conversas-humano")).getAllByRole("link")).toHaveLength(3);
      // Zero não é "percebeu 0": lia-se como defeito, e a frase é outra.
      const nenhuma = screen.getByTestId("jev-percebidos-opt_out");
      expect(nenhuma).toHaveTextContent(
        "Nos últimos 30 dias, o Jev ainda não percebeu nenhuma mensagem pedindo para parar de receber mensagens em que a regra de hoje não reconheceu o pedido.",
      );
      expect(nenhuma).not.toHaveTextContent(/\b0\b/);
      expect(screen.queryByTestId("jev-percebidos-conversas-opt_out")).toBeNull();
      unmount();
    });

    it("observando: o botão é 'Avisar a equipe', nunca 'Deixar o Jev decidir' — com pausar e manter", () => {
      montar(
        dados({
          config: { ligado: true, modo: "observacao" },
          por_tarefa: [
            { ...CLIMA, estado: "observando" },
            { ...HUMANO, percebidos: { dias: 30, mensagens: 0, conversas: [] } },
          ],
        }),
      );
      const linha = within(screen.getByTestId("jev-tarefa-humano"));
      expect(linha.queryByRole("button", { name: "Deixar o Jev decidir" })).toBeNull();
      expect(linha.getByRole("button", { name: "Avisar a equipe" })).toBeInTheDocument();
      expect(linha.getByRole("button", { name: "Pausar esta tarefa" })).toBeInTheDocument();
      expect(linha.getByRole("button", { name: "Manter só observando" })).toBeInTheDocument();
      // A tarefa nova diz o que o selo quer dizer — sem prometer decisão.
      expect(screen.getByTestId("jev-nova-humano")).toHaveTextContent(
        "Começou sozinha, só observando: nada muda até você pedir para o Jev avisar a equipe.",
      );
      // Controle: o clima, na mesma tela, decide.
      expect(
        within(screen.getByTestId("jev-tarefa-clima")).getByRole("button", { name: "Deixar o Jev decidir" }),
      ).toBeInTheDocument();
    });

    it.each([
      ["humano", TAREFA_DO_PEDIDO_DE_HUMANO],
      ["opt_out", TAREFA_DO_PEDIDO_PARA_PARAR],
    ] as const)("%s: 'Avisar a equipe' pede confirmação com o efeito — e só o diálogo grava", async (id, registro) => {
      montar(
        dados({
          config: { ligado: true, modo: "observacao" },
          por_tarefa: [{ ...HUMANO, id, rotulo: registro.rotulo, oQueFaz: registro.oQueFaz }],
        }),
      );
      fireEvent.click(within(screen.getByTestId(`jev-tarefa-${id}`)).getByRole("button", { name: "Avisar a equipe" }));
      const dialogo = await screen.findByRole("alertdialog");
      expect(dialogo).toHaveAttribute("data-tarefa", id);
      expect(within(dialogo).getByRole("heading")).toHaveTextContent("Avisar a equipe?");
      expect(dialogo).toHaveTextContent(registro.aoConfirmarDecidir);
      expect(dialogo).not.toHaveTextContent("Deixar o Jev decidir");
      expect(chamadas.filter((c) => c.metodo === "PATCH")).toEqual([]);
      fireEvent.click(within(dialogo).getByRole("button", { name: "Avisar a equipe" }));
      await waitFor(() => expect(recarregar).toHaveBeenCalledTimes(1));
      expect(chamadas.filter((c) => c.metodo === "PATCH").map((c) => c.corpo)).toEqual([{ tarefa: id, estado: "decidindo" }]);
    });

    it("avisando: o selo diz 'Avisa a equipe', a frase diz o que acontece, e dá para voltar a só observar", () => {
      montar(
        dados({
          config: { ligado: true, modo: "observacao" },
          por_tarefa: [{ ...HUMANO, estado: "decidindo", novo: false, percebidos: { dias: 30, mensagens: 0, conversas: [] } }],
        }),
      );
      const linha = screen.getByTestId("jev-tarefa-humano");
      expect(linha).toHaveAttribute("data-estado", "decidindo");
      expect(linha).toHaveTextContent("Avisa a equipe");
      expect(linha).not.toHaveTextContent(/\bDecide\b/);
      expect(screen.getByTestId("jev-decide-humano")).toHaveTextContent(TAREFA_DO_PEDIDO_DE_HUMANO.aoDecidir);
      expect(within(linha).getByRole("button", { name: "Voltar a só observar" })).toBeInTheDocument();
    });

    /**
     * O cartão inteiro não diz "Decide" onde o Jev só avisa: com o clima
     * observando e o pedido de pessoa em "Avisar a equipe", o cliente não sente
     * nada — o selo, a frase e o `data-estado` são os de quem observa. Só a
     * linha da tarefa diz "Avisa a equipe".
     */
    it.each([
      ["com o clima observando", [{ ...CLIMA, estado: "observando" }]],
      ["sozinha", []],
    ] as const)("avisando a equipe %s, o cartão diz que o Jev observa, e não que decide", (_caso, outras) => {
      montar(
        dados({
          config: { ligado: true, modo: "observacao" },
          por_tarefa: [...outras, { ...HUMANO, estado: "decidindo", novo: false, percebidos: { dias: 30, mensagens: 0, conversas: [] } }],
        }),
      );
      expect(cartao()).toHaveAttribute("data-estado", "observando");
      expect(cartao()).not.toHaveTextContent(/Decide em parte|Decidindo|Decide\b/);
      expect(screen.getByTestId("jev-tarefas").previousElementSibling).toHaveTextContent(/^Observando — /);
      expect(screen.getByTestId("jev-tarefa-humano")).toHaveTextContent("Avisa a equipe");
    });

    /**
     * A frase de estado do cartão é verdadeira para o que DE FATO roda. Só as
     * tarefas de pedidos rodando: não há o que comparar, e a "sua IA de sempre"
     * pode nem existir — a frase fala só do que o Jev faz nelas. Com tarefas
     * que comparam, a frase delas vale, e os pedidos ganham a sua. Decidindo em
     * parte, a frase nomeia também quem só avisa a equipe.
     */
    const PARAR = { ...HUMANO, id: "opt_out", rotulo: TAREFA_DO_PEDIDO_PARA_PARAR.rotulo, oQueFaz: TAREFA_DO_PEDIDO_PARA_PARAR.oQueFaz };
    const pedidos = (humano: "observando" | "decidindo", parar: "observando" | "decidindo" = "observando") => [
      { ...HUMANO, estado: humano, novo: false },
      { ...PARAR, estado: parar, novo: false },
    ];
    const frase = () => screen.getByTestId("jev-tarefas").previousElementSibling?.textContent ?? "";
    it.each([
      [
        "só os pedidos, observando",
        { ia: true, tarefas: [{ ...CLIMA, estado: "desligada" }, ...pedidos("observando")] },
        "observando",
        "Observando — o Jev só conta as mensagens em que o cliente faz um pedido que a regra de hoje não reconheceu. Nada muda no atendimento.",
      ],
      [
        "só os pedidos, um avisando a equipe",
        { ia: true, tarefas: [{ ...CLIMA, estado: "desligada" }, ...pedidos("decidindo")] },
        "observando",
        "Observando — o Jev conta as mensagens em que o cliente faz um pedido que a regra de hoje não reconheceu, e avisa a equipe na Central. Ele não decide nada no atendimento.",
      ],
      [
        "só os pedidos, e sem a IA de sempre",
        { ia: false, tarefas: [{ ...CLIMA, estado: "desligada" }, ...pedidos("observando", "decidindo")] },
        "observando",
        "Observando — o Jev conta as mensagens em que o cliente faz um pedido que a regra de hoje não reconheceu, e avisa a equipe na Central. Ele não decide nada no atendimento.",
      ],
      [
        "o clima observando e os pedidos observando",
        { ia: true, tarefas: [{ ...CLIMA, estado: "observando" }, ...pedidos("observando")] },
        "observando",
        "Observando — onde o Jev compara, a sua IA de sempre ainda decide: compare os dois antes de deixar o Jev decidir. Nos pedidos do cliente, ele só conta as mensagens em que a regra de hoje não reconheceu o pedido.",
      ],
      [
        "o clima observando e um pedido avisando",
        { ia: true, tarefas: [{ ...CLIMA, estado: "observando" }, ...pedidos("decidindo")] },
        "observando",
        "Observando — onde o Jev compara, a sua IA de sempre ainda decide: compare os dois antes de deixar o Jev decidir. Nos pedidos do cliente, ele conta as mensagens em que a regra de hoje não reconheceu o pedido, e avisa a equipe.",
      ],
      [
        "o clima decidindo e um pedido avisando",
        { ia: true, tarefas: [{ ...CLIMA, estado: "decidindo" }, ...pedidos("decidindo")] },
        "decidindo",
        "Decidindo em parte — cada tarefa abaixo diz se o Jev decide, só observa ou avisa a equipe nela.",
      ],
      [
        "o clima decidindo e os pedidos só observando (controle)",
        { ia: true, tarefas: [{ ...CLIMA, estado: "decidindo" }, ...pedidos("observando")] },
        "decidindo",
        "Decidindo em parte — cada tarefa abaixo diz se o Jev decide ou só observa nela.",
      ],
      [
        "só o clima, observando (controle: a frase de sempre)",
        { ia: true, tarefas: [{ ...CLIMA, estado: "observando" }] },
        "observando",
        "Observando — a sua IA de sempre ainda decide. Compare os dois antes de deixar o Jev decidir.",
      ],
    ] as const)("a frase do cartão, com %s, diz o que de fato roda", (_caso, c, estado, esperada) => {
      montar(dados({ config: { ligado: true, modo: "observacao" }, tem_ia_de_sempre: c.ia, por_tarefa: [...c.tarefas] }));
      expect(cartao()).toHaveAttribute("data-estado", estado);
      expect(frase()).toBe(esperada);
    });

    it("com o clima decidindo, o pedido avisando conta como a parte que não decide (controle)", () => {
      montar(
        dados({
          config: { ligado: true, modo: "decide" },
          por_tarefa: [
            { ...CLIMA, estado: "decidindo" },
            { ...HUMANO, estado: "decidindo", novo: false, percebidos: { dias: 30, mensagens: 0, conversas: [] } },
          ],
        }),
      );
      expect(cartao()).toHaveAttribute("data-estado", "decidindo");
      expect(cartao()).toHaveTextContent("Decide em parte");
    });

    it("antes de ligar, avisar a equipe não é 'Onde ele decide'", () => {
      montar(
        dados({
          por_tarefa: [
            { ...CLIMA, estado: "observando", ao_ligar: "observando" },
            { ...HUMANO, estado: "decidindo", ao_ligar: "decidindo", novo: false },
          ],
        }),
      );
      expect(screen.getByTestId("jev-ao-ligar-humano")).toHaveTextContent("(Avisa a equipe)");
      expect(screen.getByTestId("jev-ao-ligar")).not.toHaveTextContent(/Onde ele decide/);
      expect(screen.getByTestId("jev-ao-ligar")).toHaveTextContent(/Onde ele só observa/);
    });

    /**
     * O worker só pergunta os pedidos onde o atendimento automático rodaria. Numa
     * empresa em que ele não roda em número nenhum — ninguém no ar sem pausa, ou
     * o atendimento com um sistema de fora —, "Só observa" com "nenhuma
     * mensagem" seria para sempre: a tarefa diz "Não roda", e por quê.
     */
    it.each([
      ["ninguem_no_ar", /nenhum atendente automático está no ar — o Jev só é perguntado onde um atendente responderia/, true],
      ["externo", /quem conduz as conversas desta empresa é um sistema de fora/, false],
    ] as const)("sem atendimento automático (%s): 'Não roda' com o motivo, sem contar nem avisar", (motivo, frase, comLink) => {
      montar(
        dados({
          config: { ligado: true, modo: "observacao" },
          por_tarefa: [
            { ...CLIMA, estado: "observando" },
            { ...HUMANO, sem_atendente: motivo, percebidos: { dias: 30, mensagens: 0, conversas: [] } },
          ],
        }),
      );
      const linha = screen.getByTestId("jev-tarefa-humano");
      expect(linha).toHaveTextContent("Não roda");
      expect(linha).not.toHaveTextContent("Só observa");
      const porQue = screen.getByTestId("jev-sem-atendente-humano");
      expect(porQue).toHaveTextContent(frase);
      expect(within(porQue).queryAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(comLink ? ["/app/ai/agents"] : []);
      // Nada do que só vale rodando: nem a contagem, nem "começou observando", nem avisar.
      expect(screen.queryByTestId("jev-percebidos-humano")).toBeNull();
      expect(screen.queryByTestId("jev-nova-humano")).toBeNull();
      expect(within(linha).queryByRole("button", { name: "Avisar a equipe" })).toBeNull();
      // Parada, ela não observa nada: "Manter só observando" prometeria o contrário.
      expect(within(linha).queryByRole("button", { name: "Manter só observando" })).toBeNull();
      expect(within(linha).getByRole("button", { name: "Pausar esta tarefa" })).toBeInTheDocument();
      // A tarefa parada não entra na frase do cartão: só o clima roda.
      expect(screen.getByTestId("jev-tarefas").previousElementSibling).toHaveTextContent(
        "Observando — a sua IA de sempre ainda decide. Compare os dois antes de deixar o Jev decidir.",
      );
    });

    it("sem atendimento automático e só os pedidos ligados: o cartão diz que nada está rodando", () => {
      montar(
        dados({
          config: { ligado: true, modo: "observacao" },
          por_tarefa: [
            { ...CLIMA, estado: "desligada" },
            { ...HUMANO, sem_atendente: "ninguem_no_ar" },
            { ...HUMANO, id: "opt_out", rotulo: TAREFA_DO_PEDIDO_PARA_PARAR.rotulo, sem_atendente: "ninguem_no_ar" },
          ],
        }),
      );
      expect(cartao()).toHaveAttribute("data-estado", "em_pausa");
      expect(cartao()).toHaveTextContent(/nenhuma tarefa está rodando agora/);
    });

    it("controle: com quem atenda, a mesma tarefa só observa, conta e oferece avisar", () => {
      montar(
        dados({
          config: { ligado: true, modo: "observacao" },
          por_tarefa: [{ ...HUMANO, sem_atendente: null, percebidos: { dias: 30, mensagens: 0, conversas: [] } }],
        }),
      );
      const linha = screen.getByTestId("jev-tarefa-humano");
      expect(linha).toHaveTextContent("Só observa");
      expect(screen.queryByTestId("jev-sem-atendente-humano")).toBeNull();
      expect(screen.getByTestId("jev-percebidos-humano")).toBeInTheDocument();
      expect(screen.getByTestId("jev-nova-humano")).toBeInTheDocument();
      expect(within(linha).getByRole("button", { name: "Avisar a equipe" })).toBeInTheDocument();
    });

    /**
     * A frase de ANTES de ligar é verdadeira para o que vai rodar, como a do
     * cartão ligado: nos pedidos não há IA de sempre nem o que comparar, e com
     * só eles rodando (o clima pausado) a frase de comparar era falsa por
     * inteiro — sem a IA principal, contradizia a frase seguinte.
     */
    const ANTES_OBSERVA = "Onde ele só observa, a sua IA de sempre continua decidindo, e você compara os dois antes de deixar o Jev decidir.";
    const ANTES_DECIDE =
      "Onde ele decide, vale a escolha que você fez antes de desligá-lo; onde só observa, a sua IA de sempre continua decidindo, e você compara os dois antes de deixar o Jev decidir.";
    const PEDIDOS_OBSERVAM = "Nos pedidos do cliente, o Jev só conta as mensagens em que a regra de hoje não reconheceu o pedido — nada muda no atendimento.";
    const PEDIDOS_AVISAM =
      "Nos pedidos do cliente, o Jev conta as mensagens em que a regra de hoje não reconheceu o pedido e avisa a equipe na Central — ele não decide nada no atendimento.";
    const RELIGAR = "As tarefas pausadas continuam assim: depois de ligar o Jev, religue-as na lista que aparece aqui.";
    const SEM_IA_RELIGADO = "Sem uma IA principal, o clima religado volta decidindo sozinho: não há com quem comparar nem quem cubra uma falha do Jev.";
    type AoLigar = "observando" | "decidindo" | "desligada";
    const aoLigar = (clima: AoLigar, humano: AoLigar, parar: AoLigar, extra: { semAtendente?: boolean } = {}) => [
      { ...CLIMA, estado: clima, ao_ligar: clima },
      { ...HUMANO, estado: humano, ao_ligar: humano, novo: false, ...(extra.semAtendente ? { sem_atendente: "ninguem_no_ar" as const } : {}) },
      { ...PARAR, estado: parar, ao_ligar: parar, novo: false, ...(extra.semAtendente ? { sem_atendente: "ninguem_no_ar" as const } : {}) },
    ];
    it.each([
      ["só os pedidos, observando (o clima pausado)", true, aoLigar("desligada", "observando", "observando"), [PEDIDOS_OBSERVAM, RELIGAR]],
      ["só os pedidos, um avisando", true, aoLigar("desligada", "decidindo", "observando"), [PEDIDOS_AVISAM, RELIGAR]],
      ["só os pedidos, sem a IA de sempre", false, aoLigar("desligada", "observando", "observando"), [PEDIDOS_OBSERVAM, RELIGAR, SEM_IA_RELIGADO]],
      ["o clima observando e os pedidos observando", true, aoLigar("observando", "observando", "observando"), [ANTES_OBSERVA, PEDIDOS_OBSERVAM]],
      ["o clima decidindo e um pedido avisando", true, aoLigar("decidindo", "observando", "decidindo"), [ANTES_DECIDE, PEDIDOS_AVISAM]],
      ["o clima observando e os pedidos sem quem atenda", true, aoLigar("observando", "observando", "decidindo", { semAtendente: true }), [ANTES_OBSERVA]],
    ] as const)("antes de ligar, com %s, a frase diz o que vai rodar", (_caso, ia, tarefas, frases) => {
      montar(dados({ tem_ia_de_sempre: ia, por_tarefa: [...tarefas] }));
      const texto = screen.getByTestId("jev-ao-ligar").textContent?.replace(/\s+/g, " ").trim() ?? "";
      expect(texto).toBe(frases.join(" "));
    });

    it("antes de ligar, a tarefa de pedido que não vai rodar diz por quê — e a que vai rodar não (controle)", () => {
      montar(dados({ por_tarefa: [...aoLigar("observando", "observando", "observando", { semAtendente: true })] }));
      expect(screen.getByTestId("jev-ao-ligar-humano")).toHaveTextContent("(Não roda)");
      expect(screen.getByTestId("jev-ao-ligar-sem-atendente-humano")).toHaveTextContent(
        /nenhum atendente automático está no ar — o Jev só é perguntado onde um atendente responderia/,
      );
      expect(screen.queryByTestId("jev-ao-ligar-sem-atendente-clima")).toBeNull();
      cleanup();
      montar(dados({ por_tarefa: [...aoLigar("observando", "observando", "observando")] }));
      expect(screen.queryByTestId("jev-ao-ligar-sem-atendente-humano")).toBeNull();
    });

    it("antes de ligar, só o clima observando: a frase de sempre, sem a dos pedidos (controle)", () => {
      montar(dados({ por_tarefa: [{ ...CLIMA, estado: "observando", ao_ligar: "observando" }] }));
      expect(screen.getByTestId("jev-ao-ligar").textContent?.replace(/\s+/g, " ").trim()).toBe(ANTES_OBSERVA);
    });

    it("fala espanhol com quem escolheu espanhol, no singular e no plural", () => {
      montar(
        dados({
          config: { ligado: true, modo: "observacao" },
          por_tarefa: [{ ...HUMANO, percebidos: { dias: 30, mensagens: 1, conversas: [conversa(1)] } }],
        }),
        { idioma: "es" },
      );
      expect(screen.getByTestId("jev-percebidos-humano")).toHaveTextContent(
        "En los últimos 30 días, Jev detectó 1 mensaje que pide hablar con una persona en el que la regla de hoy no reconoció el pedido.",
      );
      expect(screen.getByTestId("jev-tarefa-humano")).toHaveTextContent("Detectar pedidos de hablar con una persona");
      cleanup();
      // A frase é traduzida INTEIRA, no plural também — nenhum pedaço em português.
      montar(
        dados({
          config: { ligado: true, modo: "observacao" },
          por_tarefa: [{ ...HUMANO, percebidos: { dias: 30, mensagens: 7, conversas: [conversa(1)] } }],
        }),
        { idioma: "es" },
      );
      expect(screen.getByTestId("jev-percebidos-humano")).toHaveTextContent(
        "En los últimos 30 días, Jev detectó 7 mensajes que piden hablar con una persona en los que la regla de hoy no reconoció el pedido.",
      );
      // O número segue em destaque, onde a tradução o pôs.
      expect(within(screen.getByTestId("jev-percebidos-humano")).getByText("7")).toHaveClass("font-medium");
      cleanup();
      // E o zero, com a frase própria dele, também inteira.
      montar(
        dados({
          config: { ligado: true, modo: "observacao" },
          por_tarefa: [{ ...HUMANO, percebidos: { dias: 30, mensagens: 0, conversas: [] } }],
        }),
        { idioma: "es" },
      );
      expect(screen.getByTestId("jev-percebidos-humano")).toHaveTextContent(
        "En los últimos 30 días, Jev todavía no detectó ningún mensaje que pida hablar con una persona en el que la regla de hoy no haya reconocido el pedido.",
      );
    });
  });

  it("o roteador diz que concordar é levar ao mesmo agente", () => {
    const ROTEADOR = { id: "roteador", ponto: "intent_router", rotulo: "Escolher qual agente atende", oQueFaz: "Escolhe.", estado: "observando", novo: false } as const;
    montar(dados({ config: { ligado: true, modo: "observacao" }, por_tarefa: [{ ...ROTEADOR, observacao: { dias: 30, comparadas: 4, concordaram: 3 } }] }));
    expect(screen.getByTestId("jev-concordancia-roteador")).toHaveTextContent(/levariam o cliente ao mesmo agente em 3 de 4/);
  });

  it("pausar uma tarefa só: a nova (que começou sozinha) e o clima, cada um pela tarefa — o Jev segue ligado", async () => {
    montar(
      dados({
        config: { ligado: true, modo: "observacao" },
        por_tarefa: [{ ...CLIMA, estado: "observando" }, NOVA],
      }),
    );
    const pausar = within(screen.getByTestId("jev-tarefa-manipulacao")).getByRole("button", {
      name: "Pausar esta tarefa",
    });
    fireEvent.click(pausar);
    await waitFor(() => expect(recarregar).toHaveBeenCalledTimes(1));
    fireEvent.click(
      within(screen.getByTestId("jev-tarefa-clima")).getByRole("button", { name: "Pausar esta tarefa" }),
    );
    await waitFor(() => expect(recarregar).toHaveBeenCalledTimes(2));
    // "Desligada" não tem nome no `modo`: o clima também vai pela tarefa.
    expect(chamadas.map((c) => c.corpo)).toEqual([
      { tarefa: "manipulacao", estado: "desligada" },
      { tarefa: "clima", estado: "desligada" },
    ]);
  });

  /**
   * O clima observando e a manipulação decidindo: o cartão dizia "Decidindo —
   * o Jev mede primeiro, e a sua IA de sempre só entra se ele não responder",
   * falso para as duas (uma só observa; na outra a IA de sempre segue
   * decidindo e o Jev só soma).
   */
  it("decidindo numa tarefa e observando noutra: o cartão não fala por todas, e cada linha diz o que é decidir nela", () => {
    montar(
      dados({
        config: { ligado: true, modo: "observacao" },
        por_tarefa: [
          { ...CLIMA, estado: "observando" },
          { ...NOVA, estado: "decidindo", novo: false },
        ],
      }),
    );
    expect(cartao()).toHaveAttribute("data-estado", "decidindo");
    expect(screen.getByText("Decide em parte")).toBeInTheDocument();
    expect(screen.queryByText("Decidindo")).toBeNull();
    expect(cartao()).toHaveTextContent("Decidindo em parte — cada tarefa abaixo diz se o Jev decide ou só observa nela.");
    expect(screen.queryByText(/o Jev mede primeiro/i)).toBeNull();
    // Sem "a sua IA segue decidindo" ao lado do selo "Decide": o verbo era o mesmo para os dois.
    expect(screen.getByTestId("jev-decide-manipulacao")).toHaveTextContent(
      "O alerta do Jev passa a contar junto com o da sua IA de sempre: vale o mais forte dos dois",
    );
    expect(screen.queryByTestId("jev-decide-clima")).toBeNull();
  });

  it("as duas decidindo: selo inteiro, e o clima diz que o Jev mede primeiro — só na linha dele", () => {
    montar(
      dados({
        config: { ligado: true, modo: "decide" },
        por_tarefa: [
          { ...CLIMA, estado: "decidindo" },
          { ...NOVA, estado: "decidindo", novo: false },
        ],
      }),
    );
    expect(screen.getByText("Decidindo")).toBeInTheDocument();
    expect(screen.getByTestId("jev-decide-clima")).toHaveTextContent(
      "O Jev mede primeiro; a sua IA de sempre só entra se ele não responder.",
    );
    expect(screen.getByTestId("jev-decide-manipulacao")).not.toHaveTextContent(/mede primeiro/);
  });

  /**
   * A camada anti-manipulação desligada pela empresa: o turno não pergunta ao
   * Jev, e o cartão dizia "Só observa" esperando uma comparação que nunca vem.
   */
  it("tarefa parada pela camada desligada: diz que não roda, sem comparação nem 'Deixar decidir', e não faz o cartão observar", () => {
    montar(
      dados({
        config: { ligado: true, modo: "decide" },
        por_tarefa: [
          { ...CLIMA, estado: "decidindo" },
          { ...NOVA, sem_camada: true, observacao: { dias: 30, comparadas: 0, concordaram: 0 } },
        ],
      }),
    );
    const nova = screen.getByTestId("jev-tarefa-manipulacao");
    expect(nova).toHaveTextContent("Não roda");
    expect(nova).not.toHaveTextContent("Só observa");
    // O nome que a tela do agente mostra ("Segurança" é só o nosso), com o caminho.
    const semCamada = screen.getByTestId("jev-sem-camada-manipulacao");
    expect(semCamada).toHaveTextContent(/Detectar tentativa de manipular o assistente.*empresa toda.*aba “Confere antes de enviar”/);
    expect(semCamada).not.toHaveTextContent(/Segurança/);
    expect(within(semCamada).getByRole("link", { name: "Abrir os agentes" })).toHaveAttribute("href", "/app/ai/agents");
    expect(screen.queryByTestId("jev-concordancia-manipulacao")).toBeNull();
    expect(within(nova).queryByRole("button", { name: "Deixar o Jev decidir" })).toBeNull();
    // A saída de quem não a quer continua lá.
    expect(within(nova).getByRole("button", { name: "Pausar esta tarefa" })).toBeInTheDocument();
    // O clima decide; a tarefa parada não faz o selo virar "Decide em parte".
    expect(screen.getByText("Decidindo")).toBeInTheDocument();
    expect(screen.queryByText("Decide em parte")).toBeNull();
    expect(jevNoPonto(dados({ config: { ligado: true }, por_tarefa: [{ ...NOVA, sem_camada: true }] }), "jailbreak_detect")).toBeNull();
  });

  it("controle: com a camada ligada, a mesma tarefa só observa e oferece decidir", () => {
    montar(dados({ config: { ligado: true, modo: "observacao" }, por_tarefa: [{ ...NOVA, sem_camada: false }] }));
    const nova = screen.getByTestId("jev-tarefa-manipulacao");
    expect(nova).toHaveTextContent("Só observa");
    expect(screen.queryByTestId("jev-sem-camada-manipulacao")).toBeNull();
    expect(within(nova).getByRole("button", { name: "Deixar o Jev decidir" })).toBeInTheDocument();
  });

  /**
   * O roteador numa empresa sem roteador de intenção ativo: o turno não escolhe
   * agente, e "Só observa" prometeria uma comparação que nunca vem.
   */
  it("roteador sem roteador ativo: diz que não roda e aponta onde ativar, sem comparação nem 'Deixar decidir'", () => {
    const ROTEADOR = {
      id: "roteador",
      ponto: "intent_router",
      rotulo: "Escolher qual agente atende",
      oQueFaz: "Escolhe o agente.",
      estado: "observando",
      novo: true,
    } as const;
    montar(
      dados({
        config: { ligado: true, modo: "decide" },
        por_tarefa: [
          { ...CLIMA, estado: "decidindo" },
          { ...ROTEADOR, sem_roteador: true, observacao: { dias: 30, comparadas: 0, concordaram: 0 } },
        ],
      }),
    );
    const roteador = screen.getByTestId("jev-tarefa-roteador");
    expect(roteador).toHaveTextContent("Não roda");
    const semRoteador = screen.getByTestId("jev-sem-roteador-roteador");
    expect(semRoteador).toHaveTextContent(/nenhum roteador de intenção ativo tem intenções/);
    expect(within(semRoteador).getByRole("link", { name: "Abrir os roteadores" })).toHaveAttribute("href", "/app/ai/routers");
    expect(screen.queryByTestId("jev-concordancia-roteador")).toBeNull();
    expect(within(roteador).queryByRole("button", { name: "Deixar o Jev decidir" })).toBeNull();
    expect(screen.queryByText("Decide em parte")).toBeNull();
    expect(jevNoPonto(dados({ config: { ligado: true }, por_tarefa: [{ ...ROTEADOR, sem_roteador: true }] }), "intent_router")).toBeNull();

    // Controle: com roteador ativo, a mesma tarefa observa e oferece decidir.
    cleanup();
    montar(dados({ config: { ligado: true, modo: "observacao" }, por_tarefa: [{ ...ROTEADOR, sem_roteador: false }] }));
    const ativa = screen.getByTestId("jev-tarefa-roteador");
    expect(ativa).toHaveTextContent("Só observa");
    expect(screen.queryByTestId("jev-sem-roteador-roteador")).toBeNull();
    expect(within(ativa).getByRole("button", { name: "Deixar o Jev decidir" })).toBeInTheDocument();
  });

  it("tarefa nova sem observação na resposta não inventa concordância", () => {
    montar(dados({ config: { ligado: true, modo: "observacao" }, por_tarefa: [NOVA] }));
    expect(screen.queryByTestId("jev-concordancia-manipulacao")).toBeNull();
  });
});

describe("CartaoDoJev — sem a IA de sempre, as tarefas seguem com a linha delas", () => {
  const CLIMA = { id: "clima", ponto: "sentiment_classify", rotulo: "Medir o clima da conversa", oQueFaz: "Mede.", novo: false } as const;
  const NOVA = { id: "manipulacao", ponto: "jailbreak_detect", rotulo: "Perceber tentativa de manipulação", oQueFaz: "Percebe.", estado: "observando", novo: true } as const;

  /**
   * Decidindo sozinho, as linhas ficavam sem selo e sem botão: a única saída de
   * uma tarefa nova era "Desligar" o Jev inteiro — e o clima junto.
   */
  it("decidindo sozinho: o clima diz que decide sozinho e só pausa; a tarefa nova observa, com os botões dela", () => {
    montar(dados({ config: { ligado: true }, tem_ia_de_sempre: false, por_tarefa: [{ ...CLIMA, estado: "observando" }, NOVA] }));
    expect(cartao()).toHaveAttribute("data-estado", "sozinho");
    expect(cartao()).toHaveTextContent(/Decidindo sozinho no clima/);
    const clima = screen.getByTestId("jev-tarefa-clima");
    expect(clima).toHaveTextContent("Decide sozinho");
    expect(within(clima).getByRole("button", { name: "Pausar esta tarefa" })).toBeInTheDocument();
    expect(within(clima).queryByRole("button", { name: "Deixar o Jev decidir" })).toBeNull();
    expect(screen.queryByTestId("jev-concordancia")).toBeNull();
    const nova = screen.getByTestId("jev-tarefa-manipulacao");
    expect(nova).toHaveTextContent("Só observa");
    expect(within(nova).getByRole("button", { name: "Pausar esta tarefa" })).toBeInTheDocument();
    expect(within(nova).getByRole("button", { name: "Deixar o Jev decidir" })).toBeInTheDocument();
  });

  it("o clima pausado sem a IA de sempre avisa ANTES de religar que ele volta decidindo sozinho", () => {
    montar(dados({ config: { ligado: true }, tem_ia_de_sempre: false, por_tarefa: [{ ...CLIMA, estado: "desligada" }, NOVA] }));
    expect(screen.getByTestId("jev-religar-clima-sozinho")).toHaveTextContent(/volta decidindo sozinho/);
    expect(screen.getByTestId("jev-tarefa-clima")).toHaveTextContent("Pausada");
  });

  it("controle: com a IA de sempre, religar o clima não traz esse aviso", () => {
    montar(dados({ config: { ligado: true }, por_tarefa: [{ ...CLIMA, estado: "desligada" }, NOVA] }));
    expect(screen.queryByTestId("jev-religar-clima-sozinho")).toBeNull();
  });

  it("em pausa com uma tarefa que só 'Não roda': não diz que todas estão desligadas", () => {
    montar(
      dados({
        config: { ligado: true },
        por_tarefa: [
          { ...CLIMA, estado: "desligada" },
          { id: "roteador", ponto: "intent_router", rotulo: "Escolher qual agente atende", oQueFaz: "Escolhe.", estado: "observando", novo: false, sem_roteador: true },
        ],
      }),
    );
    expect(cartao()).toHaveAttribute("data-estado", "em_pausa");
    expect(cartao()).not.toHaveTextContent(/todas as tarefas pausadas/);
    expect(cartao()).toHaveTextContent(/nenhuma tarefa está rodando agora/);
  });
});
