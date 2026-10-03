/**
 * EMPRESA SUSPENSA NA API: 403 `org_suspended` EM JSON, NUNCA 307 PARA HTML
 * (acabamentos do PR 1, itens 6 e 23).
 *
 * Era `resolveActiveOrg` → `redirect("/account-suspended")`: o `fetch` seguia o
 * 307 e a tela recebia a página HTML como se fosse o dado. A cerca estática é
 * `api-nao-redireciona-org-suspensa.test.ts`; aqui o COMPORTAMENTO, por rotas
 * reais de formatos diferentes (JSON com `no_active_org`, JSON com
 * `forbidden_tenant`, corpo vazio).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

const h = vi.hoisted(() => ({ status: "suspended" as string }));

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`redirect(${destino}) numa rota de API`);
  },
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async (): Promise<AuthUser> =>
    ({ id: "u-1", email: "a@b.c", idioma: "pt-BR", organizations: [] }) as unknown as AuthUser,
  orgAtivaSemPortao: async (): Promise<ActiveOrg> => ({
    orgId: "org-1",
    name: "Org",
    role: "admin",
    org_status: h.status,
  }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } }, error: null }) },
  }),
}));

const ROTAS: Array<[string, () => Promise<Response>]> = [
  ["conversations", async () => (await import("@/app/api/v1/conversations/route")).GET(
    new Request("http://x/api/v1/conversations") as never)],
  ["channel-sessions", async () => (await import("@/app/api/v1/channel-sessions/route")).GET()],
  ["mcp/tools", async () => (await import("@/app/api/v1/mcp/tools/route")).GET(
    new Request("http://x/api/v1/mcp/tools") as never)],
  ["voice/sessions/status", async () => (await import("@/app/api/v1/voice/sessions/status/route")).GET()],
];

beforeEach(() => {
  h.status = "suspended";
});

describe("rota de API com a empresa suspensa", () => {
  it.each(ROTAS)("%s → 403 org_suspended em JSON", async (_nome, chamar) => {
    const res = await chamar();
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    const corpo = await res.json();
    expect(corpo.error.code).toBe("org_suspended");
  });

  it("CONTROLE — empresa operante passa do portão (não é o 403 da suspensão)", async () => {
    h.status = "active";
    const res = await ROTAS[3]![1]().catch((e: unknown) => e);
    // Passado o portão, a rota vai ao banco (aqui um cliente sem `from`): o que
    // importa é NÃO ter sido o 403 `org_suspended`.
    if (res instanceof Response) {
      expect(res.status).not.toBe(403);
    } else {
      expect(String(res)).not.toMatch(/org_suspended|redirect/);
    }
  });
});
