import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { AmigoAgentTools } from "./AmigoAgentTools";
afterEach(cleanup);
it("seleciona as ferramentas Amigo por agente sem alterar as outras capacidades", () => {
  const onChange = vi.fn();
  render(
    <AmigoAgentTools
      value={["crm_get_lead", "crm_amigo_places"]}
      onChange={onChange}
      disabled={false}
    />,
  );
  expect(screen.getByRole("checkbox", { name: "Consultar unidades" })).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "Agendar consulta" }));
  expect(onChange).toHaveBeenCalledWith([
    "crm_get_lead",
    "crm_amigo_places",
    "crm_amigo_attendance_create",
  ]);
  expect(screen.getByRole("checkbox", { name: /Consultar aniversariantes/ })).toBeDisabled();
});
