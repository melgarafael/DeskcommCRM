/**
 * O filtro "Tipo de uso" oferecia uma lista fixa, quase toda de nomes que
 * `llm_calls.purpose` não tem (`sentiment_check`, `embed_chunk`...), e sem os que
 * tem (`agent_turn`, `stage_classifier`...): escolher um desses nomes inexistentes
 * devolvia zero, e a tela
 * mentia por omissão. As opções agora são os purposes que de fato aparecem no
 * período, com o rótulo do registro de pontos.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { UsagePayload } from "@/lib/ai/usage/aggregate";

import { UsageFilters } from "./UsageFilters";
import { UsageDashboardClient } from "@/app/app/ai/usage/_client";

const substituir = vi.fn();
let busca = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: substituir }),
  useSearchParams: () => new URLSearchParams(busca),
}));

// O painel faz duas consultas: a da tela (com o filtro) e a das opções (sem o
// filtro de tipo). A da tela fica carregando para o teste não desenhar gráfico.
vi.mock("@/hooks/ai/useAiUsage", () => ({
  useAiUsage: (f: { invocation_kind?: string }) =>
    f.invocation_kind
      ? { isLoading: true, data: undefined }
      : {
          isLoading: false,
          data: { by_kind: { agent_turn: 10, stage_classifier: 4 } } as unknown as UsagePayload,
        },
}));

beforeAll(() => {
  // Radix Select usa pointer capture e scrollIntoView; o jsdom não tem nenhum.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  substituir.mockClear();
  busca = "";
});

const usuario = () => userEvent.setup({ delay: null });
const TETO_MS = 30_000;
const LEGADOS = ["sentiment_check", "embed_chunk", "embed_query", "intent_classify"];

async function opcoesDoTipo(user: ReturnType<typeof usuario>): Promise<string[]> {
  const gatilhos = screen.getAllByRole("combobox");
  await user.click(gatilhos[1]!);
  return within(screen.getByRole("listbox"))
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
}

describe("UsageFilters — Tipo de uso", () => {
  it("oferece os purposes do período com o rótulo do registro, e nenhum legado", { timeout: TETO_MS }, async () => {
    const user = usuario();
    render(
      <UsageFilters
        agents={[]}
        kinds={["stage_classifier", "agent_turn", "purpose_sem_registro"]}
        initial={{}}
      />,
    );

    const opcoes = await opcoesDoTipo(user);
    expect(opcoes).toEqual([
      "Todas",
      "Identificar a etapa do lead",
      "purpose_sem_registro",
      "Responder o cliente",
    ]);
    for (const legado of LEGADOS) expect(opcoes).not.toContain(legado);
  });

  it("o valor escolhido é o purpose cru, e vai para a URL que alimenta a rota", { timeout: TETO_MS }, async () => {
    const user = usuario();
    render(<UsageFilters agents={[]} kinds={["stage_classifier", "agent_turn"]} initial={{}} />);

    await opcoesDoTipo(user);
    await user.click(screen.getByRole("option", { name: "Identificar a etapa do lead" }));

    await vi.waitFor(() => expect(substituir).toHaveBeenCalled(), { timeout: 2_000 });
    expect(substituir.mock.calls.at(-1)?.[0]).toBe("?invocation_kind=stage_classifier");
  });

  it("traduz o rótulo para espanhol", { timeout: TETO_MS }, async () => {
    const user = usuario();
    render(
      <IdiomaProvider locale="es">
        <UsageFilters agents={[]} kinds={["agent_turn"]} initial={{}} />
      </IdiomaProvider>,
    );

    expect(await opcoesDoTipo(user)).toEqual(["Todas", "Responder al cliente"]);
  });

  it("um purpose escolhido que não está no período continua visível, cru", { timeout: TETO_MS }, async () => {
    const user = usuario();
    render(<UsageFilters agents={[]} kinds={["agent_turn"]} initial={{ invocation_kind: "sentiment_check" }} />);

    expect(await opcoesDoTipo(user)).toEqual(["Todas", "Responder o cliente", "sentiment_check"]);
  });
});

describe("UsageDashboardClient — as opções não encolhem ao filtrar", () => {
  it("com um tipo escolhido, os outros tipos do período continuam oferecidos", { timeout: TETO_MS }, async () => {
    busca = "invocation_kind=stage_classifier";
    const user = usuario();
    render(<UsageDashboardClient agents={[]} initial={{ invocation_kind: "stage_classifier" }} />);

    expect(await opcoesDoTipo(user)).toEqual([
      "Todas",
      "Identificar a etapa do lead",
      "Responder o cliente",
    ]);
  });
});
