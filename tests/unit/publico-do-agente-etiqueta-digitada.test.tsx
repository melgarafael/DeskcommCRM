/**
 * O CAMPO DE ETIQUETAS DO PÚBLICO ACEITA DIGITAÇÃO (#3722).
 *
 * O campo exibia a lista já limpa (`lista.join(", ")`) e relia a cada tecla:
 * a vírgula e o espaço do fim sumiam no meio da digitação, e quem digitava
 * "cliente ativo, contrato" gravava "clienteativocontrato" — um público que
 * não casa com contato nenhum. Aqui se digita tecla a tecla, num editor com
 * estado real, como o AgentForm faz.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";

import {
  TriggerEditor,
  type TriggerValue,
} from "@/app/app/ai/agents/[id]/_components/TriggerEditor";

const INICIAL: TriggerValue = {
  events: ["message"],
  filters: { ignore_groups: true, ignore_self: true, keyword_regex: null, business_hours: null },
  concurrency: "one_per_conversation",
};

let ultimo: TriggerValue = INICIAL;
function ComEstado() {
  const [v, setV] = useState(INICIAL);
  return <TriggerEditor value={v} onChange={(n) => { ultimo = n; setV(n); }} />;
}

describe("público do agente: campo de etiquetas", () => {
  it("digitar 'cliente ativo, contrato' tecla a tecla grava as duas etiquetas", () => {
    render(<ComEstado />);
    const campo = screen.getByLabelText("Não atender quem tem estas etiquetas") as HTMLInputElement;
    for (const ch of "cliente ativo, contrato") {
      fireEvent.change(campo, { target: { value: campo.value + ch } });
    }
    expect(campo.value).toBe("cliente ativo, contrato");
    expect(ultimo.filters.exclude_tags).toEqual(["cliente ativo", "contrato"]);
  });

  it("'Descartar alterações' (o pai volta o valor) faz o campo voltar a mostrar o salvo", () => {
    const SALVO: TriggerValue = {
      ...INICIAL,
      filters: { ...INICIAL.filters, exclude_tags: ["cliente ativo", "contrato"] },
    };
    let atual = SALVO;
    const { rerender } = render(
      <TriggerEditor value={atual} onChange={(n) => { atual = n; }} />,
    );
    const campo = screen.getByLabelText("Não atender quem tem estas etiquetas") as HTMLInputElement;
    expect(campo.value).toBe("cliente ativo, contrato");
    for (const ch of ", vip") {
      fireEvent.change(campo, { target: { value: campo.value + ch } });
      rerender(<TriggerEditor value={atual} onChange={(n) => { atual = n; }} />);
    }
    expect(campo.value).toBe("cliente ativo, contrato, vip");
    // Descartar: o pai devolve o valor salvo.
    rerender(<TriggerEditor value={SALVO} onChange={(n) => { atual = n; }} />);
    expect(campo.value).toBe("cliente ativo, contrato");
  });
});
