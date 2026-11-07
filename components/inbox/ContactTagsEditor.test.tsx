import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ContactTagsEditor } from "./ContactTagsEditor";
import { apiClient } from "@/lib/api/client";

// Issue #2718 — o espelho do ConversationTagsEditor na aba do CONTATO: mesmo
// gatilho, mesmo definir_cor, mesma recusa para papel abaixo de manager.

let papel = "manager";
const mutateSpy = vi.fn();
/** O vocabulário que o hook devolve — a ORDEM dele é a das sugestões (#3180). */
const vocabularioRef: { current: string[] } = { current: [] };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({ activeOrg: { role: papel } }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate: mutateSpy, isPending: false }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: vocabularioRef.current }),
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
      <ContactTagsEditor entityId="k1" orgId="o1" tags={tags} />
    </QueryClientProvider>,
  );
}

describe("ContactTagsEditor — cor na criação (#2718)", () => {
  beforeEach(() => {
    papel = "manager";
    vi.clearAllMocks();
    vocabularioRef.current = [];
  });
  afterEach(() => cleanup());

  it("sem cor: o “+” só anexa a tag no contato", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText("Adicionar tag ao contato"), "vip");
    await user.click(screen.getByRole("button", { name: "Adicionar tag" }));
    expect(mutateSpy).toHaveBeenCalledWith({ tags: ["vip"] });
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it("com cor: anexa E grava definir_cor com a mesma grafia", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole("button", { name: "Cor da etiqueta" }));
    await user.click(screen.getByRole("button", { name: "Azul" }));
    await user.type(screen.getByLabelText("Adicionar tag ao contato"), "vip");
    await user.click(screen.getByRole("button", { name: "Adicionar tag" }));
    expect(mutateSpy).toHaveBeenCalledWith({ tags: ["vip"] });
    expect(apiClient.post).toHaveBeenCalledWith("/api/v1/tags/vocabulario", {
      acao: "definir_cor",
      tag: "vip",
      destino: null,
      cor: "#0091ff",
    });
  });

  it("para papel agent o gatilho de cor não existe", () => {
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
 * As sugestões eram as oito primeiras do vocabulário em ordem alfabética, e o
 * `draft` não entrava no filtro. Com 73 etiquetas, digitar "carteira" não
 * sugeria `carteira-andreia`; a pessoa digitava o nome inteiro de memória e
 * qualquer diferença (acento, hífen, plural) criava uma etiqueta nova — o que o
 * vocabulário existe para evitar, na conversa e no contato/negócio.
 *
 * ─── A régua daqui ──────────────────────────────────────────────────────────
 *
 * A chave é a MESMA da busca (`lib/contacts/etiquetas`, #2732): sem caixa, sem
 * acento, casando no MEIO da palavra. Com o campo vazio, a lista sai na ordem
 * da FONTE — a de USO (`uso_em_contatos`, `uso_em_leads`) —, não a do alfabeto:
 * o vocabulário do caso das mais usadas está em ordem de uso, e o primeiro do
 * alfabeto é justamente o NONO.
 */
describe("ContactTagsEditor — sugestões filtram pelo digitado (#3180)", () => {
  beforeEach(() => {
    papel = "manager";
    vi.clearAllMocks();
    vocabularioRef.current = [];
  });
  afterEach(() => cleanup());

  const campo = () => screen.getByLabelText("Adicionar tag ao contato");
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

  it("a etiqueta que o contato já tem continua fora, mesmo em outra caixa", async () => {
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
 * critério 3) — o espelho do editor da conversa no CONTATO/NEGÓCIO.
 *
 * A duplicação que a issue descreve nasce exatamente aqui: com
 * `carteira-andreia` na lista, quem digita "Carteira-Andréia" de memória e
 * aperta Enter criava a variante. A régua é a mesma dos dois editores, e é a
 * da ficha do contato (`etiquetaParaGravar`, #2732): a EXISTENTE vence.
 */
describe("ContactTagsEditor — criar só o que não existe (#3180)", () => {
  beforeEach(() => {
    papel = "manager";
    vi.clearAllMocks();
    vocabularioRef.current = [];
  });
  afterEach(() => cleanup());

  const campo = () => screen.getByLabelText("Adicionar tag ao contato");
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

    await user.type(campo(), "CARTEIRA-ANDRÉIA{Enter}");

    expect(mutateSpy).toHaveBeenCalledTimes(1);
    expect(mutateSpy).toHaveBeenCalledWith({ tags: ["carteira-andreia"] });
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

    expect(sugestao("carteira-andreia")).not.toBeNull();
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

    expect(mutateSpy).toHaveBeenCalledWith({ tags: ["indicação de parceiro"] });
  });

  it("não oferece criar uma etiqueta que o contato já tem", async () => {
    const user = userEvent.setup();
    renderEditor(["vip"]);

    await user.type(campo(), "VIP");

    expect(opcaoDeCriar()).toBeNull();
  });
});
