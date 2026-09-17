import { describe, expect, it } from "vitest";
import { compararEquipes, parseEquipeAdvomax } from "./team-readiness";

describe("prontidão da equipe Advomax", () => {
  it("rejeita payload com campos inesperados ou e-mail duplicado", () => {
    const membro = { codigo: 1, nome: "Ana", email: "ana@example.com", perfilCodigo: 3, perfilNome: "Advogado" };
    expect(parseEquipeAdvomax([{ ...membro, senha: "vazou" }])).toBeNull();
    expect(parseEquipeAdvomax([membro, { ...membro, codigo: 2 }])).toBeNull();
  });

  it("aponta ausências e divergência de administrador sem promover ninguém", () => {
    const upstream = parseEquipeAdvomax([
      { codigo: 1, nome: "Dona", email: "DONA@example.com", perfilCodigo: 1, perfilNome: "Administrador" },
      { codigo: 2, nome: "Ana", email: "ana@example.com", perfilCodigo: 3, perfilNome: "Advogado" },
    ])!;
    expect(compararEquipes(upstream, [
      { userId: "u1", email: "dona@example.com", role: "manager", revoked: false },
      { userId: "u3", email: "fora@example.com", role: "agent", revoked: false },
    ])).toEqual({
      prontos: 0,
      sem_membership_crm: ["ana@example.com"],
      ausente_na_gestao: ["fora@example.com"],
      perfil_divergente: ["dona@example.com"],
    });
  });
});
