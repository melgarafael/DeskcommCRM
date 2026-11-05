// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

/**
 * O `proxy.ts` cunha (ou aceita) o id da requisição e o entrega à rota pelo
 * cabeçalho da REQUISIÇÃO. A RESPOSTA, sob `/api/`, ele não carimba — e isso é
 * o conserto: o Next aplica os cabeçalhos do middleware por cima dos da
 * resposta, então o carimbo daqui sobrescrevia o `X-Request-Id` que a rota tinha
 * gravado no registro. A resposta saía com um id que não existia em log nenhum.
 */
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } }, error: null }) },
  }),
}));

import { cabecalhosQueOProxyEntrega } from "./helpers/cabecalhos-do-proxy";

const ID_DO_CLIENTE = "11111111-1111-4111-8111-111111111111";

async function respostaDoProxy(url: string, headers: Record<string, string> = {}) {
  const { proxy } = await import("@/proxy");
  const { NextRequest } = await import("next/server");
  return proxy(new NextRequest(url, { headers }));
}

describe("proxy: o id da requisição tem UM formato e UM dono", () => {
  it("o UUID mandado pelo cliente chega à rota", async () => {
    const h = await cabecalhosQueOProxyEntrega("https://crm.exemplo.com.br/api/v1/health", {
      "x-request-id": ID_DO_CLIENTE,
    });

    expect(h.get("x-request-id")).toBe(ID_DO_CLIENTE);
  });

  it("valor fora do formato não chega: o proxy cunha outro", async () => {
    const h = await cabecalhosQueOProxyEntrega("https://crm.exemplo.com.br/api/v1/health", {
      "x-request-id": "nao-e-uuid-inventado-pelo-cliente",
    });

    const entregue = h.get("x-request-id") ?? "";
    expect(entregue).not.toContain("level=fatal");
    expect(entregue).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("sem cabeçalho, a rota recebe um id cunhado", async () => {
    const h = await cabecalhosQueOProxyEntrega("https://crm.exemplo.com.br/api/v1/health");

    expect(h.get("x-request-id")).toBeTruthy();
  });

  it("sob /api/ o proxy NÃO carimba a resposta — quem carimba é a rota", async () => {
    const res = await respostaDoProxy("https://crm.exemplo.com.br/api/v1/health");

    expect(res.headers.get("x-request-id")).toBeNull();
  });

  it("fora de /api/ a resposta continua carimbada pelo proxy", async () => {
    const res = await respostaDoProxy("https://crm.exemplo.com.br/app/inbox", {
      "x-request-id": ID_DO_CLIENTE,
    });

    expect(res.headers.get("x-request-id")).toBe(ID_DO_CLIENTE);
  });
});
