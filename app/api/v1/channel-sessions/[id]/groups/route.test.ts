import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/grupos/servico", async (orig) => ({
  ...(await orig<typeof import("@/lib/grupos/servico")>()),
  criarDepsDeGrupos: vi.fn(() => ({})),
  listarGruposDoNumero: vi.fn(),
  alternarGrupo: vi.fn(),
}));

import { requireRole } from "@/lib/auth/require-role";
import { alternarGrupo, GrupoError, listarGruposDoNumero } from "@/lib/grupos/servico";
import { GET, PUT } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESS = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: SESS }) };
const autorizado = () =>
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u1" }, org: { orgId: ORG, role: "manager" } } as never);

beforeEach(() => vi.clearAllMocks());

describe("grupos do número", () => {
  it("atendente não liga grupo (a rota exige gerente)", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    const res = await PUT(new NextRequest("http://x", { method: "PUT", body: JSON.stringify({ group_chat_id: "1@g.us", enabled: true }) }), ctx);
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(alternarGrupo).not.toHaveBeenCalled();
  });
  it("lista os grupos com a organização da sessão, nunca do body", async () => {
    autorizado();
    vi.mocked(listarGruposDoNumero).mockResolvedValue([{ chatId: "1@g.us", subject: "A", enabled: false, enabledAt: null, presente: true }]);
    const res = await GET(new NextRequest("http://x"), ctx);
    expect(res.status).toBe(200);
    expect(listarGruposDoNumero).toHaveBeenCalledWith(expect.anything(), { organizationId: ORG, channelSessionId: SESS });
  });
  it("liga um grupo", async () => {
    autorizado();
    vi.mocked(alternarGrupo).mockResolvedValue({ enabled: true });
    const res = await PUT(new NextRequest("http://x", { method: "PUT", body: JSON.stringify({ group_chat_id: "1@g.us", subject: "A", enabled: true, organization_id: "outra" }) }), ctx);
    expect(res.status).toBe(200);
    expect(alternarGrupo).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: ORG, groupChatId: "1@g.us", ligar: true, actorUserId: "u1" }));
  });
  it("filtro não confirmado vira 502 e o grupo não fica ligado", async () => {
    autorizado();
    vi.mocked(alternarGrupo).mockRejectedValue(new GrupoError("filtro_nao_confirmado"));
    const res = await PUT(new NextRequest("http://x", { method: "PUT", body: JSON.stringify({ group_chat_id: "1@g.us", enabled: true }) }), ctx);
    expect(res.status).toBe(502);
  });
  it("WhatsApp fora do ar na listagem vira 502 com envelope de erro, não 500 cru", async () => {
    autorizado();
    vi.mocked(listarGruposDoNumero).mockRejectedValue(new Error("groups_422"));
    const res = await GET(new NextRequest("http://x"), ctx);
    expect(res.status).toBe(502);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("channel_unavailable");
    expect(corpo.error.message).toMatch(/não respondeu/);
  });
  it("body inválido é 400", async () => {
    autorizado();
    const res = await PUT(new NextRequest("http://x", { method: "PUT", body: JSON.stringify({ group_chat_id: "5568@c.us", enabled: "sim" }) }), ctx);
    expect(res.status).toBe(400);
  });
});
