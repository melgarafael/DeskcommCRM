/**
 * O painel lê duas rotas: a dos pontos (`/api/v1/ai/providers`) e a do Jev
 * (`/api/v1/ai/jev`). O cartão do ponto que o Jev atende precisa das duas —
 * sem a segunda, ele mostraria o modelo como se decidisse sozinho, com o Jev
 * ligado na frente dele.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("PainelDeProvedores — voz do agente (#4260, item 2)", () => {
  // O Radix Select usa pointer capture e `scrollIntoView`; o jsdom não os tem
  // (mesmos dublês de `components/ui/select.test.tsx`).
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });

  const VOZES_DO_PROVEDOR = [
    { id: "21m00Tcm4TlvDq8ikWAM", nome: "Ana", idioma: "Português" },
    { id: "EXAVITQu4vr4xnSDxMaL", nome: "Beto", idioma: "Espanhol" },
  ];

  function resposta(dados: unknown, status = 200): Response {
    return new Response(JSON.stringify(status >= 400 ? dados : { data: dados }), { status });
  }

  /**
   * O dublê da API inteira do painel. `voz` é o que o GET da voz devolve;
   * `preview` é o que o POST da prévia devolve (uma recusa, no caso do
   * provedor); `patch` sobrepõe o PATCH da voz quando o caso precisa de falha.
   */
  function dublar(opcoes: {
    voz: Record<string, unknown>;
    preview?: () => Response;
    patch?: () => Response;
  }) {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const metodo = init?.method ?? "GET";
      if (url === "/api/v1/ai/voz" && metodo === "GET") return resposta(opcoes.voz);
      if (url === "/api/v1/ai/voz" && metodo === "PATCH") {
        if (opcoes.patch) return opcoes.patch();
        const corpo = JSON.parse(String(init?.body ?? "{}")) as { voice_id?: string };
        return resposta({ voiceId: corpo.voice_id, modelId: null });
      }
      if (url === "/api/v1/ai/voz/preview" && metodo === "POST") {
        return opcoes.preview
          ? opcoes.preview()
          : resposta({ audioBase64: "AA==", mimeType: "audio/mpeg" });
      }
      if (url === "/api/v1/ai/jev") return resposta(jev(false));
      return resposta({ ...PROVEDORES, podeEditar: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function patchDaVoz(fetchMock: ReturnType<typeof vi.fn>) {
    const chamada = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/v1/ai/voz" && (init as RequestInit | undefined)?.method === "PATCH",
    );
    if (!chamada) return null;
    return JSON.parse(String((chamada[1] as RequestInit).body)) as { voice_id?: string };
  }

  it("(a) escolher uma voz da lista e salvar grava o id escolhido", async () => {
    const fetchMock = dublar({
      voz: {
        voiceId: null,
        vozesDisponiveis: VOZES_DO_PROVEDOR.map((v) => v.id),
        catalogo: VOZES_DO_PROVEDOR,
        catalogoVeioDoProvedor: true,
        temCredencial: true,
      },
    });
    montar();

    // Nome e idioma aparecem: é o que o catálogo do provedor acrescenta.
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("voz-escolher-da-lista"));
    await user.click(await screen.findByRole("option", { name: "Ana — Português" }));
    expect(screen.getByTestId("voz-voice-id")).toHaveValue("21m00Tcm4TlvDq8ikWAM");

    fireEvent.click(screen.getByTestId("voz-salvar"));
    await waitFor(() => expect(patchDaVoz(fetchMock)).toEqual({ voice_id: "21m00Tcm4TlvDq8ikWAM" }));
  });

  it("(b) id escrito à mão é aceito e salvo mesmo fora da lista", async () => {
    const fetchMock = dublar({
      voz: {
        voiceId: null,
        vozesDisponiveis: VOZES_DO_PROVEDOR.map((v) => v.id),
        catalogo: VOZES_DO_PROVEDOR,
        catalogoVeioDoProvedor: true,
        temCredencial: true,
      },
    });
    montar();

    const campo = await screen.findByTestId("voz-voice-id");
    // Voz própria do cliente: não está em `catalogo` e isso NÃO é erro.
    fireEvent.change(campo, { target: { value: "vozPropriaDoCliente123" } });
    fireEvent.click(screen.getByTestId("voz-salvar"));

    await waitFor(() => expect(patchDaVoz(fetchMock)).toEqual({ voice_id: "vozPropriaDoCliente123" }));
    expect(screen.queryByTestId("voz-erro-de-formato")).toBeNull();
  });

  it("(c) formato inválido é recusado na tela, sem chamar a API", async () => {
    const fetchMock = dublar({
      voz: { voiceId: null, vozesDisponiveis: [], catalogo: [], temCredencial: true },
    });
    montar();

    const campo = await screen.findByTestId("voz-voice-id");
    fireEvent.change(campo, { target: { value: "minha voz!" } });
    fireEvent.click(screen.getByTestId("voz-salvar"));

    expect(await screen.findByTestId("voz-erro-de-formato")).toHaveTextContent(
      "Voice ID inválido: use só letras, números, hífen e sublinhado (8 a 64 caracteres).",
    );
    expect(patchDaVoz(fetchMock)).toBeNull();
  });

  it("(d) catálogo do provedor falhando: cai na lista antiga, sem erro fatal e com o campo livre", async () => {
    dublar({
      voz: {
        voiceId: "21m00Tcm4TlvDq8ikWAM",
        vozesDisponiveis: ["21m00Tcm4TlvDq8ikWAM", "pNInz6obpgDQGcFmaJgB"],
        catalogo: [
          { id: "21m00Tcm4TlvDq8ikWAM", nome: "21m00Tcm4TlvDq8ikWAM", idioma: null },
          { id: "pNInz6obpgDQGcFmaJgB", nome: "pNInz6obpgDQGcFmaJgB", idioma: null },
        ],
        catalogoVeioDoProvedor: false,
        temCredencial: true,
      },
    });
    montar();

    expect(await screen.findByTestId("cartao-de-voz")).toBeInTheDocument();
    expect(screen.getByTestId("voz-catalogo-antigo")).toHaveTextContent(/lista abaixo é a da última validação/);
    // A lista de antes continua escolhível...
    const user = userEvent.setup();
    await user.click(screen.getByTestId("voz-escolher-da-lista"));
    expect(await screen.findByRole("option", { name: "pNInz6obpgDQGcFmaJgB" })).toBeInTheDocument();
    // ...e o campo livre segue aceitando um id que ela não conhece.
    expect(screen.getByTestId("voz-voice-id")).toHaveValue("21m00Tcm4TlvDq8ikWAM");
  });

  it("a recusa do provedor sobre a voz chega à tela com a mensagem dele", async () => {
    dublar({
      voz: {
        voiceId: "vozPropriaDoCliente123",
        vozesDisponiveis: [],
        catalogo: [{ id: "vozPropriaDoCliente123", nome: "vozPropriaDoCliente123", idioma: null }],
        catalogoVeioDoProvedor: true,
        temCredencial: true,
      },
      preview: () =>
        resposta(
          {
            error: {
              code: "synthesis_failed",
              message: "O provedor recusou esta voz: A voice with voice_id vozPropriaDoCliente123 was not found.",
              request_id: "req-1",
              details: { erroDoProvedor: "A voice with voice_id vozPropriaDoCliente123 was not found." },
            },
          },
          502,
        ),
    });
    montar();

    fireEvent.click(await screen.findByTestId("voz-ouvir-previa"));
    expect(await screen.findByTestId("voz-erro-do-provedor")).toHaveTextContent(
      "A voice with voice_id vozPropriaDoCliente123 was not found.",
    );
  });
});

/**
 * A RESIDÊNCIA DO TEXTO CHEGA À TELA PELO CATÁLOGO (#4519).
 *
 * O teste do componente (`app/app/ai/_components/OndeOTextoEProcessado.test.tsx`)
 * prova as quatro respostas. Este prova o encanamento: a rota devolve
 * `PROVEDORES` inteiro, e o painel tem de repassar o objeto do provedor
 * ESCOLHIDO — inclusive quando a resposta é "não declara". Um `filter` na lista
 * ou um `if (paisDeclarado)` aqui esconderia justamente o caso que precisa
 * aparecer.
 */
describe("PainelDeProvedores — onde o texto é processado", () => {
  const PROVEDORES_COM_PAIS = [
    {
      id: "deepseek",
      rotulo: "DeepSeek",
      quandoUsar: "Barata.",
      ondePegarAChave: "https://platform.deepseek.com/api_keys",
      aceitaEndpointProprio: true,
      pais: "China",
      fonteDoPais: {
        url: "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html",
        consultadoEm: "2026-11-12",
      },
    },
    {
      id: "anthropic",
      rotulo: "Anthropic (Claude)",
      quandoUsar: "Padrão.",
      ondePegarAChave: "https://console.anthropic.com/settings/keys",
      aceitaEndpointProprio: false,
      pais: "desconhecido",
      fonteDoPais: null,
    },
  ];

  function dublarProvedores(extra: Record<string, unknown> = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const data =
          url === "/api/v1/ai/jev"
            ? jev(false)
            : url === "/api/v1/ai/voz"
              ? { voiceId: null, vozesDisponiveis: [], temCredencial: false }
              : { ...PROVEDORES, provedores: PROVEDORES_COM_PAIS, podeEditar: true, ...extra };
        return new Response(JSON.stringify({ data }), { status: 200 });
      }),
    );
  }

  it("no cartão do padrão, o provedor escolhido mostra país, fonte e data", async () => {
    dublarProvedores({
      padrao: { provider: "deepseek", defaultModel: "deepseek-chat" },
    });
    montar();

    const padrao = await screen.findByTestId("cartao-do-padrao");
    const linha = within(padrao).getByTestId("onde-o-texto-e-processado");
    expect(linha).toHaveAttribute("data-situacao", "declarado");
    expect(linha).toHaveTextContent("China");
    expect(linha).toHaveTextContent("consultada em 12/11/2026");
    expect(within(padrao).getByRole("link", { name: "fonte: política do provedor" })).toHaveAttribute(
      "href",
      "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html",
    );
  });

  it("no cartão do ponto, o provedor sem país aparece com o aviso — não some", async () => {
    dublarProvedores();
    montar();

    await screen.findByTestId("cartao-do-padrao");
    fireEvent.click(screen.getByTestId("avancado-entender"));
    const ponto = screen.getByTestId("ponto-sentiment_classify");
    const linha = within(ponto).getByTestId("onde-o-texto-e-processado");
    expect(linha).toHaveAttribute("data-situacao", "desconhecido");
    expect(linha).toHaveTextContent("O provedor não declara o país; consulte a política dele");
  });
});
