/**
 * O editor de CAMPOS do funil — o que ele oferece e o que ele deixa editar.
 *
 * O defeito que estes testes trancam: a lista de tipos desta tela era digitada
 * à mão e ficou menor que a de `customFieldSchema`. `multiselect` era aceito
 * pelo schema, gravado pela API e desenhado no dossiê do contato, mas não
 * existia aqui — então um campo desse tipo abria com o seletor EM BRANCO (nenhum
 * `SelectItem` casava com o `value`) e sem a linha de opções, que só aparecia
 * para `select`. Quem administrava via um campo aparentemente corrompido, sem
 * como editar, e o conserto intuitivo (escolher um tipo qualquer para tirar o
 * branco) rebaixava a escolha múltipla para escolha única.
 *
 * Por isso os testes medem o par: a tela OFERECE todo tipo que o schema aceita,
 * e mostra as opções para TODO tipo de lista fechada — não só para `select`.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { customFieldSchema } from "@/lib/schemas/settings";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/actions/settings/updatePipelineConfig", () => ({
  updatePipelineConfig: vi.fn(async () => ({ ok: true })),
}));
// As duas seções irmãs falam com a API; este arquivo é sobre os CAMPOS.
vi.mock("./_stages", () => ({
  StagesSection: () => null,
  ancoraDasEtapas: () => "etapas",
}));
vi.mock("./_mapping", () => ({
  AgentMappingSection: () => null,
  ancoraDoMapeamento: () => "mapeamento",
}));

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

import { updatePipelineConfig } from "@/app/actions/settings/updatePipelineConfig";
import { ROTULOS_DO_TIPO } from "@/lib/schemas/rotulos-do-campo";
import {
  PipelinesClient,
  TIPOS_DE_CAMPO,
  tipoTemOpcoes,
  type EtapaDoFunil,
  type PipelineRow,
} from "./_client";

/** Um funil de clínica: o campo que importa é a lista de procedimentos, e ela é múltipla. */
const FUNIL: PipelineRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Tratamentos",
  slug: "tratamentos",
  vocabulary: { lead: "Paciente", deal: "Tratamento", won: "Fechado", lost: "Perdido" },
  settings: {
    fields: [
      {
        key: "procedimentos_de_interesse",
        label: "Procedimentos de interesse",
        type: "multiselect",
        options: [
          { value: "clareamento", label: "Clareamento Dental" },
          { value: "implantes", label: "Implantes" },
        ],
      },
    ],
  },
};

describe("tipos de campo que a tela do funil oferece", () => {
  it("oferece TODO tipo que o schema aceita — lista menor deixa campo salvo sem seletor", () => {
    const doSchema = [...customFieldSchema.shape.type.options].sort();
    const daTela = [...TIPOS_DE_CAMPO].sort();
    expect(daTela).toEqual(doSchema);
  });

  it("mostra as opções para toda lista fechada, não só para `select`", () => {
    expect(tipoTemOpcoes("select")).toBe(true);
    expect(tipoTemOpcoes("multiselect")).toBe(true);
    // Um tipo de texto livre não tem lista para editar.
    expect(tipoTemOpcoes("text")).toBe(false);
    expect(tipoTemOpcoes("date")).toBe(false);
  });
});

/**
 * O SELETOR DE TIPO FALA A LÍNGUA DE QUEM CONFIGURA (issue #3037).
 *
 * O dono do negócio via `multiselect` e `searchable_select` no seletor sem
 * saber qual era a lista de várias escolhas e qual era a pesquisável. O `value`
 * continua técnico — é o que o schema e a API gravam —, mas o texto que a
 * pessoa lê passa a ser um rótulo em português, pelo `t()`.
 */
describe("rótulos dos tipos de campo (#3037)", () => {
  it("o mapa cobre TODO tipo do schema, e nenhum rótulo é o nome técnico", () => {
    const doSchema = [...customFieldSchema.shape.type.options].sort();
    expect(Object.keys(ROTULOS_DO_TIPO).sort()).toEqual(doSchema);

    for (const tipo of doSchema) {
      const rotulo = ROTULOS_DO_TIPO[tipo];
      expect(rotulo.trim().length, `rótulo vazio para ${tipo}`).toBeGreaterThan(0);
      expect(rotulo, `${tipo} continua com nome técnico`).not.toBe(tipo);
    }
  });

  it("o gatilho mostra o RÓTULO — inclusive os dois que se confundiam", () => {
    const FUNIL_DE_TIPOS: PipelineRow = {
      id: "44444444-4444-4444-8444-444444444444",
      name: "Tipos",
      slug: "tipos",
      vocabulary: null,
      settings: {
        fields: [
          { key: "um", label: "Um", type: "select" },
          { key: "varios", label: "Vários", type: "multiselect" },
          { key: "busca", label: "Busca", type: "searchable_select" },
          { key: "curto", label: "Curto", type: "text" },
        ],
      },
    };
    render(<PipelinesClient pipelines={[FUNIL_DE_TIPOS]} podeEditarConfig />);

    expect(screen.getByLabelText(/Tipo do campo 1/i).textContent?.trim()).toBe(
      "Lista de uma escolha",
    );
    expect(screen.getByLabelText(/Tipo do campo 2/i).textContent?.trim()).toBe(
      "Lista de várias escolhas",
    );
    expect(screen.getByLabelText(/Tipo do campo 3/i).textContent?.trim()).toBe(
      "Lista pesquisável",
    );
    expect(screen.getByLabelText(/Tipo do campo 4/i).textContent?.trim()).toBe("Texto curto");
  });
});

describe("um campo multiselect já gravado", () => {
  it("abre com o tipo à mostra, e não com o seletor em branco", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);

    const seletor = screen.getByLabelText(/Tipo do campo 1/i);
    // O texto do gatilho do Radix é o RÓTULO do item casado (issue #3037).
    // Vazio = nenhum `SelectItem` bateu com o `value`, que é o defeito antigo.
    expect(seletor.textContent?.trim()).toBe("Lista de várias escolhas");
  });

  it("deixa editar as opções — sem isso o campo fica só de leitura", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i);
    expect(opcoes).toHaveValue("Clareamento Dental, Implantes");
  });
});

/**
 * Um funil cujo único campo é uma lista fechada AINDA SEM opções — o estado de
 * quem acabou de criar o campo e vai digitar a primeira. Os testes de digitação
 * partem daqui: com a lista já cheia, a vírgula some no meio do valor existente
 * e o defeito fica escondido atrás do texto que já estava lá.
 */
const FUNIL_SEM_OPCOES: PipelineRow = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Vendas",
  slug: "vendas",
  vocabulary: null,
  settings: {
    fields: [{ key: "dor", label: "Dor", type: "select" }],
  },
};

/**
 * Digita TECLA A TECLA, relendo o valor ATUAL do input antes de acrescentar a
 * seguinte — é o que o navegador faz, e é o que reproduz o defeito. Um único
 * `fireEvent.change` com o texto inteiro passa longe: sem um "valor anterior"
 * sendo relido entre as teclas, o item vazio que a vírgula cria não chega a
 * atrapalhar.
 */
function digitar(input: HTMLInputElement, texto: string): void {
  for (const tecla of texto) {
    fireEvent.change(input, { target: { value: input.value + tecla } });
  }
}

describe("o input de opções de um campo de lista fechada", () => {
  it("não apaga a vírgula recém-digitada — sem ela não há como criar a segunda opção", () => {
    render(<PipelinesClient pipelines={[FUNIL_SEM_OPCOES]} podeEditarConfig />);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;
    digitar(opcoes, "Dor,");

    // O item vazio que a vírgula criou sobrevive à digitação, e o `join(", ")`
    // o devolve como o separador visível. Descartá-lo já no `onChange` deixaria
    // o campo em "Dor" — a vírgula some e a próxima palavra cola.
    expect(opcoes).toHaveValue("Dor, ");
  });

  it("mantém o separador entre TODAS as opções ao digitar a lista tecla a tecla", () => {
    render(<PipelinesClient pipelines={[FUNIL_SEM_OPCOES]} podeEditarConfig />);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;
    digitar(opcoes, "Dor, Orçamento, Prazo");

    // Com o filtro de vazio no `onChange`, isto sairia "DorOrçamentoPrazo":
    // as vírgulas desaparecem e as palavras colam.
    expect(opcoes).toHaveValue("Dor, Orçamento, Prazo");
  });

  it("não apaga o espaço DENTRO de uma opção de duas palavras ao digitar", () => {
    render(<PipelinesClient pipelines={[FUNIL_SEM_OPCOES]} podeEditarConfig />);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;
    digitar(opcoes, "Clareamento Dental, Implantes");

    // Mesma classe da vírgula: aparar o FIM do item a cada tecla apaga o espaço
    // recém-digitado, e a palavra seguinte cola ("ClareamentoDental").
    expect(opcoes).toHaveValue("Clareamento Dental, Implantes");
  });

  it("grava a lista inteira e descarta só o vazio do fim", async () => {
    vi.mocked(updatePipelineConfig).mockClear();
    render(<PipelinesClient pipelines={[FUNIL_SEM_OPCOES]} podeEditarConfig />);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;
    // A vírgula final deixa um terceiro item vazio, que o input agora preserva.
    digitar(opcoes, "Dor, Orçamento,");
    fireEvent.click(screen.getByRole("button", { name: /Salvar vocabulário e campos/i }));

    // O save roda dentro de `startTransition`; o mock resolve num microtask.
    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));

    const patch = vi.mocked(updatePipelineConfig).mock.calls[0]?.[1];
    // O vazio morre no `handleSave` (o schema exige `label` não-vazio) e as
    // opções de verdade ficam. Um filtro no `onChange` faria a segunda opção
    // nunca chegar aqui.
    expect(patch?.fields?.[0]?.options?.map((o) => o.label)).toEqual(["Dor", "Orçamento"]);
  });

  it("grava cada opção aparada, com o espaço de dentro e sem o do fim", async () => {
    vi.mocked(updatePipelineConfig).mockClear();
    render(<PipelinesClient pipelines={[FUNIL_SEM_OPCOES]} podeEditarConfig />);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;
    // O espaço antes da vírgula sobrevive à digitação (a pessoa ainda pode
    // estar no meio da palavra); é o salvar que o apara.
    digitar(opcoes, "Clareamento Dental , Implantes ,");
    fireEvent.click(screen.getByRole("button", { name: /Salvar vocabulário e campos/i }));

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));

    const patch = vi.mocked(updatePipelineConfig).mock.calls[0]?.[1];
    expect(patch?.fields?.[0]?.options).toEqual([
      { value: "Clareamento Dental", label: "Clareamento Dental" },
      { value: "Implantes", label: "Implantes" },
    ]);
  });
});

describe("lista pesquisável: editar as opções à mão depois de importar (#2521)", () => {
  const FUNIL_DESTINO: PipelineRow = {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Viagens",
    slug: "viagens",
    vocabulary: null,
    settings: { fields: [{ key: "destino", label: "Destino", type: "searchable_select" }] },
  };

  it("acrescentar uma opção não troca o `value` nem apaga os apelidos da que veio do CSV", async () => {
    vi.mocked(updatePipelineConfig).mockClear();
    render(<PipelinesClient pipelines={[FUNIL_DESTINO]} podeEditarConfig />);

    fireEvent.change(screen.getByLabelText(/Importar opções \(CSV\) 1/i), {
      target: { value: "maceio-al,Maceió (AL),maceio;mcz" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Importar opções do campo 1/i }));

    // Rótulo exato: o botão "Importar opções do campo 1" também casaria com a regex.
    const opcoes = screen.getByLabelText("Opções do campo 1") as HTMLInputElement;
    expect(opcoes).toHaveValue("Maceió (AL)");
    // Cada tecla reconstrói a lista a partir dos rótulos: é aqui que `maceio-al`
    // virava `Maceió (AL)` e os apelidos sumiam.
    digitar(opcoes, ", Recife");
    fireEvent.click(screen.getByRole("button", { name: /Salvar vocabulário e campos/i }));

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    const patch = vi.mocked(updatePipelineConfig).mock.calls[0]?.[1];
    expect(patch?.fields?.[0]?.options).toEqual([
      { value: "maceio-al", label: "Maceió (AL)", aliases: ["maceio", "mcz"] },
      { value: "Recife", label: "Recife" },
    ]);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * O EDITOR DE `obrigatorio_em` (CR do mantenedor no PR #1688): a régua nasceu
 * no schema e não tinha TELA — quem operava não conseguia ligar a regra
 * principal do #1536. O que estes casos prendem:
 *
 *  1. a tela OFERECE as etapas do funil + "ao ganhar" + "ao perder" (as três
 *     chaves que `campoExigidoNoDestino` lê — nem mais, para não prometer
 *     gatilho que o servidor não pergunta);
 *  2. a marca vira `obrigatorio_em` no patch gravado pela ÚNICA porta de
 *     escrita do settings (`updatePipelineConfig`);
 *  3. desmarcar tudo APAGA a chave: um funil intocado continua idêntico ao de
 *     antes do #1536 (critério de aceite nº 3), em vez de ganhar `{}` morto.
 */
describe("editor de obrigatorio_em do funil (#1536)", () => {
  const ETAPA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ETAPA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const FUNIL_MARCADO_ID = "33333333-3333-4333-8333-333333333333";
  const ETAPAS: Record<string, EtapaDoFunil[]> = {
    [FUNIL.id]: [
      { id: ETAPA_A, name: "Avaliação", is_archived: false },
      { id: ETAPA_B, name: "Proposta (antiga)", is_archived: true },
    ],
    [FUNIL_MARCADO_ID]: [
      { id: ETAPA_A, name: "Avaliação", is_archived: false },
      { id: ETAPA_B, name: "Proposta (antiga)", is_archived: true },
    ],
  };
  /** Um campo JÁ marcado no settings — o estado de quem abre para desligar. */
  const FUNIL_MARCADO: PipelineRow = {
    id: FUNIL_MARCADO_ID,
    name: "Vendas",
    slug: "vendas-marcado",
    vocabulary: null,
    settings: {
      fields: [
        {
          key: "dor",
          label: "Dor",
          type: "text",
          obrigatorio_em: { etapas: [ETAPA_A], ao_perder: true },
        },
      ],
    },
  };

  const tela = (p: PipelineRow) =>
    render(<PipelinesClient pipelines={[p]} etapas={ETAPAS} podeEditarConfig />);
  const patchSalvo = () => vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1];

  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());

  it("oferece as etapas do funil + ao ganhar + ao perder, e nada vem marcado", () => {
    tela(FUNIL);

    expect(
      screen.getByLabelText("Exigir em Avaliação — Procedimentos de interesse"),
    ).not.toBeChecked();
    expect(
      screen.getByLabelText("Exigir em Proposta (antiga) — Procedimentos de interesse"),
    ).not.toBeChecked();
    expect(screen.getByLabelText("Ao ganhar — Procedimentos de interesse")).not.toBeChecked();
    expect(screen.getByLabelText("Ao perder — Procedimentos de interesse")).not.toBeChecked();
  });

  it("a marca vira `obrigatorio_em` no patch da porta única de escrita", () => {
    tela(FUNIL);

    fireEvent.click(screen.getByLabelText("Exigir em Avaliação — Procedimentos de interesse"));
    fireEvent.click(screen.getByLabelText("Ao ganhar — Procedimentos de interesse"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));

    expect(updatePipelineConfig).toHaveBeenCalledTimes(1);
    expect(patchSalvo().fields?.[0]?.obrigatorio_em).toEqual({
      etapas: [ETAPA_A],
      ao_ganhar: true,
    });
  });

  it("desmarcar tudo apaga a chave — o funil volta ao comportamento de antes", () => {
    tela(FUNIL_MARCADO);
    expect(screen.getByLabelText("Exigir em Avaliação — Dor")).toBeChecked();
    expect(screen.getByLabelText("Ao perder — Dor")).toBeChecked();

    fireEvent.click(screen.getByLabelText("Exigir em Avaliação — Dor"));
    fireEvent.click(screen.getByLabelText("Ao perder — Dor"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));

    expect(patchSalvo().fields?.[0]).not.toHaveProperty("obrigatorio_em");
  });

  it("a etapa ARQUIVADA fica visível e marcável — o que alguém já marcou não some", () => {
    tela(FUNIL_MARCADO);
    // A regra gravada aponta para ETAPA_A; ETAPA_B (arquivada) também aparece.
    const antiga = screen.getByLabelText("Exigir em Proposta (antiga) — Dor");
    expect(antiga).toBeInTheDocument();
    // O rótulo da coluna morta vem da própria lista, marcada — some da tela só
    // quando some do settings, nunca por baixo de quem a marcou.
    expect(antiga.closest("label")?.textContent).toContain("arquivada");
  });
});

describe("retomada de negócio encerrado (#1538)", () => {
  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());
  const salvar = () =>
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));

  it("nasce desligada e ligar grava `reabertura: novo_negocio` na porta única de escrita", () => {
    render(<PipelinesClient pipelines={[FUNIL]} etapas={{}} podeEditarConfig />);
    const caixa = screen.getByLabelText("Negócio encerrado que volta abre um negócio novo");
    expect(caixa).not.toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].reabertura).toBe("novo_negocio");
  });

  it("funil já ligado abre marcado, e desligar volta a `mesmo_registro`", () => {
    const ligado: PipelineRow = { ...FUNIL, settings: { ...FUNIL.settings, reabertura: "novo_negocio" } };
    render(<PipelinesClient pipelines={[ligado]} etapas={{}} podeEditarConfig />);
    const caixa = screen.getByLabelText("Negócio encerrado que volta abre um negócio novo");
    expect(caixa).toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].reabertura).toBe("mesmo_registro");
  });
});

describe("comanda do ganho (#1477)", () => {
  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());
  const salvar = () =>
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));
  const ROTULO = "Abrir comanda ao ganhar um negócio neste funil";

  it("nasce desligada e ligar grava `comanda_no_ganho: true` na porta única de escrita", () => {
    render(<PipelinesClient pipelines={[FUNIL]} etapas={{}} podeEditarConfig comandaDisponivel />);
    const caixa = screen.getByLabelText(ROTULO);
    expect(caixa).not.toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].comanda_no_ganho).toBe(true);
  });

  it("funil já ligado abre marcado, e desligar grava `false`", () => {
    const ligado: PipelineRow = { ...FUNIL, settings: { ...FUNIL.settings, comanda_no_ganho: true } };
    render(<PipelinesClient pipelines={[ligado]} etapas={{}} podeEditarConfig comandaDisponivel />);
    const caixa = screen.getByLabelText(ROTULO);
    expect(caixa).toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].comanda_no_ganho).toBe(false);
  });

  it("sem o módulo financeiro (#1907) o interruptor some, e salvar não mexe no valor gravado", () => {
    const ligado: PipelineRow = { ...FUNIL, settings: { ...FUNIL.settings, comanda_no_ganho: true } };
    render(<PipelinesClient pipelines={[ligado]} etapas={{}} podeEditarConfig />);
    expect(screen.queryByLabelText(ROTULO)).toBeNull();

    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].comanda_no_ganho).toBe(true);
  });
});

describe("escreveMostrarQuando — o item 'ainda não escolhi' não vira valor", () => {
  it("escolher o item vazio do seletor de valor deixa a condição meio montada, e ela não grava", async () => {
    const { escreveMostrarQuando, normalizaMostrarQuando, SEM_VALOR_DA_CONDICAO } = await import(
      "./_client"
    );
    const meio = escreveMostrarQuando(
      { campo: "tipo", operador: "igual", valor: "Outro" },
      { valor: SEM_VALOR_DA_CONDICAO },
    );
    expect(meio).toEqual({ campo: "tipo", operador: "igual" });
    expect(normalizaMostrarQuando(meio)).toBeUndefined();
  });
});

describe("'Este campo pertence a' só no funil padrão (#2791)", () => {
  // A ficha do contato lê as definições SÓ do funil padrão (/api/v1/pipelines/default).
  // Marcar "Contato" num funil secundário tiraria o campo do card sem levá-lo à
  // ficha: ele sumiria de toda tela. A régua é a da rota: `is_default`, senão o
  // primeiro da lista (que a página entrega por `position`).
  const campo = (escopo?: "contato") => ({
    fields: [{ key: "cpf", label: "CPF", type: "text", ...(escopo ? { escopo } : {}) }],
  });
  const funil = (id: string, nome: string, extra: Partial<PipelineRow> = {}): PipelineRow => ({
    id,
    name: nome,
    slug: nome.toLowerCase(),
    vocabulary: null,
    settings: campo(),
    ...extra,
  });
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("sem nenhum funil marcado, o padrão é o primeiro — o seletor aparece só nele", () => {
    render(<PipelinesClient pipelines={[funil(A, "Vendas"), funil(B, "Pos")]} podeEditarConfig />);
    expect(screen.getAllByLabelText(/Escopo do campo 1/i)).toHaveLength(1);
    expect(screen.getAllByText("Este campo pertence a:")).toHaveLength(1);
  });

  it("com is_default no segundo, o seletor sai do primeiro e vai para ele", () => {
    const { container } = render(
      <PipelinesClient
        pipelines={[funil(A, "Vendas", { is_default: false }), funil(B, "Pos", { is_default: true })]}
        podeEditarConfig
      />,
    );
    const cards = container.querySelectorAll("h2");
    expect(cards[0]?.textContent).toBe("Vendas");
    expect(screen.getAllByLabelText(/Escopo do campo 1/i)).toHaveLength(1);
    const cardDoPos = cards[1]?.closest("div.space-y-6");
    expect(cardDoPos?.textContent).toContain("Este campo pertence a:");
  });

  it("num funil secundário, um campo JÁ marcado Contato mantém o seletor para desfazer", () => {
    render(
      <PipelinesClient
        pipelines={[funil(A, "Vendas"), funil(B, "Pos", { settings: campo("contato") })]}
        podeEditarConfig
      />,
    );
    expect(screen.getAllByLabelText(/Escopo do campo 1/i)).toHaveLength(2);
  });
});
