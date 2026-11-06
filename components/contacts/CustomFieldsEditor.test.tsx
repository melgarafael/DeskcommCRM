/**
 * O CAMPO CONDICIONAL SOME DA TELA E O VALOR GRAVADO FICA (issue #2728).
 *
 * Este é o ponto de renderização EM SI: `CustomFieldsEditor` é o único
 * renderizador de campos personalizados que existe — a ficha do contato
 * (`EditContactDialog`), o painel do CRM na inbox (`CRMSidePanel`), o dossiê e
 * o diálogo de edição de lead (`LeadDossier` → `LeadFieldsForm`) passam todos
 * por ele. Esconder aqui é esconder nos quatro.
 *
 * O que reprova sem o conserto:
 *
 *   1. o import de `@/lib/schemas/mostrar-quando` falha (módulo não existe);
 *   2. sem filtro, `queryByLabelText` acha o campo condicional mesmo com a
 *      condição fora;
 *   3. um filtro que "conserta" limpando o valor — `registro` teria de voltar
 *      sem a chave, e é justamente o contrário: esconder não é limpar.
 */
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomFieldsEditor, type CustomFieldDef } from "./CustomFieldsEditor";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ country: "BR" }),
}));
vi.mock("@/hooks/i18n/useT", () => ({
  useT: () => (texto: string) => texto,
}));

afterEach(cleanup);

const CAMPOS: CustomFieldDef[] = [
  { key: "tipo_servico", label: "Tipo de serviço", type: "text" },
  {
    key: "outro_servico",
    label: "Outro serviço (qual?)",
    type: "text",
    mostrar_quando: { campo: "tipo_servico", contem: "Outro" },
  },
];

describe("CustomFieldsEditor — campos com mostrar_quando", () => {
  it("condição não atendida: o campo não aparece e o registro mantém o valor gravado", () => {
    const registro: Record<string, unknown> = {
      tipo_servico: "Limpeza",
      outro_servico: "Piscina",
    };

    render(
      <CustomFieldsEditor
        fields={CAMPOS}
        value={registro}
        onChange={vi.fn()}
        mode="contact"
      />,
    );

    // O campo condicional some da tela…
    expect(screen.queryByLabelText("Outro serviço (qual?)")).toBeNull();
    // …e o que dispara a condição continua lá (controle).
    expect(screen.getByLabelText("Tipo de serviço")).toBeTruthy();

    // Esconder não é limpar: ninguém mexeu no objeto de valores.
    expect(registro).toEqual({ tipo_servico: "Limpeza", outro_servico: "Piscina" });
  });

  it("condição atendida: o campo aparece com o valor que já estava gravado", () => {
    const registro: Record<string, unknown> = {
      tipo_servico: "Outro (especifique)",
      outro_servico: "Piscina",
    };

    render(
      <CustomFieldsEditor
        fields={CAMPOS}
        value={registro}
        onChange={vi.fn()}
        mode="contact"
      />,
    );

    const campo = screen.getByLabelText("Outro serviço (qual?)") as HTMLInputElement;
    expect(campo.value).toBe("Piscina");
    expect(registro).toEqual({
      tipo_servico: "Outro (especifique)",
      outro_servico: "Piscina",
    });
  });

  it("sem condição nenhuma, os campos seguem aparecendo como sempre (controle)", () => {
    render(
      <CustomFieldsEditor
        fields={[{ key: "segmento", label: "Segmento", type: "text" }]}
        value={{}}
        onChange={vi.fn()}
        mode="lead"
      />,
    );
    expect(screen.getByLabelText("Segmento")).toBeTruthy();
  });
});

describe("CustomFieldsEditor — lista pesquisável recusa o que não está na lista (#2521)", () => {
  const DESTINO: CustomFieldDef[] = [
    {
      key: "destino",
      label: "Destino",
      type: "searchable_select",
      options: [{ value: "maceio-al", label: "Maceió (AL)", aliases: ["maceio", "mcz"] }],
    },
  ];

  it("valor fora da lista, sem allow_new: não grava e explica por quê", () => {
    const onChange = vi.fn();
    render(<CustomFieldsEditor mode="lead" fields={DESTINO} value={{}} onChange={onChange} />);

    const input = screen.getByLabelText(/Destino/);
    fireEvent.change(input, { target: { value: "Recife" } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ destino: "Recife" }));
    expect(screen.getByText("Esse valor não está na lista. Escolha uma das opções.")).toBeTruthy();

    // A próxima digitação limpa o aviso: ele fala do texto recusado, não do novo.
    fireEvent.change(input, { target: { value: "mace" } });
    expect(screen.queryByText("Esse valor não está na lista. Escolha uma das opções.")).toBeNull();
  });
});

describe("CustomFieldsEditor — lista pesquisável mostra o que a busca acha (#2521)", () => {
  // O `<datalist>` do navegador refiltrava pelo rótulo, com acento: "sao paulo"
  // e "mcz" não mostravam opção nenhuma. A lista agora é a de `buscarOpcoes`.
  const DESTINO: CustomFieldDef[] = [
    {
      key: "destino",
      label: "Destino",
      type: "searchable_select",
      options: [
        { value: "sao-paulo-sp", label: "São Paulo (SP)" },
        { value: "sao-luis-ma", label: "São Luís (MA)" },
        { value: "maceio-al", label: "Maceió (AL)", aliases: ["maceio", "mcz"] },
        { value: "gramado-rs", label: "Gramado (RS)" },
      ],
    },
  ];
  const AVISO = "Esse valor não está na lista. Escolha uma das opções.";

  function montar() {
    const onChange = vi.fn();
    render(<CustomFieldsEditor mode="lead" fields={DESTINO} value={{}} onChange={onChange} />);
    return { onChange, input: screen.getByRole("combobox", { name: /Destino/ }) };
  }

  it("'sao paulo' mostra São Paulo (SP), e seta + Enter grava o value", () => {
    const { onChange, input } = montar();
    fireEvent.change(input, { target: { value: "sao paulo" } });
    expect(screen.getByRole("option", { name: "São Paulo (SP)" })).toBeTruthy();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ destino: "sao-paulo-sp" });
  });

  it("o apelido 'mcz' mostra Maceió (AL)", () => {
    const { input } = montar();
    fireEvent.change(input, { target: { value: "mcz" } });
    expect(screen.getByRole("option", { name: "Maceió (AL)" })).toBeTruthy();
  });

  it("Escape fecha a lista", () => {
    const { input } = montar();
    fireEvent.change(input, { target: { value: "mcz" } });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("clicar numa opção grava o value", () => {
    const { onChange, input } = montar();
    fireEvent.change(input, { target: { value: "gram" } });
    fireEvent.click(screen.getByRole("option", { name: "Gramado (RS)" }));
    expect(onChange).toHaveBeenCalledWith({ destino: "gramado-rs" });
  });

  it("destacar com a seta e sair com Tab grava a destacada", () => {
    const { onChange, input } = montar();
    fireEvent.change(input, { target: { value: "gramado" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ destino: "gramado-rs" });
  });

  it("passar o mouse sobre uma opção e sair com Tab não grava nada", () => {
    // Prova pela tela de 17/10: clicar no campo e sair com Tab gravava a opção
    // que estava sob o ponteiro parado (o banco recebeu 'sao-luis-ma').
    const { onChange, input } = montar();
    fireEvent.focus(input);
    fireEvent.mouseEnter(screen.getByRole("option", { name: "São Luís (MA)" }));
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("mouse sobre uma opção e Enter sem seta não grava nada", () => {
    const { onChange, input } = montar();
    fireEvent.focus(input);
    fireEvent.mouseEnter(screen.getByRole("option", { name: "São Luís (MA)" }));
    // `fireEvent` devolve false quando o evento teve preventDefault: com a
    // lista aberta, o Enter não pode cair na submissão implícita do <form>.
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("texto que casa exatamente + Enter sem seta grava o value e não submete o formulário", () => {
    // Em Editar contato e no dossiê o editor vive dentro de um <form>: o Enter
    // sem destaque submetia com o valor VELHO e o digitado se perdia.
    const { onChange, input } = montar();
    fireEvent.change(input, { target: { value: "São Paulo (SP)" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(onChange).toHaveBeenCalledWith({ destino: "sao-paulo-sp" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("texto fora da lista + Enter: recusa com aviso, sem gravar e sem submeter", () => {
    const { onChange, input } = montar();
    fireEvent.change(input, { target: { value: "gramado" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(AVISO)).toBeTruthy();
  });

  it("valor novo com allow_new + Enter grava o novo mesmo sem opção na lista", () => {
    // Sem resultado nenhum a lista não abre; o Enter ainda é do campo enquanto
    // há texto pendente, senão o valor novo se perdia na submissão.
    const onChange = vi.fn();
    render(
      <CustomFieldsEditor
        mode="lead"
        fields={[{ ...DESTINO[0]!, allow_new: true }]}
        value={{}}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole("combobox", { name: /Destino/ });
    fireEvent.change(input, { target: { value: "  Recife  " } });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(onChange).toHaveBeenCalledWith({ destino: "Recife" });
  });

  it("lista fechada e nada pendente: o Enter segue para o formulário", () => {
    const { onChange, input } = montar();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("seta depois do mouse e sair com Tab grava a destacada pela seta", () => {
    const { onChange, input } = montar();
    fireEvent.focus(input);
    fireEvent.mouseEnter(screen.getByRole("option", { name: "São Luís (MA)" }));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ destino: "sao-paulo-sp" });
  });

  it("'gramado' e sair sem escolher: avisa e não grava (sem palpite por pedaço)", () => {
    const { onChange, input } = montar();
    fireEvent.change(input, { target: { value: "gramado" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(AVISO)).toBeTruthy();
  });

  it("'Sao' é ambíguo: sair sem escolher avisa e não grava", () => {
    const { onChange, input } = montar();
    fireEvent.change(input, { target: { value: "Sao" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "São Paulo (SP)",
      "São Luís (MA)",
    ]);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(AVISO)).toBeTruthy();
  });

  it("a lista e a opção destacada são trazidas à vista dentro do container que rola", () => {
    // A lista é `absolute` e abre para baixo; num campo perto do fim do dossiê
    // ou do diálogo, ela nascia fora da área visível, e Enter gravava a opção
    // destacada sem que ninguém a visse. O jsdom não implementa scrollIntoView.
    const original = Element.prototype.scrollIntoView;
    const vistos: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      vistos.push(this);
    };
    try {
      const { input } = montar();
      fireEvent.change(input, { target: { value: "Sao" } });
      expect(vistos).toContain(screen.getByRole("listbox"));

      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(vistos.at(-1)).toBe(screen.getByRole("option", { name: "São Luís (MA)" }));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

/**
 * A LISTA PESQUISÁVEL COM MÚLTIPLA ESCOLHA NA FICHA (#3182).
 *
 * O defeito: o campo guardava UM `value` canônico, então o segundo fornecedor
 * escolhido sobrescrevia o primeiro; e o modo múltiplo que existia
 * (`multiselect`) despeja a lista INTEIRA de opções na ficha — inviável com as
 * listas longas de fornecedor/hotel. Aqui a régua é a mesma da lista
 * pesquisável (busca com apelidos, `value` canônico, recusa fora da lista) e o
 * que muda é o REGISTRO: uma lista, com os escolhidos como chips.
 */
describe("CustomFieldsEditor — lista pesquisável com MÚLTIPLA ESCOLHA (#3182)", () => {
  const FORNECEDORES: CustomFieldDef[] = [
    {
      key: "fornecedores",
      label: "Fornecedores",
      type: "searchable_select",
      multiple: true,
      options: [
        { value: "consolidadora-a", label: "Consolidadora A", aliases: ["consol a"] },
        { value: "operadora-b", label: "Operadora B" },
        { value: "seguradora-c", label: "Seguradora C" },
      ],
    },
  ];
  const AVISO = "Esse valor não está na lista. Escolha uma das opções.";

  /** Um harness CONTROLADO: é o registro que volta para a tela a cada escolha. */
  function Harness({ inicial }: { inicial?: unknown }) {
    const [v, setV] = useState<Record<string, unknown>>(
      inicial === undefined ? {} : { fornecedores: inicial },
    );
    return <CustomFieldsEditor mode="lead" fields={FORNECEDORES} value={v} onChange={setV} />;
  }
  function escolher(input: HTMLElement, texto: string) {
    fireEvent.change(input, { target: { value: texto } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
  }

  it("os escolhidos aparecem como CHIPS, e a lista de opções não é despejada na ficha", () => {
    render(<Harness inicial={["consolidadora-a", "seguradora-c"]} />);
    // Os DOIS valores gravados aparecem, pelo rótulo da opção…
    expect(screen.getByText("Consolidadora A")).toBeTruthy();
    expect(screen.getByText("Seguradora C")).toBeTruthy();
    // …e o que NÃO foi escolhido não ocupa espaço: a lista inteira de opções
    // era o que tornava o modo múltiplo inviável com listas longas.
    expect(screen.queryByText("Operadora B")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("escolher duas opções no MESMO campo grava as duas — a segunda não sobrescreve", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: /Fornecedores/ });
    escolher(input, "consolidadora");
    expect(screen.getByText("Consolidadora A")).toBeTruthy();

    escolher(input, "operadora");
    expect(screen.getByText("Consolidadora A")).toBeTruthy();
    expect(screen.getByText("Operadora B")).toBeTruthy();
  });

  it("grava o `value` CANÔNICO do apelido digitado, com um chip por opção", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: /Fornecedores/ });
    escolher(input, "consol a");
    expect(screen.getAllByText("Consolidadora A")).toHaveLength(1);
  });

  it("escolher a MESMA opção de novo não duplica o chip", () => {
    render(<Harness inicial={["consolidadora-a"]} />);
    const input = screen.getByRole("combobox", { name: /Fornecedores/ });
    escolher(input, "consolidadora");
    expect(screen.getAllByText("Consolidadora A")).toHaveLength(1);
  });

  it("remover um chip tira só ele", () => {
    render(<Harness inicial={["consolidadora-a", "seguradora-c"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remover Consolidadora A" }));
    expect(screen.queryByText("Consolidadora A")).toBeNull();
    expect(screen.getByText("Seguradora C")).toBeTruthy();
  });

  it("item fora da lista sem `allow_new`: não grava, explica e mantém os chips", () => {
    render(<Harness inicial={["consolidadora-a"]} />);
    const input = screen.getByRole("combobox", { name: /Fornecedores/ });
    fireEvent.change(input, { target: { value: "Fornecedor X" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(screen.getByText(AVISO)).toBeTruthy();
    expect(screen.getByText("Consolidadora A")).toBeTruthy();
    expect(screen.queryByText("Fornecedor X")).toBeNull();
  });

  it("com `allow_new`, o valor novo entra como chip, junto dos escolhidos", () => {
    const comNovo: CustomFieldDef[] = [{ ...FORNECEDORES[0]!, allow_new: true }];
    function HarnessNovo() {
      const [v, setV] = useState<Record<string, unknown>>({ fornecedores: ["consolidadora-a"] });
      return <CustomFieldsEditor mode="lead" fields={comNovo} value={v} onChange={setV} />;
    }
    render(<HarnessNovo />);
    const input = screen.getByRole("combobox", { name: /Fornecedores/ });
    fireEvent.change(input, { target: { value: "  Operadora Nova  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("Consolidadora A")).toBeTruthy();
    expect(screen.getByText("Operadora Nova")).toBeTruthy();
  });

  it("valor ÚNICO já gravado (o campo virou múltiplo depois) aparece como chip e sobrevive à próxima escolha", () => {
    // Registro de antes da caixa "Permitir várias escolhas", ou gravado pelo
    // diálogo de campos exigidos (seletor de valor único): é uma string, não
    // uma lista. Sem tratá-la como lista de UM, ela some da ficha e a próxima
    // escolha grava só o item novo — a "Consolidadora A" se perde.
    let gravado: unknown;
    function HarnessLegado() {
      const [v, setV] = useState<Record<string, unknown>>({ fornecedores: "consolidadora-a" });
      return (
        <CustomFieldsEditor
          mode="lead"
          fields={FORNECEDORES}
          value={v}
          onChange={(n) => {
            gravado = n.fornecedores;
            setV(n);
          }}
        />
      );
    }
    render(<HarnessLegado />);
    expect(screen.getByText("Consolidadora A")).toBeTruthy();
    escolher(screen.getByRole("combobox", { name: /Fornecedores/ }), "operadora");
    expect(gravado).toEqual(["consolidadora-a", "operadora-b"]);
  });
});
