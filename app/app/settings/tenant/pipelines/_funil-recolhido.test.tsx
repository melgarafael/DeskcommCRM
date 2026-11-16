/**
 * CADA FUNIL RECOLHIDO, UM ABERTO POR VEZ (#4083).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * A tela «Etapas do funil» monta um card por funil, e cada card vinha com TODAS
 * as etapas editáveis e o mapeamento do assistente abertos. Com ~10 funis (o
 * caso de quem pediu, na comunidade) a página virava um rolo: para chegar ao
 * terceiro funil era preciso atravessar dois funis inteiros de formulário.
 *
 * ─── O que estes testes trancam ────────────────────────────────────────────
 *
 * Recolhido é o padrão e o nome continua à vista; abrir um RECOLHE o outro
 * (é acordeão, não N gavetas independentes); clicar de novo no mesmo FECHA (não
 * existe funil travado aberto); com um funil só a tela nasce como era antes; o
 * cabeçalho é um botão de verdade (`Enter`/`Espaço`, `aria-expanded`); e o que
 * estava editável continua editável — o teste de edição usa a `StagesSection`
 * de VERDADE, não um dublê, porque «recolher só esconde» é a promessa que
 * precisa de prova.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { EstadoDoMapeamento, EtapaDoFunil } from "@/hooks/pipelines/useAgentMapping";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/actions/settings/updatePipelineConfig", () => ({
  updatePipelineConfig: vi.fn(async () => ({ ok: true })),
}));
/**
 * O MAPEAMENTO vira dublê: ele fala com a mesma rota e não é o alvo aqui — o
 * que este arquivo mede é o que o recolhimento mostra ou esconde. O resto do
 * módulo (a mensagem de erro que a seção de etapas importa) continua REAL.
 */
const dublesDoMapeamento = vi.hoisted(() => ({ usarDeVerdade: false }));
vi.mock("./_mapping", async () => {
  const real = await vi.importActual<typeof import("./_mapping")>("./_mapping");
  return {
    ...real,
    AgentMappingSection: (props: Parameters<typeof real.AgentMappingSection>[0]) =>
      dublesDoMapeamento.usarDeVerdade ? (
        <real.AgentMappingSection {...props} />
      ) : (
        <div data-testid="mapeamento-do-agente" />
      ),
  };
});

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { PipelinesClient, type PipelineRow } from "./_client";

const DONO = "11111111-1111-4111-8111-111111111111";
const FILIAL = "22222222-2222-4222-8222-222222222222";

const VAZIO = {
  new: null,
  contacted: null,
  qualifying: null,
  qualified: null,
  negotiating: null,
  won: null,
  lost: null,
};

/** As etapas do funil, prefixadas para que as duas seções não colidam em testid. */
function etapas(prefixo: string): EtapaDoFunil[] {
  return [
    { id: `${prefixo}-1`, name: "Novo contato", is_won: false, is_lost: false },
    { id: `${prefixo}-2`, name: "Em conversa", is_won: false, is_lost: false },
    { id: `${prefixo}-3`, name: "Fechado", is_won: true, is_lost: false },
  ];
}

function estado(e: EtapaDoFunil[]): EstadoDoMapeamento {
  return { etapas: e, mapeamento: { ...VAZIO } };
}

function funil(id: string, nome: string): PipelineRow {
  return {
    id,
    name: nome,
    slug: nome.toLowerCase().replace(/\s+/g, "-"),
    vocabulary: null,
    settings: null,
  };
}

const VENDAS = funil(DONO, "Vendas");
const LOCACAO = funil(FILIAL, "Locação");

function montar(
  pipelines: PipelineRow[] = [VENDAS, LOCACAO],
  { podeEditarConfig = false }: { podeEditarConfig?: boolean } = {},
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PipelinesClient pipelines={pipelines} podeEditarConfig={podeEditarConfig} />
    </QueryClientProvider>,
  );
}

/** O corpo recolhível de um funil — o que o cabeçalho abre e fecha. */
const corpoDe = (id: string) => screen.getByTestId(`corpo-do-funil-${id}`);
const cabecalhoDe = (id: string) => screen.getByTestId(`abrir-funil-${id}`);

function comMovimentoReduzido(reduzido: boolean) {
  window.matchMedia = vi.fn(() => ({ matches: reduzido })) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  comMovimentoReduzido(false);
  vi.mocked(apiClient.get).mockImplementation((async (rota: string) => {
    if (String(rota).includes(DONO)) return { data: estado(etapas("d")) };
    if (String(rota).includes(FILIAL)) return { data: estado(etapas("f")) };
    return { data: {} };
  }) as never);
});

afterEach(() => {
  // A âncora é global: sem limpar, um caso abriria o funil do caso anterior.
  window.history.replaceState(null, "", "/");
});

describe("a tela dos funis — recolhido é o padrão, aberto é um por vez", () => {
  it("com mais de um funil, todos nascem RECOLHIDOS — nome à vista, corpo escondido", async () => {
    montar();

    // ⚠️ A LINHA DO DEFEITO: hoje (antes desta mudança) os dois funis vêm
    // ABERTOS — o campo de nome da primeira etapa de cada um está à vista, e é
    // isso que empurra o resto da tela para baixo. Depois, nenhum dos dois.
    await waitFor(() => expect(screen.getByTestId("nome-d-1")).toBeInTheDocument());
    expect(screen.getByTestId("nome-d-1")).not.toBeVisible();
    expect(screen.getByTestId("nome-f-1")).not.toBeVisible();

    // O NOME continua na tela: é o que identifica o funil recolhido.
    expect(screen.getByText("Vendas")).toBeVisible();
    expect(screen.getByText("Locação")).toBeVisible();

    for (const id of [DONO, FILIAL]) {
      expect(cabecalhoDe(id)).toHaveAttribute("aria-expanded", "false");
      // `aria-controls` amarra controle e corpo: sem ele o leitor de tela
      // anuncia «recolhido» sem dizer o que foi recolhido.
      expect(cabecalhoDe(id)).toHaveAttribute("aria-controls", `corpo-do-funil-${id}`);
      expect(corpoDe(id).hidden).toBe(true);
    }

    // O mapeamento do agente vai junto: é o segundo bloco que fazia o rolo.
    expect(within(corpoDe(DONO)).getByTestId("mapeamento-do-agente")).not.toBeVisible();
  });

  it("abrir um funil RECOLHE o outro — nunca dois abertos", async () => {
    montar();
    const user = userEvent.setup();

    await user.click(cabecalhoDe(DONO));
    expect(corpoDe(DONO).hidden).toBe(false);
    expect(corpoDe(FILIAL).hidden).toBe(true);
    expect(cabecalhoDe(DONO)).toHaveAttribute("aria-expanded", "true");

    await user.click(cabecalhoDe(FILIAL));
    // O primeiro fechou sozinho: é acordeão, não gaveta independente.
    expect(corpoDe(FILIAL).hidden).toBe(false);
    expect(corpoDe(DONO).hidden).toBe(true);
    expect(cabecalhoDe(DONO)).toHaveAttribute("aria-expanded", "false");
    expect([corpoDe(DONO), corpoDe(FILIAL)].filter((c) => !c.hidden)).toHaveLength(1);
  });

  it("clicar de novo no cabeçalho FECHA — o funil não fica travado aberto", async () => {
    montar();
    const user = userEvent.setup();

    await user.click(cabecalhoDe(DONO));
    await user.click(cabecalhoDe(DONO));

    expect(corpoDe(DONO).hidden).toBe(true);
    expect(corpoDe(FILIAL).hidden).toBe(true);
    expect(cabecalhoDe(DONO)).toHaveAttribute("aria-expanded", "false");
  });

  it("com UM funil só, ele nasce aberto — e ainda assim fecha no clique", async () => {
    montar([VENDAS]);
    const user = userEvent.setup();

    // Sem outro funil não há com o que competir: a tela fica como era antes de
    // recolher existir, e o dono do funil não ganha um clique a mais.
    expect(cabecalhoDe(DONO)).toHaveAttribute("aria-expanded", "true");
    expect(corpoDe(DONO).hidden).toBe(false);
    expect(within(corpoDe(DONO)).getByTestId("mapeamento-do-agente")).toBeVisible();

    await user.click(cabecalhoDe(DONO));
    expect(corpoDe(DONO).hidden).toBe(true);
  });

  it("o cabeçalho é botão de verdade: Enter abre, Espaço fecha, aria-expanded acompanha", async () => {
    montar();
    const user = userEvent.setup();
    const botao = cabecalhoDe(DONO);

    // O nome acessível do controle é o nome do funil — nenhuma string nova.
    expect(botao).toHaveAccessibleName(/Vendas/);
    expect(botao.tagName).toBe("BUTTON");

    botao.focus();
    await user.keyboard("{Enter}");
    expect(botao).toHaveAttribute("aria-expanded", "true");
    expect(corpoDe(DONO).hidden).toBe(false);

    await user.keyboard(" ");
    expect(botao).toHaveAttribute("aria-expanded", "false");
    expect(corpoDe(DONO).hidden).toBe(true);
  });

  it("com o funil aberto, editar etapa continua gravando (o corpo não vira vitrine)", async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    montar();
    const user = userEvent.setup();

    await user.click(cabecalhoDe(DONO));
    const campo = await within(corpoDe(DONO)).findByTestId("nome-d-1");
    expect(campo).toBeVisible();

    await user.clear(campo);
    await user.type(campo, "Primeiro contato");
    await user.tab();

    // O mesmo PATCH de antes do recolhimento, na mesma rota: esconder não
    // desliga nada.
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.patch).mock.calls[0]).toEqual([
      `/api/v1/pipelines/${DONO}/stages/d-1`,
      { name: "Primeiro contato" },
    ]);
  });

  it("a âncora #mapeamento-<id> ABRE o funil que ela aponta", async () => {
    // O hash do «Mudar isso» sobrevive a recarregar a página. Recolhido, o alvo
    // estaria `hidden` e o link não levaria a lugar nenhum.
    window.location.hash = `#mapeamento-${FILIAL}`;
    montar();

    await waitFor(() => expect(corpoDe(FILIAL).hidden).toBe(false));
    expect(corpoDe(DONO).hidden).toBe(true);
  });

  it("a âncora #etapas-<id> também abre o funil", async () => {
    window.location.hash = `#etapas-${DONO}`;
    montar();

    await waitFor(() => expect(corpoDe(DONO).hidden).toBe(false));
    expect(corpoDe(FILIAL).hidden).toBe(true);
  });
});

describe("a tela dos funis — o editor de vocabulário não some quando o funil recolhe", () => {
  it("o botão «Editar vocabulário e campos deste funil» continua na tela", () => {
    montar([VENDAS, LOCACAO], { podeEditarConfig: true });
    // Ele é irmão do corpo recolhido, não filho: quem só quer editar campos não
    // precisa abrir as etapas (e a #3176 continua valendo, com o editor montando
    // sob demanda).
    expect(
      screen.getAllByRole("button", { name: /Editar vocabulário e campos deste funil/i }),
    ).toHaveLength(2);
  });
});

describe("a tela dos funis — o que acontece depois de abrir", () => {
  it("salvar o funil (lista nova, hash velho na URL) não troca o funil aberto", async () => {
    // `updatePipelineConfig` revalida a rota e a lista chega como array NOVO; o
    // hash do «Mudar isso» continua na URL. A âncora vale só na chegada à tela.
    window.location.hash = `#mapeamento-${FILIAL}`;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tela = (lista: PipelineRow[]) => (
      <QueryClientProvider client={qc}>
        <PipelinesClient pipelines={lista} podeEditarConfig={false} />
      </QueryClientProvider>
    );
    const { rerender } = render(tela([VENDAS, LOCACAO]));
    await waitFor(() => expect(corpoDe(FILIAL).hidden).toBe(false));

    await userEvent.setup().click(cabecalhoDe(DONO));
    expect(corpoDe(DONO).hidden).toBe(false);

    rerender(tela([{ ...VENDAS }, { ...LOCACAO }]));

    await new Promise((fim) => setTimeout(fim, 0));
    expect(corpoDe(DONO).hidden).toBe(false);
    expect(corpoDe(FILIAL).hidden).toBe(true);
  });

  it("nome recusado ao clicar direto no cabeçalho avisa fora do corpo recolhido", async () => {
    // O clique no cabeçalho tira o foco do campo: é esse blur que grava. A
    // recusa chega com o corpo já `hidden`, onde o aviso da linha ninguém vê.
    vi.mocked(apiClient.patch).mockRejectedValue(new Error("recusado"));
    montar();
    const user = userEvent.setup();

    await user.click(cabecalhoDe(DONO));
    const campo = await within(corpoDe(DONO)).findByTestId("nome-d-1");
    await user.clear(campo);
    await user.type(campo, "Em conversa");
    await user.click(cabecalhoDe(DONO));

    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(corpoDe(DONO).hidden).toBe(true);
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
  });
});

describe("a tela dos funis — chegar por âncora leva até a seção", () => {
  const rolagem = vi.mocked(window.HTMLElement.prototype.scrollIntoView);
  /** Quem foi rolado até agora: o `id` de cada elemento alvo de `scrollIntoView`. */
  const alvosDaRolagem = () => rolagem.mock.contexts.map((alvo) => (alvo as HTMLElement).id);

  /** A leitura do funil fica presa até `soltar()`: é a janela em que a seção ainda não existe. */
  function leituraPresa(trechoDaRota: string) {
    let soltar = () => {};
    const preso = new Promise<void>((fim) => {
      soltar = fim;
    });
    vi.mocked(apiClient.get).mockImplementation((async (rota: string) => {
      if (String(rota).includes(trechoDaRota)) await preso;
      return { data: estado(etapas(String(rota).includes(DONO) ? "d" : "f")) };
    }) as never);
    return soltar;
  }

  /** Dá tempo de um efeito atrasado rolar, antes de afirmar que ele não rolou. */
  const assentar = () => new Promise((fim) => setTimeout(fim, 20));

  // A seção de VERDADE: o `id` dela só nasce um render depois da leitura (o rascunho
  // vem de um efeito). Um dublê com o `id` sempre presente aprovou uma rolagem que, na
  // tela, procurava um alvo que ainda não existia.
  beforeEach(() => {
    dublesDoMapeamento.usarDeVerdade = true;
  });

  afterEach(() => {
    dublesDoMapeamento.usarDeVerdade = false;
    Reflect.deleteProperty(window, "scrollY");
  });

  it("espera as etapas carregarem e só então rola, uma vez, até o mapeamento", async () => {
    // Só o funil fica preso: a taxa responde antes, e nada mais acorda a rolagem depois
    // dela a não ser o próprio elemento aparecer.
    const soltar = leituraPresa(`${FILIAL}/agent-mapping`);
    window.location.hash = `#mapeamento-${FILIAL}`;
    montar();

    await waitFor(() => expect(corpoDe(FILIAL).hidden).toBe(false));
    await screen.findByTestId("etapas-carregando");
    await assentar();
    expect(rolagem).not.toHaveBeenCalled();

    soltar();
    await waitFor(() => expect(alvosDaRolagem()).toEqual([`mapeamento-${FILIAL}`]));
    expect(rolagem).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("espera também a taxa das etapas, que empurra o mapeamento para baixo", async () => {
    const soltar = leituraPresa(`${FILIAL}/stages/win-rates`);
    window.location.hash = `#mapeamento-${FILIAL}`;
    montar();

    await screen.findByTestId(`mapeamento-${FILIAL}`);
    await assentar();
    expect(rolagem).not.toHaveBeenCalled();

    soltar();
    await waitFor(() => expect(alvosDaRolagem()).toEqual([`mapeamento-${FILIAL}`]));
  });

  it("com a taxa de outro funil chegando junto, rola com a taxa deste já na tela", async () => {
    // A resposta do funil vizinho, no mesmo instante, acordava quem escuta a cache
    // inteira antes de as linhas entrarem: a seção parava 309 px longe do topo.
    let soltar = () => {};
    const preso = new Promise<void>((fim) => {
      soltar = fim;
    });
    vi.mocked(apiClient.get).mockImplementation((async (rota: string) => {
      const prefixo = String(rota).includes(DONO) ? "d" : "f";
      if (!String(rota).includes("/win-rates")) return { data: estado(etapas(prefixo)) };
      await preso;
      return {
        data: {
          inicio: "2025-10-03T12:00:00.000Z",
          fim: "2026-10-03T12:00:00.000Z",
          dias: 365,
          truncado: false,
          minimo_de_casos: 10,
          taxas: [{ etapa_id: `${prefixo}-1`, total: 20, ganhos: 8, percentual: 40, sugestao: 40 }],
        },
      };
    }) as never);
    const taxaNaHoraDeRolar: boolean[] = [];
    rolagem.mockImplementationOnce(() => {
      taxaNaHoraDeRolar.push(document.querySelector('[data-testid="taxa-f-1"]') !== null);
    });
    window.location.hash = `#mapeamento-${FILIAL}`;
    montar();
    await screen.findByTestId(`mapeamento-${FILIAL}`);

    soltar();
    await waitFor(() => expect(taxaNaHoraDeRolar).toEqual([true]));
  });

  it("a âncora #etapas-<id> também rola", async () => {
    window.location.hash = `#etapas-${DONO}`;
    montar();

    await waitFor(() => expect(alvosDaRolagem()).toEqual([`etapas-${DONO}`]));
  });

  it("com movimento reduzido chega no mesmo lugar, sem o percurso", async () => {
    comMovimentoReduzido(true);
    window.location.hash = `#mapeamento-${FILIAL}`;
    montar();

    await waitFor(() => expect(rolagem).toHaveBeenCalledTimes(1));
    expect(rolagem).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    expect(window.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("com o funil já em cache, a chegada por âncora rola do mesmo jeito", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["agent-mapping", DONO], estado(etapas("d")));
    window.location.hash = `#mapeamento-${DONO}`;
    render(
      <QueryClientProvider client={qc}>
        <PipelinesClient pipelines={[VENDAS]} podeEditarConfig={false} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(alvosDaRolagem()).toEqual([`mapeamento-${DONO}`]));
  });

  it("não rola de novo: lista nova e releitura com o hash velho na URL", async () => {
    window.location.hash = `#mapeamento-${FILIAL}`;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tela = (lista: PipelineRow[]) => (
      <QueryClientProvider client={qc}>
        <PipelinesClient pipelines={lista} podeEditarConfig={false} />
      </QueryClientProvider>
    );
    const { rerender } = render(tela([VENDAS, LOCACAO]));
    await waitFor(() => expect(rolagem).toHaveBeenCalledTimes(1));

    rerender(tela([{ ...VENDAS }, { ...LOCACAO }]));
    await qc.invalidateQueries({ queryKey: ["agent-mapping", FILIAL] });
    await qc.invalidateQueries({ queryKey: ["stage-win-rates", FILIAL] });
    // Qualquer mudança de DOM depois da chegada: quem espera o elemento já parou de olhar.
    document.body.append(document.createElement("div"));
    await assentar();

    expect(rolagem).toHaveBeenCalledTimes(1);
  });

  it("quem já rolou a página enquanto carregava não é puxado", async () => {
    const soltar = leituraPresa(FILIAL);
    window.location.hash = `#mapeamento-${FILIAL}`;
    montar();
    await waitFor(() => expect(corpoDe(FILIAL).hidden).toBe(false));

    Object.defineProperty(window, "scrollY", { configurable: true, value: 300 });
    soltar();
    await screen.findByTestId(`etapas-${FILIAL}`);
    await assentar();

    expect(rolagem).not.toHaveBeenCalled();
    expect(corpoDe(FILIAL).hidden).toBe(false);
  });

  it("abrir outro funil enquanto carrega cancela: nada recolhe nem rola, nem ao reabrir o da âncora", async () => {
    const usuario = userEvent.setup();
    const soltar = leituraPresa(FILIAL);
    window.location.hash = `#mapeamento-${FILIAL}`;
    montar();
    await waitFor(() => expect(corpoDe(FILIAL).hidden).toBe(false));

    await usuario.click(cabecalhoDe(DONO));
    soltar();
    await screen.findByTestId(`etapas-${FILIAL}`);
    await assentar();

    expect(corpoDe(DONO).hidden).toBe(false);
    expect(corpoDe(FILIAL).hidden).toBe(true);
    expect(rolagem).not.toHaveBeenCalled();

    await usuario.click(cabecalhoDe(FILIAL));
    await assentar();
    expect(corpoDe(FILIAL).hidden).toBe(false);
    expect(rolagem).not.toHaveBeenCalled();
  });

  it("sem âncora na URL, abrir um funil não move a página", async () => {
    montar();
    await userEvent.setup().click(cabecalhoDe(FILIAL));
    await screen.findByTestId(`etapas-${FILIAL}`);
    await assentar();

    expect(rolagem).not.toHaveBeenCalled();
  });
});
