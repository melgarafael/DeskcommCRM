import { describe, expect, it } from "vitest";
import { requireAmigoAccess } from "./access";

describe("autoridade de acesso ao Amigo", () => {
  it("agenda global exige gestão humana", () => {
    expect(() => requireAmigoAccess({ role: "agent", automated: false }, "attendances")).toThrow();
    expect(() =>
      requireAmigoAccess({ role: "manager", automated: false }, "attendances"),
    ).not.toThrow();
  });
  it("a IA não pode explorar listas globais de pacientes ou aniversariantes", () => {
    expect(() =>
      requireAmigoAccess(
        { role: "admin", automated: true, contactId: "contato" },
        "patient_birthdays",
      ),
    ).toThrow();
    expect(() =>
      requireAmigoAccess({ role: "admin", automated: true, contactId: "contato" }, "attendances"),
    ).toThrow();
  });
  it("uma ferramenta de paciente requer contato confiável para atendimento automático", () => {
    expect(() =>
      requireAmigoAccess({ role: "ai_operator", automated: true }, "patient_get"),
    ).toThrow();
    expect(() =>
      requireAmigoAccess(
        { role: "ai_operator", automated: true, contactId: "contato" },
        "patient_get",
      ),
    ).not.toThrow();
  });
  it("leitor não altera dados nem lê fichas de pacientes", () => {
    expect(() =>
      requireAmigoAccess({ role: "viewer", automated: false }, "patient_create"),
    ).toThrow();
    expect(() => requireAmigoAccess({ role: "viewer", automated: false }, "patient_get")).toThrow();
  });
  it("atendente sem contato não faz busca global; gestão humana pode fazer", () => {
    expect(() =>
      requireAmigoAccess({ role: "agent", automated: false }, "patient_search"),
    ).toThrow();
    expect(() =>
      requireAmigoAccess({ role: "manager", automated: false }, "patient_search"),
    ).not.toThrow();
  });
});
