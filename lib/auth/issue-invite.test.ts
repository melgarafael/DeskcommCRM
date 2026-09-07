import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ send: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "http://localhost:3013" } }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: h.send }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "Local", cor: "#000000" }) }));
vi.mock("@/lib/email/templates/invite", () => ({ buildInviteEmail: () => ({ subject: "Convite", html: "Convite", text: "Convite" }) }));
import { issueInvite } from "./issue-invite";
import { verifyInviteToken } from "./invite-token";
const input = { email: "guest@example.test", role: "admin" as const,
  organizationId: "a2180000-0000-4000-8000-000000000001", orgName: "Org",
  inviterId: "a2180000-0000-4000-8000-000000000002", inviterName: "Admin", requestId: "test" };
beforeEach(() => vi.resetAllMocks());
it("sem serviço de e-mail continua com link assinado, validade e auditoria sem token", async () => {
  h.send.mockResolvedValue({ ok: false, error: "not_configured" });
  const result = await issueInvite(input);
  const token = result.accept_url.split("/").at(-1)!;
  expect(result.email_dispatched).toBe(false);
  expect(verifyInviteToken(token)).toMatchObject({ invited_by: input.inviterId, organization_id: input.organizationId, role: "admin" });
  expect(Date.parse(result.expires_at)).toBeGreaterThan(Date.now());
  expect(JSON.stringify(h.audit.mock.calls)).not.toContain(token);
});
it("falha lançada pelo envio continua com recuperação visível", async () => {
  h.send.mockRejectedValue(new Error("network failure"));
  const result = await issueInvite(input);
  expect(result.email_dispatched).toBe(false);
  expect(result.accept_url).toContain("/team/accept-invite/");
});
it("replay usa identidade/prazo estáveis e não reenvia", async () => {
  const args = { ...input, dispatch: false, inviteId: input.inviterId, issuedAt: Math.floor(Date.now()/1000) };
  expect(await issueInvite(args)).toEqual(await issueInvite(args));
  expect(h.send).not.toHaveBeenCalled();
  expect(h.audit).not.toHaveBeenCalled();
});
