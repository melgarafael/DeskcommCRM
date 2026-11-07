import { afterEach, describe, expect, it, vi } from "vitest";

import { signCadenciaLink, verifyCadenciaLink } from "./token";

const payload = {
  enrollment_id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-000000000002",
  cadence_id: "00000000-0000-4000-8000-000000000003",
  lead_id: "00000000-0000-4000-8000-000000000004", passo_id: "email-1",
};

afterEach(() => vi.unstubAllEnvs());
describe("links de cadência separados por finalidade", () => {
  it("pixel não autoriza descadastro e descadastro não autoriza pixel", () => {
    vi.stubEnv("INTERNAL_SECRET", "segredo-sintetico-da-prova-cadencias");
    const abertura = signCadenciaLink(payload, "abertura");
    const descadastro = signCadenciaLink(payload, "descadastro");
    expect(verifyCadenciaLink(abertura, "abertura")).toEqual(payload);
    expect(verifyCadenciaLink(descadastro, "descadastro")).toEqual(payload);
    expect(verifyCadenciaLink(abertura, "descadastro")).toBeNull();
    expect(verifyCadenciaLink(descadastro, "abertura")).toBeNull();
  });
  it("sem segredo não assina nem aceita o piso conhecido", () => {
    vi.stubEnv("INTERNAL_SECRET", "");
    expect(() => signCadenciaLink(payload, "descadastro")).toThrow("cadencia_link_secret_missing");
    expect(verifyCadenciaLink("qualquer.assinatura", "descadastro")).toBeNull();
  });
});
