// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Renovação de sessão no proxy: o token rotacionado pelo `getUser()` tem de
 * chegar ao handler/layout da MESMA requisição (cabeçalho `cookie` da
 * requisição repassada) e ao navegador (`Set-Cookie`). O `NextResponse.next`
 * copia os cabeçalhos da requisição quando é criado; sem recriá-lo depois do
 * `setAll`, o handler lê o refresh token antigo e tenta renová-lo de novo
 * (409 / 429 / bad_jwt).
 */
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.exemplo",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-de-teste",
    NEXT_PUBLIC_APP_URL: "https://crm.exemplo",
  },
}));

type Opcoes = {
  cookies: {
    getAll(): { name: string; value: string }[];
    setAll(c: { name: string; value: string; options: Record<string, unknown> }[]): void;
  };
};

const ssr = vi.hoisted(() => ({ renovar: true }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, opts: Opcoes) => ({
    auth: {
      getUser: async () => {
        if (ssr.renovar) {
          opts.cookies.setAll([
            { name: "sb-deskcomm-auth", value: "token-NOVO", options: { path: "/", httpOnly: true } },
          ]);
        }
        return { data: { user: { id: "u1" } }, error: null };
      },
    },
    rpc: async () => ({ data: true, error: null }),
  }),
}));

async function passarPeloProxy(caminho: string) {
  const { proxy } = await import("@/proxy");
  const { NextRequest } = await import("next/server");
  return proxy(
    new NextRequest(`https://crm.exemplo${caminho}`, {
      headers: { cookie: "sb-deskcomm-auth=token-ANTIGO" },
    }),
  );
}

afterEach(() => {
  ssr.renovar = true;
});

describe("proxy propaga o token renovado", () => {
  it("o handler da mesma requisição vê o cookie novo, não o antigo", async () => {
    const resposta = await passarPeloProxy("/app/inbox");
    const cookieNaRequisicao = resposta.headers.get("x-middleware-request-cookie") ?? "";
    expect(cookieNaRequisicao).toContain("token-NOVO");
    expect(cookieNaRequisicao).not.toContain("token-ANTIGO");
  });

  it("o navegador recebe o Set-Cookie com o token novo", async () => {
    const resposta = await passarPeloProxy("/app/inbox");
    expect(resposta.cookies.get("sb-deskcomm-auth")?.value).toBe("token-NOVO");
  });

  it("a resposta recriada mantém o x-request-id (fora de /api/) e a requisição o repassa", async () => {
    const resposta = await passarPeloProxy("/app/inbox");
    const idNaRequisicao = resposta.headers.get("x-middleware-request-x-request-id");
    expect(idNaRequisicao).toBeTruthy();
    expect(resposta.headers.get("x-request-id")).toBe(idNaRequisicao);
  });

  it("em /api/ a resposta não carrega x-request-id (é da rota)", async () => {
    const resposta = await passarPeloProxy("/api/v1/conversations");
    expect(resposta.headers.get("x-request-id")).toBeNull();
    expect(resposta.headers.get("x-middleware-request-cookie")).toContain("token-NOVO");
  });

  it("sem renovação, o cookie da requisição segue intacto", async () => {
    ssr.renovar = false;
    const resposta = await passarPeloProxy("/app/inbox");
    expect(resposta.headers.get("x-middleware-request-cookie")).toContain("token-ANTIGO");
  });
});
