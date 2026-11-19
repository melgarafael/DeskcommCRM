// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

/**
 * Abrir o app instalado pelo ícone (Android) é uma navegação "de fora": sob
 * SameSite=Strict o navegador retém o cookie de sessão, o proxy não vê usuário
 * e mandava para o /login a cada abertura — com a sessão viva no banco.
 * Nesse caso o proxy devolve a ponte (documento nosso que refaz a navegação
 * como same-origin), e só a navegação same-origin sem sessão vai ao /login.
 */
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: async () => ({ nome: "CRM" }),
}));

async function abrir(
  headers: Record<string, string>,
  method = "GET",
  url = "https://crm.exemplo/app/inbox?x=1",
) {
  const { proxy } = await import("@/proxy");
  const { NextRequest } = await import("next/server");
  return proxy(new NextRequest(url, { headers, method }));
}

describe("proxy: abertura de fora sem cookie passa pela ponte", () => {
  it("ícone do app (sec-fetch-site none): ponte para o mesmo caminho", async () => {
    const r = await abrir({ "sec-fetch-mode": "navigate", "sec-fetch-site": "none" });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('window.location.replace("/app/inbox?x=1")');
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("destino protocol-relative não sai do site: a ponte usa o padrão", async () => {
    // Hoje o Next normaliza `//` antes do proxy; a ponte não depende disso.
    const r = await abrir(
      { "sec-fetch-mode": "navigate", "sec-fetch-site": "none" },
      "GET",
      "https://crm.exemplo//evil.example/x",
    );
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('window.location.replace("/app")');
    expect(html).not.toContain("evil.example");
  });

  it("link vindo de outro site (cross-site): ponte", async () => {
    const r = await abrir({ "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site" });
    expect(r.status).toBe(200);
  });

  it("a volta da ponte (same-origin) sem sessão: /login, sem laço", async () => {
    const r = await abrir({ "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" });
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toContain("/login?next=%2Fapp%2Finbox%3Fx%3D1");
  });

  it("navegador sem Sec-Fetch: redirect de sempre", async () => {
    const r = await abrir({});
    expect(r.status).toBe(307);
  });

  it("não-navegação (fetch) de fora: redirect de sempre", async () => {
    const r = await abrir({ "sec-fetch-mode": "cors", "sec-fetch-site": "cross-site" });
    expect(r.status).toBe(307);
  });
});
