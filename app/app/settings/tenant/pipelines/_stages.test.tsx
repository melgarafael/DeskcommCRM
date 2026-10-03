/**
 * A tela das etapas do funil — o que ela OFERECE, o que ela ENVIA e o que ela
 * pergunta ANTES de mandar.
 *
 * O que estes testes medem é só o que nasce aqui, na tela: as regras de verdade
 * (quem pode ser destino, quem pode perder a marcação, quem pode ser arquivada)
 * são da API e já têm 75 testes próprios. O que não pode falhar deste lado é
 * (a) não OFERECER o que a API recusaria — em especial mandar negócios para a
 * etapa de fechamento, que os daria por vendidos; (b) avisar CITANDO O NOME
 * antes de mover a marcação; (c) nunca deixar arquivar uma etapa com negócios
 * sem dizer para onde eles vão; e (d) reler o servidor depois de tudo.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "@/lib/api/types";
import type { EstadoDoMapeamento, EtapaDoFunil } from "@/hooks/pipelines/useAgentMapping";

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { apiClient } from "@/lib/api/client";
import { toast } from "sonner";
import {
  StagesSection,
  contagemDeNegocios,
  destinosPossiveis,
  papelDaEtapa,
  patchDePapel,
  ROTULO,
  vizinhoAoMover,
} from "./_stages";

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

const PIPE = "11111111-1111-4111-8111-111111111111";

/** O funil que o gatilho semeia — o que a clínica vê no primeiro login, encurtado. */
const ETAPAS: EtapaDoFunil[] = [
  { id: "e1", name: "Carrinho abandonado", is_won: false, is_lost: false },
  { id: "e2", name: "Aguardando pagamento", is_won: false, is_lost: false },
  { id: "e3", name: "Pago", is_won: true, is_lost: false },
  { id: "e4", name: "Cancelado", is_won: false, is_lost: true },
];

const VAZIO = {
  new: null,
  contacted: null,
  qualifying: null,
  qualified: null,
  negotiating: null,
  won: null,
  lost: null,
};

function estado(
  over: Partial<EstadoDoMapeamento["mapeamento"]> = {},
  etapas: EtapaDoFunil[] = ETAPAS,
): EstadoDoMapeamento {
  return { etapas, mapeamento: { ...VAZIO, ...over } };
}

function montar() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <StagesSection pipelineId={PIPE} ancoraMapeamento={`mapeamento-${PIPE}`} />
    </QueryClientProvider>,
  );
}

/** Abre um seletor e devolve os rótulos oferecidos. */
async function opcoesNaTela(user: ReturnType<typeof userEvent.setup>, testid: string) {
  await user.click(screen.getByTestId(testid));
  const lista = await screen.findByRole("listbox");
  return within(lista)
    .getAllByRole("option")
    .map((o) => o.textContent);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiClient.get).mockResolvedValue({ data: estado() });
});

describe("patchDePapel — só o que muda viaja", () => {
  it("marcar fechamento numa etapa comum manda só is_won", () => {
    expect(patchDePapel(ETAPAS[0]!, "won")).toEqual({ is_won: true });
  });

  it("marcar fechamento na etapa de PERDA solta o papel antigo junto", () => {
    // Sem `is_lost: false` o pedido seria "ganho e perda ao mesmo tempo" e a API
    // recusaria — o usuário veria um erro sobre uma combinação que ele nunca
    // pediu. (A API ainda recusa por outro motivo, e é ela que explica.)
    expect(patchDePapel(ETAPAS[3]!, "won")).toEqual({ is_won: true, is_lost: false });
  });

  it("«nada especial» numa etapa comum não gera pedido nenhum", () => {
    // Um PATCH vazio seria 422 «Nada para alterar» — erro na cara de quem
    // reabriu a lista e escolheu o que já estava lá.
    expect(patchDePapel(ETAPAS[0]!, "nenhum")).toEqual({});
  });

  it("«nada especial» na etapa de fechamento pede a desmarcação (e a API recusa)", () => {
    expect(patchDePapel(ETAPAS[2]!, "nenhum")).toEqual({ is_won: false });
    expect(papelDaEtapa(ETAPAS[2]!)).toBe("won");
  });
});

describe("destinosPossiveis — para onde os negócios podem ir", () => {
  it("exclui a própria etapa, a de fechamento e a de perda", () => {
    expect(destinosPossiveis(ETAPAS, "e1").map((e) => e.id)).toEqual(["e2"]);
  });

  it("funil sem etapa comum sobrando não oferece destino nenhum", () => {
    expect(destinosPossiveis([ETAPAS[0]!, ETAPAS[2]!, ETAPAS[3]!], "e1")).toEqual([]);
  });

  /**
   * ⚠️ AS DUAS METADES SEPARADAS, de propósito. Os testes acima morrem se
   * `!is_won && !is_lost` sair inteiro — e sobrevivem a quem remover só um dos
   * dois. São defeitos diferentes: mandar negócios para a etapa de GANHO os
   * marca vendidos com data de fechamento (`fn_crm_lead_close_on_stage`); para a
   * de PERDA, `fn_validate_lost_reason_required` levanta `22023` e o texto do
   * Postgres chega à tela.
   */
  it("a etapa de PERDA sozinha já é excluída", () => {
    const semGanho = [ETAPAS[0]!, ETAPAS[1]!, ETAPAS[3]!];
    expect(destinosPossiveis(semGanho, "e1").map((e) => e.id)).toEqual(["e2"]);
  });

  it("a etapa de GANHO sozinha já é excluída", () => {
    const semPerda = [ETAPAS[0]!, ETAPAS[1]!, ETAPAS[2]!];
    expect(destinosPossiveis(semPerda, "e1").map((e) => e.id)).toEqual(["e2"]);
  });
});

describe("contagemDeNegocios — a tela recompõe a frase, então pluraliza", () => {
  it("um negócio não vira «1 negócios»", () => {
    expect(contagemDeNegocios(1)).toBe("1 negócio");
  });

  it("zero e muitos ficam no plural", () => {
    expect(contagemDeNegocios(0)).toBe("0 negócios");
    expect(contagemDeNegocios(38)).toBe("38 negócios");
  });
});

describe("vizinhoAoMover — a coluna da esquerda depois do passo", () => {
  it("subir a terceira coluna a deixa depois da PRIMEIRA", () => {
    expect(vizinhoAoMover(ETAPAS, 2, "subir")).toBe("e1");
  });

  it("subir a segunda coluna a deixa em primeiro (sem vizinha à esquerda)", () => {
    expect(vizinhoAoMover(ETAPAS, 1, "subir")).toBeNull();
  });

  it("descer a primeira coluna a deixa depois da segunda", () => {
    expect(vizinhoAoMover(ETAPAS, 0, "descer")).toBe("e2");
  });
});

describe("StagesSection — a linha se explica sozinha", () => {
  /**
   * ⭐ ACHADO DA AVALIAÇÃO DE EXPERIÊNCIA, não do brief. Sem cabeçalho, a linha
   * mostra um campo de texto sem rótulo, duas setas sem legenda e um seletor
   * dizendo «Nada especial» sobre coisa nenhuma — e a pergunta do gate ("ela
   * entende o que é a etapa de fechamento?") vira um chute. O rótulo do seletor
   * foi escrito para ser lido SOB este cabeçalho.
   */
  it("cada controle tem rótulo NOS DOIS layouts — cabeçalho no desktop, na linha no celular", async () => {
    montar();
    await screen.findByTestId("nome-e1");

    // Desktop: o cabeçalho de colunas.
    const cabecalho = within(screen.getByTestId("etapas-cabecalho"));
    for (const texto of [ROTULO.nome, ROTULO.ordem, ROTULO.papel]) {
      expect(cabecalho.getByText(texto)).toBeInTheDocument();
    }

    // ⭐ Celular: a linha EMPILHA e o cabeçalho não alinha com nada — os mesmos
    // rótulos precisam viajar dentro da linha. Sem isto, o defeito que o
    // cabeçalho consertou fica intacto num viewport inteiro, e `aria-label` não
    // cobre: é invisível para quem enxerga.
    const linha = within(screen.getByTestId("etapa-e1"));
    expect(linha.getByText(ROTULO.nome)).toBeInTheDocument();
    expect(linha.getByText(ROTULO.ordem)).toBeInTheDocument();
    expect(linha.getByText(ROTULO.papel)).toBeInTheDocument();

    // E o seletor mostra o rótulo que só faz sentido debaixo deles.
    expect(screen.getByTestId("papel-e3")).toHaveTextContent("Aqui o cliente fecha");
    expect(screen.getByTestId("papel-e1")).toHaveTextContent("Nada especial");
  });
});

describe("StagesSection — renomear, criar e reordenar", () => {
  it("renomear salva ao CONFIRMAR, nunca a cada tecla", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    montar();
    const campo = await screen.findByTestId("nome-e1");

    await user.clear(campo);
    await user.type(campo, "Primeira consulta");
    // Cinco letras digitadas, zero PATCH: um por tecla gravaria "P", "Pr", "Pri"…
    expect(apiClient.patch).not.toHaveBeenCalled();

    await user.tab();
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.patch).mock.calls[0]).toEqual([
      `/api/v1/pipelines/${PIPE}/stages/e1`,
      { name: "Primeira consulta" },
    ]);
  });

  it("sair do campo sem mudar nada não manda pedido nenhum", async () => {
    const user = userEvent.setup();
    montar();
    const campo = await screen.findByTestId("nome-e1");
    await user.click(campo);
    await user.tab();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it("acrescentar etapa manda o nome para o fim do funil e relê", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({ data: { etapas: [] } });
    montar();
    await screen.findByTestId("nome-e1");

    await user.click(screen.getByTestId("nova-etapa"));
    await user.type(screen.getByTestId("nova-etapa-nome"), "Retorno");
    await user.click(screen.getByTestId("nova-etapa-criar"));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.post).mock.calls[0]).toEqual([
      `/api/v1/pipelines/${PIPE}/stages`,
      { name: "Retorno" },
    ]);
    // Releitura: a etapa nova precisa aparecer sem F5.
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
  });

  it("subir uma coluna manda a VIZINHA DA ESQUERDA, não um número de posição", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    montar();
    await screen.findByTestId("nome-e1");

    await user.click(screen.getByTestId("subir-e3"));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.patch).mock.calls[0]![1]).toEqual({ depois_de: "e1" });
  });

  it("a primeira coluna não sobe e a última não desce", async () => {
    montar();
    await screen.findByTestId("nome-e1");
    expect(screen.getByTestId("subir-e1")).toBeDisabled();
    expect(screen.getByTestId("descer-e4")).toBeDisabled();
    expect(screen.getByTestId("descer-e1")).toBeEnabled();
  });
});

describe("StagesSection — a marcação de fechamento", () => {
  it("avisa CITANDO A ETAPA que perde a marcação, e não envia antes de confirmar", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    montar();
    await screen.findByTestId("nome-e1");

    await user.click(screen.getByTestId("papel-e2"));
    await user.click(await screen.findByRole("option", { name: "Aqui o cliente fecha" }));

    const aviso = await screen.findByTestId("confirmar-papel-e2");
    // O nome, não um aviso genérico: «Pago» é a coluna que vai deixar de fechar.
    expect(aviso).toHaveTextContent("Só uma etapa pode ser a de fechamento.");
    expect(aviso).toHaveTextContent("desmarca «Pago»");
    expect(apiClient.patch).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("confirmar-papel-sim-e2"));
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.patch).mock.calls[0]![1]).toEqual({ is_won: true });
  });

  it("cancelar o aviso não grava nada", async () => {
    const user = userEvent.setup();
    montar();
    await screen.findByTestId("nome-e1");

    await user.click(screen.getByTestId("papel-e2"));
    await user.click(await screen.findByRole("option", { name: "Aqui o cliente fecha" }));
    await user.click(within(await screen.findByTestId("confirmar-papel-e2")).getByText("Cancelar"));

    expect(screen.queryByTestId("confirmar-papel-e2")).not.toBeInTheDocument();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it("funil SEM etapa de fechamento não inventa aviso — marca direto", async () => {
    const user = userEvent.setup();
    const semGanho: EtapaDoFunil[] = [
      { id: "e1", name: "Primeiro contato", is_won: false, is_lost: false },
      { id: "e2", name: "Avaliação", is_won: false, is_lost: false },
    ];
    vi.mocked(apiClient.get).mockResolvedValue({ data: estado({}, semGanho) });
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    montar();
    await screen.findByTestId("nome-e2");

    await user.click(screen.getByTestId("papel-e2"));
    await user.click(await screen.findByRole("option", { name: "Aqui o cliente fecha" }));

    // Nada a desmarcar: um aviso aqui seria falso ("desmarca «undefined»").
    expect(screen.queryByTestId("confirmar-papel-e2")).not.toBeInTheDocument();
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
  });

  it("tirar a marcação: a recusa do servidor chega inteira e o seletor não mente", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockRejectedValue(
      new ApiError(
        422,
        "unprocessable_entity",
        undefined,
        "r",
        "A etapa «Pago» é a etapa de ganho deste funil e o funil precisa de uma. Marque OUTRA etapa como de ganho — a marcação se muda, não se apaga.",
      ),
    );
    montar();
    await screen.findByTestId("nome-e1");

    await user.click(screen.getByTestId("papel-e3"));
    await user.click(await screen.findByRole("option", { name: "Nada especial" }));

    expect(await screen.findByTestId("etapa-erro-e3")).toHaveTextContent(
      "a marcação se muda, não se apaga",
    );
    // O seletor volta a dizer o que o BANCO tem — deixá-lo em «nenhuma» faria a
    // tela afirmar um estado que não existe.
    await waitFor(() =>
      expect(screen.getByTestId("papel-e3")).toHaveTextContent("Aqui o cliente fecha"),
    );
    // E releu o servidor: reenviar sobre um funil que mudou é o que o 409 pede
    // para evitar.
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
  });

  /**
   * ⭐ O LINK É SOBRE O ERRO, NÃO SOBRE A LINHA. Condicionado a "esta linha tem
   * passo", um nome duplicado produzia o non sequitur "Já existe uma etapa
   * chamada «Cancelado». Ir para o mapeamento do assistente."
   */
  it("recusa de NOME não oferece o mapeamento do assistente", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue({ data: estado({ won: "e3" }) });
    vi.mocked(apiClient.patch).mockRejectedValue(
      new ApiError(422, "unprocessable_entity", undefined, "r", "Já existe uma etapa chamada «Cancelado» neste funil. Escolha outro nome."),
    );
    montar();
    const campo = await screen.findByTestId("nome-e3");
    await user.clear(campo);
    await user.type(campo, "Cancelado");
    await user.tab();

    const aviso = await screen.findByTestId("etapa-erro-e3");
    expect(aviso).toHaveTextContent("Escolha outro nome");
    expect(within(aviso).queryByRole("link")).toBeNull();
  });

  it("etapa que representa um passo do assistente oferece o caminho para desfazer o vínculo", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: estado({ won: "e3" }) });
    montar();
    const linha = await screen.findByTestId("passo-de-e3");
    expect(linha).toHaveTextContent("O assistente usa esta etapa para «Ganho».");
    expect(within(linha).getByRole("link")).toHaveAttribute("href", `#mapeamento-${PIPE}`);
  });
});

describe("StagesSection — arquivar", () => {
  it("pede confirmação antes de tirar a coluna do quadro", async () => {
    const user = userEvent.setup();
    montar();
    await screen.findByTestId("nome-e1");

    await user.click(screen.getByTestId("arquivar-e1"));
    // Nada foi enviado só por clicar em «Arquivar»: uma coluna some do quadro
    // sem tela para desfazer.
    expect(apiClient.delete).not.toHaveBeenCalled();
    const painel = await screen.findByTestId("arquivar-painel-e1");
    expect(painel).toHaveTextContent("A coluna sai do quadro");
    // Honestidade: não existe tela que desarquive. Dizer isso ANTES é a
    // diferença entre uma escolha e uma armadilha.
    expect(painel).toHaveTextContent("não dá para trazer a coluna de volta por aqui");

    vi.mocked(apiClient.delete).mockResolvedValue({ data: { etapas: [] } });
    await user.click(screen.getByTestId("arquivar-confirmar-e1"));
    await waitFor(() => expect(apiClient.delete).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.delete).mock.calls[0]![0]).toBe(
      `/api/v1/pipelines/${PIPE}/stages/e1`,
    );
  });

  it("com negócios: pergunta o destino com a CONTAGEM do servidor e não deixa arquivar sem ele", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockRejectedValueOnce(
      new ApiError(
        422,
        "unprocessable_entity",
        { negocios: 38, precisa_destino: true },
        "r",
        "A etapa «Carrinho abandonado» tem 38 negócios. Escolha para qual etapa eles vão antes de arquivá-la.",
      ),
    );
    montar();
    await screen.findByTestId("nome-e1");

    await user.click(screen.getByTestId("arquivar-e1"));
    await user.click(screen.getByTestId("arquivar-confirmar-e1"));

    expect(await screen.findByTestId("arquivar-pergunta-e1")).toHaveTextContent(
      "38 negócios estão nesta etapa. Para onde eles vão?",
    );
    // ⭐ Sem destino escolhido, arquivar NÃO é oferecido: perder o rastro de 38
    // negócios não pode ser um clique de distância.
    expect(screen.getByTestId("arquivar-confirmar-e1")).toBeDisabled();

    // ⭐ E o destino nunca inclui fechamento nem perda: mandar os negócios para
    // «Pago» os daria por vendidos, com data de fechamento.
    expect(await opcoesNaTela(user, "destino-e1")).toEqual(["Aguardando pagamento"]);
    await user.click(await screen.findByRole("option", { name: "Aguardando pagamento" }));

    vi.mocked(apiClient.delete).mockResolvedValue({ data: { etapas: [] } });
    await waitFor(() => expect(screen.getByTestId("arquivar-confirmar-e1")).toBeEnabled());
    await user.click(screen.getByTestId("arquivar-confirmar-e1"));

    await waitFor(() => expect(apiClient.delete).toHaveBeenCalledTimes(2));
    expect(vi.mocked(apiClient.delete).mock.calls[1]![0]).toBe(
      `/api/v1/pipelines/${PIPE}/stages/e1?destino=e2`,
    );
  });

  it("com negócios e SEM destino possível: diz o beco em vez de oferecer um seletor vazio", async () => {
    const user = userEvent.setup();
    const soDesfecho: EtapaDoFunil[] = [ETAPAS[0]!, ETAPAS[2]!, ETAPAS[3]!];
    vi.mocked(apiClient.get).mockResolvedValue({ data: estado({}, soDesfecho) });
    vi.mocked(apiClient.delete).mockRejectedValue(
      new ApiError(422, "unprocessable_entity", { negocios: 4, precisa_destino: true }, "r", "…tem 4 negócios…"),
    );
    montar();
    await screen.findByTestId("nome-e1");

    await user.click(screen.getByTestId("arquivar-e1"));
    await user.click(screen.getByTestId("arquivar-confirmar-e1"));

    expect(await screen.findByTestId("arquivar-sem-destino-e1")).toHaveTextContent(
      "Crie uma etapa antes de arquivar «Carrinho abandonado»",
    );
    expect(screen.queryByTestId("destino-e1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("arquivar-confirmar-e1")).not.toBeInTheDocument();
  });

  /**
   * ⚠️ A ETAPA DE FECHAMENTO TEM NEGÓCIOS NA FIXTURE, E ISSO É O TESTE.
   *
   * Com `negocios: 0` este caso passava mesmo com a regra removida — a tela não
   * perguntava destino porque não havia negócio nenhum, não porque a etapa é a
   * de fechamento. Teste confundido: verde pelo motivo errado. «Pago» com 12
   * negócios fechados é o estado NORMAL de um funil em uso, e é aí que a
   * diferença aparece: sem a regra, a tela engole a explicação do servidor e
   * oferece mover 12 negócios fechados para outra coluna — operação que a API
   * recusaria de novo, deixando o usuário num laço sem explicação.
   */
  it("arquivar a etapa de fechamento COM negócios: explica, e não pergunta destino nenhum", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockRejectedValue(
      new ApiError(
        422,
        "unprocessable_entity",
        { negocios: 12, precisa_destino: false },
        "r",
        "«Pago» é a etapa de ganho deste funil. Marque OUTRA etapa como de ganho antes de arquivar esta — senão os negócios continuariam indo parar numa coluna fora do quadro.",
      ),
    );
    montar();
    await screen.findByTestId("nome-e1");

    await user.click(screen.getByTestId("arquivar-e3"));
    await user.click(screen.getByTestId("arquivar-confirmar-e3"));

    expect(await screen.findByTestId("arquivar-erro-e3")).toHaveTextContent(
      "Marque OUTRA etapa como de ganho antes de arquivar esta",
    );
    expect(screen.queryByTestId("destino-e3")).not.toBeInTheDocument();
    expect(screen.queryByTestId("arquivar-pergunta-e3")).not.toBeInTheDocument();
  });

  /**
   * ⭐ A SEGUNDA IRREVERSIBILIDADE. `validarArquivamento` recusa arquivar a etapa
   * de ganho/perda mas NÃO olha `agent_stage_hint`, e o DELETE não limpa o hint:
   * `resolveDestinoDoAgente` procura o alvo com `!is_archived`, então arquivar
   * desliga o passo do assistente em silêncio. A tela avisava sobre a coluna não
   * voltar e não dizia nada sobre isto.
   */
  it("⭐ avisa que arquivar desliga o passo do assistente — citando o passo", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue({ data: estado({ negotiating: "e2" }) });
    montar();
    await screen.findByTestId("nome-e1");

    await user.click(screen.getByTestId("arquivar-e2"));
    const aviso = await screen.findByTestId("arquivar-perde-passo-e2");
    expect(aviso).toHaveTextContent("assistente usa para «Em negociação»");
    expect(aviso).toHaveTextContent("para de mover o card nesse passo");
    expect(within(aviso).getByRole("link")).toHaveAttribute("href", `#mapeamento-${PIPE}`);
  });

  it("etapa sem vínculo com o assistente não ganha aviso que não se aplica", async () => {
    const user = userEvent.setup();
    montar();
    await screen.findByTestId("nome-e1");
    await user.click(screen.getByTestId("arquivar-e1"));
    await screen.findByTestId("arquivar-painel-e1");
    expect(screen.queryByTestId("arquivar-perde-passo-e1")).not.toBeInTheDocument();
  });

  it("com UM negócio a frase não vira «1 negócios estão»", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockRejectedValue(
      new ApiError(422, "unprocessable_entity", { negocios: 1, precisa_destino: true }, "r", "…tem 1 negócio…"),
    );
    montar();
    await screen.findByTestId("nome-e1");

    await user.click(screen.getByTestId("arquivar-e1"));
    await user.click(screen.getByTestId("arquivar-confirmar-e1"));
    const pergunta = await screen.findByTestId("arquivar-pergunta-e1");
    expect(pergunta).toHaveTextContent("1 negócio está nesta etapa. Para onde ele vai?");
    expect(pergunta).not.toHaveTextContent("1 negócios");
  });

  /**
   * ⭐ A tela reage ao que o SERVIDOR disse, não ao que ela deduz. Uma recusa
   * NOVA sobre etapa comum com negócios (aqui: um 409 de concorrência) tem de
   * chegar ao usuário inteira — a versão anterior a trocava por "para onde eles
   * vão?" e o motivo real só aparecia um passo depois.
   */
  it("recusa que NÃO pede destino chega inteira, mesmo com negócios na etapa", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockRejectedValue(
      new ApiError(
        409,
        "state_conflict",
        { negocios: 7, precisa_destino: false },
        "r",
        "«Carrinho abandonado» mudou de papel neste funil enquanto você editava.",
      ),
    );
    montar();
    await screen.findByTestId("nome-e1");

    await user.click(screen.getByTestId("arquivar-e1"));
    await user.click(screen.getByTestId("arquivar-confirmar-e1"));
    expect(await screen.findByTestId("arquivar-erro-e1")).toHaveTextContent("mudou de papel");
    expect(screen.queryByTestId("arquivar-pergunta-e1")).not.toBeInTheDocument();
  });

  it("erro 500 não vaza texto do Postgres para o dono da clínica", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockRejectedValue(
      new ApiError(
        500,
        "internal_error",
        undefined,
        "r",
        'update on table "crm_leads" violates foreign key constraint',
      ),
    );
    montar();
    await screen.findByTestId("nome-e1");

    await user.click(screen.getByTestId("arquivar-e1"));
    await user.click(screen.getByTestId("arquivar-confirmar-e1"));

    const aviso = await screen.findByTestId("arquivar-erro-e1");
    expect(aviso).not.toHaveTextContent("violates");
    expect(aviso).not.toHaveTextContent("crm_leads");
    expect(aviso).toHaveTextContent("Não deu para salvar");
  });
});

describe("StagesSection — a etapa que avisa na Central (migration 0440)", () => {
  it("a chave vem desligada e ligá-la manda só `avisar_na_central: true` para AQUELA etapa", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    montar();
    const chave = await screen.findByTestId("avisar-e2");
    expect(chave).toHaveAttribute("aria-checked", "false");
    // Rótulo com o NOME da etapa: num funil de doze colunas, "Avisar" sozinho
    // não diz qual chave é qual para quem usa leitor de tela.
    expect(chave).toHaveAccessibleName(/«Aguardando pagamento»/);

    await user.click(chave);
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.patch).mock.calls[0]![0]).toContain(`/stages/e2`);
    expect(vi.mocked(apiClient.patch).mock.calls[0]![1]).toEqual({ avisar_na_central: true });
  });

  it("a etapa marcada no servidor aparece ligada, e desligar manda `false`", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue({
      data: estado({}, ETAPAS.map((e) => (e.id === "e2" ? { ...e, avisar_na_central: true } : e))),
    });
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    montar();
    const chave = await screen.findByTestId("avisar-e2");
    expect(chave).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("avisar-e1")).toHaveAttribute("aria-checked", "false");

    await user.click(chave);
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.patch).mock.calls[0]![1]).toEqual({ avisar_na_central: false });
  });
});

describe("StagesSection — a janela de esfriando, em dias e horas (#1532)", () => {
  /** A primeira etapa, já com uma janela gravada (ou sem nenhuma). */
  function comJanela(horas: number | null) {
    const etapas = ETAPAS.map((e) => (e.id === "e1" ? { ...e, expected_duration_hours: horas } : e));
    vi.mocked(apiClient.get).mockResolvedValue({ data: estado({}, etapas) });
  }

  it("2 dias e 6 horas vão como 54 horas, num PATCH só — passar de um campo ao outro não grava", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    comJanela(null);
    montar();
    const dias = await screen.findByTestId("janela-dias-e1");

    await user.click(dias);
    await user.type(dias, "2");
    await user.tab();
    // O foco foi para as horas do MESMO par: gravar aqui mandaria 48 h, um valor que ninguém digitou.
    expect(screen.getByTestId("janela-horas-e1")).toHaveFocus();
    expect(apiClient.patch).not.toHaveBeenCalled();

    await user.type(screen.getByTestId("janela-horas-e1"), "6");
    await user.tab();
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.patch).mock.calls[0]).toEqual([
      `/api/v1/pipelines/${PIPE}/stages/e1`,
      { expected_duration_hours: 54 },
    ]);
  });

  it("esvaziar os dois campos de uma janela gravada manda null — a etapa volta ao padrão", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    comJanela(48);
    montar();
    const dias = await screen.findByTestId("janela-dias-e1");
    expect(dias).toHaveValue(2);

    await user.clear(dias);
    await user.tab();
    await user.clear(screen.getByTestId("janela-horas-e1"));
    await user.tab();
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.patch).mock.calls[0]![1]).toEqual({ expected_duration_hours: null });
  });

  it.each([
    ["0 dias e 0 horas", "0", "0"],
    ["366 dias", "366", ""],
  ])("%s fica fora da régua: não grava e avisa", async (_rotulo, d, h) => {
    const user = userEvent.setup();
    comJanela(null);
    montar();
    const dias = await screen.findByTestId("janela-dias-e1");

    await user.type(dias, d);
    await user.tab();
    if (h) await user.type(screen.getByTestId("janela-horas-e1"), h);
    await user.tab();
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(apiClient.patch).not.toHaveBeenCalled();
    expect(screen.getByTestId("janela-dias-e1")).toHaveValue(null);
  });

  it("Escape desfaz o rascunho e não grava", async () => {
    const user = userEvent.setup();
    comJanela(48);
    montar();
    const dias = await screen.findByTestId("janela-dias-e1");

    await user.clear(dias);
    await user.type(dias, "5");
    await user.keyboard("{Escape}");
    expect(apiClient.patch).not.toHaveBeenCalled();
    expect(screen.getByTestId("janela-dias-e1")).toHaveValue(2);
  });
});

describe("StagesSection — Escape descarta o rascunho do nome e da chance (#2164)", () => {
  it("no nome: Escape desfaz o rascunho e NÃO manda PATCH", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    montar();
    const campo = await screen.findByTestId("nome-e1");

    await user.clear(campo);
    await user.type(campo, "Carrinho abandonadoX");
    await user.keyboard("{Escape}");
    // O blur que o Escape dispara roda ANTES do setState do rascunho: sem a
    // marca `descartando`, o confirmar grava "Carrinho abandonadoX".
    expect(apiClient.patch).not.toHaveBeenCalled();
    expect(screen.getByTestId("nome-e1")).toHaveValue("Carrinho abandonado");
  });

  it("na chance: Escape desfaz o rascunho e NÃO manda PATCH", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    montar();
    const campo = await screen.findByTestId("probabilidade-e1");

    await user.type(campo, "40");
    await user.keyboard("{Escape}");
    expect(apiClient.patch).not.toHaveBeenCalled();
    expect(screen.getByTestId("probabilidade-e1")).toHaveValue(null);
  });

  it("controle: sem Escape, Enter no nome segue gravando", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    montar();
    const campo = await screen.findByTestId("nome-e1");

    await user.clear(campo);
    await user.type(campo, "Primeira consulta{Enter}");
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.patch).mock.calls[0]).toEqual([
      `/api/v1/pipelines/${PIPE}/stages/e1`,
      { name: "Primeira consulta" },
    ]);
  });

  it("controle: sem Escape, sair do campo da chance segue gravando", async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue({ data: { etapas: [] } });
    montar();
    const campo = await screen.findByTestId("probabilidade-e1");

    await user.type(campo, "40");
    await user.tab();
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(apiClient.patch).mock.calls[0]).toEqual([
      `/api/v1/pipelines/${PIPE}/stages/e1`,
      { win_probability: 40 },
    ]);
  });
});
