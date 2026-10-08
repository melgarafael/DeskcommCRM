/**
 * GET /api/v1/conversations/[id]/aviso-de-mensagem — o veredito do aviso
 * dentro do app, pela MESMA regra do push do servidor.
 *
 * Roda com: npx vitest run "app/api/v1/conversations/[id]/aviso-de-mensagem/route.test.ts"
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Destinatarios from "@/lib/notifications/destinatarios-da-mensagem";

const CONV = "33333333-3333-4333-8333-333333333333";
const ORG = "22222222-2222-4222-8222-222222222222";

const estado = vi.hoisted(() => ({
  userId: "u-ana",
  role: "agent" as string,
  conversaVisivel: true as boolean,
  carregar: vi.fn(),
  adminCriado: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: estado.userId, idioma: "pt-BR" },
    org: { orgId: ORG, name: "Org", role: estado.role },
  })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: estado.conversaVisivel ? { id: CONV } : null, error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    estado.adminCriado();
    return {};
  },
}));
vi.mock("@/lib/notifications/destinatarios-da-mensagem", async (original) => ({
  ...(await original<typeof Destinatarios>()),
  carregarDestinatariosDaMensagem: (...args: unknown[]) => estado.carregar(...args),
}));

import { GET } from "./route";

async function pergunta(id = CONV) {
  const res = await GET(new NextRequest(`http://localhost/api/v1/conversations/${id}/aviso-de-mensagem`), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, corpo: (await res.json()) as { data?: { avisar: boolean }; error?: { code: string } } };
}

beforeEach(() => {
  estado.userId = "u-ana";
  estado.role = "agent";
  estado.conversaVisivel = true;
  estado.carregar.mockReset();
  estado.adminCriado.mockReset();
});

describe("aviso-de-mensagem", () => {
  it("conversa sem responsável → avisa qualquer membro", async () => {
    estado.userId = "u-qualquer";
    estado.carregar.mockResolvedValue({ tipo: "todos" });
    const { status, corpo } = await pergunta();
    expect(status).toBe(200);
    expect(corpo.data).toEqual({ avisar: true });
    // Os fatos são lidos na organização ATIVA da sessão, para ESTA conversa.
    expect(estado.carregar.mock.calls[0]!.slice(1)).toEqual([ORG, CONV]);
  });

  it("com responsável → avisa o responsável", async () => {
    estado.carregar.mockResolvedValue({ tipo: "restrito", userIds: ["u-ana", "u-admin"] });
    expect((await pergunta()).corpo.data).toEqual({ avisar: true });
  });

  it("com responsável → avisa o admin", async () => {
    estado.userId = "u-admin";
    estado.role = "admin";
    estado.carregar.mockResolvedValue({ tipo: "restrito", userIds: ["u-ana", "u-admin"] });
    expect((await pergunta()).corpo.data).toEqual({ avisar: true });
  });

  it("com responsável → NÃO avisa outro atendente (nem gerente que não é admin)", async () => {
    estado.carregar.mockResolvedValue({ tipo: "restrito", userIds: ["u-bia", "u-admin"] });
    expect((await pergunta()).corpo.data).toEqual({ avisar: false });
    estado.role = "manager";
    estado.userId = "u-gerente";
    expect((await pergunta()).corpo.data).toEqual({ avisar: false });
  });

  it("conversa que a sessão não enxerga → 404, sem ler nada com o service role", async () => {
    estado.conversaVisivel = false;
    const { status, corpo } = await pergunta();
    expect(status).toBe(404);
    expect(corpo.error?.code).toBe("not_found");
    expect(estado.adminCriado).not.toHaveBeenCalled();
    expect(estado.carregar).not.toHaveBeenCalled();
  });

  it("id que não é uuid → 404", async () => {
    expect((await pergunta("nao-e-uuid")).status).toBe(404);
  });

  it("falha de leitura → 500 (o cliente cai para avisar)", async () => {
    estado.carregar.mockRejectedValue(new Error("boom"));
    expect((await pergunta()).status).toBe(500);
  });
});
