/**
 * O painel lê duas rotas: a dos pontos (`/api/v1/ai/providers`) e a do Jev
 * (`/api/v1/ai/jev`). O cartão do ponto que o Jev atende precisa das duas —
 * sem a segunda, ele mostraria o modelo como se decidisse sozinho, com o Jev
 * ligado na frente dele.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PainelDeProvedores } from "./PainelDeProvedores";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/app/ai/credentials/_actions", () => ({ refreshCredentialsView: vi.fn() }));

const PROVEDORES = {
  papeis: { entender: { rotulo: "Entender a conversa", explicacao: "" } },
  pontos: [
    {
      id: "sentiment_classify",
      rotulo: "Medir o clima da conversa",
      oQueFaz: "Avalia se o cliente está satisfeito ou irritado.",
      papel: "entender",
      exige: {},
      sintomaDeFalha: "Cliente irritado não é escalado.",
      fixo: null,
      mandadoPeloAgente: false,
      efetivo: {
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        credentialId: null,
        baseUrl: null,
        origem: "padrao_da_organizacao",
        porQue: "padrão da empresa",
      },
      avisos: [],
    },
  ],
  provedores: [],
  credenciais: [],
  modelos: [],
  padrao: { provider: "anthropic", defaultModel: "claude-haiku-4-5" },
  podeEditar: false,
};

function jev(ligado: boolean) {
  return {
    provedor: {
      rotulo: "Jev (TypeSafe AI)",
      quandoUsar: "Não conversa com o cliente.",
      ondePegarAChave: "https://console.typesafe.ai/keys",
      prefixoDaChave: "apikey_…",
    },
    chave: { existe: true, validada: true, credencial_id: "c1", rotulo: "Jev", erro_de_validacao: null },
    config: { ligado, modo: "observacao", aceite: ligado ? { em: "2026-09-20T00:00:00Z", por: "u1" } : null },
    tarefas: [{ id: "sentiment_classify", rotulo: "Medir o clima da conversa", oQueOJevFaz: "Percebe." }],
    tem_ia_de_sempre: true,
    numeros: {
      dias: 7,
      decisoes: 0,
      custo_cents: 0,
      latencia_media_ms: null,
      reservas: 0,
      observacao: { dias: 30, comparadas: 0, concordaram: 0 },
    },
    ultima_falha: null,
    pode_editar: false,
  };
}

let jevLigado = true;

beforeEach(() => {
  jevLigado = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const data =
        url === "/api/v1/ai/jev"
          ? jev(jevLigado)
          : url === "/api/v1/ai/voz"
            ? { voiceId: null, vozesDisponiveis: [], temCredencial: false }
            : PROVEDORES;
      return new Response(JSON.stringify({ data }), { status: 200 });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function montar() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PainelDeProvedores />
    </QueryClientProvider>,
  );
}

describe("PainelDeProvedores — o Jev no painel", () => {
  it("o cartão do Jev vem logo abaixo do Modelo padrão", async () => {
    montar();
    const jevCartao = await screen.findByTestId("cartao-do-jev");
    const padrao = screen.getByTestId("cartao-do-padrao");
    expect(padrao.compareDocumentPosition(jevCartao) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("com o Jev ligado, o cartão do ponto diz quem decide", async () => {
    montar();
    await screen.findByTestId("cartao-do-jev");
    fireEvent.click(screen.getByTestId("avancado-entender"));
    expect(screen.getByTestId("jev-no-ponto-sentiment_classify")).toHaveTextContent(
      "O Jev observa; o modelo abaixo ainda decide.",
    );
  });

  it("a manipulação decidindo: o cartão do ponto diz que o Jev SOMA, e não que o modelo virou reserva", async () => {
    const ponto = PROVEDORES.pontos[0]!;
    const jailbreak = { ...ponto, id: "jailbreak_detect", rotulo: "Barrar tentativa de manipulação", papel: "proteger" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const data =
          url === "/api/v1/ai/jev"
            ? {
                ...jev(true),
                por_tarefa: [
                  { id: "manipulacao", ponto: "jailbreak_detect", rotulo: "x", oQueFaz: "x", estado: "decidindo", novo: false },
                ],
              }
            : { ...PROVEDORES, pontos: [jailbreak] };
        return new Response(JSON.stringify({ data }), { status: 200 });
      }),
    );
    montar();
    await screen.findByTestId("cartao-do-jev");
    fireEvent.click(screen.getByTestId("avancado-proteger"));
    expect(screen.getByTestId("jev-no-ponto-jailbreak_detect")).toHaveTextContent(
      "O modelo abaixo decide; o Jev soma o sinal dele, sem nunca apagar o do modelo.",
    );
  });

  it("o roteador decidindo: o modelo do ponto segue chamado a cada mensagem, e não 'o Jev mede primeiro'", async () => {
    const ponto = PROVEDORES.pontos[0]!;
    const roteador = { ...ponto, id: "intent_router", rotulo: "Escolher qual agente atende", papel: "entender" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const data =
          url === "/api/v1/ai/jev"
            ? {
                ...jev(true),
                por_tarefa: [
                  { id: "roteador", ponto: "intent_router", rotulo: "x", oQueFaz: "x", estado: "decidindo", novo: false },
                ],
              }
            : { ...PROVEDORES, pontos: [roteador] };
        return new Response(JSON.stringify({ data }), { status: 200 });
      }),
    );
    montar();
    await screen.findByTestId("cartao-do-jev");
    fireEvent.click(screen.getByTestId("avancado-entender"));
    const linha = screen.getByTestId("jev-no-ponto-intent_router");
    expect(linha).not.toHaveTextContent(/mede primeiro/);
    expect(linha).toHaveTextContent("o modelo abaixo continua sendo chamado a cada mensagem");
  });

  it("com o Jev desligado, o cartão do ponto não fala dele", async () => {
    jevLigado = false;
    montar();
    await screen.findByTestId("cartao-do-jev");
    fireEvent.click(screen.getByTestId("avancado-entender"));
    expect(screen.getByTestId("ponto-sentiment_classify")).toBeInTheDocument();
    expect(screen.queryByTestId("jev-no-ponto-sentiment_classify")).toBeNull();
  });
});

describe("PainelDeProvedores — o cabeçalho do cartão no celular (issue #3929)", () => {
  /**
   * Os quatro pontos que o relato mediu. Todos passam pelo MESMO `CartaoDoPonto`
   * — por isso o teste roda com os quatro: se um deles deixar de usar o cartão
   * comum, a garantia some sem ninguém notar.
   */
  const PONTOS_DO_RELATO = [
    "agent_turn",
    "operator_turn",
    "proposal_assistant",
    "proposal_fill_from_conversation",
  ];

  const ponto = (id: string) => ({
    ...PROVEDORES.pontos[0]!,
    id,
    rotulo: `Ponto ${id}`,
    oQueFaz: "Responde cada mensagem que o cliente manda, com a personalidade da versão publicada.",
    papel: "conversar",
    exige: { tools: true },
  });

  function montarQuatro() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const data =
          url === "/api/v1/ai/jev"
            ? jev(false)
            : url === "/api/v1/ai/voz"
              ? { voiceId: null, vozesDisponiveis: [], temCredencial: false }
              : {
                  ...PROVEDORES,
                  papeis: { conversar: { rotulo: "Conversar", explicacao: "" } },
                  pontos: PONTOS_DO_RELATO.map((id) => ponto(id)),
                  modelos: [
                    {
                      provider: "anthropic",
                      model_id: "claude-haiku-4-5",
                      display_name: "Claude Haiku 4.5",
                      supports_tools: true,
                      supports_vision: false,
                      input_price_per_million_cents: 100,
                    },
                  ],
                  podeEditar: true,
                };
        return new Response(JSON.stringify({ data }), { status: 200 });
      }),
    );
    montar();
  }

  /**
   * As peças do cabeçalho, pelo DOM de hoje: cartão › cabeçalho › bloco de texto
   * › linha do título › h3. O bloco do modelo/origem é o pai do `origem-<id>`,
   * que já existe. Nada de testid novo só para o teste.
   */
  function cabecalhoDo(id: string) {
    const cartao = screen.getByTestId(`ponto-${id}`);
    const titulo = within(cartao).getByRole("heading", { name: `Ponto ${id}` });
    const linhaDoTitulo = titulo.parentElement as HTMLElement;
    const blocoDeTexto = linhaDoTitulo.parentElement as HTMLElement;
    const cabecalho = blocoDeTexto.parentElement as HTMLElement;
    const blocoDoModelo = screen.getByTestId(`origem-${id}`).parentElement as HTMLElement;
    return { cartao, titulo, linhaDoTitulo, blocoDeTexto, cabecalho, blocoDoModelo };
  }

  const classes = (el: HTMLElement) => el.className.split(/\s+/);

  /**
   * jsdom não calcula layout (todo `getBoundingClientRect` volta 0), então o que
   * se prende aqui é a ESTRUTURA e a CLASSE que decidem o layout. Foi essa
   * classe que espremeu o texto a 375 px: `flex-1` dentro de um `flex-wrap` tem
   * base ZERO, a linha nunca quebra e o bloco do modelo fica com a largura que
   * pedir; o `min-w-0` do texto então o encolhe até o min-content — o título
   * quebra palavra por palavra. Abaixo de `md` são duas linhas: texto na
   * largura do cartão, modelo/origem embaixo.
   */
  it.each(PONTOS_DO_RELATO)("%s: o texto não é mais espremido por `flex-1`", async (id) => {
    montarQuatro();
    fireEvent.click(await screen.findByTestId("avancado-conversar"));

    const { titulo, linhaDoTitulo, blocoDeTexto, cabecalho } = cabecalhoDo(id);
    // O bloco que carrega título e descrição não pede base zero.
    expect(classes(blocoDeTexto)).not.toContain("flex-1");
    expect(classes(blocoDeTexto)).toContain("min-w-0");
    // O cabeçalho não é uma linha flex (era ela que deixava o texto ceder).
    expect(classes(cabecalho)).toContain("grid");
    expect(classes(cabecalho)).not.toContain("flex");
    expect(classes(cabecalho)).not.toContain("flex-wrap");
    // Uma coluna abaixo de md: o template de duas colunas só existe a partir de md.
    expect(classes(cabecalho).filter((c) => /^grid-cols-/.test(c))).toEqual([]);
    expect(classes(cabecalho).filter((c) => /grid-cols-/.test(c))).toEqual([
      "md:grid-cols-[minmax(0,1fr)_auto]",
    ]);
    // Quem cede é a linha dos selos, não o título: ela quebra e ele fica inteiro.
    expect(classes(linhaDoTitulo)).toContain("flex-wrap");
    expect(classes(linhaDoTitulo)).toContain("items-center");
    expect(classes(linhaDoTitulo)).not.toContain("items-start");
    expect(classes(titulo)).not.toContain("break-all");
    expect(classes(titulo)).not.toContain("truncate");
  });

  it.each(PONTOS_DO_RELATO)(
    "%s: o seletor do ponto continua lá, e o modelo/origem desce para a linha de baixo",
    async (id) => {
      montarQuatro();
      fireEvent.click(await screen.findByTestId("avancado-conversar"));

      // O seletor (medido certo pelo relato: 44 px de altura, 57–318 de largura)
      // não foi tocado — segue no cartão, com o mesmo testid de sempre.
      expect(screen.getByTestId(`modelo-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`provider-${id}`)).toBeInTheDocument();

      const { blocoDoModelo } = cabecalhoDo(id);
      // Abaixo de md: linha própria, alinhado à esquerda — não à direita do texto.
      expect(classes(blocoDoModelo)).toContain("text-left");
      expect(classes(blocoDoModelo)).not.toContain("text-right");
      // De md para cima: volta para a coluna 2, na primeira linha, à direita.
      expect(classes(blocoDoModelo)).toContain("md:col-start-2");
      expect(classes(blocoDoModelo)).toContain("md:row-start-1");
      expect(classes(blocoDoModelo)).toContain("md:text-right");
    },
  );

  /**
   * O lado oposto: o conserto não pode virar cartão empilhado no desktop. O
   * template de duas colunas existe SÓ a partir de `md`, e é aí que o bloco do
   * modelo volta para a primeira linha — não há `flex-col` nem `grid-cols-1`
   * sem breakpoint, que empilharia também no desktop, nem `sm:` no meio, que
   * mudaria o desenho em 640 px sem ninguém pedir.
   */
  it.each(PONTOS_DO_RELATO)(
    "%s: acima de md o cabeçalho continua em linha (duas colunas)",
    async (id) => {
      montarQuatro();
      fireEvent.click(await screen.findByTestId("avancado-conversar"));

      const { cabecalho, blocoDoModelo } = cabecalhoDo(id);
      expect(classes(cabecalho)).toContain("md:grid-cols-[minmax(0,1fr)_auto]");
      expect(classes(cabecalho)).not.toContain("flex-col");
      expect(classes(cabecalho).filter((c) => /^(grid-cols-1|grid-rows-)/.test(c))).toEqual([]);
      expect(classes(cabecalho).filter((c) => /^sm:/.test(c))).toEqual([]);
      // Na mesma linha do texto, e à direita: o desenho de sempre, de md para cima.
      expect(classes(blocoDoModelo)).toContain("md:row-start-1");
      expect(classes(blocoDoModelo)).toContain("md:text-right");
      expect(classes(blocoDoModelo)).toContain("md:col-start-2");
    },
  );
});

describe("PainelDeProvedores — ponto com menu fechado", () => {
  it("sem binding e com o efetivo fora do menu, o seletor abre na opção padrão ('Automático')", async () => {
    const transcricao = {
      ...PROVEDORES.pontos[0]!,
      id: "transcricao_de_audio",
      rotulo: "Ouvir o áudio do cliente",
      papel: "perceber",
      fixo: {
        razao: "Transcrição não fala a API de chat.",
        opcoes: [
          { provider: "openai", modelId: "whisper-1", rotulo: "Automático" },
          { provider: "elevenlabs", modelId: "scribe_v1", rotulo: "ElevenLabs (Scribe)" },
        ],
      },
      // Instalação sem chave OpenAI: a escada anuncia o provedor sem modelo.
      efetivo: {
        provider: "openai",
        modelId: null,
        credentialId: null,
        baseUrl: null,
        origem: "fixo_do_produto",
        porQue: "fixo do produto",
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const data =
          url === "/api/v1/ai/jev"
            ? jev(false)
            : url === "/api/v1/ai/voz"
              ? { voiceId: null, vozesDisponiveis: [], temCredencial: false }
              : {
                  ...PROVEDORES,
                  papeis: { perceber: { rotulo: "Ver e ouvir", explicacao: "" } },
                  pontos: [transcricao],
                  podeEditar: true,
                };
        return new Response(JSON.stringify({ data }), { status: 200 });
      }),
    );
    montar();
    fireEvent.click(await screen.findByTestId("avancado-perceber"));
    expect(screen.getByTestId("servico-transcricao_de_audio")).toHaveTextContent("Automático");
    expect(screen.getByTestId("salvar-transcricao_de_audio")).toBeEnabled();
  });
});
