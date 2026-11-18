import { beforeEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";

const mocks = vi.hoisted(() => ({ resendSend: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://cadencias.test" } }));
vi.mock("@/lib/email/config", () => ({
  getSmtpConfig: async () => ({ host: "smtp.test", port: 587, security: "none", username: "", password: "", fromEmail: "a@cadencias.test", fromName: "A" }),
}));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: async () => ({ valor: "sintetico@cadencias.test" }) }));
vi.mock("resend", () => ({ Resend: class { emails = { send: mocks.resendSend }; } }));

const URL_LONGA = `https://cadencias.test/api/v1/webhooks/cadencia-descadastro/${"a".repeat(380)}.${"b".repeat(43)}`;
const headers = { "List-Unsubscribe": `<${URL_LONGA}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
const envio = { to: "p@cadencias.test", subject: "s", html: "<p>x</p>", headers };

describe("cabeçalhos do envio chegam aos dois transportes", () => {
  beforeEach(() => mocks.resendSend.mockReset().mockResolvedValue({ data: { id: "1" }, error: null }));
  it("SMTP: a mensagem crua leva a URL inteira, mesmo dobrada", async () => {
    const real = nodemailer.createTransport({ streamTransport: true, buffer: true });
    vi.spyOn(nodemailer, "createTransport").mockReturnValue(real);
    const { sendEmail } = await import("./smtp");
    const espiao = vi.spyOn(real, "sendMail");
    expect((await sendEmail(envio)).ok).toBe(true);
    const bruta = String((await espiao.mock.results[0]!.value as { message: Buffer }).message);
    const desdobrada = bruta.replace(/\r\n[ \t]+/g, " ");
    expect(desdobrada).toContain(`List-Unsubscribe: <${URL_LONGA}>`);
    expect(desdobrada).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });
  it("Resend: os cabeçalhos vão na chamada", async () => {
    const { sendEmail } = await import("./resend");
    expect((await sendEmail(envio)).ok).toBe(true);
    expect(mocks.resendSend.mock.calls[0]![0].headers).toEqual(headers);
  });
});
