/**
 * A REGRA DE DATA NO PAINEL DA CONDIÇÃO, PELA TELA.
 *
 * Escolhe o campo novo no seletor, confere que as DUAS entradas aparecem (qual
 * campo do negócio, e quantos dias), preenche e mede o que o painel entrega ao
 * `onChange` — que é exatamente o que vai para o `graph` publicado.
 *
 * ⚠️ NÃO é a prova do DoD 12: jsdom não tem layout, então nada aqui fala de
 * pixel, recorte ou sobreposição. Prova o contrato da tela, não a aparência.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...a: unknown[]) => getMock(...a) },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
// As etapas vêm de um hook com react-query; aqui o painel não precisa delas
// (a regra de data não é regra de etapa), e sem o stub o provider faltaria.
vi.mock("@/hooks/followup/useEtapasDoFluxo", () => ({
  useEtapasDoFluxo: () => ({ etapas: [], carregando: false, falhou: false, nomes: {} }),
  etapasPorFunil: () => [],
}));

import { ConditionForm } from "./ConditionForm";

beforeAll(() => {
  // Radix Select usa pointer capture e scrollIntoView; o jsdom não tem nenhum.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

type Check = { field: string; op: string; value: string | number; key?: string; id?: string };

const REGRA_DE_ETAPA: Check = { field: "lead_stage", op: "eq", value: "" };

function montar(checks: Check[] = [REGRA_DE_ETAPA]) {
  const onChange = vi.fn();
  render(
    <ConditionForm
      config={{ combinator: "and", checks } as never}
      onChange={onChange}
    />,
  );
  return { onChange };
}

/** A última regra que o painel entregou ao grafo. */
function ultimaRegra(onChange: ReturnType<typeof vi.fn>): Check {
  expect(onChange).toHaveBeenCalled();
  const ultima = onChange.mock.calls.at(-1)![0] as { checks: Check[] };
  return ultima.checks[0]!;
}

/** Troca o campo da primeira regra para a opção de nome `rotulo`. */
async function escolherCampo(user: ReturnType<typeof userEvent.setup>, rotulo: string) {
  await user.click(screen.getByLabelText("Campo"));
  await user.click(await screen.findByRole("option", { name: rotulo }));
}

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue({ data: [] });
});

describe("a regra de data aparece no seletor de campo", () => {
  it("«Data de um campo do negócio» é oferecida", async () => {
    const user = userEvent.setup();
    montar();

    await user.click(screen.getByLabelText("Campo"));

    expect(
      await screen.findByRole("option", { name: "Data de um campo do negócio" }),
    ).toBeInTheDocument();
  });

  it("escolhida, as DUAS entradas aparecem — qual campo e quantos dias", async () => {
    const user = userEvent.setup();
    montar();

    await escolherCampo(user, "Data de um campo do negócio");

    expect(screen.getByLabelText("Campo do negócio com a data")).toBeInTheDocument();
    expect(screen.getByLabelText("Prazo em dias")).toBeInTheDocument();
  });

  it("o prazo nasce em 0, e a tela diz que 0 inclui hoje", async () => {
    const user = userEvent.setup();
    montar();

    await escolherCampo(user, "Data de um campo do negócio");

    expect(screen.getByLabelText("Prazo em dias")).toHaveValue(0);
    expect(screen.getByPlaceholderText("0 = inclui hoje")).toBeInTheDocument();
  });

  it("o operador oferecido é o de data, não «é igual a»", async () => {
    const user = userEvent.setup();
    montar();
    await escolherCampo(user, "Data de um campo do negócio");

    await user.click(screen.getByLabelText("Operador"));

    expect(await screen.findByRole("option", { name: "já passou há" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "falta" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "é igual a" })).not.toBeInTheDocument();
  });

  it("o texto de ajuda explica o fuso e o zero", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ConditionForm
        config={{ combinator: "and", checks: [{ field: "lead_date", op: "passou_ha", value: 0, key: "fim_teste" }] } as never}
        onChange={vi.fn()}
      />,
    );
    void user;

    expect(container).toHaveTextContent(/dias de calendário no fuso da organização/i);
    expect(container).toHaveTextContent(/0 inclui o dia de hoje/i);
  });
});

describe("o que o painel GRAVA no grafo", () => {
  it("campo «fim_teste» com prazo 0 é o caso do período de teste", async () => {
    const user = userEvent.setup();
    const { onChange } = montar();
    await escolherCampo(user, "Data de um campo do negócio");

    await user.type(screen.getByLabelText("Campo do negócio com a data"), "fim_teste");

    await waitFor(() => expect(ultimaRegra(onChange).key).toBe("fim_teste"));
    const regra = ultimaRegra(onChange);
    expect(regra.field).toBe("lead_date");
    expect(regra.op).toBe("passou_ha");
    expect(regra.value).toBe(0);
  });

  it("prazo digitado vira NÚMERO, não texto (texto nunca compararia)", async () => {
    const user = userEvent.setup();
    const { onChange } = montar();
    await escolherCampo(user, "Data de um campo do negócio");

    await user.type(screen.getByLabelText("Campo do negócio com a data"), "fim_teste");
    const prazo = screen.getByLabelText("Prazo em dias");
    await user.clear(prazo);
    await user.type(prazo, "7");

    await waitFor(() => expect(ultimaRegra(onChange).value).toBe(7));
    expect(typeof ultimaRegra(onChange).value).toBe("number");
  });

  it("o nome do campo é gravado sem espaços nas pontas", async () => {
    const user = userEvent.setup();
    const { onChange } = montar();
    await escolherCampo(user, "Data de um campo do negócio");

    await user.type(screen.getByLabelText("Campo do negócio com a data"), "  fim_teste  ");

    await waitFor(() => expect(ultimaRegra(onChange).key).toBe("fim_teste"));
  });

  it("APAGAR o nome do campo grava a chave vazia, sem erro cru na tela", async () => {
    // Achado pela prova de tela de 17/10: com `key` exigindo 1 caractere no
    // schema do rascunho, apagar o campo reprovava o `safeParse`, o `onChange`
    // nunca era chamado (o nó seguia com «fim_teste») e a tela mostrava
    // «Too small: expected string to have >=1 characters». Quem recusa a regra
    // sem campo é o publish (`campo_de_data_ausente`), não o rascunho.
    const user = userEvent.setup();
    const { onChange } = montar([
      { field: "lead_date", op: "passou_ha", value: 0, key: "fim_teste" },
    ]);

    await user.clear(screen.getByLabelText("Campo do negócio com a data"));

    await waitFor(() => expect(ultimaRegra(onChange).key).toBe(""));
    expect(screen.queryByText(/too small/i)).not.toBeInTheDocument();
  });

  it("trocar para OUTRO campo descarta a chave — regra de etiqueta não guarda fim_teste", async () => {
    const user = userEvent.setup();
    const { onChange } = montar([
      { field: "lead_date", op: "passou_ha", value: 0, key: "fim_teste" },
    ]);

    await escolherCampo(user, "Etiqueta do contato");

    await waitFor(() => expect(ultimaRegra(onChange).field).toBe("tag"));
    expect(ultimaRegra(onChange)).not.toHaveProperty("key");
  });

  it("voltando para a regra de data, o prazo recomeça em 0 e não herda valor de texto", async () => {
    const user = userEvent.setup();
    const { onChange } = montar([{ field: "tag", op: "eq", value: "vip" }]);

    await escolherCampo(user, "Data de um campo do negócio");

    await waitFor(() => expect(ultimaRegra(onChange).field).toBe("lead_date"));
    expect(ultimaRegra(onChange).value).toBe(0);
  });

  it("a frase da regra é legível, com o prazo em palavras", async () => {
    render(
      <ConditionForm
        config={{ combinator: "and", checks: [{ field: "lead_date", op: "passou_ha", value: 3, key: "fim_teste" }] } as never}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/A data do campo já passou há 3 dias ou mais/i)).toBeInTheDocument();
  });

  it("com prazo 0 a frase diz «hoje ou já passou», não «há 0 dias»", async () => {
    render(
      <ConditionForm
        config={{ combinator: "and", checks: [{ field: "lead_date", op: "passou_ha", value: 0, key: "fim_teste" }] } as never}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("A data do campo é hoje ou já passou")).toBeInTheDocument();
  });
});
