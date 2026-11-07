import { describe, expect, it } from "vitest";
import { amigoOperations } from "./contracts";
import { agentMayExecute, agentOperationOptions } from "./agent-permissions";
describe("permissões Amigo do agente", () => {
  it("apresenta todas as operações documentadas e o vínculo explícito", () => {
    expect(agentOperationOptions.map((o) => o.id)).toEqual([...amigoOperations, "link_patient"]);
  });
  it("uma opção desmarcada bloqueia a operação antes da chamada externa", () => {
    expect(agentMayExecute([], "attendance_create")).toBe(false);
    expect(agentMayExecute(["attendance_create"], "attendance_create")).toBe(true);
  });
  it("configuração antiga preserva o comportamento existente", () => {
    expect(agentMayExecute(undefined, "attendance_create")).toBe(true);
  });
});
it("a seleção da versão do agente restringe mesmo os comandos genéricos de agenda", () => {
  expect(agentMayExecute(undefined, "attendance_create", [])).toBe(false);
  expect(agentMayExecute(undefined, "attendance_create", ["crm_amigo_attendance_create"])).toBe(
    true,
  );
  expect(agentMayExecute([], "attendance_create", ["crm_amigo_attendance_create"])).toBe(false);
});
