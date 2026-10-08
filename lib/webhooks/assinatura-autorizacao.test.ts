import { describe, expect, it } from "vitest";
import { assinaturaObrigatoriaAusente } from "./assinatura-autorizacao";
describe("AI source signature requirement", () => {
  it("rejects enabling unsigned capture", () =>
    expect(
      assinaturaObrigatoriaAusente(
        { authorize_ai_on_capture: false, secret_encrypted: null },
        { authorize_ai_on_capture: true },
      ),
    ).toBe(true));
  it("accepts an already configured signature", () =>
    expect(
      assinaturaObrigatoriaAusente(
        { authorize_ai_on_capture: false, secret_encrypted: "synthetic-cipher" },
        { authorize_ai_on_capture: true },
      ),
    ).toBe(false));
  it("rejects removing signature while authorization stays active", () =>
    expect(
      assinaturaObrigatoriaAusente(
        { authorize_ai_on_capture: true, secret_encrypted: "synthetic-cipher" },
        { secret: null },
      ),
    ).toBe(true));
  it("allows disabling authorization and removing signature atomically", () =>
    expect(
      assinaturaObrigatoriaAusente(
        { authorize_ai_on_capture: true, secret_encrypted: "synthetic-cipher" },
        { authorize_ai_on_capture: false, secret: null },
      ),
    ).toBe(false));
  it("preserves unsigned legacy sources when the new feature is off", () =>
    expect(
      assinaturaObrigatoriaAusente({ authorize_ai_on_capture: false, secret_encrypted: null }, {}),
    ).toBe(false));
});
