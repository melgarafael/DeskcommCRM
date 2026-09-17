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
import { describe, it, expect, vi } from "vitest";
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
import { PipelinesClient, TIPOS_DE_CAMPO, tipoTemOpcoes, type PipelineRow } from "./_client";

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

describe("um campo multiselect já gravado", () => {
  it("abre com o tipo à mostra, e não com o seletor em branco", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);

    const seletor = screen.getByLabelText(/Tipo do campo 1/i);
    // O texto do gatilho do Radix é o rótulo do item casado. Vazio = nenhum
    // `SelectItem` bateu com o `value`, que é exatamente o defeito.
    expect(seletor.textContent?.trim()).toBe("multiselect");
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
