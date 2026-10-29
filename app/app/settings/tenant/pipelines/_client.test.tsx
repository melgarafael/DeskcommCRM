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
import userEvent from "@testing-library/user-event";

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
import { importarOpcoesCsv } from "@/lib/leads/campos-pesquisaveis";
import { ROTULOS_DO_TIPO } from "@/lib/schemas/rotulos-do-campo";
import { NAV_DESTINATIONS } from "@/lib/navigation/registry";
import {
  PipelinesClient,
  TIPOS_DE_CAMPO,
  tipoTemOpcoes,
  type EtapaDoFunil,
  type PipelineRow,
} from "./_client";

/**
 * OS DOIS "ABRIR" DA TELA (issue #3176) — o editor do funil e a lista de um campo.
 *
 * O editor de um funil só MONTA quando ele é expandido, e as opções de um campo
 * de lista nascem RECOLHIDAS num resumo. Por isso todo caso que olha para
 * dentro do editor (ou para as opções) abre o que quer ver antes de medir — e é
 * só isso: o comportamento testado abaixo é o de sempre.
 */
function abrirEditores(): void {
  const botoes = screen.queryAllByRole("button", {
    name: /Editar vocabulário e campos deste funil/i,
  });
  for (const botao of botoes) fireEvent.click(botao);
}

/** Abre a lista de opções do campo `posicao` (1-based) do n-ésimo funil. */
function abrirOpcoes(posicao: number, qualFunil = 0): void {
  fireEvent.click(screen.getAllByTestId(`abrir-opcoes-${posicao}`)[qualFunil]!);
}

/**
 * Uma lista LONGA, com apelidos — o formato que a importação CSV grava e o caso
 * de controle da issue #3176 (a agência com 297 destinos e 756 hospedagens).
 */
function listaLonga(prefixo: string, quantas: number) {
  return Array.from({ length: quantas }, (_, i) => ({
    value: `${prefixo}-${i}`,
    label: `${prefixo} ${i}`,
    aliases: [`${prefixo}${i}`],
  }));
}

/** O caso de controle: listas longas e os MESMOS campos em mais de um funil. */
function funilDeViagens(n: number, nome: string): PipelineRow {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    name: nome,
    slug: `viagens-${n}`,
    vocabulary: null,
    settings: {
      fields: [
        {
          key: "destino",
          label: "Destino",
          type: "searchable_select",
          options: listaLonga("destino", 297),
        },
        {
          key: "hospedagem",
          label: "Hospedagem",
          type: "searchable_select",
          options: listaLonga("hotel", 756),
        },
        { key: "obs", label: "Observação", type: "text" },
      ],
    },
  };
}

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
    abrirEditores();

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

/**
 * A COLUNA DO TIPO NÃO PODE CORTAR O RÓTULO (issue #3099).
 *
 * Com `md:grid-cols-[1fr_1fr_8rem_auto]`, o gatilho ficava com ~91 px de texto:
 * "Lista de várias escolhas" (152 px) e "Lista de varias opciones" (154 px)
 * apareciam cortados, sem reticências. A coluna agora tem 13rem (208 px, ~172 px
 * de texto) — 18 px de folga sobre o maior rótulo em espanhol.
 *
 * O jsdom não mede layout, então este teste guarda o que o código DECLARA (a
 * largura da coluna e o `title` com o rótulo inteiro). A medida real por
 * `getBoundingClientRect`, em pt e es, é a prova pela tela.
 */
describe("a coluna do tipo não corta o rótulo (#3099)", () => {
  it("declara 13rem para a coluna, e não os 8rem que cortavam", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    abrirEditores();

    const linha = screen.getByLabelText(/Tipo do campo 1/i).closest("div");
    expect(linha?.className).toContain("lg:grid-cols-[1fr_1fr_13rem_auto]");
    expect(linha?.className).not.toContain("8rem");
  });

  it("só divide a linha em colunas a partir de lg — em md, Chave e Rótulo ficavam com 46 px", () => {
    // Medido pela tela a 768 px com a barra lateral aberta: com `md:`, a coluna de
    // 13rem sobrava ~46 px para cada input. Abaixo de 1024 px os campos empilham.
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    abrirEditores();

    const linha = screen.getByLabelText(/Tipo do campo 1/i).closest("div");
    expect(linha?.className).not.toMatch(/(^|\s)md:grid-cols-/);
    // Um bloco com `md:col-span-4` cria 4 colunas implícitas em md e espreme a linha
    // do mesmo jeito — medido: 43 px a 768 só com o template trocado.
    expect(linha?.querySelector('[class*="md:col-span"]')).toBeNull();
    expect(linha?.querySelector('[class*="lg:col-span-4"]')).not.toBeNull();
  });

  it("o gatilho carrega o rótulo INTEIRO no title", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    abrirEditores();

    expect(screen.getByLabelText(/Tipo do campo 1/i).getAttribute("title")).toBe(
      "Lista de várias escolhas",
    );
  });
});

describe("um campo multiselect já gravado", () => {
  it("abre com o tipo à mostra, e não com o seletor em branco", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    abrirEditores();

    const seletor = screen.getByLabelText(/Tipo do campo 1/i);
    // O texto do gatilho do Radix é o RÓTULO do item casado (issue #3037).
    // Vazio = nenhum `SelectItem` bateu com o `value`, que é o defeito antigo.
    expect(seletor.textContent?.trim()).toBe("Lista de várias escolhas");
  });

  it("deixa editar as opções — sem isso o campo fica só de leitura", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    abrirEditores();
    abrirOpcoes(1);

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
    abrirEditores();
    abrirOpcoes(1);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;
    digitar(opcoes, "Dor,");

    // O item vazio que a vírgula criou sobrevive à digitação, e o `join(", ")`
    // o devolve como o separador visível. Descartá-lo já no `onChange` deixaria
    // o campo em "Dor" — a vírgula some e a próxima palavra cola.
    expect(opcoes).toHaveValue("Dor, ");
  });

  it("mantém o separador entre TODAS as opções ao digitar a lista tecla a tecla", () => {
    render(<PipelinesClient pipelines={[FUNIL_SEM_OPCOES]} podeEditarConfig />);
    abrirEditores();
    abrirOpcoes(1);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;
    digitar(opcoes, "Dor, Orçamento, Prazo");

    // Com o filtro de vazio no `onChange`, isto sairia "DorOrçamentoPrazo":
    // as vírgulas desaparecem e as palavras colam.
    expect(opcoes).toHaveValue("Dor, Orçamento, Prazo");
  });

  it("não apaga o espaço DENTRO de uma opção de duas palavras ao digitar", () => {
    render(<PipelinesClient pipelines={[FUNIL_SEM_OPCOES]} podeEditarConfig />);
    abrirEditores();
    abrirOpcoes(1);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;
    digitar(opcoes, "Clareamento Dental, Implantes");

    // Mesma classe da vírgula: aparar o FIM do item a cada tecla apaga o espaço
    // recém-digitado, e a palavra seguinte cola ("ClareamentoDental").
    expect(opcoes).toHaveValue("Clareamento Dental, Implantes");
  });

  it("grava a lista inteira e descarta só o vazio do fim", async () => {
    vi.mocked(updatePipelineConfig).mockClear();
    render(<PipelinesClient pipelines={[FUNIL_SEM_OPCOES]} podeEditarConfig />);
    abrirEditores();
    abrirOpcoes(1);

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
    abrirEditores();
    abrirOpcoes(1);

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
    abrirEditores();
    abrirOpcoes(1);

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

  const tela = (p: PipelineRow) => {
    render(<PipelinesClient pipelines={[p]} etapas={ETAPAS} podeEditarConfig />);
    abrirEditores();
  };
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
    abrirEditores();
    const caixa = screen.getByLabelText("Negócio encerrado que volta abre um negócio novo");
    expect(caixa).not.toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].reabertura).toBe("novo_negocio");
  });

  it("funil já ligado abre marcado, e desligar volta a `mesmo_registro`", () => {
    const ligado: PipelineRow = { ...FUNIL, settings: { ...FUNIL.settings, reabertura: "novo_negocio" } };
    render(<PipelinesClient pipelines={[ligado]} etapas={{}} podeEditarConfig />);
    abrirEditores();
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
    abrirEditores();
    const caixa = screen.getByLabelText(ROTULO);
    expect(caixa).not.toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].comanda_no_ganho).toBe(true);
  });

  it("funil já ligado abre marcado, e desligar grava `false`", () => {
    const ligado: PipelineRow = { ...FUNIL, settings: { ...FUNIL.settings, comanda_no_ganho: true } };
    render(<PipelinesClient pipelines={[ligado]} etapas={{}} podeEditarConfig comandaDisponivel />);
    abrirEditores();
    const caixa = screen.getByLabelText(ROTULO);
    expect(caixa).toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].comanda_no_ganho).toBe(false);
  });

  it("sem o módulo financeiro (#1907) o interruptor some, e salvar não mexe no valor gravado", () => {
    const ligado: PipelineRow = { ...FUNIL, settings: { ...FUNIL.settings, comanda_no_ganho: true } };
    render(<PipelinesClient pipelines={[ligado]} etapas={{}} podeEditarConfig />);
    abrirEditores();
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
    abrirEditores();
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
    abrirEditores();
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
    abrirEditores();
    expect(screen.getAllByLabelText(/Escopo do campo 1/i)).toHaveLength(2);
  });
});

/**
 * A LISTA PESQUISÁVEL COM MÚLTIPLA ESCOLHA — O CONTROLE NO EDITOR DO FUNIL
 * (#3182).
 *
 * Sem uma TELA para ligar o modo múltiplo, a chave nasceria no schema e ninguém
 * conseguiria marcá-la — o mesmo defeito de `obrigatorio_em` no #1536. O
 * controle é do `searchable_select`, grava pela porta única de escrita
 * (`updatePipelineConfig`) e desmarcar APAGA a chave, para o funil intocado
 * continuar idêntico ao de antes.
 */
describe("lista pesquisável: o controle de múltipla escolha no funil (#3182)", () => {
  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());
  const salvar = () =>
    fireEvent.click(screen.getByRole("button", { name: /Salvar vocabulário e campos/i }));

  const CAMPO_FORNECEDORES = {
    key: "fornecedores",
    label: "Fornecedores",
    type: "searchable_select" as const,
    options: [{ value: "consolidadora-a", label: "Consolidadora A" }],
  };
  const FUNIL_FORNECEDORES: PipelineRow = {
    id: "55555555-5555-4555-8555-555555555555",
    name: "Fornecedores",
    slug: "fornecedores",
    vocabulary: null,
    settings: { fields: [CAMPO_FORNECEDORES] },
  };

  it("nasce desligado e ligar grava `multiple: true` no patch salvo", () => {
    render(<PipelinesClient pipelines={[FUNIL_FORNECEDORES]} podeEditarConfig />);
    abrirEditores();
    const caixa = screen.getByLabelText(/Permitir várias escolhas 1/i);
    expect(caixa).not.toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].fields?.[0]?.multiple).toBe(true);
    // O resto do campo (a lista e o `value` canônico) fica como estava.
    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].fields?.[0]?.options).toEqual([
      { value: "consolidadora-a", label: "Consolidadora A" },
    ]);
  });

  it("campo JÁ múltiplo abre marcado, e desmarcar apaga a chave", () => {
    const jaMultiplo: PipelineRow = {
      ...FUNIL_FORNECEDORES,
      // O campo JÁ gravado como múltiplo: é o estado de quem abre para desligar.
      settings: { fields: [{ ...CAMPO_FORNECEDORES, multiple: true }] },
    };
    render(<PipelinesClient pipelines={[jaMultiplo]} podeEditarConfig />);
    abrirEditores();
    const caixa = screen.getByLabelText(/Permitir várias escolhas 1/i);
    expect(caixa).toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].fields?.[0]).not.toHaveProperty(
      "multiple",
    );
  });

  it("o controle é só do `searchable_select` — num `select` comum ele não existe", () => {
    render(<PipelinesClient pipelines={[FUNIL_SEM_OPCOES]} podeEditarConfig />);
    abrirEditores();
    // controle: o editor ABRIU — sem isto o `toBeNull` abaixo passa com a tela fechada.
    expect(screen.getByLabelText(/Escopo do campo 1/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Permitir várias escolhas 1/i)).toBeNull();
  });
});

describe("o botão de acrescentar campo e a cota do negócio (#3111)", () => {
  function funilCom(negocio: number, contato: number): PipelineRow {
    return {
      ...FUNIL,
      settings: {
        fields: [
          ...Array.from({ length: negocio }, (_, i) => ({
            key: `n${i}`,
            label: `Negócio ${i}`,
            type: "text" as const,
          })),
          ...Array.from({ length: contato }, (_, i) => ({
            key: `c${i}`,
            label: `Contato ${i}`,
            type: "text" as const,
            escopo: "contato" as const,
          })),
        ],
      },
    };
  }

  it("os campos do contato não escondem o botão: 20 do negócio + 30 do contato ainda acrescenta", () => {
    render(<PipelinesClient pipelines={[funilCom(20, 30)]} podeEditarConfig />);
    abrirEditores();
    expect(screen.getByRole("button", { name: /Adicionar campo/i })).toBeInTheDocument();
  });

  it("50 campos do negócio escondem o botão, com ou sem contato junto", () => {
    render(<PipelinesClient pipelines={[funilCom(50, 5)]} podeEditarConfig />);
    abrirEditores();
    expect(screen.queryByRole("button", { name: /Adicionar campo/i })).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * O EDITOR DE FUNIS COM LISTAS LONGAS (issue #3176) — opções recolhidas e
 * editor sob demanda.
 *
 * O defeito, do jeito que o autor da issue mediu: numa agência de viagens (297
 * destinos, 756 hospedagens, os mesmos campos em 3 funis) a página gastava
 * mais de 45 s num `Runtime.evaluate` sem resposta, logo depois de carregar —
 * porque montava o editor de TODOS os funis com as opções de TODOS os campos,
 * apelidos inclusos, de uma vez.
 *
 * O que estes casos prendem, e por quê:
 *
 *  1. o editor de cada funil só MONTA quando é expandido — e a contagem de nós
 *     do DOM, antes e depois, é o alvo medido (o relógio do navegador é
 *     instável; o número de nós não é);
 *  2. as opções de um campo de lista nascem RECOLHIDAS, com o RESUMO
 *     ("756 opções · Importar CSV · Exportar CSV") — ninguém monta 756 linhas
 *     que ninguém pediu;
 *  3. abrir a lista mostra as opções DAQUELE campo, com busca, e não mais que
 *     uma página de cada vez;
 *  4. o resto do editor continua igual: importar CSV, apelidos e `value`
 *     canônico preservados, e o exportar CSV no MESMO dialeto da importação.
 */
describe("Configurações › Funis com listas longas (#3176)", () => {
  const VIAGENS_1 = funilDeViagens(1, "Viagens 1");
  const VIAGENS_2 = funilDeViagens(2, "Viagens 2");
  const telaDeViagens = () =>
    render(<PipelinesClient pipelines={[VIAGENS_1, VIAGENS_2]} podeEditarConfig />);

  const DESTINOS_VAZIO: PipelineRow = {
    id: "55555555-5555-4555-8555-555555555555",
    name: "Destinos",
    slug: "destinos",
    vocabulary: null,
    settings: { fields: [{ key: "destino", label: "Destino", type: "searchable_select" }] },
  };

  it("o editor de um funil só monta quando expandido — a contagem de nós prova", () => {
    const { container } = telaDeViagens();
    const recolhido = container.querySelectorAll("*").length;

    // Recolhido: nem o seletor de tipo dos campos, nem o resumo das listas.
    expect(screen.queryAllByLabelText(/^Tipo do campo/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^resumo-opcoes-/)).toHaveLength(0);

    // Expandir UM funil monta o editor DELE, e só dele.
    fireEvent.click(screen.getByTestId(`abrir-editor-${VIAGENS_1.id}`));
    const aberto = container.querySelectorAll("*").length;
    expect(aberto, `recolhido=${recolhido} aberto=${aberto}`).toBeGreaterThan(recolhido);
    expect(screen.getAllByLabelText(/^Tipo do campo 1/)).toHaveLength(1);

    // Recolher ESCONDE o editor sem desmontá-lo: desmontar jogaria fora, sem
    // aviso, o que foi editado e ainda não salvo (caso abaixo).
    fireEvent.click(screen.getByTestId(`abrir-editor-${VIAGENS_1.id}`));
    expect(screen.getByTestId(`area-do-editor-${VIAGENS_1.id}`).hidden).toBe(true);
  });

  it("recolher e reabrir o editor não perde o que foi editado e ainda não salvo", () => {
    telaDeViagens();
    const botao = () => screen.getByTestId(`abrir-editor-${VIAGENS_1.id}`);
    fireEvent.click(botao());
    const rotulo = () => screen.getByLabelText("Rótulo do campo 1") as HTMLInputElement;
    const original = rotulo().value;
    fireEvent.change(rotulo(), { target: { value: `${original} EDITADO` } });

    fireEvent.click(botao()); // Recolher
    fireEvent.click(botao()); // abrir de novo
    expect(screen.getByTestId(`area-do-editor-${VIAGENS_1.id}`).hidden).toBe(false);
    expect(rotulo().value).toBe(`${original} EDITADO`);
  });

  it("com centenas de opções em mais de um funil, as listas nascem RECOLHIDAS com o resumo", () => {
    const { container } = telaDeViagens();
    abrirEditores();

    // O resumo aparece nos DOIS funis, com a contagem do campo.
    const resumos = screen.getAllByTestId("resumo-opcoes-2");
    expect(resumos).toHaveLength(2);
    for (const resumo of resumos) {
      expect(resumo.textContent).toContain("756 opções");
      expect(resumo.textContent).toContain("Importar CSV");
      expect(resumo.textContent).toContain("Exportar CSV");
    }
    // O primeiro campo do funil (297 opções, com apelido) também vem resumido.
    expect(screen.getAllByTestId("resumo-opcoes-1")[0]?.textContent).toContain("297 opções");

    // E NADA das opções está montado: nem o input de edição da lista, nem a
    // caixa de importação CSV, nem os rótulos das 297+756 opções.
    expect(screen.queryAllByLabelText(/^Opções do campo/)).toHaveLength(0);
    expect(container.querySelectorAll("textarea")).toHaveLength(0);
    expect(container.textContent).not.toContain("hotel 755");
    expect(container.textContent).not.toContain("destino 296");
  });

  it("abrir a lista mostra as opções DAQUELE campo, com busca, e não mais que uma página", () => {
    const { container } = telaDeViagens();
    abrirEditores();
    abrirOpcoes(2); // Hospedagem, do primeiro funil

    // Só a lista do campo que a pessoa abriu: a do outro funil continua fechada.
    const listas = screen.getAllByTestId("lista-opcoes-2");
    expect(listas).toHaveLength(1);
    const lista = listas[0]!;
    expect(lista.querySelectorAll("li")).toHaveLength(20); // uma página, não 756
    expect(lista.textContent).toContain("hotel 0");

    // A BUSCA corta o que é montado: "hotel 700" deixa só a opção que casa.
    const busca = screen.getAllByLabelText("Buscar opções 2")[0]!;
    fireEvent.change(busca, { target: { value: "hotel 700" } });
    expect(lista.querySelectorAll("li")).toHaveLength(1);
    expect(lista.textContent).toContain("hotel 700");

    // Limpar a busca volta para uma página, e a página seguinte só existe quando
    // alguém a pede — nunca as 756 de uma vez.
    fireEvent.change(busca, { target: { value: "" } });
    expect(lista.querySelectorAll("li")).toHaveLength(20);
    fireEvent.click(screen.getAllByTestId("mais-opcoes-2")[0]!);
    expect(lista.querySelectorAll("li")).toHaveLength(40);
    expect(container.querySelectorAll("li").length).toBeLessThan(756);
  });

  it("três funis com listas longas: nenhuma opção montada antes de alguém pedir", () => {
    const { container } = render(
      <PipelinesClient
        pipelines={[funilDeViagens(1, "Um"), funilDeViagens(2, "Dois"), funilDeViagens(3, "Três")]}
        podeEditarConfig
      />,
    );
    expect(container.querySelectorAll("textarea")).toHaveLength(0);
    expect(screen.queryAllByLabelText(/^Opções do campo/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/^lista-opcoes-/)).toHaveLength(0);
  });

  it("exportar CSV sai ao lado do importar, no MESMO dialeto, e o arquivo volta pelo Importar", () => {
    // O download de verdade depende de `URL.createObjectURL` (que o jsdom não
    // implementa): sem ele o arquivo sai por uma URL `data:` — é o que o teste
    // lê aqui, depois de interceptar o clique da âncora para não navegar.
    const semObjectURL = (URL as { createObjectURL?: unknown }).createObjectURL;
    (URL as { createObjectURL?: unknown }).createObjectURL = undefined;
    const links: string[] = [];
    const cliqueOriginal = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      links.push(this.getAttribute("href") ?? "");
    };
    try {
      render(<PipelinesClient pipelines={[DESTINOS_VAZIO]} podeEditarConfig />);
      abrirEditores();
      // A lista fechada NÃO oferece importar nem exportar: eles nascem dentro da
      // lista aberta (#3176).
      expect(screen.queryByTestId("exportar-opcoes-1")).toBeNull();
      abrirOpcoes(1);

      fireEvent.change(screen.getByLabelText(/Importar opções \(CSV\) 1/i), {
        target: { value: "maceio-al,Maceió (AL),maceio;mcz" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Importar opções do campo 1/i }));
      fireEvent.click(screen.getByTestId("exportar-opcoes-1"));

      expect(links).toHaveLength(1);
      const csv = decodeURIComponent(links[0]!.replace(/^data:text\/csv;charset=utf-8,/, ""));
      expect(csv).toBe("value,label,apelidos\nmaceio-al,Maceió (AL),maceio;mcz\n");
      // O ciclo fecha: o arquivo exportado reimportado devolve as MESMAS opções,
      // com o `value` canônico e os apelidos que os negócios já usam.
      expect(importarOpcoesCsv([], csv).opcoes).toEqual([
        { value: "maceio-al", label: "Maceió (AL)", aliases: ["maceio", "mcz"] },
      ]);
    } finally {
      (URL as { createObjectURL?: unknown }).createObjectURL = semObjectURL;
      HTMLAnchorElement.prototype.click = cliqueOriginal;
    }
  });
});

describe("organização sem nenhum funil", () => {
  it("manda criar em Funis, com link — e não para quem instalou o sistema", () => {
    // O texto dizia que criar funil "é feito por quem instalou o sistema, direto
    // no banco". Falso desde que a lista de Funis ganhou o botão "Novo funil":
    // o dono ficava procurando alguém para fazer o que ele mesmo faz num clique.
    render(<PipelinesClient pipelines={[]} podeEditarConfig />);
    const vazio = screen.getByTestId("sem-funil-configuracao");
    expect(vazio.textContent).not.toMatch(/banco|quem instalou/i);
    const funis = NAV_DESTINATIONS.find((d) => d.href === "/app/kanban");
    expect(funis).toBeTruthy();
    const link = screen.getByTestId("link-criar-funil");
    expect(link.getAttribute("href")).toBe(funis!.href);
    expect(link.textContent).toContain(funis!.label);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * A ETAPA DE ENTRADA DAS CONVERSAS DO INBOX, PELA TELA (#3011 — CR do PR #3250).
 *
 * O ajuste já existia no BANCO: a etapa declarada valia, o fallback era
 * provado, e NINGUÉM CONSEGUIA LIGAR — nenhum ponto da interface mandava
 * `entrada_do_inbox` no patch que a tela envia ao `updatePipelineConfig`.
 *
 * O que estes casos prendem é o caminho inteiro: o admin escolhe a etapa NA
 * TELA, a escolha sai no patch da porta única de escrita, a tela reaberta
 * mostra a escolha feita — e, quando a etapa escolhida deixa de valer, o aviso
 * aparece em vez de a queda para a primeira etapa virar silêncio.
 */
describe("etapa de entrada das conversas do Inbox na tela (#3011)", () => {
  const ETAPA_ABERTA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OUTRA_ABERTA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const ETAPA_ARQUIVADA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ETAPA_GANHO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  const ETAPAS_DE_ENTRADA: Record<string, EtapaDoFunil[]> = {
    [FUNIL.id]: [
      { id: ETAPA_ABERTA, name: "Em atendimento", is_archived: false },
      { id: OUTRA_ABERTA, name: "Proposta", is_archived: false },
      { id: ETAPA_ARQUIVADA, name: "Antiga", is_archived: true },
      { id: ETAPA_GANHO, name: "Fechado", is_archived: false, is_won: true },
    ],
  };

  const funilCom = (settings: Record<string, unknown>): PipelineRow => ({
    ...FUNIL,
    settings: { ...FUNIL.settings, ...settings },
  });

  // O editor do funil só monta expandido (#3176): o seletor mora dentro dele.
  // E o seletor só existe no funil de entrada: por padrão, `p` é o padrão.
  const montar = (p: PipelineRow) => {
    const r = render(
      <PipelinesClient pipelines={[{ is_default: true, ...p }]} etapas={ETAPAS_DE_ENTRADA} podeEditarConfig />,
    );
    abrirEditores();
    return r;
  };
  const salvar = () =>
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));
  const patchSalvo = () => vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1];
  const seletor = () => screen.getByLabelText("Etapa de entrada das conversas do Inbox");

  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());

  it("o seletor só aparece no funil que o servidor lê: o padrão e o de clientes, nunca um secundário", () => {
    // `funilDeEntrada` consulta `entrada_do_inbox` só no `is_default` e no
    // `is_client_pipeline`. Num secundário a escolha seria salva e nunca usada.
    const SECUNDARIO: PipelineRow = {
      ...FUNIL,
      id: "44444444-4444-4444-8444-444444444444",
      name: "Pós-venda",
      slug: "pos-venda",
      is_default: false,
    };
    const etapas = { ...ETAPAS_DE_ENTRADA, [SECUNDARIO.id]: ETAPAS_DE_ENTRADA[FUNIL.id]! };
    const rotulo = "Etapa de entrada das conversas do Inbox";

    const { unmount } = render(
      <PipelinesClient pipelines={[{ ...FUNIL, is_default: true }, SECUNDARIO]} etapas={etapas} podeEditarConfig />,
    );
    abrirEditores();
    expect(screen.getAllByRole("button", { name: /Salvar vocabulário e campos/i })).toHaveLength(2);
    expect(screen.queryAllByLabelText(rotulo)).toHaveLength(1);
    unmount();

    const { unmount: desmontar } = render(
      <PipelinesClient pipelines={[SECUNDARIO]} etapas={etapas} podeEditarConfig />,
    );
    abrirEditores();
    expect(screen.queryAllByLabelText(rotulo)).toHaveLength(0);
    desmontar();

    render(
      <PipelinesClient
        pipelines={[{ ...SECUNDARIO, is_client_pipeline: true }]}
        etapas={etapas}
        podeEditarConfig
      />,
    );
    abrirEditores();
    expect(screen.queryAllByLabelText(rotulo)).toHaveLength(1);
  });

  it("abre na primeira etapa quando o funil não declara nada, e sem aviso", () => {
    montar(FUNIL);

    expect(seletor().textContent?.trim()).toBe("Primeira etapa do funil (padrão)");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("o admin ESCOLHE a etapa na tela e a escolha vai no patch do updatePipelineConfig", async () => {
    const user = userEvent.setup();
    montar(FUNIL);

    await user.click(seletor());
    await user.click(await screen.findByRole("option", { name: "Em atendimento" }));
    salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    // A chave só existe aqui porque a TELA a mandou: é este o elo que faltava
    // entre o ajuste do banco e quem configura.
    expect(patchSalvo().entrada_do_inbox).toEqual({ ativa: true, stage_id: ETAPA_ABERTA });
  });

  it("a tela reabre mostrando a escolha feita, e salvar mantém a decisão", async () => {
    montar(funilCom({ entrada_do_inbox: { ativa: true, stage_id: ETAPA_ABERTA } }));

    expect(seletor().textContent?.trim()).toBe("Em atendimento");
    salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    expect(patchSalvo().entrada_do_inbox).toEqual({ ativa: true, stage_id: ETAPA_ABERTA });
  });

  it("não oferece etapa arquivada nem de ganho — a gravação no banco as recusaria", async () => {
    const user = userEvent.setup();
    montar(FUNIL);

    await user.click(seletor());
    expect(await screen.findByRole("option", { name: "Em atendimento" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Antiga/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Fechado/ })).toBeNull();
  });

  it("funil que nunca declarou nada NÃO ganha a chave morta no patch", async () => {
    montar(FUNIL);

    salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    // O settings de um funil intocado continua idêntico ao de antes do #3011.
    expect(patchSalvo()).not.toHaveProperty("entrada_do_inbox");
  });

  it("desligar GUARDA a etapa escolhida: religar não obriga a escolher de novo", async () => {
    const user = userEvent.setup();
    montar(funilCom({ entrada_do_inbox: { ativa: true, stage_id: ETAPA_ABERTA } }));

    await user.click(seletor());
    await user.click(
      await screen.findByRole("option", { name: "Primeira etapa do funil (padrão)" }),
    );
    salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    expect(patchSalvo().entrada_do_inbox).toEqual({ ativa: false, stage_id: ETAPA_ABERTA });
  });

  it("etapa que deixou de valer: AVISO visível, e a escolha continua à mostra", () => {
    montar(funilCom({ entrada_do_inbox: { ativa: true, stage_id: ETAPA_ARQUIVADA } }));

    expect(screen.getByRole("alert").textContent).toContain("primeira etapa do funil");
    expect(seletor().textContent?.trim()).toBe("Antiga (indisponível)");
  });

  it("etapa apagada (nem aparece na lista) também avisa, como removida", () => {
    montar(funilCom({ entrada_do_inbox: { ativa: true, stage_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" } }));

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(seletor().textContent?.trim()).toBe("Etapa removida (indisponível)");
  });

  it("ajuste DESLIGADO com etapa lembrada não avisa — não há queda acontecendo", () => {
    montar(funilCom({ entrada_do_inbox: { ativa: false, stage_id: ETAPA_ABERTA } }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(seletor().textContent?.trim()).toBe("Primeira etapa do funil (padrão)");
  });
});

/**
 * O RECORTE DE ENCERRADOS ANTIGOS DO QUADRO (#2995) — o controle no editor.
 *
 * Este arquivo mede a PONTE da tela: o valor que já estava salvo volta marcado e
 * com os dias relidos, e o que a pessoa salva sai no payload do
 * `updatePipelineConfig`. Quem grava a chave no settings é a action (medida em
 * `app/actions/settings/updatePipelineConfig.test.ts`) e quem monta o quadro é a
 * rota (medida em `app/api/v1/pipelines/[id]/board/route.test.ts`) — sem os três,
 * o payload poderia sair certo e não chegar a lugar nenhum.
 */
describe("o recorte de encerrados antigos do quadro (#2995)", () => {
  const comRecorte = (settings: Record<string, unknown>): PipelineRow => ({
    id: "55555555-5555-4555-8555-555555555555",
    name: "Pedidos",
    slug: "pedidos",
    vocabulary: null,
    settings,
  });

  const caixa = () =>
    screen.getByRole("checkbox", { name: /Esconder do quadro os negócios encerrados/i });
  const campoDeDias = () =>
    screen.getByLabelText(/Dias de encerrado para esconder do quadro/i) as HTMLInputElement;
  const salvar = () =>
    fireEvent.click(screen.getByRole("button", { name: /Salvar vocabulário e campos/i }));

  it("relê o que está salvo: caixa marcada e os dias do settings", () => {
    render(
      <PipelinesClient pipelines={[comRecorte({ ocultar_encerrados_dias: 45 })]} podeEditarConfig />,
    );
    abrirEditores();

    expect(caixa()).toBeChecked();
    expect(campoDeDias()).toHaveValue(45);
  });

  it("funil sem a opção nasce DESMARCADO, com a sugestão no campo", () => {
    render(<PipelinesClient pipelines={[comRecorte({})]} podeEditarConfig />);
    abrirEditores();

    expect(caixa()).not.toBeChecked();
    // A sugestão preenche o campo para ligar/desligar não exigir digitação — e
    // ela NÃO é gravada enquanto a caixa estiver desmarcada (caso abaixo).
    expect(campoDeDias()).toHaveValue(30);
  });

  it("salvar com a opção ligada manda os dias escolhidos", async () => {
    vi.mocked(updatePipelineConfig).mockClear();
    render(<PipelinesClient pipelines={[comRecorte({})]} podeEditarConfig />);
    abrirEditores();

    fireEvent.click(caixa());
    fireEvent.change(campoDeDias(), { target: { value: "15" } });
    salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updatePipelineConfig).mock.calls[0]?.[1].ocultar_encerrados_dias).toBe(15);
  });

  it("desligar manda 0 EXPLÍCITO — a chave não pode ficar com o número antigo", async () => {
    vi.mocked(updatePipelineConfig).mockClear();
    render(
      <PipelinesClient pipelines={[comRecorte({ ocultar_encerrados_dias: 45 })]} podeEditarConfig />,
    );
    abrirEditores();

    fireEvent.click(caixa());
    salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    const patch = vi.mocked(updatePipelineConfig).mock.calls[0]?.[1];
    // Um `undefined` aqui deixaria `45` no settings e os cards continuariam
    // sumindo do quadro de quem acabou de desligar a opção.
    expect(patch?.ocultar_encerrados_dias).toBe(0);
  });

  it("dias fora da faixa não salvam nada", () => {
    vi.mocked(updatePipelineConfig).mockClear();
    render(<PipelinesClient pipelines={[comRecorte({})]} podeEditarConfig />);
    abrirEditores();

    fireEvent.click(caixa());
    fireEvent.change(campoDeDias(), { target: { value: "0" } });
    salvar();

    // O schema recusaria o save inteiro com a mensagem genérica de validação;
    // barrar na tela é o que permite dizer QUAL campo está errado.
    expect(updatePipelineConfig).not.toHaveBeenCalled();
  });
});
