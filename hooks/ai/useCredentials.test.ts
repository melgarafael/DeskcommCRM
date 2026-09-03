/**
 * Credencial criada sem resultado de validação por mais de 2 minutos não está
 * "validando": o processo que validaria já morreu. Dizer "Validando…" para
 * sempre esconde do operador o único botão que resolve (revalidar).
 */
import { describe, expect, it } from "vitest";
import { credentialStatus, JANELA_DE_VALIDACAO_MS, type CredentialRow } from "./useCredentials";

const base: CredentialRow = {
  id: "c1", organization_id: "o1", provider: "anthropic", label: "x",
  api_key_last4: "abcd", validated_at: null, validation_error: null,
  models_available: null, is_active: true, created_by: null,
  created_at: "2026-09-02T12:00:00Z", updated_at: "2026-09-02T12:00:00Z",
};
const criadaEm = Date.parse(base.created_at);

describe("credentialStatus", () => {
  it("recém-criada sem resultado é 'validating'", () => {
    expect(credentialStatus(base, criadaEm + 10_000)).toBe("validating");
  });

  it("passada a janela sem resultado é 'unvalidated'", () => {
    expect(credentialStatus(base, criadaEm + JANELA_DE_VALIDACAO_MS + 1)).toBe("unvalidated");
  });

  it("erro gravado vence a janela", () => {
    expect(credentialStatus({ ...base, validation_error: "auth_failed_401" }, criadaEm)).toBe("invalid");
  });

  it("validada é validada", () => {
    expect(credentialStatus({ ...base, validated_at: base.created_at }, criadaEm + 1e9)).toBe("validated");
  });

  it("inativa vence tudo", () => {
    expect(credentialStatus({ ...base, is_active: false, validated_at: base.created_at }, criadaEm)).toBe("inactive");
  });
});
