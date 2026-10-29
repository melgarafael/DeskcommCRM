import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: async () => ({ valor: "" }) }));

import { sendEmail } from "@/lib/email/resend";

afterEach(() => vi.restoreAllMocks());

describe("aviso de envio desligado", () => {
  it("explica a configuração ausente sem destinatário, assunto ou corpo", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resultado = await sendEmail({
      to: "titular-sintetico@example.test",
      subject: "Assunto privado sintético",
      html: "<p>Corpo privado sintético</p>",
      text: "Prévia privada sintética",
    });
    expect(resultado).toEqual({ ok: false, error: "not_configured" });
    expect(aviso).toHaveBeenCalledOnce();
    const gravado = JSON.stringify(aviso.mock.calls);
    expect(gravado).not.toMatch(/titular-sintetico|Assunto privado|Corpo privado|Prévia privada/);
    expect(gravado).toContain("RESEND_API_KEY");
  });
});
