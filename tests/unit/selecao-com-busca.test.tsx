import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { SearchableSelect } from "@/components/ui/searchable-select";
import type { OpcaoDeSelecao } from "@/lib/ui/filtrar-opcoes";

const modelo = (value: string, label: string): OpcaoDeSelecao => ({ value, label, keywords: [value] });

const MODELOS: OpcaoDeSelecao[] = [
  modelo("anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6"),
  modelo("anthropic/claude-haiku-4-5", "Claude Haiku 4.5"),
  modelo("anthropic/claude-opus-4-7", "Claude Opus 4.7"),
  modelo("openai/gpt-5", "GPT-5"),
  modelo("openai/gpt-5-mini", "GPT-5 mini"),
  modelo("google/gemini-2.5-pro", "Gemini 2.5 Pro"),
  modelo("google/gemini-2.5-flash", "Gemini 2.5 Flash"),
  modelo("meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B"),
  modelo("mistralai/mistral-large", "Mistral Large"),
  modelo("deepseek/deepseek-chat", "DeepSeek V3"),
];

const CURTA: OpcaoDeSelecao[] = [
  { value: "a", label: "Primeira" },
  { value: "b", label: "Segunda" },
  { value: "c", label: "Terceira" },
];

function Controlado({
  options = MODELOS,
  inicial = "",
  onChange = () => {},
}: {
  options?: OpcaoDeSelecao[];
  inicial?: string;
  onChange?: (v: string) => void;
}) {
  const [valor, setValor] = useState(inicial);
  return (
    <>
      <label htmlFor="modelo">Modelo</label>
      <SearchableSelect
        id="modelo"
        options={options}
        value={valor}
        placeholder="Selecione um modelo"
        onValueChange={(v) => {
          setValor(v);
          onChange(v);
        }}
      />
    </>
  );
}

const gatilho = () => screen.getByRole("combobox", { name: "Modelo" });
const rotulosVisiveis = () => screen.queryAllByRole("option").map((o) => o.textContent);

describe("SearchableSelect — caixa de seleção com busca", () => {
  it("lista longa abre com a busca focada e filtra pelo que se digita", async () => {
    const user = userEvent.setup();
    render(<Controlado />);

    await user.click(gatilho());
    const busca = await screen.findByRole("textbox", { name: "Buscar…" });
    expect(busca).toHaveFocus();
    expect(rotulosVisiveis()).toHaveLength(10);

    await user.type(busca, "sonnet");
    expect(rotulosVisiveis()).toEqual(["Claude Sonnet 4.6"]);
  });

  it("acha pelo identificador técnico que vem em keywords", async () => {
    const user = userEvent.setup();
    render(<Controlado />);

    await user.click(gatilho());
    await user.type(await screen.findByRole("textbox", { name: "Buscar…" }), "anthropic/claude-haiku");
    expect(rotulosVisiveis()).toEqual(["Claude Haiku 4.5"]);
  });

  it("escolhe pelo teclado: seta para baixo e Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlado onChange={onChange} />);

    await user.click(gatilho());
    await user.type(await screen.findByRole("textbox", { name: "Buscar…" }), "gemini");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenCalledWith("google/gemini-2.5-flash");
    expect(gatilho()).toHaveTextContent("Gemini 2.5 Flash");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("escolhe pelo clique e marca a opção escolhida", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlado onChange={onChange} />);

    await user.click(gatilho());
    await user.click(await screen.findByRole("option", { name: "GPT-5 mini" }));
    expect(onChange).toHaveBeenCalledWith("openai/gpt-5-mini");

    await user.click(gatilho());
    expect(await screen.findByRole("option", { name: "GPT-5 mini" })).toHaveAttribute("aria-selected", "true");
  });

  it("nada casa → mostra a mensagem de vazio e nenhuma opção", async () => {
    const user = userEvent.setup();
    render(<Controlado />);

    await user.click(gatilho());
    await user.type(await screen.findByRole("textbox", { name: "Buscar…" }), "xyz");
    expect(screen.getByText("Nenhum resultado")).toBeInTheDocument();
    expect(rotulosVisiveis()).toEqual([]);
  });

  it("lista curta não mostra busca, mas abre e escolhe igual", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlado options={CURTA} onChange={onChange} />);

    await user.click(gatilho());
    expect(await screen.findAllByRole("option")).toHaveLength(3);
    expect(screen.queryByRole("textbox")).toBeNull();

    await user.click(screen.getByRole("option", { name: "Segunda" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("sem valor mostra o placeholder; valor fora da lista aparece cru em vez de sumir", () => {
    const { unmount } = render(<Controlado />);
    expect(gatilho()).toHaveTextContent("Selecione um modelo");
    unmount();

    render(<Controlado inicial="openrouter/modelo-sob-medida" />);
    expect(gatilho()).toHaveTextContent("openrouter/modelo-sob-medida");
  });

  it("digitar com o gatilho focado abre já buscando aquela letra", async () => {
    const user = userEvent.setup();
    render(<Controlado />);

    gatilho().focus();
    await user.keyboard("l");
    expect(await screen.findByRole("textbox", { name: "Buscar…" })).toHaveValue("l");
  });

  it("opção desabilitada não é escolhida", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Controlado
        options={[...CURTA, { value: "x", label: "Indisponível", disabled: true }]}
        onChange={onChange}
      />,
    );

    await user.click(gatilho());
    await user.click(await screen.findByRole("option", { name: "Indisponível" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
