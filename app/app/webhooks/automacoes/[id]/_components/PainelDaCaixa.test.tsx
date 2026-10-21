/**
 * Onde a tela pergunta pelo VALOR da condição — e onde ela não deve perguntar.
 *
 * `esta vazio`/`esta preenchido` perguntam pelo campo, não por um texto
 * (`OPERADORES_SEM_VALOR`, #2727). Estes casos trancam os dois lugares em que o
 * desenho ainda pedia o valor, medidos na prova pela tela do PR #2858:
 *  1. o painel da caixa de condições desenhava o campo de valor;
 *  2. a frase da caixa montava o trecho `“valor”` — « Nome do lead está vazio “” ».
 *
 * A régua é o CAMPO e a FRASE do componente de verdade: se o campo voltar, o
 * caso fica vermelho pelo motivo certo (o valor reaparece), e não por markup.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { LinhaDeCondicao } from "@/lib/automation/desenho-da-regra";
import type { DadosNaTela } from "./CaixaDaAutomacao";

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));

vi.mock("@/hooks/webhooks/useWebhookSources", () => ({
  usePipelines: () => ({ data: { data: [] } }),
  usePipelineStages: () => ({ data: { data: { stages: [] } } }),
  useWebhookSources: () => ({ data: { data: [] } }),
}));

// O Radix (Select) exige estes recursos do navegador, que o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

import { CaixaDaAutomacao } from "./CaixaDaAutomacao";
import { PainelDasCondicoes } from "./PainelDaCaixa";

const EVENTO = "lead.created";
/** Campo curado do gatilho (`CURATED_FIELDS["lead.created"]`): rótulo conhecido. */
const CAMPO = { field: "lead.title", rotulo: "Nome do lead" };

function painel(linhas: LinhaDeCondicao[]) {
  return render(
    <IdiomaProvider locale="pt-BR">
      <PainelDasCondicoes
        dados={{ kind: "condicoes", linhas }}
        evento={EVENTO}
        onLinhas={() => {}}
      />
    </IdiomaProvider>,
  );
}

/** As props completas que o React Flow entrega a um nó (o cartão as ignora). */
function cartao(dados: DadosNaTela) {
  const props = {
    id: "c1",
    data: dados,
    type: dados.kind,
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    selected: false,
    draggable: true,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
  return render(
    <IdiomaProvider locale="pt-BR">
      <CaixaDaAutomacao {...props} />
    </IdiomaProvider>,
  );
}

const frase = () => screen.getByText(/Nome do lead/).textContent;

describe("painel da caixa — operador sem valor não pede valor", () => {
  it.each(["is_empty", "is_not_empty"] as const)("não desenha o campo de valor em %s", (op) => {
    painel([{ field: CAMPO.field, op, value: "" }]);

    expect(screen.queryByLabelText("Valor")).toBeNull();
    // A LINHA continua na tela: o que sumiu foi o campo de valor, não a condição.
    expect(screen.getByLabelText("Operador")).toBeTruthy();
    expect(screen.getByLabelText("Campo")).toBeTruthy();
  });

  it("continua desenhando o campo de valor para o operador que PEDE um valor", () => {
    painel([{ field: CAMPO.field, op: "eq", value: "Maria" }]);

    expect((screen.getByLabelText("Valor") as HTMLInputElement).value).toBe("Maria");
  });
});

describe("frase da caixa — operador sem valor não carrega trecho de valor", () => {
  it("« esta vazio » termina no operador, sem aspas de valor", () => {
    cartao({ kind: "condicoes", linhas: [{ field: CAMPO.field, op: "is_empty", value: "" }], eventoDaRegra: EVENTO });

    expect(frase()).toBe(`${CAMPO.rotulo} está vazio`);
    expect(frase()).not.toContain("“");
  });

  it("« está preenchido » também não monta o trecho de valor", () => {
    cartao({
      kind: "condicoes",
      linhas: [{ field: CAMPO.field, op: "is_not_empty", value: "" }],
      eventoDaRegra: EVENTO,
    });

    expect(frase()).toBe(`${CAMPO.rotulo} está preenchido`);
  });

  it("o operador que pede valor continua mostrando o valor entre aspas", () => {
    cartao({ kind: "condicoes", linhas: [{ field: CAMPO.field, op: "eq", value: "Maria" }], eventoDaRegra: EVENTO });

    expect(frase()).toBe(`${CAMPO.rotulo} é “Maria”`);
  });
});

describe("painel do grupo preservado — o campo aparece pelo rótulo, não pela chave", () => {
  it("mostra « Nome do lead », e não « lead.title », nas condições do grupo", () => {
    const linhas: LinhaDeCondicao[] = [
      { field: CAMPO.field, op: "contains", value: "A" },
      { field: CAMPO.field, op: "contains", value: "B" },
    ];
    render(
      <IdiomaProvider locale="pt-BR">
        <PainelDasCondicoes
          dados={{
            kind: "condicoes",
            linhas,
            grupoPreservado: { any: linhas.map(({ field, op, value }) => ({ field, op, value })) },
          }}
          evento={EVENTO}
          onLinhas={() => {}}
        />
      </IdiomaProvider>,
    );
    const primeira = screen.getByTestId("condicao-0").textContent ?? "";
    expect(primeira).toContain(CAMPO.rotulo);
    expect(primeira).not.toContain(CAMPO.field);
  });
});
