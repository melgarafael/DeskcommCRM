/**
 * O HORÁRIO COMERCIAL DO GATILHO NASCE NO FUSO DA ORGANIZAÇÃO.
 *
 * Ao ligar "Só atender em horário de funcionamento", o editor cria o bloco
 * `business_hours` com um fuso. Ele era sempre `America/Sao_Paulo`: uma clínica
 * na Cidade do México configurava 08:00–20:00 e o agente passava a atender no
 * horário de São Paulo, sem nada na tela que mostrasse a diferença.
 *
 * Agora nasce no fuso da organização, e só cai em São Paulo quando ela não tem
 * um (`organizationTimezone` ausente).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import {
  TriggerEditor,
  type TriggerValue,
} from "@/app/app/ai/agents/[id]/_components/TriggerEditor";

const SEM_HORARIO: TriggerValue = {
  events: ["message"],
  filters: { ignore_groups: true, ignore_self: true, keyword_regex: null, business_hours: null },
  concurrency: "one_per_conversation",
};

/** Liga o horário de funcionamento e devolve o valor que o editor emitiu. */
function ligarHorario(organizationTimezone?: string): TriggerValue {
  const onChange = vi.fn();
  render(
    <TriggerEditor
      value={SEM_HORARIO}
      onChange={onChange}
      organizationTimezone={organizationTimezone}
    />,
  );
  fireEvent.click(screen.getByLabelText("Só atender em horário de funcionamento"));
  expect(onChange).toHaveBeenCalledTimes(1);
  return onChange.mock.calls[0]![0] as TriggerValue;
}

describe("gatilho do agente: fuso do horário de funcionamento", () => {
  it("nasce no fuso da organização", () => {
    const emitido = ligarHorario("America/Mexico_City");
    expect(emitido.filters.business_hours?.timezone).toBe("America/Mexico_City");
  });

  it("sem fuso da organização, cai em São Paulo", () => {
    const emitido = ligarHorario(undefined);
    expect(emitido.filters.business_hours?.timezone).toBe("America/Sao_Paulo");
  });
});
