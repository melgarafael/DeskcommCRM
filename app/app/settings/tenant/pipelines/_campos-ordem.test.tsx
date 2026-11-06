/**
 * A ORDEM DOS CAMPOS DO FUNIL (#4043) — arrastar e subir/descer.
 *
 * O defeito que estes testes trancam: o editor desenhava os campos na ordem do
 * array `settings.fields` e não tinha como mudá-la. Quem quisesse "Destino"
 * antes de "Hospedagem" precisava remover e recriar o campo com a mesma chave —
 * refazendo à mão opções, `mostrar_quando`, `obrigatorio_em`, `allow_new` e
 * `multiple` (297 e 756 opções nos dois campos do relato da issue).
 *
 * O que se prova aqui: (1) o campo muda de lugar pelo arrasto E pelas setas, e a
 * ordem nova é a que vai no `fields` do patch da `updatePipelineConfig` — a
 * mesma porta de escrita do `settings`; (2) reordenar não encosta em chave nem
 * em dado, porque `crm_leads.custom_fields` é lido POR CHAVE; (3) campo novo
 * continua entrando no FIM; (4) chave repetida é RECUSADA com nome, e não
 * gravada; (5) os dois caminhos usam a MESMA `moverCampo`, que nunca trunca.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

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

import { toast } from "sonner";

import { updatePipelineConfig } from "@/app/actions/settings/updatePipelineConfig";
import {
  camposDoFunilPatchSchema,
  MENSAGEM_DE_CHAVE_REPETIDA,
  type CustomFieldDef,
} from "@/lib/schemas/settings";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { moverCampo, PipelinesClient, type PipelineRow } from "./_client";

/** O caso da issue, reduzido: três campos criados fora de ordem. */
const AEREO: CustomFieldDef = { key: "aereo", label: "Aéreo", type: "text" };
const HOTEIS: CustomFieldDef = {
  key: "hospedagem",
  label: "Hospedagem",
  type: "select",
  options: [
    { value: "hotel-a", label: "Hotel A" },
    { value: "hotel-b", label: "Hotel B" },
  ],
};
const SEGURO: CustomFieldDef = { key: "seguro", label: "Seguro", type: "text" };

const FUNIL: PipelineRow = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Experiência do Cliente",
  slug: "experiencia",
  vocabulary: null,
  settings: { fields: [AEREO, HOTEIS, SEGURO] },
};

/** Abre o editor do funil — é onde os campos moram. */
function abrirEditor(): void {
  for (const botao of screen.queryAllByRole("button", {
    name: /Editar vocabulário e campos deste funil/i,
  })) {
    fireEvent.click(botao);
  }
}

/** As chaves dos campos NA ORDEM DA TELA (o `aria-label` é posicional). */
function chavesNaTela(): string[] {
  return screen
    .getAllByLabelText(/^Chave do campo \d+$/)
    .map((el) => (el as HTMLInputElement).value);
}

async function salvar(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /Salvar vocabulário e campos/i }));
}

beforeEach(() => {
  vi.mocked(updatePipelineConfig).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("moverCampo — a conta que o arrasto e as setas compartilham", () => {
  const lista = [AEREO, HOTEIS, SEGURO];

  it("sobe e desce uma casa, devolvendo lista NOVA sem tocar nos campos", () => {
    const subiu = moverCampo(lista, 2, 1);
    expect(subiu.map((c) => c.key)).toEqual(["aereo", "seguro", "hospedagem"]);
    // O campo é o MESMO objeto: mover não clona, não reescreve chave nem rótulo.
    expect(subiu[1]).toBe(SEGURO);

    const desceu = moverCampo(lista, 0, 1);
    expect(desceu.map((c) => c.key)).toEqual(["hospedagem", "aereo", "seguro"]);
    expect(desceu[1]).toBe(AEREO);
  });

  it("posição fora da lista devolve a MESMA lista — nunca um recorte", () => {
    // O `splice` de um índice inválido apagaria justamente o campo que a pessoa
    // está movendo, e o save seguiria com o array truncado.
    expect(moverCampo(lista, 0, -1)).toBe(lista);
    expect(moverCampo(lista, 3, 1)).toBe(lista);
    expect(moverCampo(lista, -1, 0)).toBe(lista);
    expect(moverCampo(lista, 1, 3)).toBe(lista);
    // Mesma posição é gesto cancelado, não lista nova.
    expect(moverCampo(lista, 1, 1)).toBe(lista);
  });
});

describe("o editor do funil reordena os campos (#4043)", () => {
  it("as setas sobem e descem, e o campo leva junto rótulo e opções", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    abrirEditor();

    expect(chavesNaTela()).toEqual(["aereo", "hospedagem", "seguro"]);

    fireEvent.click(screen.getByTestId("subir-campo-3"));

    // A tela já mostra a ordem nova: é a ordem do array, e é ela que o card lê.
    expect(chavesNaTela()).toEqual(["aereo", "seguro", "hospedagem"]);
    expect(screen.getByLabelText(/^Rótulo do campo 2$/)).toHaveValue("Seguro");

    fireEvent.click(screen.getByTestId("descer-campo-1"));

    expect(chavesNaTela()).toEqual(["seguro", "aereo", "hospedagem"]);
    // As opções da hospedagem viajaram com ela, na posição nova.
    expect(screen.getByLabelText(/^Rótulo do campo 3$/)).toHaveValue("Hospedagem");
  });

  it("grava a ordem nova no `fields` do patch, pela updatePipelineConfig", async () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    abrirEditor();

    fireEvent.click(screen.getByTestId("subir-campo-3"));
    await salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    const patch = vi.mocked(updatePipelineConfig).mock.calls[0]?.[1];

    // A ordem do array É a ordem gravada — não existe uma segunda representação
    // de ordem no settings que pudesse divergir desta.
    expect(patch?.fields?.map((c) => c.key)).toEqual(["aereo", "seguro", "hospedagem"]);
    // Nada truncado: os três campos continuam na lista, e o que é dado do campo
    // (rótulo e opções) viaja intacto.
    expect(patch?.fields?.length).toBe(3);
    expect(patch?.fields).toEqual([AEREO, SEGURO, HOTEIS]);
  });

  it("campo novo continua entrando no FIM da lista", async () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    abrirEditor();

    fireEvent.click(screen.getByRole("button", { name: /Adicionar campo/i }));
    await salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    const patch = vi.mocked(updatePipelineConfig).mock.calls[0]?.[1];
    expect(patch?.fields?.map((c) => c.key)).toEqual([
      "aereo",
      "hospedagem",
      "seguro",
      "campo_4",
    ]);
  });

  it("recusa chave repetida com o nome da chave, sem chamar a porta de escrita", async () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    abrirEditor();

    // Repetir a chave faria dois campos disputarem a mesma gaveta do
    // `custom_fields` e a mesma posição — a ordem deixaria de ter resposta.
    fireEvent.change(screen.getByLabelText(/^Chave do campo 3$/), {
      target: { value: "aereo" },
    });
    await salvar();

    expect(toast.error).toHaveBeenCalledWith(MENSAGEM_DE_CHAVE_REPETIDA("aereo"));
    expect(updatePipelineConfig).not.toHaveBeenCalled();
  });

  it("o primeiro não sobe e o último não desce — a seta que não faz nada fica desligada", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    abrirEditor();

    expect(screen.getByTestId("subir-campo-1")).toBeDisabled();
    expect(screen.getByTestId("descer-campo-3")).toBeDisabled();
    expect(screen.getByTestId("subir-campo-2")).toBeEnabled();
    expect(screen.getByTestId("descer-campo-2")).toBeEnabled();
  });

  it("cada campo tem alça de arrasto focável — arrastar sozinho exclui quem usa teclado", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    abrirEditor();

    const alcas = screen.getAllByLabelText(/Arrastar para reordenar/);
    expect(alcas).toHaveLength(3);
    // O `@hello-pangea/dnd` liga o sensor de teclado na alça: `tabIndex` 0 é o
    // que prova que ela é um alvo de verdade, e não um ícone decorativo.
    for (const alca of alcas) {
      expect(alca).toHaveAttribute("tabindex", "0");
    }
    // E as setas continuam sendo o caminho explícito, nomeado por campo.
    expect(screen.getByRole("button", { name: /Mover para cima «Seguro»/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Mover para baixo «Aéreo»/ })).toBeEnabled();
  });
});

describe("camposDoFunilPatchSchema — a lista inteira, na ordem da tela", () => {
  it("aceita a lista reordenada e a lê na ordem recebida", () => {
    const recebida = camposDoFunilPatchSchema.safeParse([SEGURO, AEREO, HOTEIS]);
    expect(recebida.success).toBe(true);
    // A ordem não é normalizada no caminho: o que a tela mandou é o que o card
    // desenha depois.
    expect(camposDoFunil({ fields: recebida.success ? recebida.data : [] })).toEqual([
      SEGURO,
      AEREO,
      HOTEIS,
    ]);
  });

  it("recusa chave repetida — uma issue só, mesmo com três cópias", () => {
    const r = camposDoFunilPatchSchema.safeParse([AEREO, SEGURO, AEREO, AEREO]);
    expect(r.success).toBe(false);
    expect(r.error?.issues).toHaveLength(1);
    expect(r.error?.issues[0]?.message).toBe(MENSAGEM_DE_CHAVE_REPETIDA("aereo"));
  });

  it("aceita a lista vazia: remover o último campo é uma decisão legítima", () => {
    // A lista vazia NÃO é ordem inválida — é o funil sem campo personalizado, e
    // recusá-la tiraria da tela o único jeito de limpar os campos. O que não
    // pode acontecer é o save MANDAR menos campos do que a tela mostra, e isso
    // os testes acima prendem (o patch carrega os três, sempre).
    expect(camposDoFunilPatchSchema.safeParse([]).success).toBe(true);
  });
});
