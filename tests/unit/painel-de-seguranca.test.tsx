import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PainelDeSeguranca } from "@/app/app/ai/agents/[id]/_components/PainelDeSeguranca";
import {
  CONFERENCIAS_DE_SAIDA,
  CONFERENCIA_DE_ENTRADA,
} from "@/lib/ai/guardrails/lista-de-conferencia";

/**
 * O painel do terceiro papel (spec 16 §3.3 e §6).
 *
 * O que estes casos guardam é POLÍTICA, não layout. O painel existe porque a
 * cadeia de conferências rodava e o dono do negócio não sabia — e a decisão de
 * produto que o acompanha é que quase nada ali é escolha dele. Um interruptor que
 * queima o número do cliente não é preferência; **oferecer** o controle já ensina
 * que é opcional.
 *
 * A divisão de trabalho com o teste irmão importa:
 * `seguranca-lista-casa-com-a-cadeia` guarda a LISTA (o que a tela mostra é o que
 * o motor roda); este guarda a POLÍTICA (o que a tela oferece como escolha).
 * Sabotagens diferentes acendem luzes diferentes, e é isso que mostra que os dois
 * medem coisas distintas em vez de um pegar carona no outro.
 */
/**
 * O painel lê as duas camadas configuráveis por organização; sem o provider de
 * query ele estoura. O `apiClient` é dublado para o teste medir a TELA, não a
 * rede.
 */
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({
      data: {
        camadas: [
          { layer: "promessa_semantica", escolha: null, padraoDoAmbiente: true, efetivo: true },
          { layer: "jailbreak", escolha: false, padraoDoAmbiente: true, efetivo: false },
        ],
        podeEditar: true,
      },
    })),
    put: vi.fn(async () => ({ data: {} })),
  },
}));

function renderPainel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PainelDeSeguranca />
    </QueryClientProvider>,
  );
}

describe("painel de segurança — o que se confere antes de enviar", () => {
  it("renderiza TODOS os itens da lista, na ordem — nenhum fica pelo caminho", () => {
    renderPainel();

    // ⚠️ ESTE CASO NÃO GUARDA A CADEIA, e o nome anterior dizia que sim.
    // Descoberto por sabotagem: removi uma conferência da lista pura e este caso
    // seguiu VERDE, porque ele renderiza A PARTIR da lista e compara COM a lista
    // — auto-referente. O que ele guarda de verdade é o componente: um `.slice()`,
    // um filtro ou um `key` duplicado que perdesse item no caminho reprova aqui.
    // Quem amarra a lista à cadeia que roda é
    // `seguranca-lista-casa-com-a-cadeia.test.ts`, e essa separação é de propósito
    // (componente não importa `pg`).
    //
    // A ordem é informação: a primeira que barra interrompe as seguintes. Ler o
    // DOM na ordem em que ele foi montado é o que prova isso — comparar conjuntos
    // passaria com a lista embaralhada.
    const itens = screen.getAllByTestId(/^item-conferencia-/);
    const nomes = itens.map((el) => el.getAttribute("data-testid")?.replace("item-conferencia-", ""));
    expect(nomes).toEqual([
      ...CONFERENCIAS_DE_SAIDA.map((c) => c.nome),
      CONFERENCIA_DE_ENTRADA.nome,
    ]);
  });

  it("EXATAMENTE dois interruptores — um por camada que custa dinheiro", async () => {
    // ⚠️ ESTE CASO JÁ AFIRMOU O CONTRÁRIO, e a mudança é deliberada. Enquanto o
    // motor lia só o `.env`, a asserção certa era ZERO interruptores: um controle
    // que a tela grava e o código ignora é pior que controle nenhum. Depois que a
    // migration 0142 criou a escolha por organização e os TRÊS pontos de consumo
    // passaram a lê-la, o interruptor deixou de ser decorativo e passou a ser
    // devido. A ordem foi essa de propósito.
    //
    // Nove continuam sem controle: desligar o que respeita quem pediu para parar,
    // ou o que impede o número do cliente de ser bloqueado, não é preferência.
    const { container } = renderPainel();
    await waitFor(() =>
      expect(container.querySelectorAll('[role="switch"]')).toHaveLength(2),
    );
    expect(screen.getByTestId("conferencia-semantic_promise-liga")).toBeTruthy();
    expect(screen.getByTestId("conferencia-jailbreak_detect-liga")).toBeTruthy();
  });

  it("o interruptor reflete o que VALE hoje, não o que a organização digitou", async () => {
    // São três estados. `promessa_semantica` sem escolha e ligada no servidor tem
    // de aparecer LIGADA — mostrar desligado porque "a organização não escolheu"
    // faria a pessoa ligar algo que já estava ligado e concluir que estava
    // desligado esse tempo todo.
    renderPainel();
    await waitFor(() => {
      expect(screen.getByTestId("conferencia-semantic_promise-liga")).toHaveAttribute(
        "data-state",
        "checked",
      );
    });
    expect(screen.getByTestId("conferencia-jailbreak_detect-liga")).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });

  it("diz de ONDE vem a decisão — servidor ou escolha da organização", async () => {
    renderPainel();
    await waitFor(() => {
      expect(screen.getByTestId("conferencia-semantic_promise-escolha").textContent).toContain(
        "configuração do servidor",
      );
    });
    expect(screen.getByTestId("conferencia-jailbreak_detect-escolha").textContent).toContain(
      "por você",
    );
  });

  it("cada conferência sem escolha DIZ por que não se desliga", () => {
    renderPainel();

    const fixas = CONFERENCIAS_DE_SAIDA.filter((c) => c.escolha === null);
    // 11 das 12 hoje. A contagem entra na asserção de propósito: se alguém tornar
    // uma delas "configurável", este número muda e a mudança tem de ser deliberada.
    expect(fixas).toHaveLength(11);
    for (const c of fixas) {
      const linha = screen.getByTestId(`conferencia-${c.nome}-fixa`);
      expect(linha.textContent).toContain("não se desliga");
      // Proibição sem razão é o que faz alguém procurar como contornar.
      expect(linha.textContent?.length ?? 0).toBeGreaterThan(50);
    }
  });

  it("as configuráveis dizem o CUSTO — é o que torna a escolha uma escolha", () => {
    // O custo é a única razão pela qual estas duas são configuráveis e as outras
    // demais não. Sem o número na tela, o interruptor vira preferência estética.
    //
    // A frase de ONDE a decisão vem tem caso próprio abaixo: ela depende do
    // estado carregado, e misturar as duas fazia esta asserção medir o texto de
    // "carregando…".
    renderPainel();

    for (const c of [...CONFERENCIAS_DE_SAIDA, CONFERENCIA_DE_ENTRADA]) {
      if (c.escolha === null) continue;
      const linha = screen.getByTestId(`conferencia-${c.nome}-escolha`);
      expect(linha.textContent).toContain("consulta ao modelo");
    }
  });

  it("a conferência de ENTRADA aparece separada da cadeia de saída", () => {
    renderPainel();
    expect(screen.getByText(/antes de o assistente ler/i)).toBeTruthy();
    expect(screen.getByTestId(`item-conferencia-${CONFERENCIA_DE_ENTRADA.nome}`)).toBeTruthy();
  });

  it("a tela não fala a NOSSA língua", () => {
    // O mesmo defeito que a spec 16 existe para matar, um nível acima: se o
    // vocabulário interno vaza para quem CONFIGURA, ele vaza de novo para quem é
    // atendido. E seria irônico aqui, no painel da conferência que barra
    // justamente isso.
    const { container } = renderPainel();
    const texto = (container.textContent ?? "").toLowerCase();
    for (const jargao of ["gate", "before_send", "payload", "guardrail", "veto", "_id"]) {
      expect(texto, `vocabulário interno na tela: ${jargao}`).not.toContain(jargao);
    }
  });
});
