/**
 * O assistente interno no fio: sem chave de IA, o chat responde 503
 * `ai_indisponivel` (e o frontend cai para as regras locais); ação
 * desconhecida na `/executar` é 422 antes de qualquer auth lateral; e a
 * `/executar` cobra o piso `agent` e revalida o payload.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/ai/gateway-binding", () => ({ resolverModeloDoPonto: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { POST as chatPOST } from "@/app/api/v1/assistente/chat/route";
import { POST as executarPOST } from "@/app/api/v1/assistente/executar/route";

const AUTH_OK = {
  ok: true,
  user: { id: "user-1" },
  org: { orgId: "org-1", role: "manager" },
};

function pedido(body: unknown, rota: string): NextRequest {
  return new NextRequest(`http://localhost${rota}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function corpo(res: Response) {
  return (await res.json()) as { data?: unknown; error?: { code?: string; message?: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/assistente/chat", () => {
  it("corpo inválido é 422 antes de pensar", async () => {
    vi.mocked(requireRole).mockResolvedValue(AUTH_OK as never);
    const res = await chatPOST(pedido({ mensagens: [] }, "/api/v1/assistente/chat"));
    expect(res.status).toBe(422);
  });

  it("sem modelo (sem chave) é 503 ai_indisponivel — o frontend usa as regras locais", async () => {
    vi.mocked(requireRole).mockResolvedValue(AUTH_OK as never);
    vi.mocked(resolverModeloDoPonto).mockResolvedValue(null);
    const res = await chatPOST(
      pedido({ mensagens: [{ papel: "user", texto: "gere um pedido" }] }, "/api/v1/assistente/chat"),
    );
    expect(res.status).toBe(503);
    expect((await corpo(res)).error?.code).toBe("ai_indisponivel");
  });
});

describe("POST /api/v1/assistente/executar", () => {
  it("ação desconhecida é 422 sem tocar em nada", async () => {
    const res = await executarPOST(
      pedido({ acao: "apagar_banco", payload: {} }, "/api/v1/assistente/executar"),
    );
    expect(res.status).toBe(422);
    expect(vi.mocked(requireRole)).not.toHaveBeenCalled();
  });

  it("criar_pedido cobra piso agent e revalida o payload", async () => {
    vi.mocked(requireRole).mockResolvedValue(AUTH_OK as never);
    const res = await executarPOST(
      pedido({ acao: "criar_pedido", payload: {} }, "/api/v1/assistente/executar"),
    );
    // Piso cobrado antes de qualquer efeito…
    expect(vi.mocked(requireRole)).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "commercial_orders" }));
    // …e payload vazio não passa na revalidação.
    expect(res.status).toBe(422);
  });
});
