// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";

/**
 * O túnel do Sentry (`tunnelRoute` em `next.config.ts`) é um rewrite do Next
 * que o `proxy.ts` alcança antes. Sem entrada em `PUBLIC_PATHS`, o envelope de
 * erro do navegador recebia 307 para `/login` e nunca chegava ao Sentry — com
 * ou sem sessão (issue #5091). O próprio comentário do Sentry no
 * `next.config.ts` avisa: a rota não pode casar com o middleware.
 */
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}));

const RAIZ = process.cwd();

function rotaDoTunel(): string {
  const config = fs.readFileSync(path.join(RAIZ, "next.config.ts"), "utf8");
  const rota = config.match(/tunnelRoute:\s*"([^"]+)"/)?.[1];
  if (!rota) throw new Error("tunnelRoute não encontrado em next.config.ts");
  return rota;
}

describe("túnel do Sentry alcançável sem sessão (#5091)", () => {
  it("o caminho configurado em tunnelRoute é público", () => {
    // Amarrado ao valor do config: renomear o túnel sem mexer aqui reprova.
    expect(isPublicPath(rotaDoTunel())).toBe(true);
  });

  it("POST do envelope sem sessão não vira 3xx para /login", async () => {
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const r = await proxy(
      new NextRequest(`https://crm.exemplo${rotaDoTunel()}?o=1&p=2&r=us`, {
        method: "POST",
        body: "{}",
      }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("location")).toBeNull();
  });

  it("a entrada é ancorada — não abre sub-path nem vizinho", () => {
    expect(isPublicPath("/monitoring/x")).toBe(false);
    expect(isPublicPath("/monitoringx")).toBe(false);
    expect(isPublicPath("/app/monitoring")).toBe(false);
  });
});
