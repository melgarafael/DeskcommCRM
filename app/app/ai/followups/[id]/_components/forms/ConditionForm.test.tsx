/**
 * O formulário de condição remontava a config com `{ combinator, checks }` e mais
 * nada, então qualquer campo fora dessas duas chaves era descartado na primeira
 * edição do nó. Com o modo de ramificação vivendo justamente ali, o efeito
 * visível seria o pior possível: o usuário liga "uma saída por regra", mexe em
 * qualquer outro campo, e as bolinhas somem sozinhas.
 *
 * Estes testes guardam COMPORTAMENTO (o que desce no onChange), não o texto do
 * arquivo — trocar a implementação sem perder a propriedade continua verde.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { EtapasDoFluxo } from "../EtapasDoFluxo";
import { ConditionForm } from "./ConditionForm";
import type { ConfigOf } from "./shared";

/** As etapas que o construtor enxerga, trocadas por teste — sem react-query nem rede. */
let etapasDoFluxo: EtapasDoFluxo = { etapas: [], carregando: false, falhou: false, nomes: {} };
vi.mock("../EtapasDoFluxo", () => ({ useEtapasDoFluxo: () => etapasDoFluxo }));

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

/** `delay: null` — sem isso o Radix Select estoura o teto do vitest sob carga. */
const usuario = () => userEvent.setup({ delay: null });

const POR_REGRA: ConfigOf<"condition"> = {
  combinator: "and",
  branching: "per_check",
  checks: [
    { id: "regra-1", label: "Cliente VIP", field: "tag", op: "contains", value: "vip" },
    { id: "regra-2", field: "steps_taken", op: "gte", value: 3 },
  ],
};

function renderizar(config: ConfigOf<"condition">, ramosLigados: string[] = []) {
  const gravados: ConfigOf<"condition">[] = [];
  render(<ConditionForm config={config} onChange={(c) => gravados.push(c)} ramosLigados={ramosLigados} />);
  return gravados;
}

describe("ConditionForm — o modo sobrevive a uma edição qualquer", () => {
  it("editar o valor de uma regra NÃO apaga o modo uma-saída-por-regra", async () => {
    const user = usuario();
    const gravados = renderizar(POR_REGRA);

    await user.type(screen.getAllByLabelText("Valor")[0]!, "x");

    expect(gravados.length).toBeGreaterThan(0);
    expect(gravados.at(-1)!.branching).toBe("per_check");
  });

  it("editar mantém os ids das regras — é o que segura a aresta no lugar", async () => {
    const user = usuario();
    const gravados = renderizar(POR_REGRA);

    await user.type(screen.getByLabelText("Nome da saída 1"), "!");

    expect(gravados.at(-1)!.checks.map((c) => c.id)).toEqual(["regra-1", "regra-2"]);
  });

  it("apagar o nome da saída remove o campo em vez de gravar vazio e reprovar", async () => {
    const user = usuario();
    const gravados = renderizar(POR_REGRA);

    await user.clear(screen.getByLabelText("Nome da saída 1"));

    expect(gravados.at(-1)!.checks[0]!.label).toBeUndefined();
    expect(gravados.at(-1)!.checks[0]!.id).toBe("regra-1");
  });

  it("um nó de fluxo antigo não ganha a chave nova só por ser editado", async () => {
    const user = usuario();
    const v1: ConfigOf<"condition"> = {
      combinator: "and",
      checks: [{ field: "tag", op: "contains", value: "vip" }],
    };
    const gravados = renderizar(v1);

    await user.type(screen.getByLabelText("Valor"), "x");

    expect(gravados.at(-1)).not.toHaveProperty("branching");
  });
});

describe("ConditionForm — trocar de modo avisa antes", () => {
  it("com ligação que vai ficar órfã, pergunta e diz QUANTAS antes de aplicar", async () => {
    const user = usuario();
    // As duas regras estão ligadas; no modo combinado esses ramos deixam de existir.
    const gravados = renderizar(POR_REGRA, ["regra-1", "regra-2"]);

    await user.click(screen.getByRole("combobox", { name: "Como as regras decidem o caminho" }));
    await user.click(await screen.findByRole("option", { name: /Avaliar as regras juntas/ }));

    const aviso = screen.getByTestId("cond-troca-aviso");
    expect(aviso).toHaveTextContent("2 ligações sem saída");
    // E, principalmente: NADA foi gravado ainda.
    expect(gravados).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Trocar mesmo assim" }));
    expect(gravados.at(-1)).not.toHaveProperty("branching");
  });

  it("cancelar deixa tudo como estava", async () => {
    const user = usuario();
    const gravados = renderizar(POR_REGRA, ["regra-1"]);

    await user.click(screen.getByRole("combobox", { name: "Como as regras decidem o caminho" }));
    await user.click(await screen.findByRole("option", { name: /Avaliar as regras juntas/ }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByTestId("cond-troca-aviso")).toBeNull();
    expect(gravados).toEqual([]);
  });

  it("sem nenhuma ligação órfã, troca direto e já dá id estável para cada regra", async () => {
    const user = usuario();
    const v1: ConfigOf<"condition"> = {
      combinator: "and",
      checks: [
        { field: "tag", op: "contains", value: "vip" },
        { field: "steps_taken", op: "gte", value: 3 },
      ],
    };
    const gravados = renderizar(v1, []);

    await user.click(screen.getByRole("combobox", { name: "Como as regras decidem o caminho" }));
    await user.click(await screen.findByRole("option", { name: "Uma saída por regra" }));

    expect(screen.queryByTestId("cond-troca-aviso")).toBeNull();
    const ultimo = gravados.at(-1)!;
    expect(ultimo.branching).toBe("per_check");
    const ids = ultimo.checks.map((c) => c.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });
});

describe("ConditionForm — a regra nasce e muda sem decidir sozinha", () => {
  const ID_PAGO = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

  beforeEach(() => {
    etapasDoFluxo = {
      etapas: [{ stageId: ID_PAGO, stageName: "Pago", pipelineId: "p1", pipelineName: "Vendas", isPerda: false, settingsDoFunil: null }],
      carregando: false,
      falhou: false,
      nomes: { etapa: (id) => (id === ID_PAGO ? "Pago · Vendas" : null) },
    };
  });

  it("'+ Condição' acrescenta uma regra A PREENCHER — nunca uma que vale para todo lead", async () => {
    // Era `passos ≥ 0`: verdadeira sempre, e no modo por regra desviava todo lead.
    const user = usuario();
    const gravados = renderizar(POR_REGRA);

    await user.click(screen.getByRole("button", { name: "Condição" }));

    expect(gravados.at(-1)!.checks.at(-1)).toEqual({ id: "regra-3", field: "lead_stage", op: "eq", value: "" });
  });

  it("a etapa é escolhida na lista pelo nome e grava o id que o motor compara", async () => {
    const user = usuario();
    const gravados = renderizar({ combinator: "and", checks: [{ field: "lead_stage", op: "eq", value: "" }] });

    await user.click(screen.getByRole("combobox", { name: "Valor" }));
    await user.click(await screen.findByRole("option", { name: "Pago · Vendas" }));

    expect(gravados.at(-1)!.checks[0]!.value).toBe(ID_PAGO);
    expect(screen.getByText("O lead está na etapa “Pago · Vendas”")).toBeInTheDocument();
  });

  it("o nome digitado à mão num fluxo antigo aparece como AVISO, não como etapa escolhida", () => {
    renderizar({ combinator: "and", checks: [{ field: "lead_stage", op: "eq", value: "PAGO" }] });

    const aviso = screen.getByTestId("regra-etapa-solta");
    expect(aviso).toHaveTextContent("“PAGO” foi digitado à mão e não é uma etapa do funil");
    expect(screen.getByRole("combobox", { name: "Valor" })).toHaveTextContent("Escolha a etapa");
  });

  it("etapa apagada avisa sem mostrar o id", () => {
    const APAGADA = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
    renderizar({ combinator: "and", checks: [{ field: "lead_stage", op: "neq", value: APAGADA }] });

    const aviso = screen.getByTestId("regra-etapa-solta");
    expect(aviso).toHaveTextContent("não está mais na lista de etapas ativas");
    expect(document.body).not.toHaveTextContent(APAGADA);
  });

  it("enquanto as etapas carregam, não acusa etapa solta", () => {
    etapasDoFluxo = { etapas: [], carregando: true, falhou: false, nomes: { etapa: () => "…" } };
    renderizar({ combinator: "and", checks: [{ field: "lead_stage", op: "eq", value: ID_PAGO }] });

    expect(screen.queryByTestId("regra-etapa-solta")).toBeNull();
  });

  it("leitura que falhou não acusa a regra: diz que não deu para carregar, e preserva o valor", () => {
    etapasDoFluxo = { etapas: [], carregando: false, falhou: true, nomes: { etapa: () => "…" } };
    renderizar({ combinator: "and", checks: [{ field: "lead_stage", op: "eq", value: ID_PAGO }] });

    expect(screen.getByTestId("regra-etapas-indisponiveis")).toHaveTextContent("Não consegui carregar as etapas agora");
    expect(screen.queryByTestId("regra-etapa-solta")).toBeNull();
  });

  it("a regra que vale para todo contato se avisa enquanto se escreve", () => {
    // Era o padrão do produto (`passos ≥ 0`) e continua digitável: no modo uma
    // saída por regra ela leva todo mundo e as outras saídas morrem.
    renderizar({ combinator: "and", checks: [{ field: "steps_taken", op: "gte", value: 0 }] });

    expect(screen.getByTestId("regra-vale-sempre-0")).toHaveTextContent("vale para todo contato");
  });

  it("passos com valor de verdade não é acusado de valer sempre", () => {
    renderizar({ combinator: "and", checks: [{ field: "steps_taken", op: "gte", value: 3 }] });

    expect(screen.queryByTestId("regra-vale-sempre-0")).toBeNull();
  });

  it("passos digitado grava NÚMERO — o motor não compara texto com número", async () => {
    const user = usuario();
    const gravados = renderizar(POR_REGRA);

    const campo = screen.getAllByLabelText("Valor")[1]!;
    await user.clear(campo);
    await user.type(campo, "5");

    expect(gravados.at(-1)!.checks[1]!.value).toBe(5);
  });

  it("trocar o campo recomeça o valor — o 3 de passos não vira a etapa “3”", async () => {
    const user = usuario();
    const gravados = renderizar(POR_REGRA);

    await user.click(screen.getAllByRole("combobox", { name: "Campo" })[1]!);
    await user.click(await screen.findByRole("option", { name: "Etiqueta do contato" }));

    expect(gravados.at(-1)!.checks[1]).toMatchObject({ id: "regra-2", field: "tag", value: "" });
  });
});
