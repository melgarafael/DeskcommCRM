import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationTagsEditor } from "./ConversationTagsEditor";
import { apiClient } from "@/lib/api/client";

// Issue #2718 — com tom escolhido, o "+" anexa a tag NA CONVERSA e grava a
// cor NO VOCABULÁRIO (definir_cor) com o nome canônico; sem tom, o POST não
// acontece e o comportamento é o de antes.

let papel = "manager";
const mutateSpy = vi.fn();
/** O vocabulário que o hook devolve — a ORDEM dele é a das sugestões (#3180). */
const vocabularioRef: { current: string[] } = { current: [] };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { role: papel } }),
}));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: mutateSpy, isPending: false }),
  useConversationTagVocabulary: () => ({ data: vocabularioRef.current }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

function renderEditor(tags: string[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ConversationTagsEditor conversationId="c1" orgId="o1" tags={tags} />
    </QueryClientProvider>,
  );
}

describe("ConversationTagsEditor — cor na criação (#2718)", () => {
  beforeEach(() => {
    papel = "manager";
    vi.clearAllMocks();
    vocabularioRef.current = [];
  });
  afterEach(() => cleanup());

  it("sem cor: o “+” só anexa a tag (nenhum POST de vocabulário)", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText("Adicionar tag à conversa"), "vip");
    await user.click(screen.getByRole("button", { name: "Adicionar tag" }));
    expect(mutateSpy).toHaveBeenCalledWith({ conversation_id: "c1", tags: ["vip"] });
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("com cor: anexa E grava definir_cor com o nome canônico", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole("button", { name: "Cor da etiqueta" }));
    await user.click(screen.getByRole("button", { name: "Roxo" }));
    await user.type(screen.getByLabelText("Adicionar tag à conversa"), "VIP");
    await user.click(screen.getByRole("button", { name: "Adicionar tag" }));
    expect(mutateSpy).toHaveBeenCalledWith({ conversation_id: "c1", tags: ["vip"] });
    expect(apiClient.post).toHaveBeenCalledWith("/api/v1/tags/vocabulario", {
      acao: "definir_cor",
      tag: "vip",
      destino: null,
      cor: "#ab4aba",
    });
  });

  it("para papel agent o gatilho de cor não existe (a rota recusaria)", async () => {
    papel = "agent";
    renderEditor();
    expect(
      screen.queryByRole("button", { name: "Cor da etiqueta" }),
    ).not.toBeInTheDocument();
  });
});

/**
 * AS SUGESTÕES FILTRAM PELO QUE SE DIGITA (#3180).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `(vocabulary ?? []).filter((v) => !tags.includes(v)).slice(0, 8)`: as oito
 * primeiras do vocabulário, sempre as mesmas, em ordem alfabética — e o `draft`
 * não entrava no filtro. Com 73 etiquetas, digitar "carteira" não sugeria
 * `carteira-andreia`; a pessoa digitava o nome inteiro de memória e qualquer
 * diferença (acento, hífen, plural) criava uma etiqueta nova, que é exatamente
 * o que o vocabulário existe para evitar.
 *
 * ─── A régua daqui ──────────────────────────────────────────────────────────
 *
 * A chave é a MESMA da busca (`lib/contacts/etiquetas`, #2732): sem caixa, sem
 * acento, casando no MEIO da palavra. Com o campo vazio, a lista sai na ordem
 * da FONTE — que é a de USO (`uso_em_*`), não a do alfabeto. É por isso que o
 * vocabulário do caso das mais usadas está em ordem de uso e o primeiro do
 * alfabeto é o NONO: inverter para o alfabeto põe outro bloco de oito na tela.
 */
describe("ConversationTagsEditor — sugestões filtram pelo digitado (#3180)", () => {
  beforeEach(() => {
    papel = "manager";
    vi.clearAllMocks();
    vocabularioRef.current = [];
  });
  afterEach(() => cleanup());

  const campo = () => screen.getByLabelText("Adicionar tag à conversa");
  const sugestao = (tag: string) => screen.queryByRole("button", { name: `+ ${tag}` });

  it("digitar “carteira” acha carteira-* com hífen e acento fora da conta", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = ["carteira-andreia", "carteira-danilo", "carteira-joão", "origem-site"];
    renderEditor();

    // Caixa alta de propósito: a chave é sem caixa, como a da busca.
    await user.type(campo(), "CARTEIRA");

    expect(sugestao("carteira-andreia")).not.toBeNull();
    expect(sugestao("carteira-danilo")).not.toBeNull();
    // Acento: o vocabulário tem "joão", quem digita escreve "joao".
    expect(sugestao("carteira-joão")).not.toBeNull();
    expect(sugestao("origem-site")).toBeNull();
  });

  it("digitado sem acento acha a etiqueta com acento", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = ["carteira-andreia", "carteira-joão"];
    renderEditor();

    await user.type(campo(), "joao");

    expect(sugestao("carteira-joão")).not.toBeNull();
    expect(sugestao("carteira-andreia")).toBeNull();
  });

  it("casa no MEIO da palavra (“teira” em “carteira”), não só no começo", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = ["carteira-andreia", "carteira-danilo", "origem-site"];
    renderEditor();

    await user.type(campo(), "teira");

    expect(sugestao("carteira-andreia")).not.toBeNull();
    expect(sugestao("carteira-danilo")).not.toBeNull();
    expect(sugestao("origem-site")).toBeNull();
  });

  it("com o campo vazio mostra as mais usadas, não as primeiras do alfabeto", async () => {
    // Ordem de USO (a que a rota entrega): "zebra-frequente" é a mais usada da
    // organização e "aa-primeira-do-alfabeto" é a NONA em uso. Na ordem
    // alfabética o bloco das oito seria outro — e a mais usada nem apareceria.
    vocabularioRef.current = [
      "zebra-frequente",
      "yy-usada",
      "xx-media",
      "ww-media",
      "vv-pouco",
      "uu-pouco",
      "tt-rara",
      "ss-rara",
      "aa-primeira-do-alfabeto",
    ];
    renderEditor();

    expect(sugestao("zebra-frequente")).not.toBeNull();
    expect(sugestao("ss-rara")).not.toBeNull();
    expect(sugestao("aa-primeira-do-alfabeto")).toBeNull();
  });

  it("o filtro manda: sugere o que casa mesmo fora das oito primeiras", async () => {
    const user = userEvent.setup();
    // A etiqueta que casa é a DÉCIMA da lista: quem corta em oito antes de
    // filtrar nunca a oferece — o defeito descrito na issue.
    vocabularioRef.current = [
      ...Array.from({ length: 9 }, (_, i) => `tag-${String(i).padStart(2, "0")}`),
      "carteira-alvo",
    ];
    renderEditor();

    await user.type(campo(), "alvo");

    expect(sugestao("carteira-alvo")).not.toBeNull();
  });

  it("a etiqueta que a conversa já tem continua fora, mesmo em outra caixa", async () => {
    vocabularioRef.current = ["carteira-andreia", "carteira-danilo"];
    // "Carteira-Andréia" é a mesma etiqueta (a chave ignora caixa e acento): o
    // chip dela não pode voltar para a lista.
    renderEditor(["Carteira-Andréia"]);

    expect(sugestao("carteira-danilo")).not.toBeNull();
    expect(sugestao("carteira-andreia")).toBeNull();
  });
});

/**
 * CRIAR É A ÚLTIMA OPÇÃO, E SÓ QUANDO O TEXTO NÃO EXISTE AINDA (#3180,
 * critério 3).
 *
 * ─── O que faltava ──────────────────────────────────────────────────────────
 *
 * Filtrar pelo digitado (critério 1) e ordenar por uso (critério 2) já estavam
 * de pé; o que a tela ainda não dizia era QUAL das duas coisas o clique faz. A
 * lista oferecia só as existentes, e o Enter no campo criava uma etiqueta nova
 * com o texto cru — então quem digitava "Carteira-Andréia" de memória, com a
 * `carteira-andreia` na frente dos olhos, criava a variante que o vocabulário
 * existe para evitar.
 *
 * ─── A régua ────────────────────────────────────────────────────────────────
 *
 *  - Enter/clique com texto que CASA com uma existente (sem caixa, sem acento)
 *    aplica a EXISTENTE, com a grafia dela;
 *  - a opção "Criar «…»" é a ÚLTIMA da lista e some quando há correspondência
 *    exata — nesse caso a sugestão da etiqueta já está ali.
 */
describe("ConversationTagsEditor — criar só o que não existe (#3180)", () => {
  beforeEach(() => {
    papel = "manager";
    vi.clearAllMocks();
    vocabularioRef.current = [];
  });
  afterEach(() => cleanup());

  const campo = () => screen.getByLabelText("Adicionar tag à conversa");
  const sugestao = (tag: string) => screen.queryByRole("button", { name: `+ ${tag}` });
  const opcaoDeCriar = () => screen.queryByRole("button", { name: /^Criar «/ });
  /** Os chips da lista, na ordem em que a tela os desenha. */
  const opcoes = () =>
    screen
      .getAllByRole("button")
      .map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((rotulo) => rotulo.startsWith("+ ") || rotulo.startsWith("Criar «"));

  it("o Enter APLICA a etiqueta existente quando o texto casa por caixa e acento", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = ["carteira-andreia", "carteira-danilo"];
    renderEditor();

    // Grafia de quem digita de memória: caixa alta e acento que a etiqueta não
    // tem. Criar "carteira-andréia" aqui seria a 74ª etiqueta da organização.
    await user.type(campo(), "CARTEIRA-ANDRÉIA{Enter}");

    expect(mutateSpy).toHaveBeenCalledTimes(1);
    expect(mutateSpy).toHaveBeenCalledWith({
      conversation_id: "c1",
      tags: ["carteira-andreia"],
    });
  });

  it("a opção de criar vem por ÚLTIMO, depois das que casam", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = ["carteira-andreia", "carteira-danilo"];
    renderEditor();

    await user.type(campo(), "carteira");

    expect(sugestao("carteira-andreia")).not.toBeNull();
    expect(sugestao("carteira-danilo")).not.toBeNull();
    expect(opcoes()).toEqual([
      "+ carteira-andreia",
      "+ carteira-danilo",
      "Criar «carteira»",
    ]);
  });

  it("com correspondência exata a opção de criar não aparece", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = ["carteira-andreia"];
    renderEditor();

    await user.type(campo(), "Carteira-Andreia");

    // A existente continua sugerida (é ela que o clique aplica)...
    expect(sugestao("carteira-andreia")).not.toBeNull();
    // ...e não há o que criar.
    expect(opcaoDeCriar()).toBeNull();
  });

  it("clicar em Criar «…» grava a etiqueta nova, pela régua do banco", async () => {
    const user = userEvent.setup();
    vocabularioRef.current = ["carteira-andreia"];
    renderEditor();

    await user.type(campo(), "Indicação de Parceiro");
    const criar = opcaoDeCriar();
    expect(criar).not.toBeNull();

    await user.click(criar as HTMLElement);

    // Minúscula e sem espaço sobrando: a mesma forma que o PATCH grava e que o
    // filtro `?tag=` casa.
    expect(mutateSpy).toHaveBeenCalledWith({
      conversation_id: "c1",
      tags: ["indicação de parceiro"],
    });
  });

  it("não oferece criar uma etiqueta que a conversa já tem", async () => {
    const user = userEvent.setup();
    renderEditor(["vip"]);

    await user.type(campo(), "VIP");

    expect(opcaoDeCriar()).toBeNull();
  });
});
