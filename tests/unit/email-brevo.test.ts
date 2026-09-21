import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  BREVO_API_KEY: "test-brevo-key",
  BREVO_FROM_EMAIL: "mail@example.com",
  RESEND_API_KEY: "",
  RESEND_FROM_EMAIL: "",
}));
vi.mock("@/lib/env", () => ({ env: config }));
const resendSend = vi.hoisted(() => vi.fn());
vi.mock("resend", () => ({ Resend: class { emails = { send: resendSend }; } }));
import { fromAddress, isEmailConfigured, sendEmail } from "@/lib/email/resend";

describe("Brevo transactional delivery", () => {
  const request = { to: "owner@example.com", subject: "Convite", html: "<p>Olá</p>" };
  const fetchMock = vi.fn();
  beforeEach(() => {
    config.BREVO_API_KEY = "test-brevo-key";
    config.BREVO_FROM_EMAIL = "mail@example.com";
    config.RESEND_API_KEY = "";
    config.RESEND_FROM_EMAIL = "";
    fetchMock.mockReset(); resendSend.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requires both key and sender; does not silently use Resend", async () => {
    config.BREVO_FROM_EMAIL = "";
    config.RESEND_API_KEY = "legacy-resend-key";
    config.RESEND_FROM_EMAIL = "legacy@example.com";
    expect(isEmailConfigured()).toBe(false);
    expect(fromAddress()).toBeNull();
    expect(await sendEmail(request)).toEqual({ ok: false, error: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("maps recipients, brand, reply address and content; returns provider id", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messageId: "<accepted@brevo>" }), { status: 201 }));
    const result = await sendEmail({ ...request, to: [request.to, "other@example.com"],
      fromName: 'Marca\r\n<>"', text: "Olá", replyTo: "help@example.com",
      tags: [{ name: "kind", value: "team_invite" }] });
    expect(result).toEqual({ ok: true, id: "<accepted@brevo>" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.headers["api-key"]).toBe(config.BREVO_API_KEY);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({ sender: { email: "mail@example.com", name: "Marca" },
      to: [{ email: request.to }, { email: "other@example.com" }], subject: "Convite",
      htmlContent: "<p>Olá</p>", textContent: "Olá", replyTo: { email: "help@example.com" },
      tags: ["kind:team_invite"] });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 429, 500])("does not report success or retry HTTP %s", async (status) => {
    fetchMock.mockResolvedValue(new Response("private provider error", { status }));
    expect(await sendEmail(request)).toEqual({ ok: false,
      error: status === 429 ? "rate_limited" : "send_failed", details: `Brevo HTTP ${status}` });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it.each([{}, { messageId: "" }, { messageId: 123 }, null])("rejects incomplete success payload %j", async (body) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 201 }));
    expect((await sendEmail(request)).ok).toBe(false);
  });

  it("does not retry an ambiguous timeout or expose secrets in errors", async () => {
    fetchMock.mockRejectedValue(new Error(config.BREVO_API_KEY));
    expect(await sendEmail(request)).toEqual({ ok: false, error: "send_failed", details: "Brevo request failed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("keeps existing Resend installations functional when Brevo is absent", async () => {
    config.BREVO_API_KEY = "";
    config.RESEND_API_KEY = "legacy-resend-key";
    config.RESEND_FROM_EMAIL = "legacy@example.com";
    resendSend.mockResolvedValue({ data: { id: "legacy-id" }, error: null });
    expect(isEmailConfigured()).toBe(true);
    expect(await sendEmail(request)).toEqual({ ok: true, id: "legacy-id" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
