/**
 * O lado oposto da #3971, numa rota REAL das ~95 que já gravam o `requestId`.
 *
 * A correção em `fail()` (lib/api/wrappers.ts) grava uma linha `logger.error`
 * com o ID do header quando o status é 5xx. Se ela gravasse SEMPRE, toda rota
 * que já registra a própria linha passaria a ter DUAS linhas para o mesmo
 * `requestId` — e a segunda, sem causa nem organização, não acrescenta nada.
 *
 * Esta rota é o caso real: em `contact-tags/route.ts` a falha de leitura loga
 * `logger.error(..., { requestId, orgId, cause })` e SÓ DEPOIS chama
 * `fail(..., 500, { requestId })`. O que se prova aqui:
 *
 *  - o `X-Request-Id` da resposta é o MESMO id que aparece no log (literal);
 *  - existe UMA linha com esse id, não duas;
 *  - a linha que fica é a da rota, a que tem a causa — não a genérica do
 *    `fail()`.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  banco: {} as Record<string, unknown>,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: "u-1" }, org: { orgId: "org-3971" } }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.banco }));

import { GET } from "./route";

type Linha = { level: string; msg: string; requestId?: string };

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  // A cadeia que a rota usa no caminho sem busca: from().select().eq().neq().order().limit()
  const cadeia: Record<string, unknown> = {};
  for (const passo of ["select", "eq", "neq", "order"]) {
    cadeia[passo] = () => cadeia;
  }
  cadeia.limit = async () => ({ data: null, error: { message: "conexão caiu" } });
  h.banco = { from: () => cadeia };
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("contact-tags: rota que já loga não ganha segunda linha", () => {
  it("⭐ 500 loga o MESMO id do header, uma vez, na linha da rota", async () => {
    const res = await GET(new NextRequest("http://localhost/api/v1/contact-tags"));
    const id = res.headers.get("X-Request-Id");

    expect(res.status).toBe(500);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const linhas = errorSpy.mock.calls
      .map((c: unknown[]) => JSON.parse(String(c[0])) as Linha)
      .filter((l: Linha) => l.requestId === id);

    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.msg).toBe("contact-tags: leitura das tags do contato falhou");
    expect(linhas[0]?.level).toBe("error");
  });
});
