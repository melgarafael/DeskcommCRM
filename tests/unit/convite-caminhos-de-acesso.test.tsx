import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { signInviteToken } from "@/lib/auth/invite-token";

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@/lib/auth/rate-limit", () => ({
  authRateLimited: async () => false,
  AUTH_LIMITS: { invite_accept: {} },
}));
vi.mock("@/lib/i18n/idiomaAnonimo", () => ({ idiomaDoVisitante: async () => "pt-BR" }));
vi.mock("@/lib/auth/politica-de-cadastro", () => ({ modoDeCadastro: async () => "aberto" }));
vi.mock("@/components/auth/LoginForm", () => ({
  LoginForm: ({ email, next }: { email?: string; next?: string }) => (
    <input data-next={next} defaultValue={email} />
  ),
}));
vi.mock("@/components/auth/SignupForm", () => ({ SignupForm: () => null }));
vi.mock("@/components/auth/EntrarComGoogle", () => ({ EntrarComGoogle: () => null }));
vi.mock("@/app/team/accept-invite/[token]/AcceptInviteForm", () => ({
  AcceptInviteForm: () => null,
}));

const token = signInviteToken({
  invite_id: "e9f1fd0c-8d64-4d33-b7e2-793856166df2",
  organization_id: "9093db4b-9d09-4a65-8f76-caf4c0b09a13",
  email: "pessoa@example.test",
  role: "agent",
  exp: Math.floor(Date.now() / 1000) + 3600,
});
const destino = `/team/accept-invite/${token}`;

describe("convite acompanha os dois caminhos", () => {
  it("destaca criar conta e preserva o token nas duas opções", async () => {
    const Page = (await import("@/app/team/accept-invite/[token]/page")).default;
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ token }) }));
    const doc = new DOMParser().parseFromString(html, "text/html");
    const links = doc.querySelectorAll("a");
    expect(links[0]?.textContent).toBe("Criar minha conta");
    expect(links[0]?.className).toContain("bg-primary");
    expect(links[0]?.getAttribute("href")).toBe(`/signup?invite=${encodeURIComponent(token)}`);
    expect(links[1]?.textContent).toBe("Já tenho conta? Entrar");
    expect(links[1]?.getAttribute("href")).toBe(`/login?next=${encodeURIComponent(destino)}`);
    expect(html).toContain("pessoa@example.test");
  });
  it("login preenche só e-mail de convite válido e mantém cadastro vinculado", async () => {
    const Page = (await import("@/app/(public)/login/page")).default;
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({ next: destino }) }),
    );
    expect(html).toContain('value="pessoa@example.test"');
    expect(html).toContain(`/signup?invite=${encodeURIComponent(token)}`);
    const invalido = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({ next: destino + "x" }) }),
    );
    expect(invalido).not.toContain('value="pessoa@example.test"');
  });
  it("cadastro conserva convite quando a pessoa decide entrar", async () => {
    const Page = (await import("@/app/(public)/signup/page")).default;
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({ invite: token }) }),
    );
    expect(html).toContain(`/login?next=${encodeURIComponent(destino)}`);
  });
});
