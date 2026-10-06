/**
 * O FILTRO POR ETIQUETA NA TELA DO AGENTE — grava o que promete.
 *
 * Três armadilhas que este arquivo segura:
 *   - a tela dizer que é gatilho (não é: colocar etiqueta não dispara mensagem);
 *   - gravar a etiqueta crua ("Cliente ") quando o servidor normaliza ("cliente"):
 *     o formulário nunca bateria com a versão salva e o Publicar travaria;
 *   - gravar `[]` ao tirar a última etiqueta: chave que a versão salva não tem,
 *     mesmo defeito (`lib/ai/agents/mesmo-rascunho.ts`).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import {
  TriggerEditor,
  type TriggerValue,
} from "@/app/app/ai/agents/[id]/_components/TriggerEditor";

const BASE: TriggerValue = {
  events: ["message"],
  filters: { ignore_groups: true, ignore_self: true, keyword_regex: null, business_hours: null },
  concurrency: "one_per_conversation",
};

function montar(value: TriggerValue = BASE, sugestoes?: string[]) {
  const onChange = vi.fn();
  render(<TriggerEditor value={value} onChange={onChange} sugestoesDeEtiquetas={sugestoes} />);
  return onChange;
}

function emitido(onChange: ReturnType<typeof vi.fn>): TriggerValue {
  return onChange.mock.calls.at(-1)![0] as TriggerValue;
}

describe("filtro por etiqueta do contato no editor do agente", () => {
  it("diz que é filtro, não gatilho", () => {
    montar();
    expect(screen.getByText(/Não é um gatilho/)).toBeInTheDocument();
  });

  it("digitar e Enter grava a etiqueta normalizada em contact_tags_include", () => {
    const onChange = montar();
    const campo = screen.getByLabelText("Responder só quem tem uma destas etiquetas");
    fireEvent.change(campo, { target: { value: "  Cliente " } });
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(emitido(onChange).filters.contact_tags_include).toEqual(["cliente"]);
  });

  it("a lista de exclusão grava em contact_tags_exclude", () => {
    const onChange = montar();
    const campo = screen.getByLabelText("Nunca responder quem tem uma destas etiquetas");
    fireEvent.change(campo, { target: { value: "fornecedor" } });
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(emitido(onChange).filters.contact_tags_exclude).toEqual(["fornecedor"]);
  });

  it("tirar a última etiqueta apaga a chave (senão o Publicar trava)", () => {
    const onChange = montar({ ...BASE, filters: { ...BASE.filters, contact_tags_include: ["cliente"] } });
    fireEvent.click(screen.getByRole("button", { name: "Remover cliente" }));
    expect(emitido(onChange).filters.contact_tags_include).toBeUndefined();
  });

  it("sugere as etiquetas em uso e um clique grava", () => {
    const onChange = montar(BASE, ["cliente", "lead"]);
    // A primeira sugestão "+ lead" é a da lista "só quem tem" (vem antes na tela).
    fireEvent.click(screen.getAllByRole("button", { name: "+ lead" })[0]!);
    expect(emitido(onChange).filters.contact_tags_include).toEqual(["lead"]);
  });

  it("avisa quando nenhum contato tem a etiqueta (erro de digitação calaria o agente)", () => {
    montar({ ...BASE, filters: { ...BASE.filters, contact_tags_include: ["clinete"] } }, ["cliente"]);
    expect(screen.getByText(/Nenhum contato tem esta etiqueta ainda/)).toBeInTheDocument();
  });
});
