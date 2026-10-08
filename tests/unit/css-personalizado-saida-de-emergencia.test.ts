// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { CABECALHO_SEM_CSS } from "@/lib/branding/sem-css-personalizado";

/**
 * `?sem_css=1` é a saída de quem se trancou fora com o próprio CSS
 * personalizado (docs/white-label.md). O `proxy.ts` traduz o parâmetro num
 * cabeçalho da REQUISIÇÃO; o Next só repassa aos Server Components os
 * cabeçalhos copiados por `NextResponse.next({ request })`, e eles saem na
 * resposta como `x-middleware-request-*`. É isso que se mede aqui.
 */
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.exemplo",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-de-teste",
  },
}));

async function cabecalhoRepassado(url: string, cabecalhos?: Record<string, string>) {
  const { proxy } = await import("@/proxy");
  const { NextRequest } = await import("next/server");
  const resposta = await proxy(new NextRequest(url, { headers: cabecalhos }));
  return resposta.headers.get(`x-middleware-request-${CABECALHO_SEM_CSS}`);
}

describe("saída de emergência do CSS personalizado", () => {
  it("?sem_css=1 desliga a folha para quem pediu", async () => {
    expect(await cabecalhoRepassado("https://crm.exemplo/login?sem_css=1")).toBe("1");
  });

  it("sem o parâmetro, a folha vale", async () => {
    expect(await cabecalhoRepassado("https://crm.exemplo/login")).toBe("0");
  });

  it("o cabeçalho mandado pelo navegador não vale: só o parâmetro decide", async () => {
    expect(
      await cabecalhoRepassado("https://crm.exemplo/login", { [CABECALHO_SEM_CSS]: "1" }),
    ).toBe("0");
  });
});
